/**
 * DEPENDENCIES
 * Consumed by: packages/backtest/src/runner.ts, packages/backtest/src/index.ts, scripts/verify-phase11.ts
 * Consumes: none
 * Risk-sensitive: NO
 * Last modified: 2026-03-09
 * Notes: Shared Phase 11 types for backtest requests, computed trades, curves, and stored runs.
 */

export type BacktestMode = 'FULL' | 'CORE_LITE';
export type BacktestExitReason = 'STOP_HIT' | 'TIME_EXIT_20D' | 'PARTIAL_LOOKAHEAD' | 'NO_OUTCOME';
export type BacktestValidity = 'VALID' | 'PARTIAL' | 'INVALID_FOR_PERFORMANCE_CLAIMS';
export type BacktestEvidenceVerdict = 'INCONCLUSIVE' | 'PROMISING' | 'SUPPORTED' | 'DEGRADING';

export interface BacktestConfidenceInterval {
  lower: number;
  upper: number;
  confidence: 0.95;
}

export interface BacktestRequest {
  startDate: Date;
  endDate: Date;
  replayDate?: Date | null;
  mode?: BacktestMode;
  sleeve?: string | null;
  regime?: string | null;
  ticker?: string | null;
  initialCapital?: number;
  riskPerTradePct?: number;
  maxPositions?: number;
  executionCostPctPerSide?: number;
}

export interface BacktestTrade {
  ticker: string;
  name: string;
  sleeve: string;
  regime: string;
  signalDate: string;
  entryPrice: number;
  entryTrigger: number;
  stopLevel: number;
  riskPerShare: number;
  currency?: string;
  entryFxToGbp?: number | null;
  exitFxToGbp?: number | null;
  simulatedQuantity?: number | null;
  simulatedPositionValueGbp?: number | null;
  simulatedRiskAmountGbp?: number | null;
  cashReservationStatus?: 'FUNDED' | 'REJECTED_CASH' | 'REJECTED_FX' | 'NOT_SLOT_ELIGIBLE';
  bqs: number;
  fws: number;
  ncs: number;
  bps: number;
  actionNote: string;
  stopHit: boolean;
  stopHitDate: string | null;
  stopHitR: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
  realizedR: number | null;
  exitDate: string | null;
  exitReason: BacktestExitReason;
  daysHeld: number | null;
}

export interface BacktestCurvePoint {
  date: string;
  equity: number;
  drawdownPct: number;
  tradeCount: number;
}

export interface BacktestSummary {
  validity: BacktestValidity;
  validityReasons: string[];
  mode: BacktestMode;
  startDate: string;
  endDate: string;
  replayDate: string | null;
  initialCapital: number;
  endingCapital: number | null;
  riskPerTradePct: number;
  maxPositions: number;
  executionCostPctPerSide: number;
  snapshotCount: number;
  signalCount: number;
  completedTrades: number;
  incompleteTrades: number;
  slotEligibleTrades: number;
  positionLimitRejectedTrades: number;
  cashFundedTrades: number;
  cashRejectedTrades: number;
  fxRejectedTrades: number;
  averageFundedPositionValueGbp: number | null;
  averageFundedRiskAmountGbp: number | null;
  slotEligibleGrossAverageR: number | null;
  slotEligibleNetAverageR: number | null;
  executionCostDragR: number | null;
  distinctOutcomeDays: number;
  evidenceVerdict: BacktestEvidenceVerdict;
  evidenceVerdictReason: string;
  winRate: number | null;
  dailyWinRate: number | null;
  winRateInterval: BacktestConfidenceInterval | null;
  averageR: number | null;
  dailyMeanR: number | null;
  averageRInterval: BacktestConfidenceInterval | null;
  averageWinR: number | null;
  averageLossR: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  averageHoldingDays: number | null;
  stopsHit: number;
  stopsHitPct: number | null;
}

export interface BacktestResult {
  summary: BacktestSummary;
  trades: BacktestTrade[];
  equityCurve: BacktestCurvePoint[];
  drawdownCurve: BacktestCurvePoint[];
}

export interface StoredBacktestRun extends BacktestResult {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  requestedAt: string;
  finishedAt: string | null;
  filters: {
    ticker: string | null;
    sleeve: string | null;
    regime: string | null;
  };
  errorMessage: string | null;
}