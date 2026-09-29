/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts, src/lib/jev-entry-gate.ts, src/cron/watchdog.ts
 * Consumes: nothing (pure — no native modules, no DB, no network)
 * Risk-sensitive: YES — decides which A-grade candidates auto-trade may keep
 * Notes: Kept dependency-free on purpose. auto-trade.ts imports this statically,
 *        and only loads jev-entry-gate.ts (which pulls in the native
 *        better-sqlite3 module) when the veto is enabled, so a native-module
 *        break can never stop an auto-trade session from starting.
 *        Both filters only ever REMOVE candidates; they never add or reorder.
 */

export const DEFAULT_JEV_VETO_PASS_PROBABILITY = 0.6;
export const JEV_VETO_PREFIX = 'Jev veto:';
export const ETF_ONLY_SKIP_REASON = 'ETF-only mode: not an ETF';

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

/** ETF-only mode keeps a candidate only when its sleeve is ETF. */
export function isEtfOnlyEligible(sleeve: string): boolean {
  return sleeve === 'ETF';
}

export interface Skip { ticker: string; reason: string }

/** Splits candidates for ETF-only mode. Order of kept candidates is preserved. */
export function partitionEtfOnly<T extends { ticker: string; sleeve: string }>(candidates: readonly T[]): { kept: T[]; skipped: Skip[] } {
  const kept: T[] = [];
  const skipped: Skip[] = [];
  for (const candidate of candidates) {
    if (isEtfOnlyEligible(candidate.sleeve)) kept.push(candidate);
    else skipped.push({ ticker: candidate.ticker, reason: ETF_ONLY_SKIP_REASON });
  }
  return { kept, skipped };
}

/**
 * Applies Jev verdicts. Only an explicit VETO removes a candidate; a missing
 * verdict keeps it (fail-open). Order of kept candidates is preserved.
 */
export function partitionJevVerdicts<T extends { ticker: string }>(
  candidates: readonly T[],
  verdicts: ReadonlyMap<string, JevVerdict>,
): { kept: T[]; vetoed: Skip[] } {
  const kept: T[] = [];
  const vetoed: Skip[] = [];
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.ticker);
    if (verdict?.action === 'VETO') vetoed.push({ ticker: candidate.ticker, reason: verdict.reason });
    else kept.push(candidate);
  }
  return { kept, vetoed };
}

/** ExecutionLog phase for a verdict. Unreviewed allows are logged separately so a silent non-check is visible. */
export function jevLogPhase(verdict: JevVerdict): 'JEV_VETO' | 'JEV_ALLOW' | 'JEV_SKIPPED' {
  if (verdict.action === 'VETO') return 'JEV_VETO';
  return verdict.reviewed ? 'JEV_ALLOW' : 'JEV_SKIPPED';
}
