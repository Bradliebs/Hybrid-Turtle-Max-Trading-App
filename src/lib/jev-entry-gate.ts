/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts
 * Consumes: typesafe-candidate-review.ts, typesafe-client.ts, typesafe-review-source.ts,
 *           typesafe-review-store.ts, typesafe-shadow.ts
 * Risk-sensitive: YES — can remove an auto-trade buy candidate (veto only)
 * Notes: Jev may block an A-grade buy that already passed every HybridTurtle
 *        rule. It can never add a buy or change grades, ranking, size, stops or
 *        risk gates. It fails open: missing key, evidence, budget, lock or any
 *        provider error leaves the existing rules in charge, so automation never
 *        depends on Typesafe being available. Shares the 20-per-day request
 *        budget and ledger with the scheduled review worker.
 */
import { buildCandidateEvidence, type CandidateEvidence } from './typesafe-candidate-review';
import { createTypesafeReviewer, TypesafeReviewError, type TypesafeResponse } from './typesafe-client';
import { reviewDatabasePath, TypesafeReviewSource, type ReviewSnapshot } from './typesafe-review-source';
import { reviewKey, TypesafeReviewStore, type ReviewRecord } from './typesafe-review-store';
import { buildShadowPrediction, shadowPickSchema } from './typesafe-shadow';

export const JEV_GATE_MAX_REVIEWS = 5;
export const DEFAULT_JEV_VETO_PASS_PROBABILITY = 0.6;
export const JEV_VETO_PREFIX = 'Jev veto:';
const DEFAULT_LOCK_WAIT_MS = 15_000;
const DEFAULT_DEADLINE_MS = 60_000;

export interface JevGateConfig {
  enabled: boolean;
  hasKey: boolean;
  passThreshold: number;
}

export function readJevGateConfig(env: Record<string, string | undefined> = process.env): JevGateConfig {
  const raw = Number(env.JEV_VETO_PASS_PROBABILITY);
  return {
    enabled: env.JEV_AUTO_TRADE_GATE === 'veto' && env.TYPESAFE_REVIEW_ENABLED === 'true',
    hasKey: Boolean(env.TYPESAFE_API_KEY?.trim()),
    // Floor of 0.5 so a misconfigured threshold cannot turn Jev into a veto-everything switch.
    passThreshold: Number.isFinite(raw) && raw >= 0.5 && raw <= 1 ? raw : DEFAULT_JEV_VETO_PASS_PROBABILITY,
  };
}

