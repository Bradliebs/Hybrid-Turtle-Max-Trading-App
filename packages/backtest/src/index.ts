/**
 * DEPENDENCIES
 * Consumed by: scripts/verify-phase11.ts
 * Consumes: packages/backtest/src/runner.ts, packages/backtest/src/types.ts
 * Risk-sensitive: NO
 * Last modified: 2026-03-09
 * Notes: Public Phase 11 backtest package surface.
 */

export { getStoredBacktestRun, runAndStoreBacktest, runBacktest } from './runner';
export type {
  BacktestCurvePoint,
  BacktestMode,
  BacktestRequest,
  BacktestResult,
  BacktestSummary,
  BacktestTrade,
  StoredBacktestRun,
} from './types';