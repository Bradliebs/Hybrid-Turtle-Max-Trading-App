import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { buildCandidateEvidence, type CandidateEvidence } from '../lib/typesafe-candidate-review';
import { createTypesafeReviewer, TypesafeReviewError, type TypesafeResponse } from '../lib/typesafe-client';
import { TypesafeReviewSource, reviewDatabasePath, type ReviewSnapshot } from '../lib/typesafe-review-source';
import { isReviewWeekday, reviewDay, reviewKey, TypesafeReviewStore, type ReviewRecord } from '../lib/typesafe-review-store';

interface ReviewWorkerOptions {
  enabled: boolean;
  ownerId: string;
  hasKey: boolean;
  store: TypesafeReviewStore;
  latest: () => ReviewSnapshot | null;
  evaluate: (state: CandidateEvidence, signal: AbortSignal) => Promise<TypesafeResponse>;
  now?: () => Date;
}

export async function runTypesafeReview(options: ReviewWorkerOptions): Promise<{ status: string; failed: boolean }> {
  const now = options.now ?? (() => new Date());
  const start = now();
  if (!options.enabled) return { status: 'DISABLED', failed: false };
  if (!isReviewWeekday(start)) return { status: 'WEEKEND', failed: false };
  if (!options.hasKey) return { status: 'MISSING_KEY', failed: true };
  if (!options.ownerId) return { status: 'MISSING_OWNER', failed: true };
  options.store.acquire();
  try {
    const ledger = options.store.read();
    options.store.observe(ledger, start);
    const finish = (status: string, failed = false) => {
      ledger.lastRun = { at: now().toISOString(), status, ownerId: options.ownerId };
      options.store.save(ledger);
      return { status, failed };
    };
    if (ledger.cooldownUntil > start.getTime()) return finish('PROVIDER_COOLDOWN');
    const snapshot = options.latest();
    if (!snapshot) return finish('NO_SNAPSHOT');
    if (snapshot.ownerId !== options.ownerId) return finish('OWNER_MISMATCH', true);
    const age = start.getTime() - Date.parse(snapshot.scanTime);
    if (!Number.isFinite(age) || age < 120_000 || age > 3_600_000) return finish('NO_RECENT_SETTLED_SNAPSHOT');
    const signal = AbortSignal.timeout(110_000);
    let status = 'NO_NEW_CANDIDATES';
    let failed = false;
    for (const candidate of snapshot.candidates.slice(0, 5)) {
      if (signal.aborted || now().getTime() - start.getTime() >= 110_000) return finish('RUN_DEADLINE', true);
      const current = options.latest();
      if (!current || current.id !== snapshot.id) return finish('SUPERSEDED_SNAPSHOT');
      if (now().getTime() - Date.parse(snapshot.scanTime) > 3_600_000) return finish('SNAPSHOT_EXPIRED');
      const refreshed = current.candidates.find(item => item.resultId === candidate.resultId);
      if (!refreshed) return finish('SUPERSEDED_CANDIDATES', failed);
      const evidence = buildCandidateEvidence(refreshed.evidence);
      const key = reviewKey(snapshot.id, candidate.resultId);
      if (ledger.attempts.some(attempt => attempt.key === key)) {
        const previous = ledger.reviews[key];
        if (previous && previous.inputHash !== evidence.inputHash) {
          ledger.reviews[key] = { ...previous, status: 'CHANGED_EVIDENCE', answer: null, flags: ['INPUT_CHANGED_AFTER_ATTEMPT'] };
        }
        continue;
      }
      const record: ReviewRecord = {
        scanId: snapshot.id, resultId: candidate.resultId, ownerId: options.ownerId,
        ticker: candidate.evidence.ticker, scanTime: snapshot.scanTime, reviewedAt: now().toISOString(),
        inputHash: evidence.inputHash, claim: evidence.state?.claim ?? null,
        status: 'INSUFFICIENT_EVIDENCE', flags: evidence.flags, answer: null, elapsedMs: 0,
      };
      if (!evidence.state) {
        ledger.reviews[key] = record;
        status = 'INCOMPLETE_EVIDENCE';
        continue;
      }
      if (ledger.attempts.filter(attempt => ledger.reviews[attempt.key]?.scanId === snapshot.id).length >= 5) {
        return finish('SCAN_LIMIT_REACHED', failed);
      }
      if (!options.store.reserve(ledger, record, now())) {
        ledger.reviews[key] = { ...record, status: 'BUDGET_EXHAUSTED' };
        status = 'BUDGET_EXHAUSTED';
        continue;
      }
      const requestStarted = now().getTime();
      try {
        const response = await options.evaluate(evidence.state, signal);
        record.status = 'COMPLETE';
        record.answer = {
          choice: response.answers.evidence.choice, confidence: response.answers.evidence.confidence,
          probabilities: response.answers.evidence.probabilities, model: response.model,
          inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        };
        status = 'COMPLETE';
      } catch (error) {
        record.status = 'UNAVAILABLE';
        record.flags = [error instanceof TypesafeReviewError ? error.code : 'PROVIDER_UNAVAILABLE'];
        failed = true;
        status = 'PROVIDER_UNAVAILABLE';
        if (error instanceof TypesafeReviewError && [401, 403, 429, 529].includes(error.status ?? 0)) {
          ledger.cooldownUntil = Math.max(now().getTime() + 900_000, error.retryAt ?? 0);
        }
      }
      record.reviewedAt = now().toISOString();
      record.elapsedMs = Math.max(0, now().getTime() - requestStarted);
      ledger.reviews[key] = record;
      options.store.save(ledger);
      if (ledger.cooldownUntil > now().getTime()) break;
    }
    return finish(failed ? 'PROVIDER_UNAVAILABLE' : status, failed);
  } finally { options.store.release(); }
}

