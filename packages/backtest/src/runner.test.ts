import { describe, it, expect, vi } from 'vitest';
const history = vi.hoisted(() => ({ snapshots: vi.fn(), rows: vi.fn(), stocks: vi.fn(), instruments: vi.fn() }));
vi.mock('../../data/src/prisma', () => ({
  prisma: {
    snapshot: { findMany: history.snapshots }, snapshotTicker: { findMany: history.rows },
    stock: { findMany: history.stocks }, instrument: { findMany: history.instruments },
  },
  round: (value: number, precision = 4) => Number(value.toFixed(precision)),
}));
import { applyExecutionCostScenario, buildDailyOutcomeSeries, buildSummary, classifyBacktestValidity, resolveHistoricalFxToGbp, runBacktest, selectTradesByPositionLimit, simulateCashConstrainedPortfolio, simulateStopLadder } from './runner';
import type { BacktestTrade } from './types';

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    ticker: 'TEST',
    name: 'Test',
    sleeve: 'STOCK_CORE',
    regime: 'BULLISH',
    signalDate: '2026-01-01T00:00:00.000Z',
    entryPrice: 100,
    entryTrigger: 100,
    stopLevel: 90,
    riskPerShare: 10,
    currency: 'GBP',
    entryFxToGbp: 1,
    exitFxToGbp: 1,
    bqs: 60,
    fws: 20,
    ncs: 70,
    bps: 50,
    actionNote: 'Conditional',
    stopHit: false,
    stopHitDate: null,
    stopHitR: null,
    maxFavorableR: 1,
    maxAdverseR: -0.5,
    realizedR: 1,
    exitDate: '2026-01-21T00:00:00.000Z',
    exitReason: 'TIME_EXIT_20D',
    daysHeld: 20,
    ...overrides,
  };
}

