import { describe, it, expect } from 'vitest';
import { checkStopIntegrity, checkConfigCoherence, checkSleeveLimits, checkOpenPositionUniqueness, tallyInvalidT212TickerRows, tallyInvalidYahooTickerRows } from './health-check';
import type { RiskProfileType } from '@/types';

// ── Helper: make a minimal position for health checks ──
function makePos(overrides: Partial<{
  ticker: string;
  entryPrice: number;
  currentStop: number;
  stopLoss: number;
  initialRisk: number;
  protectionLevel: string;
  shares: number;
  sleeve: string;
  cluster: string;
  sector: string;
}> = {}) {
  return {
    entryPrice: overrides.entryPrice ?? 100,
    shares: overrides.shares ?? 10,
    currentStop: overrides.currentStop ?? 90,
    stopLoss: overrides.stopLoss ?? 90,
    initialRisk: overrides.initialRisk ?? 10,
    protectionLevel: overrides.protectionLevel ?? 'INITIAL',
    status: 'OPEN',
    stock: {
      ticker: overrides.ticker ?? 'TEST',
      sleeve: overrides.sleeve ?? 'CORE',
      currency: 'USD',
      cluster: overrides.cluster ?? 'TECH',
      sector: overrides.sector ?? 'Technology',
    },
    stopHistory: [],
  };
}

// ── checkStopIntegrity ──

describe('checkStopIntegrity', () => {
  it('returns GREEN for healthy positions', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'AAPL', entryPrice: 150, currentStop: 140, protectionLevel: 'INITIAL', initialRisk: 10 }),
    ]);
    expect(result.status).toBe('GREEN');
    expect(result.id).toBe('D2');
  });

  it('returns GREEN for empty positions', () => {
    expect(checkStopIntegrity([]).status).toBe('GREEN');
  });

  it('flags INITIAL stop >= entry as RED', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'BAD', entryPrice: 100, currentStop: 105, protectionLevel: 'INITIAL' }),
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('BAD');
    expect(result.message).toContain('INITIAL');
  });

  it('allows stop above entry for non-INITIAL levels', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'OK', entryPrice: 100, currentStop: 105, protectionLevel: 'BREAKEVEN' }),
    ]);
    expect(result.status).toBe('GREEN');
  });

  it('flags zero stop as RED', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'ZERO', currentStop: 0 }),
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('ZERO');
  });

  it('flags negative stop as RED', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'NEG', currentStop: -5 }),
    ]);
    expect(result.status).toBe('RED');
  });

  it('flags zero initialRisk as RED', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'NORISK', initialRisk: 0 }),
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('initialRisk');
  });

  it('reports multiple issues', () => {
    const result = checkStopIntegrity([
      makePos({ ticker: 'A', currentStop: 0 }),
      makePos({ ticker: 'B', initialRisk: 0 }),
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('A');
    expect(result.message).toContain('B');
  });
});

// ── checkConfigCoherence ──

describe('checkConfigCoherence', () => {
  it('returns GREEN for CONSERVATIVE profile', () => {
    const result = checkConfigCoherence('CONSERVATIVE' as RiskProfileType);
    expect(result.status).toBe('GREEN');
    expect(result.id).toBe('F');
  });

  it('returns GREEN for BALANCED profile', () => {
    expect(checkConfigCoherence('BALANCED' as RiskProfileType).status).toBe('GREEN');
  });

  it('returns GREEN for SMALL_ACCOUNT profile', () => {
    expect(checkConfigCoherence('SMALL_ACCOUNT' as RiskProfileType).status).toBe('GREEN');
  });

  it('returns GREEN for AGGRESSIVE profile', () => {
    expect(checkConfigCoherence('AGGRESSIVE' as RiskProfileType).status).toBe('GREEN');
  });
});

// ── checkSleeveLimits ──

