/**
 * DEPENDENCIES
 * Consumed by: /api/performance/scoreboard/route.ts, weekly review
 * Consumes: prisma.ts
 * Risk-sensitive: NO — read-only analytics
 * Notes: R-based performance metrics + system grade with sample-size warnings.
 *        Serves Job 8 (weekly review checks performance and drift).
 */

import prisma from './prisma';
import { computeCapitalAdjustedDrawdown, fromFirstBrokerSnapshot, loadCapitalEvents } from './capital-adjusted-drawdown';
import { overlapAdjustedMeanConfidenceInterval, type ConfidenceInterval } from './statistics';

// ── System Grade ─────────────────────────────────────────────

export type EvidenceVerdict = 'INCONCLUSIVE' | 'PROMISING' | 'SUPPORTED' | 'DEGRADING';

export interface ProfitScoreboard {
  // Core R metrics
  totalClosedPositions: number;  // All closed positions (including those without R data)
  totalClosedTrades: number;     // Only positions with realisedPnlR data
  distinctOutcomeDays: number;
  totalRealisedR: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyPerTrade: number;
  expectancyPerOutcomeDay: number;
  profitFactor: number | null;

  // Drawdown
  maxDrawdownPct: number;
  currentDrawdownPct: number;

  // Hold time
  avgHoldDays: number | null;
  medianHoldDays: number | null;

  // Evidence verdict
  verdict: EvidenceVerdict;
  verdictReason: string;
  expectancyInterval: ConfidenceInterval | null;

  // Sample-size warning
  sampleSizeWarning: string | null;

  // Review milestones
  nextMilestone: number | null; // 30, 50, 100
  milestonePassed: number[];
}

export async function computeProfitScoreboard(userId: string = 'default-user'): Promise<ProfitScoreboard> {
  const closedPositions = await prisma.position.findMany({
    where: { userId, status: 'CLOSED' },
    orderBy: { entryDate: 'asc' },
    select: {
      realisedPnlR: true,
      entryDate: true,
      exitDate: true,
    },
  });

  const totalClosedPositions = closedPositions.length;
  const tradesWithRData = closedPositions.filter(p => p.realisedPnlR != null);
  const totalClosedTrades = tradesWithRData.length;

  // R metrics (computed only from trades with R data)
  const rValues = tradesWithRData.map(p => p.realisedPnlR!);
  const totalRealisedR = rValues.reduce((s, r) => s + r, 0);
  const wins = rValues.filter(r => r > 0);
  const losses = rValues.filter(r => r <= 0);
  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = totalClosedTrades > 0 ? winCount / totalClosedTrades : 0;
  const avgWinR = wins.length > 0 ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, r) => s + r, 0) / losses.length : 0;
  const expectancyPerTrade = totalClosedTrades > 0 ? totalRealisedR / totalClosedTrades : 0;
  const grossWins = wins.reduce((s, r) => s + r, 0);
  const grossLosses = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;
  const outcomesByEntryDay = new Map<string, number[]>();
  for (const trade of tradesWithRData) {
    const day = trade.entryDate.toISOString().slice(0, 10);
    const outcomes = outcomesByEntryDay.get(day) ?? [];
    outcomes.push(trade.realisedPnlR!);
    outcomesByEntryDay.set(day, outcomes);
  }
  const dailyMeanR = [...outcomesByEntryDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, outcomes]) =>
    outcomes.reduce((sum, outcome) => sum + outcome, 0) / outcomes.length);
  const distinctOutcomeDays = dailyMeanR.length;
  const averageDailyR = distinctOutcomeDays > 0
    ? dailyMeanR.reduce((sum, outcome) => sum + outcome, 0) / distinctOutcomeDays
    : 0;

  // Hold time
  const holdDays = tradesWithRData
    .filter(p => p.exitDate && p.entryDate)
    .map(p => Math.floor((p.exitDate!.getTime() - p.entryDate.getTime()) / 86400000));
  const avgHoldDays = holdDays.length > 0 ? holdDays.reduce((s, d) => s + d, 0) / holdDays.length : null;
  const sortedDays = [...holdDays].sort((a, b) => a - b);
  const medianHoldDays = sortedDays.length > 0 ? sortedDays[Math.floor(sortedDays.length / 2)] : null;

  // Drawdown from equity snapshots, capital-adjusted so withdrawals are not losses
  const [snapshots, capitalEvents] = await Promise.all([
    prisma.equitySnapshot.findMany({
      orderBy: { capturedAt: 'asc' },
      select: { equity: true, capturedAt: true, source: true },
    }),
    loadCapitalEvents(),
  ]);
  const { maxDrawdownPct, currentDrawdownPct } = computeCapitalAdjustedDrawdown(fromFirstBrokerSnapshot(snapshots), capitalEvents);

  const expectancyInterval = overlapAdjustedMeanConfidenceInterval(dailyMeanR, 20);
  const { verdict, verdictReason } = computeEvidenceVerdict(
    distinctOutcomeDays,
    averageDailyR,
    expectancyInterval,
    maxDrawdownPct,
    'distinct entry days',
  );

  // Sample-size warning
  let sampleSizeWarning: string | null = null;
  if (totalClosedPositions > totalClosedTrades) {
    sampleSizeWarning = `⚠ ${totalClosedPositions - totalClosedTrades} closed position(s) missing R data — metrics based on ${totalClosedTrades} trades only.`;
  } else if (distinctOutcomeDays < 30) {
    sampleSizeWarning = `⚠ Only ${distinctOutcomeDays} distinct entry days. Need ≥30 for reliable conclusions.`;
  } else if (distinctOutcomeDays < 50) {
    sampleSizeWarning = `⚠ ${distinctOutcomeDays} distinct entry days — preliminary data. Need ≥50 for moderate confidence.`;
  }

  // Milestones
  const milestones = [30, 50, 100];
  const milestonePassed = milestones.filter(m => totalClosedTrades >= m);
  const nextMilestone = milestones.find(m => totalClosedTrades < m) ?? null;

  return {
    totalClosedPositions,
    totalClosedTrades,
    distinctOutcomeDays,
    totalRealisedR,
    winCount,
    lossCount,
    winRate,
    avgWinR,
    avgLossR,
    expectancyPerTrade,
    expectancyPerOutcomeDay: averageDailyR,
    profitFactor,
    maxDrawdownPct,
    currentDrawdownPct,
    avgHoldDays,
    medianHoldDays,
    verdict,
    verdictReason,
    expectancyInterval,
    sampleSizeWarning,
    nextMilestone,
    milestonePassed,
  };
}