describe('simulateStopLadder', () => {
  const makeSnap = (date: string, close: number, atr14 = 2) => ({ date, close, atr14 });

  it('ignores stops and closes after the selected time exit', () => {
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-20', 110),
      makeSnap('2026-04-21', 80),
    ], '2026-04-20');
    expect(result).toMatchObject({ hit: false, hitR: null, maxFavR: 1, maxAdvR: 0 });
  });

  it('still applies a stop on the time-exit session', () => {
    expect(simulateStopLadder(100, 90, [
      { date: '2026-04-20', open: 80, low: 75, close: 110, atr14: 2 },
    ], '2026-04-20').hitR).toBe(-2);
  });

  it('fills an opening gap below the initial stop at the open, not the stop', () => {
    const result = simulateStopLadder(100, 90, [
      { date: '2026-04-01', open: 80, low: 75, close: 120, atr14: 2 },
    ]);
    expect(result.hitR).toBe(-2);
    expect(result.maxFavR).toBe(0);
    expect(result.maxAdvR).toBe(-2);
  });

  it('applies gaps to raised stops without using the exit-day recovery', () => {
    const result = simulateStopLadder(100, 90, [
      { date: '2026-04-01', open: 101, low: 100, close: 116, atr14: 2 },
      { date: '2026-04-02', open: 95, low: 94, close: 140, atr14: 2 },
    ]);
    expect(result.hitR).toBe(-0.5);
    expect(result.maxFavR).toBe(1.6);
  });

  it('keeps a stop-price fill when the session opens above the stop', () => {
    expect(simulateStopLadder(100, 90, [
      { date: '2026-04-01', open: 99, low: 89, close: 105, atr14: 2 },
    ]).hitR).toBe(-1);
  });

  it('returns no hit when price stays above stop', () => {
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 105),
      makeSnap('2026-04-02', 110),
      makeSnap('2026-04-03', 108),
    ]);
    expect(result.hit).toBe(false);
    expect(result.hitDate).toBeNull();
    expect(result.maxFavR).toBeGreaterThan(0);
  });

  it('detects stop hit when price drops to stop level', () => {
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 105),
      makeSnap('2026-04-02', 90), // hits stop
      makeSnap('2026-04-03', 95),
    ]);
    expect(result.hit).toBe(true);
    expect(result.hitDate).toBe('2026-04-02');
    expect(result.hitR).toBeCloseTo(-1.0); // Lost 1R
  });

  it('detects an intraday stop hit when the daily close recovers above the stop', () => {
    const result = simulateStopLadder(100, 90, [
      { date: '2026-04-01', close: 95, low: 89, atr14: 2 },
    ]);

    expect(result.hit).toBe(true);
    expect(result.hitDate).toBe('2026-04-01');
    expect(result.hitR).toBeCloseTo(-1);
  });

  it('returns early when riskPerShare <= 0', () => {
    const result = simulateStopLadder(100, 100, [makeSnap('2026-04-01', 105)]);
    expect(result.hit).toBe(false);
    expect(result.maxFavR).toBe(0);
  });

  it('raises stop to breakeven at 1.5R', () => {
    // Entry 100, stop 90, risk = 10. 1.5R = 115.
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 115), // 1.5R → stop moves to breakeven (100)
      makeSnap('2026-04-02', 95),  // Below original stop 90 but above breakeven 100? No — 95 < 100 → hits new stop
    ]);
    expect(result.hit).toBe(true);
    expect(result.hitDate).toBe('2026-04-02');
    // Stop was raised to 100 (breakeven), so R at hit = (100-100)/10 = 0
    expect(result.hitR).toBeCloseTo(0);
  });

  it('raises stop further at 2.5R (lock 0.5R)', () => {
    // Entry 100, stop 90, risk = 10. 2.5R = 125.
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 125), // 2.5R → stop moves to entry + 0.5R = 105
      makeSnap('2026-04-02', 104), // Below 105 → hits
    ]);
    expect(result.hit).toBe(true);
    expect(result.hitR).toBeCloseTo(0.5); // Locked 0.5R
  });

  it('raises stop to trailing at 3.0R', () => {
    // Entry 100, stop 90, risk = 10. 3.0R = 130.
    // Trailing: max(entry + 1R, close - 1.5*ATR) = max(110, 130 - 3) = 127 (live ATR_TRAILING_MULTIPLIER)
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 130, 2), // 3.0R → trailing stop = max(110, 130-3) = 127
      makeSnap('2026-04-02', 125),     // Below 127 → hits
    ]);
    expect(result.hit).toBe(true);
    expect(result.hitR).toBeCloseTo(2.7); // Locked at 127 → (127-100)/10 = 2.7R
  });

  it('tracks maxFavR and maxAdvR correctly', () => {
    // Entry 100, stop 90, risk 10. Dips below entry first, then rises.
    // maxAdvR tracks the lowest R-multiple seen.
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 97),  // -0.3R
      makeSnap('2026-04-02', 105), // +0.5R
      makeSnap('2026-04-03', 110), // +1R
    ]);
    expect(result.hit).toBe(false);
    expect(result.maxFavR).toBeCloseTo(1.0);
    expect(result.maxAdvR).toBeCloseTo(-0.3);
  });

  it('stop is monotonic — never decreases', () => {
    // After hitting 1.5R, stop at breakeven. Even if price dips, stop stays.
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 116), // 1.6R → stop → 100
      makeSnap('2026-04-02', 105), // Dips but above breakeven stop
      makeSnap('2026-04-03', 99),  // Below breakeven → hit at 100
    ]);
    expect(result.hit).toBe(true);
    expect(result.hitR).toBeCloseTo(0); // Breakeven
  });

  it('returns maxFavR for trades that never hit stop', () => {
    const result = simulateStopLadder(100, 90, [
      makeSnap('2026-04-01', 105),
      makeSnap('2026-04-02', 110),
      makeSnap('2026-04-03', 115),
    ]);
    expect(result.hit).toBe(false);
    expect(result.maxFavR).toBeCloseTo(1.5);
  });
});

describe('runBacktest outcome boundaries', () => {
  it.each([false, true])('uses session opens and stops at the time exit (earlyGap=%s)', async earlyGap => {
    const signalDate = new Date('2026-05-01T22:00:00Z');
    history.snapshots.mockResolvedValue([{ id: 'synthetic-scan', createdAt: signalDate }]);
    history.rows.mockResolvedValue([{
      snapshotId: 'synthetic-scan', createdAt: signalDate, ticker: 'SYNTHETIC', currency: 'GBP',
      close: 100, entryTrigger: 99, stopLevel: 90, atr14: 2, marketRegime: 'BULLISH',
    }]);
    history.stocks.mockResolvedValue([]);
    const bar = (date: string, open: number, low: number, close: number) => ({
      date: new Date(date), open, low, high: Math.max(open, close) + 2, close, volume: 1000,
    });
    history.instruments.mockReset();
    history.instruments.mockResolvedValueOnce([{
      symbol: 'SYNTHETIC', currency: 'GBP', dailyBars: [
        bar('2026-05-02T13:30:00Z', earlyGap ? 80 : 100, earlyGap ? 75 : 99, 105),
        bar('2026-05-21T13:30:00Z', 105, 100, 110),
        bar('2026-05-22T13:30:00Z', 50, 45, 60),
      ],
    }]).mockResolvedValueOnce([]);
    const result = await runBacktest({ startDate: signalDate, endDate: signalDate });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      realizedR: earlyGap ? -2 : 1,
      exitReason: earlyGap ? 'STOP_HIT' : 'TIME_EXIT_20D',
      exitDate: earlyGap ? '2026-05-02T13:30:00.000Z' : '2026-05-21T13:30:00.000Z',
      maxFavorableR: earlyGap ? 0 : 1,
      cashReservationStatus: 'FUNDED',
    });
  });
});

