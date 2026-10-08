/**
 * DEPENDENCIES
 * Consumed by: packages/backtest/src/index.ts, scripts/verify-phase11.ts
 * Consumes: packages/data/src/prisma.ts, src/lib/dual-score.ts, src/lib/breakout-probability.ts
 * Risk-sensitive: NO
 * Last modified: 2026-03-09
 * Notes: Phase 11 shared backtest runner over historical snapshot data. Reuses the live scoring stack and monotonic stop simulation, then persists stored run results for UI/API access.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, round } from '../../data/src/prisma';
import { computeAtr } from '../../signals/src/math';
import { scoreRow, type SnapshotRow } from '../../../src/lib/dual-score';
import { calcBPSFromSnapshot, computeRsPercentiles } from '../../../src/lib/breakout-probability';
import { overlapAdjustedMeanConfidenceInterval } from '../../../src/lib/statistics';
import { toYahooTicker } from '../../../src/lib/ticker-maps';
import { ATR_TRAILING_MULTIPLIER } from '../../../src/types';
import type {
  BacktestConfidenceInterval,
  BacktestEvidenceVerdict,
  BacktestCurvePoint,
  BacktestMode,
  BacktestRequest,
  BacktestResult,
  BacktestSummary,
  BacktestTrade,
  BacktestValidity,
  StoredBacktestRun,
} from './types';

const DEFAULT_INITIAL_CAPITAL = 10_000;
const DEFAULT_RISK_PER_TRADE_PCT = 2;
const DEFAULT_MAX_POSITIONS = 4;
const DEFAULT_EXECUTION_COST_PCT_PER_SIDE = 0;
const LOOKBACK_BUFFER_DAYS = 10;
const LOOKAHEAD_BUFFER_DAYS = 45;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isSameUtcDay(left: Date, right: Date): boolean {
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate();
}

function exitsBeforeSignalDay(exitDate: string, signalDate: string): boolean {
  return exitDate.slice(0, 10) < signalDate.slice(0, 10);
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

function decimalOrNull(value: number | null | undefined): number | null {
  return value == null ? null : value;
}

type FxBar = { date: Date; close: number };

export function resolveHistoricalFxToGbp(
  currency: string | null | undefined,
  ticker: string,
  at: Date,
  barsBySymbol: Map<string, FxBar[]>,
): number | null {
  if (toYahooTicker(ticker).endsWith('.L')) return 0.01;
  const normalized = currency === 'GBp' ? 'GBX' : currency?.trim().toUpperCase();
  if (normalized === 'GBP') return 1;
  if (normalized === 'GBX') return 0.01;
  if (!normalized) return null;
  const targetDay = at.toISOString().slice(0, 10);
  const bars = barsBySymbol.get(`${normalized}GBP=X`) ?? [];
  let rate: number | null = null;
  for (const bar of bars) {
    if (bar.date.toISOString().slice(0, 10) >= targetDay) break;
    if (Number.isFinite(bar.close) && bar.close > 0) rate = bar.close;
  }
  return rate;
}

const snapshotRowSchema = z.object({
  ticker: z.string(),
  name: z.string().default(''),
  sleeve: z.string().default(''),
  status: z.string().default(''),
  currency: z.string().nullish().transform((value) => value ?? ''),
  close: z.number().default(0),
  atr14: z.number().default(0),
  atrPct: z.number().default(0),
  adx14: z.number().default(0),
  plusDi: z.number().default(0),
  minusDi: z.number().default(0),
  volRatio: z.number().default(1),
  dollarVol20: z.number().default(0),
  liquidityOk: z.boolean().default(true),
  marketRegime: z.string().default('NEUTRAL'),
  marketRegimeStable: z.boolean().default(true),
  high20: z.number().default(0),
  high55: z.number().default(0),
  distanceTo20dHighPct: z.number().default(0),
  distanceTo55dHighPct: z.number().default(0),
  entryTrigger: z.number().default(0),
  stopLevel: z.number().default(0),
  chasing20Last5: z.boolean().default(false),
  chasing55Last5: z.boolean().default(false),
  atrSpiking: z.boolean().default(false),
  atrCollapsing: z.boolean().default(false),
  atrCompressionRatio: z.number().nullable().default(null),
  rsVsBenchmarkPct: z.number().default(0),
  daysToEarnings: z.number().nullable().default(null),
  earningsInNext5d: z.boolean().default(false),
  clusterName: z.string().default(''),
  superClusterName: z.string().default(''),
  clusterExposurePct: z.number().default(0),
  superClusterExposurePct: z.number().default(0),
  maxClusterPct: z.number().default(0),
  maxSuperClusterPct: z.number().default(0),
  weeklyAdx: z.number().default(0),
  volRegime: z.string().default('NORMAL_VOL'),
  dualRegimeAligned: z.boolean().default(true),
  bisScore: z.number().default(0),
});

function toSnapshotRow(row: Record<string, unknown>): SnapshotRow {
  const parsed = snapshotRowSchema.parse(row);
  return {
    ticker: parsed.ticker,
    name: parsed.name || parsed.ticker,
    sleeve: parsed.sleeve,
    status: parsed.status,
    currency: parsed.currency,
    close: parsed.close,
    atr_14: parsed.atr14,
    atr_pct: parsed.atrPct,
    adx_14: parsed.adx14,
    plus_di: parsed.plusDi,
    minus_di: parsed.minusDi,
    vol_ratio: parsed.volRatio,
    dollar_vol_20: parsed.dollarVol20,
    liquidity_ok: parsed.liquidityOk,
    market_regime: parsed.marketRegime,
    market_regime_stable: parsed.marketRegimeStable,
    high_20: parsed.high20,
    high_55: parsed.high55,
    distance_to_20d_high_pct: parsed.distanceTo20dHighPct,
    distance_to_55d_high_pct: parsed.distanceTo55dHighPct,
    entry_trigger: parsed.entryTrigger,
    stop_level: parsed.stopLevel,
    chasing_20_last5: parsed.chasing20Last5,
    chasing_55_last5: parsed.chasing55Last5,
    atr_spiking: parsed.atrSpiking,
    atr_collapsing: parsed.atrCollapsing,
    atr_compression_ratio: parsed.atrCompressionRatio,
    rs_vs_benchmark_pct: parsed.rsVsBenchmarkPct,
    days_to_earnings: parsed.daysToEarnings,
    earnings_in_next_5d: parsed.earningsInNext5d,
    cluster_name: parsed.clusterName,
    super_cluster_name: parsed.superClusterName,
    cluster_exposure_pct: parsed.clusterExposurePct,
    super_cluster_exposure_pct: parsed.superClusterExposurePct,
    max_cluster_pct: parsed.maxClusterPct,
    max_super_cluster_pct: parsed.maxSuperClusterPct,
    weekly_adx: parsed.weeklyAdx,
    vol_regime: parsed.volRegime,
    dual_regime_aligned: parsed.dualRegimeAligned,
    bis_score: parsed.bisScore,
  };
}

/** @internal Exported for testing — simulates the stop ladder for a position */
export function simulateStopLadder(
  entryPrice: number,
  initialStop: number,
  forwardCloses: Array<{ date: string; open?: number; close: number; low?: number; atr14: number }>,
  timeExitDate?: string,
): { hit: boolean; hitDate: string | null; hitR: number | null; maxFavR: number; maxAdvR: number } {
  const riskPerShare = entryPrice - initialStop;
  if (riskPerShare <= 0) {
    return { hit: false, hitDate: null, hitR: null, maxFavR: 0, maxAdvR: 0 };
  }

  let currentStop = initialStop;
  let maxFavR = 0;
  let maxAdvR = 0;

  for (const snap of forwardCloses) {
    if (timeExitDate && new Date(snap.date).getTime() > new Date(timeExitDate).getTime()) break;
    const openingPrice = snap.open != null && Number.isFinite(snap.open) && snap.open > 0
      ? snap.open : null;
    if ((openingPrice != null && openingPrice <= currentStop)
      || (snap.low ?? snap.close) <= currentStop) {
      const fillPrice = openingPrice == null ? currentStop : Math.min(currentStop, openingPrice);
      const hitR = (fillPrice - entryPrice) / riskPerShare;
      return {
        hit: true,
        hitDate: snap.date,
        hitR,
        maxFavR: Math.max(maxFavR, hitR),
        maxAdvR: Math.min(maxAdvR, hitR),
      };
    }

    const rMultiple = (snap.close - entryPrice) / riskPerShare;
    maxFavR = Math.max(maxFavR, rMultiple);
    maxAdvR = Math.min(maxAdvR, rMultiple);

    if (rMultiple >= 3.0) {
      currentStop = Math.max(currentStop, Math.max(entryPrice + riskPerShare, snap.close - ATR_TRAILING_MULTIPLIER * snap.atr14));
    } else if (rMultiple >= 2.5) {
      currentStop = Math.max(currentStop, entryPrice + 0.5 * riskPerShare);
    } else if (rMultiple >= 1.5) {
      currentStop = Math.max(currentStop, entryPrice);
    }
  }

  return { hit: false, hitDate: null, hitR: null, maxFavR, maxAdvR };
}