export function computeEvidenceVerdict(
  observations: number,
  expectancy: number,
  interval: ConfidenceInterval | null,
  maxDrawdown: number,
  observationLabel = 'closed trades',
): { verdict: EvidenceVerdict; verdictReason: string } {
  if (observations < 30 || !interval) {
    return {
      verdict: 'INCONCLUSIVE',
      verdictReason: `Only ${observations} ${observationLabel}. At least 30 are required before interpreting expectancy.`,
    };
  }

  if (interval.upper < 0 || maxDrawdown > 20) {
    return {
      verdict: 'DEGRADING',
      verdictReason: `Negative evidence: ${expectancy.toFixed(2)}R expectancy (95% CI ${interval.lower.toFixed(2)} to ${interval.upper.toFixed(2)}R), ${maxDrawdown.toFixed(1)}% max drawdown.`,
    };
  }

  if (interval.lower > 0 && maxDrawdown < 15) {
    return {
      verdict: 'SUPPORTED',
      verdictReason: `Positive expectancy is supported: ${expectancy.toFixed(2)}R (95% CI ${interval.lower.toFixed(2)} to ${interval.upper.toFixed(2)}R).`,
    };
  }

  if (expectancy > 0) {
    return {
      verdict: 'PROMISING',
      verdictReason: `Positive point estimate, but uncertainty includes no edge: ${expectancy.toFixed(2)}R (95% CI ${interval.lower.toFixed(2)} to ${interval.upper.toFixed(2)}R).`,
    };
  }

  return {
    verdict: 'INCONCLUSIVE',
    verdictReason: `Expectancy remains uncertain: ${expectancy.toFixed(2)}R (95% CI ${interval.lower.toFixed(2)} to ${interval.upper.toFixed(2)}R).`,
  };
}
