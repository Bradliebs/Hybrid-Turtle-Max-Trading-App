/**
 * DEPENDENCIES
 * Consumed by: nightly.ts, /api/nightly/route.ts, /api/modules/route.ts; the flag it
 *              sets is acted on by failed-breakout-exit.ts (auto-trade sells)
 * Consumes: (standalone — no imports)
 * Risk-sensitive: YES (since 2026-10-08) — its flag now triggers an automatic sell
 *                 of auto-trade positions at the next session
 * Last modified: 2026-10-08
 * Notes: Detects failed breakouts where price closes back below the entry trigger
 *        within 5 days of entry. This is a fast-exit recommendation to reduce
 *        slow-bleed losses on positions that never followed through.
 */

// ── Configuration ──────────────────────────────────────────────────

export const BREAKOUT_FAILURE_CONFIG = {
  /** Max days after entry for the check to apply */
  maxDaysHeld: 5,
  /** R-multiple ceiling — above this the breakout is "working", skip the check */
  maxRMultiple: 0.5,
} as const;

// ── Types ──────────────────────────────────────────────────────────

export interface BreakoutFailureInput {
  id: string;
  ticker: string;
  entryPrice: number;
  entryDate: Date;
  /** 20-day high trigger price at time of entry (Donchian + ATR buffer).
   *  If null/undefined (legacy positions), falls back to entryPrice. */
  entryTrigger: number | null;
  initialRisk: number;
  currentPrice: number;
  shares: number;
  currency: string;
  /** True if this position was already flagged (breakoutFailureDetectedAt is set) */
  alreadyFlagged: boolean;
}

export interface BreakoutFailureResult {
  positionId: string;
  ticker: string;
  daysHeld: number;
  rMultiple: number;
  entryTrigger: number;
  currentPrice: number;
  /** Estimated loss in position currency (negative = loss) */
  estimatedLoss: number;
  currency: string;
  reason: string;
}

// ── Detection Logic ────────────────────────────────────────────────

/**
 * Detect breakout failure positions.
 *
 * A breakout failure is defined as:
 *   - daysHeld <= 5  (early in the trade)
 *   - currentPrice < entryTrigger  (price closed back below breakout level)
 *   - rMultiple < 0.5  (not yet working — rules out healthy pullbacks)
 *
 * Returns only NEW failures (positions not already flagged).
 * Once flagged, the position keeps the flag permanently.
 */
export function detectBreakoutFailures(
  positions: BreakoutFailureInput[]
): BreakoutFailureResult[] {
  const now = new Date();
  const results: BreakoutFailureResult[] = [];

  for (const pos of positions) {
    // Skip positions already flagged — once detected, stays logged
    if (pos.alreadyFlagged) continue;

    // Guard: need valid prices to evaluate
    if (!pos.currentPrice || pos.currentPrice <= 0) continue;
    if (!pos.entryPrice || pos.entryPrice <= 0) continue;

    // Use entryTrigger if available, otherwise fall back to entryPrice
    // (conservative: for legacy positions without trigger, checks if price < fill)
    const triggerPrice = pos.entryTrigger && pos.entryTrigger > 0
      ? pos.entryTrigger
      : pos.entryPrice;

    // Calculate days held
    const daysHeld = Math.floor(
      (now.getTime() - new Date(pos.entryDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    // Must be within the early window (≤5 days)
    if (daysHeld > BREAKOUT_FAILURE_CONFIG.maxDaysHeld) continue;

    // Calculate R-multiple: (currentPrice - entryPrice) / initialRisk
    const rMultiple = pos.initialRisk > 0
      ? (pos.currentPrice - pos.entryPrice) / pos.initialRisk
      : 0;

    // If the trade is working (R >= 0.5), it's a healthy pullback, not a failure
    if (rMultiple >= BREAKOUT_FAILURE_CONFIG.maxRMultiple) continue;

    // Core check: price has closed back below the breakout trigger
    if (pos.currentPrice >= triggerPrice) continue;

    // This is a breakout failure — compute estimated loss
    const estimatedLoss = (pos.currentPrice - pos.entryPrice) * pos.shares;

    results.push({
      positionId: pos.id,
      ticker: pos.ticker,
      daysHeld,
      rMultiple,
      entryTrigger: triggerPrice,
      currentPrice: pos.currentPrice,
      estimatedLoss,
      currency: pos.currency,
      reason: `Price closed below entry trigger (${triggerPrice.toFixed(2)}) after ${daysHeld} day${daysHeld !== 1 ? 's' : ''} — breakout has failed`,
    });
  }

  return results;
}