describe('buildDailyOutcomeSeries', () => {
  it('uses only bars after the signal and derives ATR from OHLC history', () => {
    const bars = Array.from({ length: 16 }, (_, index) => ({
      date: new Date(`2026-03-${String(index + 1).padStart(2, '0')}T13:30:00.000Z`),
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000,
    }));

    const result = buildDailyOutcomeSeries(
      bars,
      new Date('2026-03-15T22:00:00.000Z'),
      9,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: '2026-03-16T13:30:00.000Z',
      open: 115,
      close: 116,
      low: 114,
      atr14: 3,
    });
  });
});

describe('selectTradesByPositionLimit', () => {
  it('takes the highest-ranked same-evening signals up to the position cap', () => {
    const result = selectTradesByPositionLimit([
      makeTrade({ ticker: 'LOW', ncs: 40 }),
      makeTrade({ ticker: 'HIGH', ncs: 90 }),
      makeTrade({ ticker: 'MID', ncs: 60 }),
    ], 2);

    expect(result.selected.map((trade) => trade.ticker)).toEqual(['HIGH', 'MID']);
    expect(result.rejected).toBe(1);
  });

  it('frees a slot when an earlier position exits', () => {
    const result = selectTradesByPositionLimit([
      makeTrade({ ticker: 'FIRST', signalDate: '2026-01-01T00:00:00.000Z', exitDate: '2026-01-10T00:00:00.000Z' }),
      makeTrade({ ticker: 'BLOCKED', signalDate: '2026-01-05T00:00:00.000Z', exitDate: '2026-01-20T00:00:00.000Z' }),
      makeTrade({ ticker: 'AFTER', signalDate: '2026-01-11T00:00:00.000Z', exitDate: '2026-01-30T00:00:00.000Z' }),
    ], 1);

    expect(result.selected.map((trade) => trade.ticker)).toEqual(['FIRST', 'AFTER']);
    expect(result.rejected).toBe(1);
  });

  it('keeps a slot occupied when exit and signal ordering is unknown on the same UTC date', () => {
    const result = selectTradesByPositionLimit([
      makeTrade({ ticker: 'FIRST', signalDate: '2026-01-01T20:00:00.000Z', exitDate: '2026-01-10T23:00:00.000Z' }),
      makeTrade({ ticker: 'AFTER', signalDate: '2026-01-10T20:00:00.000Z', exitDate: '2026-01-30T23:00:00.000Z' }),
    ], 1);

    expect(result.selected.map((trade) => trade.ticker)).toEqual(['FIRST']);
    expect(result.rejected).toBe(1);
  });

  it('does not open the same ticker twice concurrently', () => {
    const result = selectTradesByPositionLimit([
      makeTrade({ ticker: 'TEST', signalDate: '2026-01-01T00:00:00.000Z' }),
      makeTrade({ ticker: 'TEST', signalDate: '2026-01-02T00:00:00.000Z' }),
    ], 4);

    expect(result.selected).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('keeps an incomplete trade open through the replay boundary', () => {
    const result = selectTradesByPositionLimit([
      makeTrade({ ticker: 'OPEN', realizedR: null, exitDate: '2026-01-05T00:00:00.000Z', exitReason: 'PARTIAL_LOOKAHEAD' }),
      makeTrade({ ticker: 'BLOCKED', signalDate: '2026-01-10T00:00:00.000Z' }),
    ], 1);

    expect(result.selected.map((trade) => trade.ticker)).toEqual(['OPEN']);
    expect(result.rejected).toBe(1);
  });
});

describe('applyExecutionCostScenario', () => {
  it('preserves gross R when the scenario cost is zero', () => {
    const trade = { ...makeTrade(), realizedR: 1.5 };
    expect(applyExecutionCostScenario(trade, 0)).toBe(1.5);
  });

  it('converts adverse entry and exit costs into R using the trade stop distance', () => {
    const trade = { ...makeTrade({ entryPrice: 100, riskPerShare: 10 }), realizedR: 1 };

    expect(applyExecutionCostScenario(trade, 0.5)).toBeCloseTo(0.895);
  });
});

describe('simulateCashConstrainedPortfolio', () => {
  it('floors whole shares to both the risk budget and available cash', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ entryPrice: 100, riskPerShare: 10 }), realizedR: 1, exitDate: '2026-01-21T00:00:00.000Z' },
    ], 950, 20, 0);

    expect(result.funded[0]).toMatchObject({ quantity: 9, positionValue: 900, riskAmount: 90 });
    expect(result.endingCash).toBe(1040);
  });

  it('rejects an overlapping trade when the first position has reserved all cash', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ ticker: 'FIRST', exitDate: '2026-01-10T00:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-10T00:00:00.000Z' },
      { ...makeTrade({ ticker: 'BLOCKED', signalDate: '2026-01-05T00:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-25T00:00:00.000Z' },
    ], 1_000, 10, 0);

    expect(result.funded.map((position) => position.trade.ticker)).toEqual(['FIRST']);
    expect(result.cashRejected).toBe(1);
  });

  it('does not let a cash-rejected candidate consume a position slot', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ ticker: 'FIRST', entryPrice: 500, riskPerShare: 1000, ncs: 90 }), realizedR: 0, exitDate: '2026-01-20T00:00:00.000Z' },
      { ...makeTrade({ ticker: 'TOO_EXPENSIVE', entryPrice: 600, riskPerShare: 10, ncs: 80 }), realizedR: 0, exitDate: '2026-01-20T00:00:00.000Z' },
      { ...makeTrade({ ticker: 'AFFORDABLE', entryPrice: 400, riskPerShare: 400, ncs: 70 }), realizedR: 0, exitDate: '2026-01-20T00:00:00.000Z' },
    ], 1_000, 100, 0, 2);

    expect(result.funded.map((position) => position.trade.ticker)).toEqual(['FIRST', 'AFFORDABLE']);
    expect(result.cashRejected).toBe(1);
    expect(result.positionRejected).toBe(0);
  });

  it('does not release exit proceeds for another entry on the same day', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ ticker: 'FIRST', exitDate: '2026-01-10T23:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-10T23:00:00.000Z' },
      { ...makeTrade({ ticker: 'AFTER', signalDate: '2026-01-10T20:00:00.000Z', exitDate: '2026-01-30T23:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-30T23:00:00.000Z' },
    ], 1_000, 10, 0);

    expect(result.funded.map((position) => [position.trade.ticker, position.quantity])).toEqual([
      ['FIRST', 10],
    ]);
    expect(result.cashRejected).toBe(1);
    expect(result.endingCash).toBe(1100);
  });

  it('releases exit proceeds for an entry on a later UTC date', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ ticker: 'FIRST', exitDate: '2026-01-10T23:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-10T23:00:00.000Z' },
      { ...makeTrade({ ticker: 'AFTER', signalDate: '2026-01-11T00:00:00.000Z', exitDate: '2026-01-30T23:00:00.000Z' }), realizedR: 1, exitDate: '2026-01-30T23:00:00.000Z' },
    ], 1_000, 10, 0);

    expect(result.funded.map((position) => [position.trade.ticker, position.quantity])).toEqual([
      ['FIRST', 10],
      ['AFTER', 11],
    ]);
    expect(result.cashRejected).toBe(0);
    expect(result.endingCash).toBe(1210);
  });

  it('uses entry FX for sizing and exit FX for returned cash', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ entryFxToGbp: 0.8, exitFxToGbp: 0.82 }), realizedR: 1, exitDate: '2026-01-21T00:00:00.000Z' },
    ], 1_000, 10, 0);

    expect(result.funded[0]).toMatchObject({ quantity: 12, positionValue: 960, riskAmount: 96 });
    expect(result.endingCash).toBeCloseTo(1122.4);
  });

  it('fails closed when a historical FX rate is unavailable', () => {
    const result = simulateCashConstrainedPortfolio([
      { ...makeTrade({ currency: '', entryFxToGbp: null, exitFxToGbp: null }), realizedR: 1, exitDate: '2026-01-21T00:00:00.000Z' },
    ], 1_000, 10, 0);

    expect(result.funded).toHaveLength(0);
    expect(result.fxRejected).toBe(1);
  });

  it('reserves cash for an incomplete trade through the replay boundary', () => {
    const result = simulateCashConstrainedPortfolio([
      makeTrade({ ticker: 'OPEN', realizedR: null, exitDate: '2026-01-05T00:00:00.000Z', exitReason: 'PARTIAL_LOOKAHEAD' }),
      makeTrade({ ticker: 'BLOCKED', signalDate: '2026-01-10T00:00:00.000Z' }),
    ], 1_000, 10, 0, 1);

    expect(result.funded.map((position) => position.trade.ticker)).toEqual(['OPEN']);
    expect(result.positionRejected).toBe(1);
  });
});

