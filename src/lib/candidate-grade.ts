/**
 * DEPENDENCIES
 * Consumed by: scan API route, auto-trade.ts, TodayDirectiveCard, CandidateTable
 * Consumes: @/types (ScanCandidate, CandidateStatus)
 * Risk-sensitive: NO — classification only, does not execute trades or bypass gates
 * Last modified: 2026-10-05
 * Notes: Pure function — no DB, no side effects. Takes a candidate + context, returns a grade.
 *        Auto-trade uses grade to prefer A_GRADE_BUY and skip BLOCKED/C_GRADE.
 *        Thresholds are configurable via GRADE_THRESHOLDS export.
 */

import type { ScanCandidate, CandidateStatus, MarketRegime } from '@/types';

// ── Grade enum ──────────────────────────────────────────────

export type CandidateGrade =
  | 'A_GRADE_BUY'
  | 'B_GRADE_WATCH'
  | 'C_GRADE_IGNORE'
  | 'BLOCKED_RISK'
  | 'BLOCKED_REGIME'
  | 'BLOCKED_CHASE'
  | 'BLOCKED_DATA'
  | 'BLOCKED_EVENT';

// ── Classification result ───────────────────────────────────

export interface CandidateClassification {
  grade: CandidateGrade;
  /** Plain-English explanation of why this grade was assigned */
  reason: string;
  /** All individual checks that contributed to the grade */
  checks: GradeCheck[];
}

export interface GradeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

// ── Configurable thresholds ─────────────────────────────────

export interface GradeThresholds {
  /** Minimum NCS for A-grade (default 70) */
  minNCS: number;
  /** Maximum FWS for A-grade (default 30) */
  maxFWS: number;
  /** Minimum BQS for A-grade (default 55) */
  minBQS: number;
  /** Minimum volume ratio for A-grade (default 0.8) */
  minVolumeRatio: number;
  /**
   * Minimum relative-strength score for A-grade (default 50). The scanner's RS is a
   * 0–100 score where 50 means level with SPY over 20 sessions (market-data.ts), so
   * 50 = "not lagging the market". It was 0, which every score passes.
   */
  minRelativeStrength: number;
}

export const DEFAULT_GRADE_THRESHOLDS: GradeThresholds = {
  minNCS: 70,
  maxFWS: 30,
  minBQS: 55,
  minVolumeRatio: 0.8,
  minRelativeStrength: 50,
};

// ── Context required for grading ────────────────────────────

export interface GradingContext {
  regime: MarketRegime | string;
  healthOverall: string;
  /** NCS, BQS, FWS scores — may be null if dual-score hasn't run */
  ncs?: number | null;
  bqs?: number | null;
  fws?: number | null;
  /** True when the scores are older than the freshness limit (a missed nightly). Blocks A-grade. */
  scoresStale?: boolean;
}

// ── Classification logic ────────────────────────────────────