describe('checkSleeveLimits', () => {
  it('returns GREEN for empty positions', () => {
    const result = checkSleeveLimits([], 10000);
    expect(result.status).toBe('GREEN');
    expect(result.id).toBe('G1');
  });

  it('returns GREEN for a single-sleeve portfolio within its cap of equity', () => {
    const result = checkSleeveLimits([
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 100, shares: 10 }),
      makePos({ ticker: 'B', sleeve: 'CORE', entryPrice: 200, shares: 5 }),
    ], 10000);
    expect(result.status).toBe('GREEN');
  });

  it('flags a fully invested single-sleeve portfolio over its cap', () => {
    const result = checkSleeveLimits([
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 100, shares: 10 }),
    ], 900);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('CORE: 100% > 80%');
  });

  it('measures against equity so a cash-heavy account is not a breach', () => {
    // 98% of invested value is CORE, but invested is only 44% of equity (live 2026-09-22 shape).
    const result = checkSleeveLimits([
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 100, shares: 43 }),
      makePos({ ticker: 'B', sleeve: 'HIGH_RISK', entryPrice: 100, shares: 1 }),
    ], 10000);
    expect(result.status).toBe('GREEN');
  });

  it('uses mark-to-market GBP prices when available', () => {
    const positions = [
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 100, shares: 10 }),
      makePos({ ticker: 'B', sleeve: 'HIGH_RISK', entryPrice: 100, shares: 1 }),
    ];
    expect(checkSleeveLimits(positions, 1500).status).toBe('GREEN');
    expect(checkSleeveLimits(positions, 1500, { A: 150 }, { A: 130 }).status).toBe('RED');
  });

  it('returns GREEN when sleeves are within limits', () => {
    // CORE cap=80%, HIGH_RISK cap=40% — put 70% CORE, 30% HIGH_RISK
    const result = checkSleeveLimits([
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 100, shares: 7 }),        // 700 = 70%
      makePos({ ticker: 'B', sleeve: 'HIGH_RISK', entryPrice: 100, shares: 3 }),   // 300 = 30%
    ], 10000);
    expect(result.status).toBe('GREEN');
  });

  it('flags when a sleeve exceeds its cap', () => {
    // HIGH_RISK has cap of ~0.35, put 90% there
    const result = checkSleeveLimits([
      makePos({ ticker: 'A', sleeve: 'CORE', entryPrice: 10, shares: 1 }),          // 10
      makePos({ ticker: 'B', sleeve: 'HIGH_RISK', entryPrice: 100, shares: 10 }),   // 1000 = 99%
    ], 0);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('HIGH_RISK');
  });
});

// ── checkOpenPositionUniqueness (regression: 2026-05-01 "9 vs 6" bug) ──

describe('checkOpenPositionUniqueness', () => {
  it('returns GREEN when every (stockId, accountType) is unique', () => {
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'AAPL' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'GOOGL' }), stockId: 's2', accountType: 'isa' },
      { ...makePos({ ticker: 'UNFI' }), stockId: 's3', accountType: 'invest' },
    ]);
    expect(result.id).toBe('A4');
    expect(result.status).toBe('GREEN');
    expect(result.message).toContain('3 unique');
  });

  it('returns RED when two OPEN rows share the same stockId + accountType', () => {
    // This is the production bug: auto-trade row + broker-sync row for the
    // same holding, both OPEN under the ISA account.
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'UNFI' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'UNFI' }), stockId: 's1', accountType: 'isa' },
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('UNFI');
    expect(result.message).toContain('isa');
    expect(result.message).toContain('2 rows');
  });

  it('does NOT flag the same stockId held under different account types as duplicate', () => {
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'AAPL' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'AAPL' }), stockId: 's1', accountType: 'invest' },
    ]);
    expect(result.status).toBe('GREEN');
  });

  it('treats a null accountType as invest (default) for grouping', () => {
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'PWR' }), stockId: 's1', accountType: null },
      { ...makePos({ ticker: 'PWR' }), stockId: 's1', accountType: 'invest' },
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('PWR');
  });

  it('lists every duplicated ticker, not just the first', () => {
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'UNFI' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'UNFI' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'GOOGL' }), stockId: 's2', accountType: 'isa' },
      { ...makePos({ ticker: 'GOOGL' }), stockId: 's2', accountType: 'isa' },
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('UNFI');
    expect(result.message).toContain('GOOGL');
  });

  it('returns GREEN with zero positions', () => {
    const result = checkOpenPositionUniqueness([]);
    expect(result.status).toBe('GREEN');
    expect(result.message).toContain('0 unique');
  });

  // Regression: orphan accountType=null rows are invisible to per-account
  // counters in /api/trading212/sync (which only count 'invest' or 'isa').
  // A null orphan would silently under-report holdings on the dashboard.
  it('returns RED when an OPEN position has NULL accountType, even if otherwise unique', () => {
    const result = checkOpenPositionUniqueness([
      { ...makePos({ ticker: 'AAPL' }), stockId: 's1', accountType: 'isa' },
      { ...makePos({ ticker: 'ORPHAN' }), stockId: 's2', accountType: null },
    ]);
    expect(result.status).toBe('RED');
    expect(result.message).toContain('NULL accountType');
    expect(result.message).toContain('ORPHAN');
  });
});

// ── A5: T212 Ticker Mappings (post-RBOT-incident defence-in-depth) ──