describe('resolveHistoricalFxToGbp', () => {
  const bars = new Map([
    ['USDGBP=X', [
      { date: new Date('2026-01-01T16:00:00.000Z'), close: 0.79 },
      { date: new Date('2026-01-02T16:00:00.000Z'), close: 0.8 },
    ]],
  ]);

  it('uses only FX closes from a prior UTC day', () => {
    expect(resolveHistoricalFxToGbp('USD', 'AAPL', new Date('2026-01-02T13:00:00.000Z'), bars)).toBe(0.79);
    expect(resolveHistoricalFxToGbp('USD', 'AAPL', new Date('2026-01-03T00:00:00.000Z'), bars)).toBe(0.8);
  });

  it('treats LSE prices as GBX even when historical metadata says GBP', () => {
    expect(resolveHistoricalFxToGbp('GBP', 'AZN.L', new Date('2026-01-02T00:00:00.000Z'), bars)).toBe(0.01);
    expect(resolveHistoricalFxToGbp('GBP', 'AZNl', new Date('2026-01-02T00:00:00.000Z'), bars)).toBe(0.01);
  });

  it('does not infer an unknown currency', () => {
    expect(resolveHistoricalFxToGbp(null, 'UNKNOWN', new Date('2026-01-02T00:00:00.000Z'), bars)).toBeNull();
  });
});