export function classifyCandidate(
  candidate: ScanCandidate,
  context: GradingContext,
  thresholds: GradeThresholds = DEFAULT_GRADE_THRESHOLDS,
): CandidateClassification {
  const checks: GradeCheck[] = [];

  // ── BLOCKED checks (hard blocks — any one of these forces a BLOCKED grade) ──

  // 1. Regime
  const regimeBullish = context.regime === 'BULLISH';
  checks.push({
    name: 'regime',
    passed: regimeBullish,
    detail: regimeBullish ? 'BULLISH' : `${context.regime} — entries require BULLISH`,
  });
  if (!regimeBullish) {
    return {
      grade: 'BLOCKED_REGIME',
      reason: `Market regime is ${context.regime}. New entries require BULLISH regime.`,
      checks,
    };
  }

  // 2. Health
  const healthGreen = context.healthOverall === 'GREEN';
  checks.push({
    name: 'health',
    passed: healthGreen,
    detail: healthGreen ? 'GREEN' : `${context.healthOverall} — system health issue`,
  });
  if (context.healthOverall === 'RED') {
    return {
      grade: 'BLOCKED_DATA',
      reason: 'System health is RED. Resolve before considering entries.',
      checks,
    };
  }

  // 3. Earnings/event block
  const earningsBlocked = candidate.status === 'EARNINGS_BLOCK' ||
    candidate.earningsInfo?.action === 'AUTO_NO';
  checks.push({
    name: 'earnings',
    passed: !earningsBlocked,
    detail: earningsBlocked
      ? `Earnings within ${candidate.earningsInfo?.daysUntilEarnings ?? '?'} days — blocked`
      : 'No earnings conflict',
  });
  if (earningsBlocked) {
    return {
      grade: 'BLOCKED_EVENT',
      reason: `Blocked: earnings within ${candidate.earningsInfo?.daysUntilEarnings ?? 'unknown'} days. Binary event risk.`,
      checks,
    };
  }

  // 4. Data quality
  const dataOk = candidate.filterResults.dataQuality !== false;
  checks.push({
    name: 'dataQuality',
    passed: dataOk,
    detail: dataOk ? 'Data quality OK' : 'Insufficient or stale price data',
  });
  if (!dataOk) {
    return {
      grade: 'BLOCKED_DATA',
      reason: 'Insufficient price data. Cannot reliably assess this candidate.',
      checks,
    };
  }

  // 5. Anti-chase block
  const antiChaseOk = candidate.passesAntiChase !== false;
  const isWaitPullback = candidate.status === 'WAIT_PULLBACK';
  const chaseBlocked = !antiChaseOk || isWaitPullback;
  checks.push({
    name: 'antiChase',
    passed: !chaseBlocked,
    detail: chaseBlocked
      ? (isWaitPullback ? 'Extended beyond trigger — wait for pullback' : `Anti-chase: ${candidate.antiChaseResult?.reason || 'gap too large'}`)
      : 'Within entry zone',
  });
  if (chaseBlocked) {
    return {
      grade: 'BLOCKED_CHASE',
      reason: isWaitPullback
        ? 'Price extended beyond entry trigger. Waiting for pullback into zone.'
        : `Anti-chase guard triggered: ${candidate.antiChaseResult?.reason || 'price gapped above trigger'}`,
      checks,
    };
  }

  // 6. Risk gates
  const riskGatesOk = candidate.passesRiskGates !== false;
  const hasShares = (candidate.shares ?? 0) > 0;
  checks.push({
    name: 'riskGates',
    passed: riskGatesOk && hasShares,
    detail: !riskGatesOk
      ? `Risk gate failed: ${candidate.riskGateResults?.filter(g => !g.passed).map(g => g.gate).join(', ') || 'unknown'}`
      : !hasShares
      ? 'Position size is zero after caps'
      : 'All risk gates pass',
  });
  if (!riskGatesOk || !hasShares) {
    return {
      grade: 'BLOCKED_RISK',
      reason: !riskGatesOk
        ? `Risk gate blocked: ${candidate.riskGateResults?.filter(g => !g.passed).map(g => g.message).join('; ') || 'gate failed'}`
        : 'Position size rounds to zero after caps — account may be too small for this entry.',
      checks,
    };
  }

  // 7. Cooldown
  const inCooldown = candidate.status === 'COOLDOWN';
  checks.push({
    name: 'cooldown',
    passed: !inCooldown,
    detail: inCooldown ? 'Failed breakout cooldown active (5 days)' : 'No cooldown',
  });
  if (inCooldown) {
    return {
      grade: 'BLOCKED_CHASE',
      reason: 'Recent failed breakout. In 5-day cooldown period before re-entry allowed.',
      checks,
    };
  }

  // ── All hard blocks passed. Now classify A vs B vs C. ──

  // 8. Hard filters
  const passesAllFilters = candidate.passesAllFilters;
  checks.push({
    name: 'technicalFilters',
    passed: passesAllFilters,
    detail: passesAllFilters ? 'All 7-stage filters pass' : 'One or more technical filters failed',
  });

  // 9. Status — A-grade requires the breakout actually triggered (price >= entryTrigger).
  // READY (within 2% below trigger) is watchlist-only; it demotes to B-grade.
  // This aligns code with documented intent in DASHBOARD-GUIDE.md and 10-10-PLAN.md
  // ("By definition, buying after the breakout…") and keeps R-multiple analytics honest
  // since entry_type is recorded as 'BREAKOUT'.
  const isReady = candidate.status === 'READY';
  const isTriggerMet = candidate.price >= candidate.entryTrigger;
  checks.push({
    name: 'status',
    passed: isTriggerMet,
    detail: isTriggerMet
      ? 'TRIGGERED — price ≥ entry trigger'
      : isReady
        ? 'READY — within 2% of trigger but breakout not yet confirmed'
        : `${candidate.status} — not yet ready`,
  });

  // 10. Scoring quality
  const ncs = context.ncs ?? 0;
  const fws = context.fws ?? 100;
  const bqs = context.bqs ?? 0;
  const ncsOk = ncs >= thresholds.minNCS;
  const fwsOk = fws <= thresholds.maxFWS;
  const bqsOk = bqs >= thresholds.minBQS;
  const scoresFresh = context.scoresStale !== true;
  checks.push({
    name: 'scoreFreshness',
    passed: scoresFresh,
    detail: scoresFresh ? 'Scores current' : 'Scores older than 36h (missed nightly) — not trusted for a buy',
  });
  checks.push({
    name: 'ncs',
    passed: ncsOk,
    detail: `NCS ${ncs.toFixed(0)} ${ncsOk ? '≥' : '<'} ${thresholds.minNCS}`,
  });
  checks.push({
    name: 'fws',
    passed: fwsOk,
    detail: `FWS ${fws.toFixed(0)} ${fwsOk ? '≤' : '>'} ${thresholds.maxFWS}`,
  });
  checks.push({
    name: 'bqs',
    passed: bqsOk,
    detail: `BQS ${bqs.toFixed(0)} ${bqsOk ? '≥' : '<'} ${thresholds.minBQS}`,
  });

  // 11. Volume
  const volRatio = candidate.technicals.volumeRatio;
  const volOk = volRatio >= thresholds.minVolumeRatio;
  checks.push({
    name: 'volume',
    passed: volOk,
    detail: `Vol ratio ${volRatio.toFixed(2)} ${volOk ? '≥' : '<'} ${thresholds.minVolumeRatio}`,
  });

  // 12. Relative strength (0–100 score; 50 = level with SPY)
  const rs = candidate.technicals.relativeStrength;
  const rsOk = rs >= thresholds.minRelativeStrength;
  checks.push({
    name: 'relativeStrength',
    passed: rsOk,
    detail: `RS ${rs.toFixed(1)} ${rsOk ? '≥' : '<'} ${thresholds.minRelativeStrength} (50 = level with SPY)`,
  });

  // 13. Earnings soon (confirmed in 3–5 days, or an unconfirmed date within 2 days):
  // the scanner demotes READY to WATCH, but the A-grade rule checks the trigger,
  // not READY, so the demotion was bypassed. Binary event risk: watch, don't buy.
  const earningsSoon = candidate.earningsInfo?.action === 'DEMOTE_WATCH';
  checks.push({
    name: 'earningsSoon',
    passed: !earningsSoon,
    detail: earningsSoon
      ? `Earnings in ${candidate.earningsInfo?.daysUntilEarnings ?? '3–5'} days — watch only`
      : 'No earnings within 5 days',
  });

  // 14. ATR spike (soft check — doesn't block, but demotes from A to B)
  const atrSpiking = candidate.filterResults.atrSpiking === true;
  checks.push({
    name: 'atrSpike',
    passed: !atrSpiking,
    detail: atrSpiking ? 'ATR spiking — volatility elevated' : 'ATR normal',
  });

  // ── Grade decision ──

  const aGradeChecks = passesAllFilters && isTriggerMet &&
    ncsOk && fwsOk && bqsOk && scoresFresh && volOk && rsOk && !earningsSoon && !atrSpiking;

  if (aGradeChecks) {
    return {
      grade: 'A_GRADE_BUY',
      reason: `Trigger met — price at or above entry. All filters pass, scores strong (NCS ${ncs.toFixed(0)}, BQS ${bqs.toFixed(0)}, FWS ${fws.toFixed(0)}), volume confirmed.`,
      checks,
    };
  }

  // B-grade: passes filters and is READY/WATCH, but doesn't meet all A-grade quality bars
  const bGrade = passesAllFilters && (isReady || candidate.status === 'WATCH');
  if (bGrade) {
    const failedChecks = checks.filter(c => !c.passed && !['regime', 'health', 'earnings', 'dataQuality', 'antiChase', 'riskGates', 'cooldown', 'technicalFilters'].includes(c.name));
    const weakPoints = failedChecks.map(c => c.detail).join('. ');
    return {
      grade: 'B_GRADE_WATCH',
      reason: `Passes filters but not A-grade. ${weakPoints || 'Near threshold — watch for improvement.'}`,
      checks,
    };
  }

  // C-grade: everything else that passed blocks but isn't actionable
  const failedChecks = checks.filter(c => !c.passed);
  return {
    grade: 'C_GRADE_IGNORE',
    reason: `Not actionable: ${failedChecks.map(c => c.detail).join('. ') || 'does not meet minimum criteria.'}`,
    checks,
  };
}

