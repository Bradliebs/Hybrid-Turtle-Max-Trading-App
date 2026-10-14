/**
 * DEPENDENCIES
 * Consumed by: /api/plan/allocation/route.ts, plan page
 * Consumes: @/types, ev-tracker.ts (optional), prisma.ts
 * Risk-sensitive: NO — advisory ranking only, no orders placed
 * Last modified: 2026-03-06
 *
 * ALLOCATION SCORE — "Among eligible READY trades, which deserves capital first?"
 *
 * Formula (v1):
 *   allocationScore =
 *     qualityComponent         (0–40)  NCS-based setup quality
 *   + expectancyComponent      (0–15)  Historical EV for this sleeve/regime/atr bucket
 *   + sleeveBalanceBonus       (0–10)  Bonus for underweight sleeve
 *   - clusterCrowdingPenalty   (0–15)  Penalty for concentrated clusters
 *   - sectorCrowdingPenalty    (0–10)  Penalty for concentrated sectors
 *   - earningsNearPenalty      (0–10)  Penalty for upcoming earnings
 *   - correlationPenalty       (0–10)  Penalty for correlated holdings
 *   - capitalInefficencyPen    (0–10)  Penalty for poor risk-to-capital ratio
 *
 * Score range: roughly -30 to +75. Higher = deploy capital here first.
 *
 * WEIGHT TUNING: All weights are in the WEIGHTS constant below.
 * Change one number → changes the ranking. No hidden dependencies.
 */

import type { Sleeve, RiskProfileType } from '@/types';
import { SLEEVE_CAPS, getProfileCaps } from '@/types';

// ── Tunable Weights ─────────────────────────────────────────
// Single location to tune the allocation formula. Each weight
// controls one component's contribution to the final score.

export const WEIGHTS = {
  /** NCS quality: score = NCS * weight. NCS 70 → 28 pts */
  quality: 0.40,

  /** Expectancy: score = expectancy * weight. Expectancy 1.0R → 15 pts */
  expectancy: 15,

  /** Bonus for underweight sleeve: score = underweightPct * weight, capped */
  sleeveBalance: 10,

  /** Cluster crowding: penalty = (exposure / cap) * weight, above 60% threshold */
  clusterCrowding: 15,

  /** Sector crowding: penalty = (exposure / cap) * weight, above 60% threshold */
  sectorCrowding: 10,

  /** Earnings: penalty scales with proximity. ≤5d = max penalty */
  earningsNear: 10,

  /** Correlation: penalty per highly-correlated holding */
  correlationPerHolding: 5,
  /** Max correlation penalty */
  correlationMax: 10,

  /** Capital inefficiency: penalty when risk/capital ratio is poor */
  capitalInefficiency: 10,
} as const;

// ── Types ───────────────────────────────────────────────────────────

/** Breakdown of one candidate's allocation score */
export interface AllocationScoreBreakdown {
  ticker: string;
  allocationScore: number;
  rank: number;

  // Components (positive = bonus, negative = penalty)
  qualityComponent: number;
  expectancyComponent: number;
  sleeveBalanceBonus: number;
  clusterCrowdingPenalty: number;
  sectorCrowdingPenalty: number;
  earningsNearPenalty: number;
  correlationPenalty: number;
  capitalInefficiencyPenalty: number;

  // Context (for display)
  ncs: number;
  fws: number;
  bqs: number;
  sleeve: Sleeve;
  sector: string;
  cluster: string;
  expectancyR: number | null;
  clusterExposurePct: number;
  sectorExposurePct: number;
  correlatedHoldings: string[];
  riskToCapitalRatio: number | null;
}

/** Input: what the scorer needs for each candidate */
export interface AllocationCandidate {
  ticker: string;
  name: string;
  sleeve: Sleeve;
  sector: string;
  cluster: string;
  ncs: number;
  fws: number;
  bqs: number;
  entryTrigger: number;
  stopPrice: number;
  suggestedShares: number | null;
  suggestedRiskGbp: number | null;
  suggestedCostGbp: number | null;
  daysToEarnings: number | null;
  atrPct: number;
}

/** Portfolio context: existing positions + portfolio state */
export interface PortfolioContext {
  equity: number;
  riskProfile: RiskProfileType;
  positions: {
    ticker: string;
    sleeve: Sleeve;
    sector: string;
    cluster: string;
    value: number;
  }[];
  correlationFlags: { tickerA: string; tickerB: string; correlation: number }[];
  expectancyByKey: Map<string, number>;  // "sleeve|atrBucket|regime" → expectancy R
  regime: string;
}

// ── Pure scoring functions (exported for testing) ───────────────────

/**
 * Quality component: NCS mapped to 0–40 range.
 * NCS 70 (Auto-Yes threshold) → 28 pts.
 * NCS 100 → 40 pts. NCS 0 → 0 pts.
 */
export function calcQuality(ncs: number): number {
  return Math.round(Math.max(0, ncs) * WEIGHTS.quality * 100) / 100;
}

/**
 * Expectancy component: historical EV for this candidate's context.
 * If no EV data, returns 0 (neutral — don't penalize new setups).
 */