async function main(): Promise<void> {
  const store = new TypesafeReviewStore();
  if (process.argv.includes('--initialize')) {
    store.acquire();
    try { store.initialize(new Date()); } finally { store.release(); }
    console.log('[Typesafe] INITIALIZED; no provider request sent');
    return;
  }
  let source: TypesafeReviewSource | undefined;
  let reviewer: ReturnType<typeof createTypesafeReviewer> | undefined;
  const ownerId = process.env.TYPESAFE_REVIEW_USER_ID ?? 'default-user';
  const synthetic = process.argv.includes('--synthetic');
  try {
    const result = await runTypesafeReview({
      enabled: process.env.TYPESAFE_REVIEW_ENABLED === 'true', ownerId,
      hasKey: Boolean(process.env.TYPESAFE_API_KEY?.trim()), store,
      latest: () => {
        if (synthetic) {
          const now = new Date();
          const scanTime = new Date(now.getTime() - 180_000).toISOString();
          return { id: `synthetic-${reviewDay(now)}`, ownerId, scanTime, candidates: [{ resultId: 'synthetic', evidence: {
            ticker: 'TEST', regime: 'BULLISH', price: 100, ma200: 90, entryTrigger: 101, adx: 25,
            ncs: 60, bqs: 60, fws: 20, volumeRatio: 1, relativeStrength: 1,
            grade: 'B_GRADE_WATCH', gradeReason: 'Passes filters but not A-grade. NCS 60 < 70',
            source: 'LIVE', dataAsOf: scanTime, scanTime, provenanceMatches: true,
          } }] };
        }
        source ??= new TypesafeReviewSource(reviewDatabasePath(process.env.DATABASE_URL));
        return source.latest(ownerId);
      },
      evaluate: (state, signal) => {
        reviewer ??= createTypesafeReviewer(process.env.TYPESAFE_API_KEY ?? '');
        return reviewer(state, signal);
      },
    });
    console.log(`[Typesafe] ${result.status}`);
    process.exitCode = result.failed ? 1 : 0;
  } finally { source?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('[Typesafe] WORKER_FAILED; check local ledger, lock and configuration. No automatic reset.');
    process.exitCode = 1;
  });
}