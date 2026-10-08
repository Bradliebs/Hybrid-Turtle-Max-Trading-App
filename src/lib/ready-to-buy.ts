/**
 * DEPENDENCIES
 * Consumed by: src/components/portfolio/ReadyToBuyPanel.tsx, src/components/portfolio/BuyConfirmationModal.tsx
 * Consumes: (pure functions — no imports)
 * Risk-sensitive: NO (display/filtering logic only — actual risk gates run server-side on POST /api/positions)
 * Last modified: 2026-02-28
 * Notes: Trigger-met detection mirrors cross-ref/route.ts line 365 logic exactly
 */

// ── Types ─────────────────────────────────────────────────────

/** Shape of a ticker from GET /api/scan/cross-ref response */
export interface CrossRefTicker {
  ticker: string;
  yahooTicker?: string;
  name: string;
  sleeve: string;
  // 7-Stage Scan data
  scanStatus: string | null;
  scanRankScore: number | null;
  scanPassesFilters: boolean | null;
  scanPassesRiskGates: boolean | null;
  scanPassesAntiChase: boolean | null;
  scanDistancePercent: number | null;
  scanEntryTrigger: number | null;
  scanStopPrice: number | null;
  scanPrice: number | null;
  scanShares: number | null;
  scanRiskDollars: number | null;
  // Dual Score data
  dualBQS: number | null;
  dualFWS: number | null;
  dualNCS: number | null;
  dualAction: string | null;
  dualStatus: string | null;
  dualClose: number | null;
  dualEntryTrigger: number | null;
  dualStopLevel: number | null;
  dualDistancePct: number | null;
  // Display currency
  priceCurrency: string;
  // Cross-reference classification
  matchType: 'BOTH_RECOMMEND' | 'SCAN_ONLY' | 'DUAL_ONLY' | 'BOTH_REJECT' | 'CONFLICT';
  agreementScore: number;
  // Breakout Probability Score (0–19)
  bps?: number | null;
  // Hurst Exponent from scan engine (0–1, >0.5 = trending)
  hurstExponent?: number | null;
  // ADX from scan engine (trend strength)
  scanAdx?: number | null;
}

/** Enriched candidate that has passed trigger-met detection */
export interface TriggerMetCandidate extends CrossRefTicker {
  /** Percentage the current price is above the entry trigger */
  aboveTriggerPct: number;
}

/** Minimal position shape for cluster warning checks */
export interface OpenPositionForCluster {
  ticker: string;
  cluster?: string;
  sleeve?: string;
}

/** Snapshot age analysis */
export interface SnapshotAge {
  /** Wall-clock hours since last snapshot */
  hours: number;
  /** >48 weekday hours — show amber warning */
  stale: boolean;
  /** >7 weekday days — show red warning, block buys */
  critical: boolean;
  /** Human-readable age description */
  label: string;
}

// ── Pure Functions ────────────────────────────────────────────

function getWeekdayHoursBetween(start: Date, end: Date): number {
  if (end.getTime() < start.getTime()) {
    return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  }

  let cursor = start.getTime();
  let elapsedMs = 0;
  while (cursor < end.getTime()) {
    const current = new Date(cursor);
    const nextUtcDay = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + 1
    );
    const boundary = Math.min(nextUtcDay, end.getTime());
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) {
      elapsedMs += boundary - cursor;
    }
    cursor = boundary;
  }

  return elapsedMs / (1000 * 60 * 60);
}

/**
 * Filter cross-ref tickers to only those whose current price >= entry trigger.
 * Mirrors the exact logic from cross-ref/route.ts:
 *   scanPrice != null && scanEntryTrigger != null && scanPrice >= scanEntryTrigger
 *
 * Sorts by NCS descending (best candidates first). Excludes AUTO_NO candidates.
 */
