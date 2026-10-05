/**
 * DEPENDENCIES
 * Consumed by: src/app/api/scan/route.ts, src/cron/auto-trade.ts (per-candidate grading)
 * Consumes: ScoreBreakdown table (populated nightly by score-tracker.ts)
 * Risk-sensitive: NO — read-only lookup. Does not affect trade execution paths
 *                 directly; feeds the candidate-grade module.
 *
 * Resolves the latest BQS/FWS/NCS scores for a list of tickers from the
 * ScoreBreakdown table. The grading layer uses these to decide A/B/C grades.
 *
 * Without this lookup the grader receives null scores, which it correctly
 * treats as worst-case (NCS=0, FWS=100, BQS=0). That blocks every candidate
 * from reaching A_GRADE_BUY and prevents auto-trade from firing.
 */

import prisma from './prisma';

export interface CandidateScores {
  ncs: number;
  fws: number;
  bqs: number;
  scoredAt: Date;
}

/**
 * Look up the most recent ScoreBreakdown row for each ticker.
 * Returns a Map keyed by ticker for O(1) lookup during grading.
 *
 * If a ticker has no ScoreBreakdown rows, it is omitted from the map so
 * the caller can choose how to handle the absence (null context = worst
 * case in candidate-grade.ts).
 */
export async function getLatestScoresByTicker(
  tickers: string[],
): Promise<Map<string, CandidateScores>> {
  if (tickers.length === 0) return new Map();

  // Pull every relevant row once, then reduce to most-recent-per-ticker in JS.
  // SQLite has no efficient DISTINCT ON, and the candidate set is bounded
  // (typically <2000), so the cost of fetching ~3-7 rows per ticker and
  // reducing in memory is trivial.
  const rows = await prisma.scoreBreakdown.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, ncsTotal: true, fwsTotal: true, bqsTotal: true, scoredAt: true },
    orderBy: { scoredAt: 'desc' },
  });

  const result = new Map<string, CandidateScores>();
  for (const row of rows) {
    if (result.has(row.ticker)) continue; // first hit per ticker is the most recent
    result.set(row.ticker, {
      ncs: row.ncsTotal,
      fws: row.fwsTotal,
      bqs: row.bqsTotal,
      scoredAt: row.scoredAt,
    });
  }
  return result;
}

/**
 * Convenience: stale-tolerance check used by callers who want to detect
 * scores too old to trust. Returns true when the score is from a snapshot
 * older than maxAgeHours (default 36 — covers a missed nightly).
 */
export function isScoreStale(scores: CandidateScores | undefined, maxAgeHours = 36, nowMs = Date.now()): boolean {
  if (!scores) return true;
  const scoredMs = scores.scoredAt instanceof Date ? scores.scoredAt.getTime() : NaN;
  if (!Number.isFinite(scoredMs)) return true; // unknown age is treated as stale (blocks A-grade)
  const ageHours = (nowMs - scoredMs) / (1000 * 60 * 60);
  return ageHours > maxAgeHours;
}