export function calcExpectancy(expectancyR: number | null): number {
  if (expectancyR == null) return 0;
  // Clamp expectancy to [-1, +1] range before scaling
  const clamped = Math.max(-1, Math.min(1, expectancyR));
  return Math.round(clamped * WEIGHTS.expectancy * 100) / 100;
}

/**
 * Sleeve balance bonus: reward candidates in underweight sleeves.
 * Compare current sleeve exposure to its cap. The further below cap,
 * the bigger the bonus (capped at WEIGHTS.sleeveBalance).
 */
export function calcSleeveBonus(
  sleeve: Sleeve,
  sleeveExposurePct: number,
  sleeveCap: number
): number {
  if (sleeveCap <= 0) return 0;
  const utilizationPct = sleeveExposurePct / sleeveCap;
  if (utilizationPct >= 0.8) return 0; // Already near cap — no bonus
  // Bonus scales linearly: 0% utilization = full bonus, 80% = 0
  const bonus = (1 - utilizationPct / 0.8) * WEIGHTS.sleeveBalance;
  return Math.round(Math.max(0, bonus) * 100) / 100;
}

/**
 * Cluster crowding penalty: penalize adding to an already-concentrated cluster.
 * Kicks in when cluster exposure exceeds 60% of the cap.
 */
export function calcClusterPenalty(
  clusterExposurePct: number,
  clusterCap: number
): number {
  if (clusterCap <= 0) return 0;
  const ratio = clusterExposurePct / clusterCap;
  if (ratio <= 0.6) return 0; // Under 60% of cap — no penalty
  // Linear ramp from 60% to 100% of cap, then flat at max
  const severity = Math.min(1, (ratio - 0.6) / 0.4);
  return Math.round(severity * WEIGHTS.clusterCrowding * 100) / 100;
}

/**
 * Sector crowding penalty: same logic as cluster but for sector.
 */
export function calcSectorPenalty(
  sectorExposurePct: number,
  sectorCap: number
): number {
  if (sectorCap <= 0) return 0;
  const ratio = sectorExposurePct / sectorCap;
  if (ratio <= 0.6) return 0;
  const severity = Math.min(1, (ratio - 0.6) / 0.4);
  return Math.round(severity * WEIGHTS.sectorCrowding * 100) / 100;
}

/**
 * Earnings near penalty.
 * @deprecated PRUNED in OVERLAP-03: NCS already includes earnings penalty.
 *             Allocation quality component reflects NCS, so this was triple-counting.
 *             Kept for backward compatibility but no longer called in scoring.
 */
export function calcEarningsPenalty(daysToEarnings: number | null): number {
  if (daysToEarnings == null || daysToEarnings < 0) return 0;
  if (daysToEarnings <= 2) return WEIGHTS.earningsNear;
  if (daysToEarnings <= 5) return Math.round(WEIGHTS.earningsNear * 0.5 * 100) / 100;
  return 0;
}

/**
 * Correlation penalty: penalize adding a ticker highly correlated with
 * existing holdings. Each correlated holding adds to the penalty.
 */
export function calcCorrelationPenalty(correlatedCount: number): number {
  const raw = correlatedCount * WEIGHTS.correlationPerHolding;
  return Math.min(raw, WEIGHTS.correlationMax);
}

/**
 * Capital inefficiency penalty: penalize setups where risk-to-capital
 * ratio is worse than the profile target. This detects "big position,
 * small risk" setups that burn through capital budget without deploying
 * meaningful risk.
 *
 * riskToCapitalRatio = suggestedRiskGbp / suggestedCostGbp
 * Profile target ratio ≈ riskPerTrade% (1% for SMALL_ACCOUNT)
 * If actual ratio < target * 0.5 → penalty scales up.
 */
export function calcCapitalInefficiency(
  riskToCapitalRatio: number | null,
  targetRiskPct: number
): number {
  if (riskToCapitalRatio == null || riskToCapitalRatio <= 0) return 0;
  const targetRatio = targetRiskPct / 100;
  if (targetRatio <= 0) return 0;
  if (riskToCapitalRatio >= targetRatio * 0.5) return 0; // Efficient enough
  // Penalty scales: ratio = 0 → full penalty, ratio = target*0.5 → 0
  const severity = Math.min(1, 1 - riskToCapitalRatio / (targetRatio * 0.5));
  return Math.round(severity * WEIGHTS.capitalInefficiency * 100) / 100;
}

// ── Main scoring function ───────────────────────────────────────────

/**
 * Compute allocation scores for a list of candidates against current portfolio.
 * Pure function — needs all context pre-fetched.
 *
 * Returns candidates ranked by allocationScore descending.
 */