type DailyOutcomeBar = {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | bigint;
};

/** @internal Exported for testing - converts OHLC history into post-signal stop inputs. */
export function buildDailyOutcomeSeries(
  bars: DailyOutcomeBar[],
  signalDate: Date,
  fallbackAtr14: number,
) {
  return bars.flatMap((bar, index) => {
    if (bar.date <= signalDate) {
      return [];
    }
    const atrWindow = bars.slice(Math.max(0, index - 14), index + 1).map((windowBar) => ({
      date: windowBar.date,
      open: windowBar.open,
      high: windowBar.high,
      low: windowBar.low,
      close: windowBar.close,
      volume: 0,
    }));
    const atr14 = computeAtr(atrWindow, 14) || fallbackAtr14;
    return [{
      date: bar.date.toISOString(),
      open: bar.open,
      close: bar.close,
      low: bar.low,
      atr14,
    }];
  });
}

function findForwardReturn(
  forwardSnaps: Array<{ date: string; close: number }>,
  signalDate: Date,
  targetDays: number,
  riskPerShare: number,
  entryPrice: number,
): { date: string; close: number; rMultiple: number; daysDelta: number } | null {
  if (forwardSnaps.length === 0 || riskPerShare <= 0) {
    return null;
  }

  let best: { snap: { date: string; close: number }; daysDelta: number } | null = null;
  const tolerance = Math.max(3, targetDays * 0.4);

  for (const snap of forwardSnaps) {
    const snapDate = new Date(snap.date);
    const daysDelta = daysBetween(signalDate, snapDate);
    const diff = Math.abs(daysDelta - targetDays);
    if (diff <= tolerance && (!best || diff < Math.abs(best.daysDelta - targetDays))) {
      best = { snap, daysDelta };
    }
  }

  if (!best) {
    return null;
  }

  return {
    date: best.snap.date,
    close: best.snap.close,
    rMultiple: round((best.snap.close - entryPrice) / riskPerShare),
    daysDelta: best.daysDelta,
  };
}

export function isCompleteBacktestTrade(
  trade: BacktestTrade,
): trade is BacktestTrade & { realizedR: number } {
  return trade.realizedR != null
    && (trade.exitReason === 'STOP_HIT' || trade.exitReason === 'TIME_EXIT_20D');
}