describe('tallyInvalidT212TickerRows', () => {
  it('returns GREEN when every populated t212Ticker is well-shaped', () => {
    const result = tallyInvalidT212TickerRows([
      { ticker: 'AAPL', t212Ticker: 'AAPL_US_EQ' },
      { ticker: 'AZN', t212Ticker: 'AZNl_EQ' },
      { ticker: 'SAP', t212Ticker: 'SAPd_EQ' },
    ]);
    expect(result.status).toBe('GREEN');
    expect(result.id).toBe('A5');
    expect(result.label).toBe('T212 Ticker Mappings');
    expect(result.message).toContain('3 populated');
  });

  it('ignores null/empty t212Ticker (those are "unmapped", not "invalid")', () => {
    const result = tallyInvalidT212TickerRows([
      { ticker: 'AAPL', t212Ticker: 'AAPL_US_EQ' },
      { ticker: 'EVO.ST', t212Ticker: null },
      { ticker: 'CATT.L', t212Ticker: '' },
    ]);
    expect(result.status).toBe('GREEN');
  });

  it('returns YELLOW (never RED) when bare values are present', () => {
    // The 11 May 2026 RBOT incident root cause: bare 'RBOT' instead of 'RBOTl_EQ'.
    const result = tallyInvalidT212TickerRows([
      { ticker: 'AAPL', t212Ticker: 'AAPL_US_EQ' },
      { ticker: 'RBOT', t212Ticker: 'RBOT' },
    ]);
    expect(result.status).toBe('YELLOW');
    expect(result.message).toContain('1 stock');
    expect(result.message).toContain('RBOT');
    expect(result.message).toContain('missing _EQ suffix');
    expect(result.message).toContain('repair-t212-tickers-from-instruments');
  });

  it('lists at most 5 ticker examples and indicates more were detected', () => {
    const rows = [
      { ticker: 'A1', t212Ticker: 'A1' },
      { ticker: 'A2', t212Ticker: 'A2' },
      { ticker: 'A3', t212Ticker: 'A3' },
      { ticker: 'A4', t212Ticker: 'A4' },
      { ticker: 'A5', t212Ticker: 'A5' },
      { ticker: 'A6', t212Ticker: 'A6' },
      { ticker: 'A7', t212Ticker: 'A7' },
    ];
    const result = tallyInvalidT212TickerRows(rows);
    expect(result.status).toBe('YELLOW');
    expect(result.message).toContain('7 stock');
    expect(result.message).toContain('A1, A2, A3, A4, A5');
    expect(result.message).toContain('…');
    expect(result.message).not.toContain('A6');
    expect(result.message).not.toContain('A7');
  });

  it('handles an empty input list', () => {
    const result = tallyInvalidT212TickerRows([]);
    expect(result.status).toBe('GREEN');
    expect(result.message).toContain('All 0');
  });
});

// ── A6: Yahoo Ticker Mappings (defence-in-depth on the price feed) ──

describe('tallyInvalidYahooTickerRows', () => {
  it('returns GREEN when every populated yahooTicker is well-shaped', () => {
    const result = tallyInvalidYahooTickerRows([
      { ticker: 'AAPL', yahooTicker: 'AAPL' },
      { ticker: 'AZN', yahooTicker: 'AZN.L' },
      { ticker: 'SAP', yahooTicker: 'SAP.DE' },
      { ticker: 'NOVO-B', yahooTicker: 'NOVO-B.CO' },
    ]);
    expect(result.status).toBe('GREEN');
    expect(result.id).toBe('A6');
    expect(result.label).toBe('Yahoo Ticker Mappings');
  });

  it('ignores null/empty yahooTicker (those rows fall back to ticker-as-Yahoo-symbol)', () => {
    const result = tallyInvalidYahooTickerRows([
      { ticker: 'AAPL', yahooTicker: null },
      { ticker: 'MSFT', yahooTicker: '' },
    ]);
    expect(result.status).toBe('GREEN');
  });

  it('flags T212-style _EQ values as wrong-shape (the most common copy-paste mistake)', () => {
    const result = tallyInvalidYahooTickerRows([
      { ticker: 'AAPL', yahooTicker: 'AAPL_US_EQ' },
      { ticker: 'AZN', yahooTicker: 'AZNl_EQ' },
    ]);
    expect(result.status).toBe('YELLOW');
    expect(result.message).toContain('AAPL→AAPL_US_EQ');
    expect(result.message).toContain('AZN→AZNl_EQ');
  });

  it('flags unknown exchange suffixes', () => {
    const result = tallyInvalidYahooTickerRows([
      { ticker: 'WEIRD', yahooTicker: 'WEIRD.NOPE' },
    ]);
    expect(result.status).toBe('YELLOW');
  });

  it('caps message at 5 examples', () => {
    const rows = [
      { ticker: 'A1', yahooTicker: 'A1_EQ' },
      { ticker: 'A2', yahooTicker: 'A2_EQ' },
      { ticker: 'A3', yahooTicker: 'A3_EQ' },
      { ticker: 'A4', yahooTicker: 'A4_EQ' },
      { ticker: 'A5', yahooTicker: 'A5_EQ' },
      { ticker: 'A6', yahooTicker: 'A6_EQ' },
    ];
    const result = tallyInvalidYahooTickerRows(rows);
    expect(result.status).toBe('YELLOW');
    expect(result.message).toContain('6 stock');
    expect(result.message).toContain('…');
    expect(result.message).not.toContain('A6→');
  });
});