// ── Batch classification ────────────────────────────────────

/**
 * A per-candidate context override. Used by the scan route to inject
 * NCS/FWS/BQS scores looked up from ScoreBreakdown for each ticker, while
 * keeping shared fields like `regime` and `healthOverall` in a single
 * base context.
 */
export type GradingContextResolver =
  | GradingContext
  | ((candidate: ScanCandidate) => GradingContext);

export function classifyCandidates(
  candidates: ScanCandidate[],
  context: GradingContextResolver,
  thresholds?: GradeThresholds,
): Array<ScanCandidate & { classification: CandidateClassification }> {
  const isResolver = typeof context === 'function';
  return candidates.map(c => ({
    ...c,
    classification: classifyCandidate(c, isResolver ? context(c) : context, thresholds),
  }));
}

// ── Grade display helpers ───────────────────────────────────

export function gradeLabel(grade: CandidateGrade): string {
  switch (grade) {
    case 'A_GRADE_BUY': return 'A — Buy';
    case 'B_GRADE_WATCH': return 'B — Watch';
    case 'C_GRADE_IGNORE': return 'C — Ignore';
    case 'BLOCKED_RISK': return 'Blocked (Risk)';
    case 'BLOCKED_REGIME': return 'Blocked (Regime)';
    case 'BLOCKED_CHASE': return 'Blocked (Chase)';
    case 'BLOCKED_DATA': return 'Blocked (Data)';
    case 'BLOCKED_EVENT': return 'Blocked (Event)';
  }
}

export function gradeColor(grade: CandidateGrade): { bg: string; text: string; border: string } {
  switch (grade) {
    case 'A_GRADE_BUY':
      return { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/40' };
    case 'B_GRADE_WATCH':
      return { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/40' };
    case 'C_GRADE_IGNORE':
      return { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/40' };
    case 'BLOCKED_RISK':
    case 'BLOCKED_REGIME':
    case 'BLOCKED_CHASE':
    case 'BLOCKED_DATA':
    case 'BLOCKED_EVENT':
      return { bg: 'bg-red-500/15', text: 'text-red-400', border: 'border-red-500/30' };
  }
}