export function classifyBacktestValidity(
  completedTrades: number,
  maxPositions = DEFAULT_MAX_POSITIONS,
  executionCostPctPerSide = DEFAULT_EXECUTION_COST_PCT_PER_SIDE,
): {
  validity: BacktestValidity;
  validityReasons: string[];
} {
  const modelLimitations = [
    'Signals and entries come from timestamped snapshots; stop hits use daily lows and fill at the worse of the active stop and valid session open, before scenario costs.',
    'Missing session opens fall back to stop-price fills; liquidity, intraday gaps and bid/ask execution are not reconstructed.',
    'Favorable/adverse excursions use pre-exit daily closes and the exit fill, not full intraday extrema.',
    'The time exit uses the available close nearest 20 calendar days within an 8-day tolerance, not 20 trading sessions.',
    'Trailing stops update from daily closes, so intraday price ordering within a session is not simulated.',
    'Same-date exits do not release cash or position slots until the next UTC date because daily bars do not establish intraday ordering.',
    `Concurrent entries are limited to ${maxPositions} positions and same-snapshot collisions are ranked by NCS.`,
    `${executionCostPctPerSide.toFixed(2)}% adverse execution cost per side is applied as a user-defined scenario, not an observed estimate.`,
    'Whole-share sizing uses historical entry FX; cash is reserved at entry and released from converted exit proceeds.',
    'Trades with missing currency or historical FX are rejected rather than assigned a fallback rate.',
  ];
  if (completedTrades === 0) {
    return {
      validity: 'INVALID_FOR_PERFORMANCE_CLAIMS',
      validityReasons: ['No trades have a complete 20-day or stop-hit outcome.', ...modelLimitations],
    };
  }
  return { validity: 'PARTIAL', validityReasons: modelLimitations };
}

function computeOutcomeEvidence(completed: Array<BacktestTrade & { realizedR: number }>): {
  distinctOutcomeDays: number;
  dailyMeanR: number | null;
  dailyWinRate: number | null;
  averageRInterval: BacktestConfidenceInterval | null;
  winRateInterval: BacktestConfidenceInterval | null;
  evidenceVerdict: BacktestEvidenceVerdict;
  evidenceVerdictReason: string;
} {
  const outcomesByDay = new Map<string, number[]>();
  for (const trade of completed) {
    const day = trade.signalDate.slice(0, 10);
    const outcomes = outcomesByDay.get(day) ?? [];
    outcomes.push(trade.realizedR);
    outcomesByDay.set(day, outcomes);
  }

  const orderedOutcomes = [...outcomesByDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, outcomes]) => outcomes);
  const dailyMeanR = orderedOutcomes.map((outcomes) =>
    outcomes.reduce((sum, outcome) => sum + outcome, 0) / outcomes.length);
  const dailyWinRates = orderedOutcomes.map((outcomes) =>
    (outcomes.filter((outcome) => outcome > 0).length / outcomes.length) * 100);
  const averageRInterval = overlapAdjustedMeanConfidenceInterval(dailyMeanR, 20);
  const winRateInterval = overlapAdjustedMeanConfidenceInterval(dailyWinRates, 20);
  const distinctOutcomeDays = outcomesByDay.size;
  const averageDailyR = dailyMeanR.length > 0
    ? dailyMeanR.reduce((sum, outcome) => sum + outcome, 0) / dailyMeanR.length
    : 0;
  const averageDailyWinRate = dailyWinRates.length > 0
    ? dailyWinRates.reduce((sum, rate) => sum + rate, 0) / dailyWinRates.length
    : null;
  const shared = {
    distinctOutcomeDays,
    dailyMeanR: dailyMeanR.length > 0 ? round(averageDailyR) : null,
    dailyWinRate: averageDailyWinRate == null ? null : round(averageDailyWinRate),
    averageRInterval,
    winRateInterval,
  };

  if (distinctOutcomeDays < 30 || !averageRInterval) {
    return {
      ...shared,
      evidenceVerdict: 'INCONCLUSIVE',
      evidenceVerdictReason: `Only ${distinctOutcomeDays} distinct signal days have complete outcomes; at least 30 are required.`,
    };
  }
  if (averageRInterval.upper < 0) {
    return {
      ...shared,
      evidenceVerdict: 'DEGRADING',
      evidenceVerdictReason: `Daily mean outcome is ${averageDailyR.toFixed(2)}R (95% CI ${averageRInterval.lower.toFixed(2)} to ${averageRInterval.upper.toFixed(2)}R).`,
    };
  }
  if (averageRInterval.lower > 0) {
    return {
      ...shared,
      evidenceVerdict: 'SUPPORTED',
      evidenceVerdictReason: `Daily mean outcome is ${averageDailyR.toFixed(2)}R (95% CI ${averageRInterval.lower.toFixed(2)} to ${averageRInterval.upper.toFixed(2)}R).`,
    };
  }
  return {
    ...shared,
    evidenceVerdict: averageDailyR > 0 ? 'PROMISING' : 'INCONCLUSIVE',
    evidenceVerdictReason: `Daily mean outcome is ${averageDailyR.toFixed(2)}R; uncertainty includes no edge (95% CI ${averageRInterval.lower.toFixed(2)} to ${averageRInterval.upper.toFixed(2)}R).`,
  };
}