describe('backtest validity', () => {
  it('marks the hybrid snapshot and OHLC replay as partial when complete outcomes exist', () => {
    expect(classifyBacktestValidity(1).validity).toBe('PARTIAL');
  });

  it('rejects performance claims when no complete outcomes exist', () => {
    expect(classifyBacktestValidity(0).validity).toBe('INVALID_FOR_PERFORMANCE_CLAIMS');
  });

  it('retains observational outcomes but suppresses invalid portfolio performance', () => {
    const summary = buildSummary(
      'FULL',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-31T00:00:00.000Z'),
      null,
      10_000,
      2,
      30,
      [
        makeTrade({ realizedR: 1, exitReason: 'TIME_EXIT_20D' }),
        makeTrade({ realizedR: 10, exitReason: 'PARTIAL_LOOKAHEAD', daysHeld: 5 }),
      ],
      [
        { date: '2026-01-01T00:00:00.000Z', equity: 10_000, drawdownPct: 0, tradeCount: 0 },
        { date: '2026-01-21T00:00:00.000Z', equity: 10_200, drawdownPct: 0, tradeCount: 1 },
      ],
    );

    expect(summary.completedTrades).toBe(1);
    expect(summary.incompleteTrades).toBe(1);
    expect(summary.maxPositions).toBe(4);
    expect(summary.slotEligibleTrades).toBe(1);
    expect(summary.positionLimitRejectedTrades).toBe(1);
    expect(summary.cashFundedTrades).toBe(1);
    expect(summary.cashRejectedTrades).toBe(0);
    expect(summary.fxRejectedTrades).toBe(0);
    expect(summary.averageFundedPositionValueGbp).toBe(2000);
    expect(summary.averageFundedRiskAmountGbp).toBe(200);
    expect(summary.executionCostPctPerSide).toBe(0);
    expect(summary.slotEligibleGrossAverageR).toBe(1);
    expect(summary.slotEligibleNetAverageR).toBe(1);
    expect(summary.executionCostDragR).toBe(0);
    expect(summary.averageR).toBe(1);
    expect(summary.dailyMeanR).toBe(1);
    expect(summary.dailyWinRate).toBe(100);
    expect(summary.distinctOutcomeDays).toBe(1);
    expect(summary.evidenceVerdict).toBe('INCONCLUSIVE');
    expect(summary.endingCapital).toBeNull();
    expect(summary.totalReturnPct).toBeNull();
    expect(summary.maxDrawdownPct).toBeNull();
  });

  it('supports positive outcomes only after 30 distinct signal days', () => {
    const trades = Array.from({ length: 30 }, (_, index) => makeTrade({
      signalDate: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      realizedR: 1,
    }));

    const summary = buildSummary(
      'FULL',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-31T00:00:00.000Z'),
      null,
      10_000,
      2,
      30,
      trades,
      [],
    );

    expect(summary.distinctOutcomeDays).toBe(30);
    expect(summary.dailyMeanR).toBe(1);
    expect(summary.dailyWinRate).toBe(100);
    expect(summary.averageRInterval).toEqual({ lower: 1, upper: 1, confidence: 0.95 });
    expect(summary.evidenceVerdict).toBe('SUPPORTED');
  });
});