export interface JevVerdict {
  action: 'ALLOW' | 'VETO';
  reviewed: boolean;
  reason: string;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function decideJevVerdict(evidenceChoice: string, pick: unknown, passThreshold: number): JevVerdict {
  if (evidenceChoice === 'CONTRADICTED' || evidenceChoice === 'MIXED') {
    const verb = evidenceChoice === 'CONTRADICTED' ? 'contradicts' : 'partly contradicts';
    return { action: 'VETO', reviewed: true, reason: `${JEV_VETO_PREFIX} scan data ${verb} the buy reason` };
  }
  const parsed = shadowPickSchema.safeParse(pick);
  if (parsed.success && parsed.data.probabilities.PASS >= passThreshold) {
    return { action: 'VETO', reviewed: true, reason: `${JEV_VETO_PREFIX} PASS (${percent(parsed.data.probabilities.PASS)} pass)` };
  }
  const pickText = parsed.success ? `${parsed.data.choice} ${percent(parsed.data.probabilities[parsed.data.choice])}` : 'pick unavailable';
  return { action: 'ALLOW', reviewed: true, reason: `Jev allow: evidence ${evidenceChoice}, ${pickText}` };
}

export interface JevGateDeps {
  config: JevGateConfig;
  ownerId: string;
  scanId: string | null;
  /** Remaining buy candidates in execution (rank) order. */
  tickers: readonly string[];
  store: TypesafeReviewStore;
  load: (scanId: string, tickers: readonly string[]) => ReviewSnapshot | null;
  evaluate: (state: CandidateEvidence, signal: AbortSignal) => Promise<TypesafeResponse>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  deadlineMs?: number;
}

export interface JevGateResult {
  status: string;
  verdicts: Map<string, JevVerdict>;
}

export async function runJevEntryGate(deps: JevGateDeps): Promise<JevGateResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const verdicts = new Map<string, JevVerdict>();
  const allowRest = (status: string, why: string): JevGateResult => {
    for (const ticker of deps.tickers) {
      if (!verdicts.has(ticker)) verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: `Jev not consulted: ${why}` });
    }
    return { status, verdicts };
  };

  if (!deps.config.enabled) return allowRest('DISABLED', 'gate off');
  if (deps.tickers.length === 0) return { status: 'NO_CANDIDATES', verdicts };
  if (!deps.config.hasKey) return allowRest('MISSING_KEY', 'API key missing');
  if (!deps.scanId) return allowRest('NO_SCAN', 'execution scan not saved');

  const lockDeadline = now().getTime() + (deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  for (;;) {
    try { deps.store.acquire(); break; } catch {
      if (now().getTime() >= lockDeadline) return allowRest('LOCK_BUSY', 'review lock busy');
      await sleep(500);
    }
  }

  try {
    let ledger: ReturnType<TypesafeReviewStore['read']>;
    try {
      ledger = deps.store.read();
      deps.store.observe(ledger, now());
    } catch {
      return allowRest('LEDGER_UNAVAILABLE', 'review ledger unavailable');
    }
    if (ledger.cooldownUntil > now().getTime()) return allowRest('PROVIDER_COOLDOWN', 'provider cooling down');

    const reviewable = deps.tickers.slice(0, JEV_GATE_MAX_REVIEWS);
    let snapshot: ReviewSnapshot | null;
    try { snapshot = deps.load(deps.scanId, reviewable); } catch { snapshot = null; }
    if (!snapshot || snapshot.ownerId !== deps.ownerId) return allowRest('SCAN_NOT_FOUND', 'execution scan not readable');

    const signal = AbortSignal.timeout(deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
    let status = 'COMPLETE';
    for (const ticker of reviewable) {
      if (signal.aborted) { status = 'RUN_DEADLINE'; break; }
      const candidate = snapshot.candidates.find(item => item.evidence.ticker === ticker);
      if (!candidate) {
        verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: 'Jev not consulted: not in saved scan' });
        continue;
      }
      const evidence = buildCandidateEvidence(candidate.evidence);
      const key = reviewKey(snapshot.id, candidate.resultId);
      const record: ReviewRecord = {
        scanId: snapshot.id, resultId: candidate.resultId, ownerId: deps.ownerId,
        ticker, scanTime: snapshot.scanTime, reviewedAt: now().toISOString(),
        inputHash: evidence.inputHash, claim: evidence.state?.claim ?? null,
        status: 'INSUFFICIENT_EVIDENCE', flags: evidence.flags, answer: null, elapsedMs: 0,
      };
      if (!evidence.state) {
        ledger.reviews[key] ??= record;
        verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: `Jev not consulted: evidence incomplete (${evidence.flags.join(', ')})` });
        continue;
      }
      if (ledger.attempts.some(attempt => attempt.key === key)) {
        const previous = ledger.reviews[key];
        if (previous?.status === 'COMPLETE' && previous.answer && previous.inputHash === evidence.inputHash) {
          const shadow = deps.store.findShadow(snapshot.id, candidate.resultId, evidence.inputHash!);
          verdicts.set(ticker, decideJevVerdict(previous.answer.choice, shadow ? { type: 'choice', ...shadow.pick } : null, deps.config.passThreshold));
        } else {
          verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: 'Jev not consulted: earlier attempt unusable' });
        }
        continue;
      }
      if (!deps.store.reserve(ledger, record, now())) {
        ledger.reviews[key] = { ...record, status: 'BUDGET_EXHAUSTED' };
        verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: 'Jev not consulted: request budget used' });
        status = 'BUDGET_EXHAUSTED';
        continue;
      }
      const started = now().getTime();
      try {
        const response = await deps.evaluate(evidence.state, signal);
        record.status = 'COMPLETE';
        record.answer = {
          choice: response.answers.evidence.choice, confidence: response.answers.evidence.confidence,
          probabilities: response.answers.evidence.probabilities, model: response.model,
          inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        };
        const shadow = buildShadowPrediction(
          { scanId: snapshot.id, resultId: candidate.resultId, ticker, ownerId: deps.ownerId,
            scanTime: snapshot.scanTime, inputHash: evidence.inputHash! },
          evidence.state, response.answers, now(),
        );
        if (!shadow) record.flags = ['SHADOW_ANSWER_INVALID'];
        else {
          try { deps.store.appendShadow(shadow); } catch { record.flags = ['SHADOW_NOT_RECORDED']; }
        }
        verdicts.set(ticker, decideJevVerdict(response.answers.evidence.choice, response.answers.pick, deps.config.passThreshold));
      } catch (error) {
        const code = error instanceof TypesafeReviewError ? error.code : 'PROVIDER_UNAVAILABLE';
        record.status = 'UNAVAILABLE';
        record.flags = [code];
        status = 'PROVIDER_UNAVAILABLE';
        if (error instanceof TypesafeReviewError && [401, 403, 429, 529].includes(error.status ?? 0)) {
          ledger.cooldownUntil = Math.max(now().getTime() + 900_000, error.retryAt ?? 0);
        }
        verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: `Jev not consulted: provider unavailable (${code})` });
      }
      record.reviewedAt = now().toISOString();
      record.elapsedMs = Math.max(0, now().getTime() - started);
      ledger.reviews[key] = record;
      deps.store.save(ledger);
      if (ledger.cooldownUntil > now().getTime()) break;
    }
    try { deps.store.save(ledger); } catch { /* verdicts stand; the ledger keeps its last good save */ }
    return allowRest(status, status === 'COMPLETE' ? `beyond first ${JEV_GATE_MAX_REVIEWS}` : status.toLowerCase());
  } finally {
    try { deps.store.release(); } catch { /* lock ownership changed; leave it for manual recovery */ }
  }
}

/** Production wiring for auto-trade. Never throws: any failure allows every candidate. */
export async function runJevGateForAutoTrade(params: {
  config: JevGateConfig;
  ownerId: string;
  scanId: string | null;
  tickers: readonly string[];
}): Promise<JevGateResult> {
  let source: TypesafeReviewSource | undefined;
  let reviewer: ReturnType<typeof createTypesafeReviewer> | undefined;
  try {
    return await runJevEntryGate({
      ...params,
      store: new TypesafeReviewStore(),
      load: (scanId, tickers) => {
        source ??= new TypesafeReviewSource(reviewDatabasePath(process.env.DATABASE_URL));
        return source.forScan(scanId, params.ownerId, tickers);
      },
      evaluate: (state, signal) => {
        reviewer ??= createTypesafeReviewer(process.env.TYPESAFE_API_KEY ?? '');
        return reviewer(state, signal);
      },
    });
  } catch {
    const verdicts = new Map<string, JevVerdict>();
    for (const ticker of params.tickers) verdicts.set(ticker, { action: 'ALLOW', reviewed: false, reason: 'Jev not consulted: gate error' });
    return { status: 'GATE_ERROR', verdicts };
  } finally {
    try { source?.close(); } catch { /* read-only handle */ }
  }
}