export function buildSummary(
  mode: BacktestMode,
  startDate: Date,
  endDate: Date,
  replayDate: Date | null,
  initialCapital: number,
  riskPerTradePct: number,
  snapshotCount: number,
  trades: BacktestTrade[],
  equityCurve: BacktestCurvePoint[],
  maxPositions = DEFAULT_MAX_POSITIONS,
  executionCostPctPerSide = DEFAULT_EXECUTION_COST_PCT_PER_SIDE,
  cashSimulation?: ReturnType<typeof simulateCashConstrainedPortfolio>,
): BacktestSummary {
  const completed = trades.filter(isCompleteBacktestTrade);
  const incompleteTrades = trades.length - completed.length;
  const { validity, validityReasons } = classifyBacktestValidity(completed.length, maxPositions, executionCostPctPerSide);
  const outcomeEvidence = computeOutcomeEvidence(completed);
  const portfolioSimulation = cashSimulation ?? simulateCashConstrainedPortfolio(
    trades,
    initialCapital,
    riskPerTradePct,
    executionCostPctPerSide,
    maxPositions,
  );
  const completedSlotEligible = portfolioSimulation.slotEligible.filter(isCompleteBacktestTrade);
  const slotGrossR = completedSlotEligible.map((trade) => trade.realizedR);
  const slotNetR = completedSlotEligible.map((trade) => applyExecutionCostScenario(trade, executionCostPctPerSide));
  const slotEligibleGrossAverageR = slotGrossR.length > 0
    ? round(slotGrossR.reduce((sum, value) => sum + value, 0) / slotGrossR.length)
    : null;
  const slotEligibleNetAverageR = slotNetR.length > 0
    ? round(slotNetR.reduce((sum, value) => sum + value, 0) / slotNetR.length)
    : null;
  const averageFundedPositionValueGbp = portfolioSimulation.funded.length > 0
    ? round(portfolioSimulation.funded.reduce((sum, position) => sum + position.positionValue, 0) / portfolioSimulation.funded.length)
    : null;
  const averageFundedRiskAmountGbp = portfolioSimulation.funded.length > 0
    ? round(portfolioSimulation.funded.reduce((sum, position) => sum + position.riskAmount, 0) / portfolioSimulation.funded.length)
    : null;
  const winners = completed.filter((trade) => (trade.realizedR ?? 0) > 0);
  const losers = completed.filter((trade) => (trade.realizedR ?? 0) < 0);
  const winSum = winners.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0);
  const lossSumAbs = Math.abs(losers.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0));
  const averageR = completed.length > 0
    ? round(completed.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / completed.length)
    : null;
  const averageWinR = winners.length > 0 ? round(winSum / winners.length) : null;
  const averageLossR = losers.length > 0
    ? round(losers.reduce((sum, trade) => sum + (trade.realizedR ?? 0), 0) / losers.length)
    : null;
  const portfolioMetricsAvailable = validity === 'VALID';
  const endingCapital = portfolioMetricsAvailable
    ? equityCurve[equityCurve.length - 1]?.equity ?? initialCapital
    : null;
  const totalReturnPct = portfolioMetricsAvailable && endingCapital != null
    ? round(((endingCapital - initialCapital) / initialCapital) * 100)
    : null;
  const maxDrawdownPct = portfolioMetricsAvailable && equityCurve.length > 0
    ? round(Math.max(...equityCurve.map((point) => point.drawdownPct)))
    : null;
  const stopsHit = trades.filter((trade) => trade.stopHit).length;
  const averageHoldingDays = completed.length > 0
    ? round(completed.reduce((sum, trade) => sum + (trade.daysHeld ?? 0), 0) / completed.length)
    : null;

  return {
    validity,
    validityReasons,
    mode,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    replayDate: replayDate?.toISOString() ?? null,
    initialCapital: round(initialCapital),
    endingCapital: endingCapital == null ? null : round(endingCapital),
    riskPerTradePct: round(riskPerTradePct),
    maxPositions,
    executionCostPctPerSide: round(executionCostPctPerSide),
    snapshotCount,
    signalCount: trades.length,
    completedTrades: completed.length,
    incompleteTrades,
    slotEligibleTrades: portfolioSimulation.slotEligible.length,
    positionLimitRejectedTrades: portfolioSimulation.positionRejected,
    cashFundedTrades: portfolioSimulation.funded.length,
    cashRejectedTrades: portfolioSimulation.cashRejected,
    fxRejectedTrades: portfolioSimulation.fxRejected,
    averageFundedPositionValueGbp,
    averageFundedRiskAmountGbp,
    slotEligibleGrossAverageR,
    slotEligibleNetAverageR,
    executionCostDragR: slotEligibleGrossAverageR != null && slotEligibleNetAverageR != null
      ? round(slotEligibleGrossAverageR - slotEligibleNetAverageR)
      : null,
    ...outcomeEvidence,
    winRate: completed.length > 0 ? round((winners.length / completed.length) * 100) : null,
    averageR,
    averageWinR,
    averageLossR,
    expectancyR: averageR,
    profitFactor: lossSumAbs > 0 ? round(winSum / lossSumAbs) : null,
    totalReturnPct,
    maxDrawdownPct,
    averageHoldingDays,
    stopsHit,
    stopsHitPct: trades.length > 0 ? round((stopsHit / trades.length) * 100) : null,
  };
}

function mapStoredRun(row: {
  id: string;
  status: string;
  requestedAt: Date;
  finishedAt: Date | null;
  filtersJson: Prisma.JsonValue | null;
  summaryJson: Prisma.JsonValue | null;
  tradesJson: Prisma.JsonValue | null;
  equityCurveJson: Prisma.JsonValue | null;
  drawdownCurveJson: Prisma.JsonValue | null;
  errorMessage: string | null;
}): StoredBacktestRun {
  return {
    id: row.id,
    status: row.status as StoredBacktestRun['status'],
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    filters: (row.filtersJson as unknown as StoredBacktestRun['filters'] | null) ?? { ticker: null, sleeve: null, regime: null },
    summary: row.summaryJson as unknown as BacktestSummary,
    trades: (row.tradesJson as unknown as BacktestTrade[]) ?? [],
    equityCurve: (row.equityCurveJson as unknown as BacktestCurvePoint[]) ?? [],
    drawdownCurve: (row.drawdownCurveJson as unknown as BacktestCurvePoint[]) ?? [],
    errorMessage: row.errorMessage,
  };
}

