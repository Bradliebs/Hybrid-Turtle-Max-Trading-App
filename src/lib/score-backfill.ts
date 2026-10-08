/**
 * DEPENDENCIES
 * Consumed by: src/cron/research-refresh.ts
 * Consumes: prisma.ts, dual-score.ts
 * Risk-sensitive: NO — analytics only, backfills score data
 * Last modified: 2026-03-06
 * Notes: Populates bqs/fws/ncs/dualScoreAction on CandidateOutcome rows
 *        by matching to ScoreBreakdown data: the latest score at or before the
 *        scan (no look-ahead), at most 2 days old. Until 2026-10-01 this used
 *        the latest score within ±2 days, so rows scored before then can carry
 *        scores computed after the scan.
 */
import prisma from './prisma';

/**
 * Derive actionNote classification from FWS and NCS values.
 * Mirrors dual-score.ts actionNote() logic exactly:
 *  - FWS > 65 → 'Auto-No (fragile)'
 *  - NCS >= 70 AND FWS <= 30 → 'Auto-Yes'
 *  - Otherwise → 'Conditional'
 */
export function classifyDualScoreAction(fws: number, ncs: number): string {
  if (fws > 65) return 'Auto-No';
  if (ncs >= 70 && fws <= 30) return 'Auto-Yes';
  return 'Conditional';
}

/** Scores older than this before the scan are not attributed to it. */
export const SCORE_MATCH_MAX_AGE_MS = 2 * 86_400_000;

/**
 * Point-in-time score match: the latest score taken AT OR BEFORE the scan,
 * no older than maxAgeMs. This is the score live grading could have seen.
 * A score taken after the scan is never used (that would be look-ahead).
 * `sortedAsc` must be ordered by scoredAt ascending.
 */
export function pickPrecedingScore<T extends { scoredAt: Date }>(
  sortedAsc: readonly T[],
  scanDate: Date,
  maxAgeMs = SCORE_MATCH_MAX_AGE_MS,
): T | null {
  const scanMs = scanDate.getTime();
  let lo = 0;
  let hi = sortedAsc.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid].scoredAt.getTime() <= scanMs) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (found < 0) return null;
  const candidate = sortedAsc[found];
  return scanMs - candidate.scoredAt.getTime() <= maxAgeMs ? candidate : null;
}

/**
 * Backfill BQS/FWS/NCS/dualScoreAction on CandidateOutcome rows
 * by joining to ScoreBreakdown data (ticker + point-in-time match).
 *
 * Only processes rows where bqs IS NULL (not yet populated). All such rows are
 * matched in memory each run, so rows without a usable score never block newer
 * rows (the previous fixed 500-row batch was starved by them).
 *
 * @returns count of rows updated
 */
export async function backfillScoresOnOutcomes(): Promise<{
  updated: number;
  skipped: number;
  errors: number;
}> {
  const outcomes = await prisma.candidateOutcome.findMany({
    where: { bqs: null },
    select: { id: true, ticker: true, scanDate: true },
  });
  if (outcomes.length === 0) return { updated: 0, skipped: 0, errors: 0 };

  const tickers = Array.from(new Set(outcomes.map(outcome => outcome.ticker)));
  const scores = await prisma.scoreBreakdown.findMany({
    where: { ticker: { in: tickers } },
    orderBy: { scoredAt: 'asc' },
    select: { ticker: true, scoredAt: true, bqsTotal: true, fwsTotal: true, ncsTotal: true },
  });
  const byTicker = new Map<string, typeof scores>();
  for (const score of scores) {
    const list = byTicker.get(score.ticker);
    if (list) list.push(score); else byTicker.set(score.ticker, [score]);
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const pending: Array<{ id: string; ticker: string; data: { bqs: number; fws: number; ncs: number; dualScoreAction: string } }> = [];
  for (const outcome of outcomes) {
    const match = pickPrecedingScore(byTicker.get(outcome.ticker) ?? [], outcome.scanDate);
    if (!match) { skipped++; continue; }
    pending.push({ id: outcome.id, ticker: outcome.ticker, data: {
      bqs: match.bqsTotal, fws: match.fwsTotal, ncs: match.ncsTotal,
      dualScoreAction: classifyDualScoreAction(match.fwsTotal, match.ncsTotal),
    } });
  }

  // Batched writes; `bqs: null` in the filter keeps the update idempotent if
  // another process scored the row in the meantime.
  for (let i = 0; i < pending.length; i += 200) {
    const batch = pending.slice(i, i + 200);
    try {
      const results = await prisma.$transaction(batch.map(row => prisma.candidateOutcome.updateMany({
        where: { id: row.id, bqs: null },
        data: row.data,
      })));
      updated += results.reduce((sum, result) => sum + result.count, 0);
    } catch (e) {
      console.error(`[ScoreBackfill] Batch failed (${batch[0].ticker}…):`, e);
      errors += batch.length;
    }
  }

  return { updated, skipped, errors };
}