export function filterTriggerMet(tickers: CrossRefTicker[]): TriggerMetCandidate[] {
  const triggerMet: TriggerMetCandidate[] = [];

  for (const t of tickers) {
    if (t.scanPrice == null || t.scanEntryTrigger == null) continue;
    if (t.scanPrice < t.scanEntryTrigger) continue;
    // Exclude hard rejections — AUTO_NO means FWS > 65
    if (t.dualAction === 'Auto-No') continue;

    const aboveTriggerPct =
      t.scanEntryTrigger > 0
        ? ((t.scanPrice - t.scanEntryTrigger) / t.scanEntryTrigger) * 100
        : 0;

    triggerMet.push({ ...t, aboveTriggerPct });
  }

  // Sort by NCS descending (best quality first), then BPS as tiebreaker, then agreement score
  triggerMet.sort((a, b) => {
    const ncsA = a.dualNCS ?? 0;
    const ncsB = b.dualNCS ?? 0;
    if (ncsA !== ncsB) return ncsB - ncsA;
    // BPS tiebreaker — higher BPS = higher structural breakout probability
    const bpsA = a.bps ?? 0;
    const bpsB = b.bps ?? 0;
    if (bpsA !== bpsB) return bpsB - bpsA;
    return b.agreementScore - a.agreementScore;
  });

  return triggerMet;
}

/**
 * Calculate how old the snapshot data is and classify staleness.
 * Thresholds:
 *   - Fresh: < 48 weekday hours
 *   - Stale: 48h–7 weekday days (amber warning)
 *   - Critical: > 7 weekday days (red warning, discourage buying)
 * The displayed age remains wall-clock time.
 */
export function getSnapshotAge(cachedAt: string | null, now: Date = new Date()): SnapshotAge {
  if (!cachedAt) {
    return { hours: Infinity, stale: true, critical: true, label: 'No snapshot data' };
  }

  const cached = new Date(cachedAt);
  if (isNaN(cached.getTime())) {
    return { hours: Infinity, stale: true, critical: true, label: 'Invalid date' };
  }

  const hours = (now.getTime() - cached.getTime()) / (1000 * 60 * 60);
  const weekdayHours = getWeekdayHoursBetween(cached, now);
  const stale = weekdayHours > 48;
  const critical = weekdayHours > 168; // 7 weekdays

  let label: string;
  if (hours < 1) {
    label = 'Just now';
  } else if (hours < 24) {
    label = `${Math.round(hours)}h ago`;
  } else {
    const days = Math.round(hours / 24);
    label = `${days}d ago`;
  }

  return { hours, stale, critical, label };
}

/**
 * Check for cluster overlap between a candidate and currently open positions.
 * Returns warning strings for any matches found.
 */
export function getClusterWarnings(
  candidateTicker: string,
  candidateCluster: string | undefined,
  candidateSuperCluster: string | undefined,
  openPositions: OpenPositionForCluster[]
): string[] {
  const warnings: string[] = [];
  if (!candidateCluster && !candidateSuperCluster) return warnings;

  for (const pos of openPositions) {
    if (pos.ticker === candidateTicker) continue; // Skip self if already held

    if (candidateCluster && pos.cluster && pos.cluster === candidateCluster) {
      warnings.push(`Same cluster as ${pos.ticker} (${candidateCluster})`);
    }
  }

  return warnings;
}

/**
 * Determine buy button state based on day-of-week rules.
 *
 * | Day       | Phase       | Button State             |
 * |-----------|-------------|--------------------------|
 * | Sunday    | PLANNING    | disabled (grey)          |
 * | Mon–Fri   | EXECUTION   | enabled (green)          |
 * | Saturday  | MAINTENANCE | disabled (grey)          |
 */
export function getBuyButtonState(dayOfWeek: number): {
  enabled: boolean;
  color: 'green' | 'amber' | 'red' | 'grey';
  tooltip: string;
} {
  switch (dayOfWeek) {
    case 0: // Sunday
      return { enabled: false, color: 'grey', tooltip: 'Planning day — review only' };
    case 6: // Saturday
      return { enabled: false, color: 'grey', tooltip: 'Markets closed' };
    default: // Mon-Fri
      return { enabled: true, color: 'green', tooltip: 'Execution day — ready to trade' };
  }
}