export async function runBacktest(input: BacktestRequest): Promise<BacktestResult> {
  const startDate = new Date(input.startDate);
  const endDate = new Date(input.endDate);
  const replayDate = input.replayDate ? new Date(input.replayDate) : null;
  const mode: BacktestMode = input.mode ?? 'FULL';
  const initialCapital = input.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const riskPerTradePct = input.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT;
  const maxPositions = Math.max(1, Math.floor(input.maxPositions ?? DEFAULT_MAX_POSITIONS));
  const executionCostPctPerSide = Math.max(0, input.executionCostPctPerSide ?? DEFAULT_EXECUTION_COST_PCT_PER_SIDE);

  const loadStart = addDays(startDate, -LOOKBACK_BUFFER_DAYS);
  const loadEnd = addDays(endDate, LOOKAHEAD_BUFFER_DAYS);

  const snapshots = await prisma.snapshot.findMany({
    where: {
      createdAt: {
        gte: loadStart,
        lte: loadEnd,
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true },
  });

  if (snapshots.length === 0) {
    const emptyCurve: BacktestCurvePoint[] = [{
      date: startDate.toISOString(),
      equity: round(initialCapital),
      drawdownPct: 0,
      tradeCount: 0,
    }];
    return {
      summary: buildSummary(mode, startDate, endDate, replayDate, initialCapital, riskPerTradePct, 0, [], emptyCurve, maxPositions, executionCostPctPerSide),
      trades: [],
      equityCurve: emptyCurve,
      drawdownCurve: emptyCurve,
    };
  }

  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const snapshotDateMap = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.createdAt]));

  const where: Prisma.SnapshotTickerWhereInput = {
    snapshotId: { in: snapshotIds },
  };
  if (input.ticker) {
    where.ticker = input.ticker;
  }
  if (input.sleeve) {
    where.sleeve = input.sleeve;
  }

  const rows = await prisma.snapshotTicker.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }],
    select: {
      snapshotId: true,
      ticker: true,
      name: true,
      sleeve: true,
      status: true,
      currency: true,
      close: true,
      atr14: true,
      atrPct: true,
      adx14: true,
      plusDi: true,
      minusDi: true,
      weeklyAdx: true,
      volRatio: true,
      dollarVol20: true,
      liquidityOk: true,
      bisScore: true,
      marketRegime: true,
      marketRegimeStable: true,
      volRegime: true,
      dualRegimeAligned: true,
      high20: true,
      high55: true,
      distanceTo20dHighPct: true,
      distanceTo55dHighPct: true,
      entryTrigger: true,
      stopLevel: true,
      chasing20Last5: true,
      chasing55Last5: true,
      atrSpiking: true,
      atrCollapsing: true,
      atrCompressionRatio: true,
      rsVsBenchmarkPct: true,
      daysToEarnings: true,
      earningsInNext5d: true,
      clusterName: true,
      superClusterName: true,
      clusterExposurePct: true,
      superClusterExposurePct: true,
      maxClusterPct: true,
      maxSuperClusterPct: true,
      createdAt: true,
    },
  });

  type HistoryRow = (typeof rows)[number];
  const rsPercentileBySnapshot = new Map<string, Map<string, number>>();
  const snapshotBuckets = new Map<string, Array<{ ticker: string; rs: number }>>();
  for (const row of rows) {
    const bucket = snapshotBuckets.get(row.snapshotId) ?? [];
    bucket.push({ ticker: row.ticker, rs: row.rsVsBenchmarkPct ?? 0 });
    snapshotBuckets.set(row.snapshotId, bucket);
  }
  for (const [snapshotId, bucket] of Array.from(snapshotBuckets.entries())) {
    rsPercentileBySnapshot.set(snapshotId, computeRsPercentiles(bucket));
  }

  const historyByTicker = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const history = historyByTicker.get(row.ticker) ?? [];
    history.push(row);
    historyByTicker.set(row.ticker, history);
  }

  const sourceTickers = Array.from(historyByTicker.keys());
  const stockMappings = await prisma.stock.findMany({
    where: { ticker: { in: sourceTickers } },
    select: { ticker: true, yahooTicker: true },
  });
  const yahooOverrideByTicker = new Map(stockMappings.map((stock) => [stock.ticker, stock.yahooTicker]));
  const canonicalSymbolByTicker = new Map(sourceTickers.map((ticker) => [
    ticker,
    toYahooTicker(ticker, yahooOverrideByTicker.get(ticker)),
  ]));
  const marketInstruments = await prisma.instrument.findMany({
    where: { symbol: { in: Array.from(new Set(canonicalSymbolByTicker.values())) } },
    select: {
      symbol: true,
      currency: true,
      dailyBars: {
        where: {
          date: {
            gte: addDays(loadStart, -30),
            lte: loadEnd,
          },
        },
        orderBy: { date: 'asc' },
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
        },
      },
    },
  });
  const currencies = Array.from(new Set([
    ...rows.map((row) => row.currency),
    ...marketInstruments.map((instrument) => instrument.currency),
  ].filter((currency): currency is string => Boolean(currency))));
  const fxSymbols = currencies
    .map((currency) => currency === 'GBp' ? 'GBX' : currency.toUpperCase())
    .filter((currency) => currency !== 'GBP' && currency !== 'GBX')
    .map((currency) => `${currency}GBP=X`);
  const fxInstruments = await prisma.instrument.findMany({
    where: { symbol: { in: Array.from(new Set(fxSymbols)) } },
    select: {
      symbol: true,
      currency: true,
      dailyBars: {
        where: {
          date: {
            gte: addDays(loadStart, -30),
            lte: loadEnd,
          },
        },
        orderBy: { date: 'asc' },
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
        },
      },
    },
  });
  const instruments = [...marketInstruments, ...fxInstruments];
  const dailyBarsBySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument.dailyBars]));
  const instrumentCurrencyBySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument.currency]));
  const fxBarsBySymbol = new Map(fxSymbols.map((symbol) => [
    symbol,
    (dailyBarsBySymbol.get(symbol) ?? []).map((bar) => ({ date: bar.date, close: bar.close })),
  ]));

  const trades: BacktestTrade[] = [];

  for (const [ticker, history] of Array.from(historyByTicker.entries())) {
    history.sort((left, right) => {
      const leftTime = snapshotDateMap.get(left.snapshotId)?.getTime() ?? left.createdAt.getTime();
      const rightTime = snapshotDateMap.get(right.snapshotId)?.getTime() ?? right.createdAt.getTime();
      return leftTime - rightTime;
    });

    for (let index = 0; index < history.length; index += 1) {
      const current = history[index];
      const previous = index > 0 ? history[index - 1] : null;
      const signalDate = snapshotDateMap.get(current.snapshotId) ?? current.createdAt;

      if (signalDate < startDate || signalDate > endDate) {
        continue;
      }
      if (replayDate && !isSameUtcDay(signalDate, replayDate)) {
        continue;
      }
      if (input.regime && current.marketRegime !== input.regime) {
        continue;
      }
      if (!current.entryTrigger || !current.stopLevel || !current.close) {
        continue;
      }

      const entryPrice = current.close;
      const riskPerShare = entryPrice - current.stopLevel;
      if (riskPerShare <= 0) {
        continue;
      }

      const triggered = current.close >= current.entryTrigger;
      const prevBelow = !previous || previous.close < (previous.entryTrigger || current.entryTrigger);
      if (!triggered || !prevBelow) {
        continue;
      }

      const snapshotRow = toSnapshotRow(current as unknown as Record<string, unknown>);
      const scored = scoreRow(snapshotRow);
      const displayNcs = mode === 'CORE_LITE'
        ? round(Math.max(0, Math.min(100, scored.BQS - 0.8 * scored.FWS + 10)))
        : scored.NCS;
      const actionNote = mode === 'CORE_LITE' ? 'CORE_LITE' : scored.ActionNote;

      const canonicalSymbol = canonicalSymbolByTicker.get(ticker) ?? toYahooTicker(ticker);
      const forwardCloses = buildDailyOutcomeSeries(
        dailyBarsBySymbol.get(canonicalSymbol) ?? [],
        signalDate,
        current.atr14,
      );
      const fwd20 = findForwardReturn(
        forwardCloses.map((point) => ({ date: point.date, close: point.close })),
        signalDate,
        20,
        riskPerShare,
        entryPrice,
      );
      const stopSimulation = simulateStopLadder(entryPrice, current.stopLevel, forwardCloses, fwd20?.date);
      const lastForward = forwardCloses.length > 0 ? forwardCloses[forwardCloses.length - 1] : null;

      const realizedR = stopSimulation.hit
        ? round(stopSimulation.hitR ?? 0)
        : fwd20
          ? round(fwd20.rMultiple)
          : lastForward
            ? round((lastForward.close - entryPrice) / riskPerShare)
            : null;
      const exitDate = stopSimulation.hit
        ? stopSimulation.hitDate
        : fwd20?.date ?? lastForward?.date ?? null;
      const exitReason = stopSimulation.hit
        ? 'STOP_HIT'
        : fwd20
          ? 'TIME_EXIT_20D'
          : lastForward
            ? 'PARTIAL_LOOKAHEAD'
            : 'NO_OUTCOME';
      const tradeCurrency = instrumentCurrencyBySymbol.get(canonicalSymbol) || current.currency || '';
      const entryFxToGbp = resolveHistoricalFxToGbp(tradeCurrency, ticker, signalDate, fxBarsBySymbol);
      const exitFxToGbp = exitDate
        ? resolveHistoricalFxToGbp(tradeCurrency, ticker, new Date(exitDate), fxBarsBySymbol)
        : null;

      const rsPercentile = rsPercentileBySnapshot.get(current.snapshotId)?.get(ticker) ?? null;
      const bps = calcBPSFromSnapshot({
        atr_pct: snapshotRow.atr_pct,
        atr_compression_ratio: snapshotRow.atr_compression_ratio,
        rs_vs_benchmark_pct: snapshotRow.rs_vs_benchmark_pct,
        rsPercentile,
        weekly_adx: snapshotRow.weekly_adx as number | undefined,
        sector: snapshotRow.cluster_name as string | undefined,
      }).bps;

      trades.push({
        ticker,
        name: current.name || ticker,
        sleeve: current.sleeve || '',
        regime: current.marketRegime,
        signalDate: signalDate.toISOString(),
        entryPrice: round(entryPrice),
        entryTrigger: round(current.entryTrigger),
        stopLevel: round(current.stopLevel),
        riskPerShare: round(riskPerShare),
        currency: tradeCurrency,
        entryFxToGbp,
        exitFxToGbp,
        bqs: round(scored.BQS),
        fws: round(scored.FWS),
        ncs: round(displayNcs),
        bps,
        actionNote,
        stopHit: stopSimulation.hit,
        stopHitDate: stopSimulation.hitDate,
        stopHitR: stopSimulation.hitR == null ? null : round(stopSimulation.hitR),
        maxFavorableR: round(stopSimulation.maxFavR),
        maxAdverseR: round(stopSimulation.maxAdvR),
        realizedR,
        exitDate,
        exitReason,
        daysHeld: exitDate ? daysBetween(signalDate, new Date(exitDate)) : null,
      });
    }
  }

  trades.sort((left, right) => new Date(left.signalDate).getTime() - new Date(right.signalDate).getTime());
  const cashSimulation = simulateCashConstrainedPortfolio(
    trades,
    initialCapital,
    riskPerTradePct,
    executionCostPctPerSide,
    maxPositions,
  );
  const slotEligibleKeys = new Set(cashSimulation.slotEligible.map((trade) => `${trade.ticker}|${trade.signalDate}`));
  const fundedByKey = new Map(cashSimulation.funded.map((position) => [
    `${position.trade.ticker}|${position.trade.signalDate}`,
    position,
  ]));
  const simulatedTrades = trades.map((trade) => {
    const key = `${trade.ticker}|${trade.signalDate}`;
    const funded = fundedByKey.get(key);
    if (funded) {
      return {
        ...trade,
        simulatedQuantity: funded.quantity,
        simulatedPositionValueGbp: funded.positionValue,
        simulatedRiskAmountGbp: funded.riskAmount,
        cashReservationStatus: 'FUNDED' as const,
      };
    }
    if (!slotEligibleKeys.has(key)) {
      return { ...trade, cashReservationStatus: 'NOT_SLOT_ELIGIBLE' as const };
    }
    const missingFx = trade.entryFxToGbp == null
      || (isCompleteBacktestTrade(trade) && trade.exitFxToGbp == null);
    return {
      ...trade,
      simulatedQuantity: 0,
      simulatedPositionValueGbp: 0,
      simulatedRiskAmountGbp: 0,
      cashReservationStatus: missingFx ? 'REJECTED_FX' as const : 'REJECTED_CASH' as const,
    };
  });
  const equityCurve = cashSimulation.equityCurve;
  const summary = buildSummary(mode, startDate, endDate, replayDate, initialCapital, riskPerTradePct, snapshots.length, simulatedTrades, equityCurve, maxPositions, executionCostPctPerSide, cashSimulation);
  const portfolioMetricsAvailable = summary.validity === 'VALID';

  return {
    summary,
    trades: [...simulatedTrades].sort((left, right) => new Date(right.signalDate).getTime() - new Date(left.signalDate).getTime()),
    equityCurve: portfolioMetricsAvailable ? equityCurve : [],
    drawdownCurve: portfolioMetricsAvailable ? equityCurve.map((point) => ({
      date: point.date,
      equity: point.drawdownPct,
      drawdownPct: point.drawdownPct,
      tradeCount: point.tradeCount,
    })) : [],
  };
}