export function scoreAndRankCandidates(
  candidates: AllocationCandidate[],
  context: PortfolioContext
): AllocationScoreBreakdown[] {
  const caps = getProfileCaps(context.riskProfile);
  const targetRiskPct = {
    CONSERVATIVE: 0.75, BALANCED: 0.95, SMALL_ACCOUNT: 1.0, AGGRESSIVE: 3.0,
  }[context.riskProfile] ?? 1.0;

  // Pre-compute portfolio exposure
  const sleeveExposure = new Map<string, number>();
  const clusterExposure = new Map<string, number>();
  const sectorExposure = new Map<string, number>();
  const heldTickers = new Set<string>();

  for (const p of context.positions) {
    heldTickers.add(p.ticker);
    const pct = context.equity > 0 ? (p.value / context.equity) * 100 : 0;
    sleeveExposure.set(p.sleeve, (sleeveExposure.get(p.sleeve) ?? 0) + pct);
    clusterExposure.set(p.cluster, (clusterExposure.get(p.cluster) ?? 0) + pct);
    sectorExposure.set(p.sector, (sectorExposure.get(p.sector) ?? 0) + pct);
  }

  // Index correlation flags by ticker for O(1) lookup
  const corrByTicker = new Map<string, { ticker: string; correlation: number }[]>();
  for (const cf of context.correlationFlags) {
    const existing = corrByTicker.get(cf.tickerA) ?? [];
    existing.push({ ticker: cf.tickerB, correlation: cf.correlation });
    corrByTicker.set(cf.tickerA, existing);
    const existingB = corrByTicker.get(cf.tickerB) ?? [];
    existingB.push({ ticker: cf.tickerA, correlation: cf.correlation });
    corrByTicker.set(cf.tickerB, existingB);
  }

  // ATR bucket classification (matches ev-tracker.ts buckets)
  function atrBucket(atrPct: number): string {
    if (atrPct < 2) return 'LOW';
    if (atrPct < 4) return 'MEDIUM';
    if (atrPct < 7) return 'HIGH';
    return 'EXTREME';
  }

  const scored: AllocationScoreBreakdown[] = candidates.map((c) => {
    // Quality: NCS → 0-40
    const quality = calcQuality(c.ncs);

    // Expectancy: look up EV for this sleeve/atrBucket/regime combination
    const evKey = `${c.sleeve}|${atrBucket(c.atrPct)}|${context.regime}`;
    const expectancyR = context.expectancyByKey.get(evKey) ?? null;
    const expectancy = calcExpectancy(expectancyR);

    // Sleeve balance: bonus for underweight sleeves
    const sleeveCap = (SLEEVE_CAPS[c.sleeve] ?? 0.8) * 100;
    const currentSleeveExp = sleeveExposure.get(c.sleeve) ?? 0;
    const sleeveBonus = calcSleeveBonus(c.sleeve, currentSleeveExp, sleeveCap);

    // Cluster crowding
    const currentClusterExp = clusterExposure.get(c.cluster) ?? 0;
    const clusterCap = caps.clusterCap * 100;
    const clusterPen = calcClusterPenalty(currentClusterExp, clusterCap);

    // Sector crowding
    const currentSectorExp = sectorExposure.get(c.sector) ?? 0;
    const sectorCap = caps.sectorCap * 100;
    const sectorPen = calcSectorPenalty(currentSectorExp, sectorCap);

    // Earnings
    // PRUNED (OVERLAP-03): Earnings penalty removed from allocation score.
    // NCS already includes an earnings penalty (0–20 pts) via computePenalties().
    // Allocation quality component uses NCS as input, so earnings is already reflected.
    // Keeping the field in the breakdown for transparency (always 0).
    const earningsPen = 0;

    // Correlation: count how many existing holdings are highly correlated
    const corrEntries = corrByTicker.get(c.ticker) ?? [];
    const correlatedHoldings = corrEntries
      .filter((e) => heldTickers.has(e.ticker))
      .map((e) => e.ticker);
    const corrPen = calcCorrelationPenalty(correlatedHoldings.length);

    // Capital inefficiency
    const riskToCapital = c.suggestedRiskGbp != null && c.suggestedCostGbp != null && c.suggestedCostGbp > 0
      ? c.suggestedRiskGbp / c.suggestedCostGbp
      : null;
    const capitalPen = calcCapitalInefficiency(riskToCapital, targetRiskPct);

    const allocationScore = Math.round(
      (quality + expectancy + sleeveBonus - clusterPen - sectorPen - earningsPen - corrPen - capitalPen) * 100
    ) / 100;

    return {
      ticker: c.ticker,
      allocationScore,
      rank: 0, // set after sort
      qualityComponent: quality,
      expectancyComponent: expectancy,
      sleeveBalanceBonus: sleeveBonus,
      clusterCrowdingPenalty: clusterPen,
      sectorCrowdingPenalty: sectorPen,
      earningsNearPenalty: earningsPen,
      correlationPenalty: corrPen,
      capitalInefficiencyPenalty: capitalPen,
      ncs: c.ncs,
      fws: c.fws,
      bqs: c.bqs,
      sleeve: c.sleeve,
      sector: c.sector,
      cluster: c.cluster,
      expectancyR,
      clusterExposurePct: currentClusterExp,
      sectorExposurePct: currentSectorExp,
      correlatedHoldings,
      riskToCapitalRatio: riskToCapital,
    };
  });

  // Sort by allocationScore descending
  scored.sort((a, b) => b.allocationScore - a.allocationScore);

  // Assign ranks
  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}