export async function runAndStoreBacktest(input: BacktestRequest): Promise<StoredBacktestRun> {
  const mode: BacktestMode = input.mode ?? 'FULL';
  const filters = {
    ticker: input.ticker ?? null,
    sleeve: input.sleeve ?? null,
    regime: input.regime ?? null,
  };

  const created = await prisma.backtestRun.create({
    data: {
      mode,
      startDate: input.startDate,
      endDate: input.endDate,
      replayDate: input.replayDate ?? null,
      status: 'RUNNING',
      initialCapital: input.initialCapital ?? DEFAULT_INITIAL_CAPITAL,
      riskPerTradePct: input.riskPerTradePct ?? DEFAULT_RISK_PER_TRADE_PCT,
      filtersJson: filters as Prisma.JsonObject,
    },
    select: {
      id: true,
    },
  });

  try {
    const result = await runBacktest(input);
    const updated = await prisma.backtestRun.update({
      where: { id: created.id },
      data: {
        status: result.summary.validity === 'VALID' ? 'SUCCEEDED' : 'PARTIAL',
        signalCount: result.summary.signalCount,
        completedTrades: result.summary.completedTrades,
        winRate: decimalOrNull(result.summary.winRate),
        averageR: decimalOrNull(result.summary.averageR),
        totalReturnPct: decimalOrNull(result.summary.totalReturnPct),
        maxDrawdownPct: decimalOrNull(result.summary.maxDrawdownPct),
        summaryJson: result.summary as unknown as Prisma.JsonObject,
        tradesJson: result.trades as unknown as Prisma.JsonArray,
        equityCurveJson: result.equityCurve as unknown as Prisma.JsonArray,
        drawdownCurveJson: result.drawdownCurve as unknown as Prisma.JsonArray,
        finishedAt: new Date(),
      },
      select: {
        id: true,
        status: true,
        requestedAt: true,
        finishedAt: true,
        filtersJson: true,
        summaryJson: true,
        tradesJson: true,
        equityCurveJson: true,
        drawdownCurveJson: true,
        errorMessage: true,
      },
    });

    return mapStoredRun(updated);
  } catch (error) {
    await prisma.backtestRun.update({
      where: { id: created.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown backtest failure',
      },
    });
    throw error;
  }
}

export async function getStoredBacktestRun(id: string): Promise<StoredBacktestRun | null> {
  const row = await prisma.backtestRun.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      requestedAt: true,
      finishedAt: true,
      filtersJson: true,
      summaryJson: true,
      tradesJson: true,
      equityCurveJson: true,
      drawdownCurveJson: true,
      errorMessage: true,
    },
  });

  return row ? mapStoredRun(row) : null;
}

export function selectTradesByPositionLimit(
  trades: BacktestTrade[],
  maxPositions: number,
): { selected: BacktestTrade[]; rejected: number } {
  const candidates = [...trades].sort((left, right) => {
    const dateDelta = new Date(left.signalDate).getTime() - new Date(right.signalDate).getTime();
    if (dateDelta !== 0) return dateDelta;
    const scoreDelta = right.ncs - left.ncs;
    return scoreDelta !== 0 ? scoreDelta : left.ticker.localeCompare(right.ticker);
  });
  const selected: BacktestTrade[] = [];
  let active: BacktestTrade[] = [];
  let rejected = 0;

  for (const trade of candidates) {
    active = active.filter((position) =>
      !isCompleteBacktestTrade(position)
      || position.exitDate == null
      || !exitsBeforeSignalDay(position.exitDate, trade.signalDate));
    const duplicateTicker = active.some((position) => position.ticker === trade.ticker);
    if (active.length >= maxPositions || duplicateTicker) {
      rejected += 1;
      continue;
    }
    selected.push(trade);
    active.push(trade);
  }

  return { selected, rejected };
}

export function applyExecutionCostScenario(
  trade: BacktestTrade & { realizedR: number },
  costPctPerSide: number,
): number {
  if (costPctPerSide <= 0 || trade.riskPerShare <= 0) {
    return trade.realizedR;
  }
  const exitPrice = Math.max(0, trade.entryPrice + trade.realizedR * trade.riskPerShare);
  const roundTripCost = (trade.entryPrice + exitPrice) * (costPctPerSide / 100);
  return round(trade.realizedR - roundTripCost / trade.riskPerShare);
}

export interface SimulatedBacktestPosition {
  trade: BacktestTrade;
  quantity: number;
  positionValue: number;
  riskAmount: number;
  netPnl: number | null;
}

export function simulateCashConstrainedPortfolio(
  trades: BacktestTrade[],
  initialCapital: number,
  riskPerTradePct: number,
  executionCostPctPerSide: number,
  maxPositions = Number.MAX_SAFE_INTEGER,
): {
  funded: SimulatedBacktestPosition[];
  slotEligible: BacktestTrade[];
  positionRejected: number;
  cashRejected: number;
  endingCash: number;
  equityCurve: BacktestCurvePoint[];
  fxRejected: number;
} {
  const candidates = [...trades]
    .sort((left, right) => {
      const dateDelta = new Date(left.signalDate).getTime() - new Date(right.signalDate).getTime();
      if (dateDelta !== 0) return dateDelta;
      const scoreDelta = right.ncs - left.ncs;
      return scoreDelta !== 0 ? scoreDelta : left.ticker.localeCompare(right.ticker);
    });
  const costRate = Math.max(0, executionCostPctPerSide) / 100;
  const funded: SimulatedBacktestPosition[] = [];
  const slotEligible: BacktestTrade[] = [];
  let open: SimulatedBacktestPosition[] = [];
  let cash = initialCapital;
  let peakEquity = initialCapital;
  let cashRejected = 0;
  let fxRejected = 0;
  let positionRejected = 0;
  const equityCurve: BacktestCurvePoint[] = [{
    date: candidates[0]?.signalDate ?? new Date(0).toISOString(),
    equity: round(initialCapital),
    drawdownPct: 0,
    tradeCount: 0,
  }];

  const closePosition = (position: SimulatedBacktestPosition): void => {
    if (!isCompleteBacktestTrade(position.trade) || position.trade.exitDate == null) return;
    const grossExitPrice = Math.max(0, position.trade.entryPrice + position.trade.realizedR * position.trade.riskPerShare);
    cash += position.quantity * grossExitPrice * (position.trade.exitFxToGbp ?? 0) * (1 - costRate);
    const equity = cash + open
      .filter((candidate) => candidate !== position)
      .reduce((sum, candidate) => sum + candidate.positionValue, 0);
    peakEquity = Math.max(peakEquity, equity);
    equityCurve.push({
      date: position.trade.exitDate,
      equity: round(equity),
      drawdownPct: round(peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0),
      tradeCount: funded.length,
    });
  };

  for (const trade of candidates) {
    const exiting = open
      .filter((position) => isCompleteBacktestTrade(position.trade)
        && position.trade.exitDate != null
        && exitsBeforeSignalDay(position.trade.exitDate, trade.signalDate))
      .sort((left, right) => new Date(left.trade.exitDate ?? 0).getTime() - new Date(right.trade.exitDate ?? 0).getTime());
    for (const position of exiting) closePosition(position);
    open = open.filter((position) => !isCompleteBacktestTrade(position.trade)
      || position.trade.exitDate == null
      || !exitsBeforeSignalDay(position.trade.exitDate, trade.signalDate));

    if (open.length >= maxPositions || open.some((position) => position.trade.ticker === trade.ticker)) {
      positionRejected += 1;
      continue;
    }
    slotEligible.push(trade);

    const entryFxToGbp = trade.entryFxToGbp;
    const exitFxToGbp = trade.exitFxToGbp;
    const complete = isCompleteBacktestTrade(trade) && trade.exitDate != null;
    if (entryFxToGbp == null || entryFxToGbp <= 0 || (complete && (exitFxToGbp == null || exitFxToGbp <= 0))) {
      fxRejected += 1;
      continue;
    }

    const accountEquity = cash + open.reduce((sum, position) => sum + position.positionValue, 0);
    const riskBudget = Math.max(0, accountEquity * (riskPerTradePct / 100));
    const entryCashPerShare = trade.entryPrice * entryFxToGbp * (1 + costRate);
    const riskPerShareGbp = trade.riskPerShare * entryFxToGbp;
    const maxRiskShares = Math.floor(riskBudget / riskPerShareGbp);
    const maxCashShares = entryCashPerShare > 0 ? Math.floor(cash / entryCashPerShare) : 0;
    const quantity = Math.max(0, Math.min(maxRiskShares, maxCashShares));
    if (quantity === 0) {
      cashRejected += 1;
      continue;
    }

    const positionValue = quantity * trade.entryPrice * entryFxToGbp;
    const entryOutflow = quantity * entryCashPerShare;
    const grossExitPrice = complete ? Math.max(0, trade.entryPrice + trade.realizedR * trade.riskPerShare) : null;
    const exitProceeds = grossExitPrice == null || exitFxToGbp == null
      ? null
      : quantity * grossExitPrice * exitFxToGbp * (1 - costRate);
    const position: SimulatedBacktestPosition = {
      trade,
      quantity,
      positionValue: round(positionValue),
      riskAmount: round(quantity * riskPerShareGbp),
      netPnl: exitProceeds == null ? null : round(exitProceeds - entryOutflow),
    };
    cash -= entryOutflow;
    funded.push(position);
    open.push(position);
  }

  for (const position of [...open]
    .filter((candidate) => isCompleteBacktestTrade(candidate.trade) && candidate.trade.exitDate != null)
    .sort((left, right) => new Date(left.trade.exitDate ?? 0).getTime() - new Date(right.trade.exitDate ?? 0).getTime())) {
    closePosition(position);
    open = open.filter((candidate) => candidate !== position);
  }

  return { funded, slotEligible, positionRejected, cashRejected, fxRejected, endingCash: round(cash), equityCurve };
}