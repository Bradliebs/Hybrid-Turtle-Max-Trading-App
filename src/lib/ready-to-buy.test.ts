import { describe, it, expect } from 'vitest';
import {
  filterTriggerMet,
  getSnapshotAge,
  getClusterWarnings,
  getBuyButtonState,
  type CrossRefTicker,
} from './ready-to-buy';

// ── Helper to build a minimal CrossRefTicker for testing ────
function makeTicker(overrides: Partial<CrossRefTicker> = {}): CrossRefTicker {
  return {
    ticker: 'TEST',
    name: 'Test Corp',
    sleeve: 'CORE',
    scanStatus: 'READY',
    scanRankScore: 50,
    scanPassesFilters: true,
    scanPassesRiskGates: true,
    scanPassesAntiChase: true,
    scanDistancePercent: 0,
    scanEntryTrigger: 100,
    scanStopPrice: 90,
    scanPrice: 105,
    scanShares: 10,
    scanRiskDollars: 100,
    dualBQS: 70,
    dualFWS: 20,
    dualNCS: 65,
    dualAction: 'Auto-Yes',
    dualStatus: 'READY',
    dualClose: 105,
    dualEntryTrigger: 100,
    dualStopLevel: 90,
    dualDistancePct: 0,
    priceCurrency: 'USD',
    matchType: 'BOTH_RECOMMEND',
    agreementScore: 80,
    bps: null,
    ...overrides,
  };
}

// ── filterTriggerMet ─────────────────────────────────────────

describe('filterTriggerMet', () => {
  it('includes candidates where price >= trigger', () => {
    const tickers = [
      makeTicker({ ticker: 'HIT', scanPrice: 105, scanEntryTrigger: 100 }),
      makeTicker({ ticker: 'EXACT', scanPrice: 100, scanEntryTrigger: 100 }),
    ];
    const result = filterTriggerMet(tickers);
    expect(result.map((r) => r.ticker)).toEqual(['HIT', 'EXACT']);
  });

  it('excludes candidates where price < trigger', () => {
    const tickers = [
      makeTicker({ ticker: 'MISS', scanPrice: 99, scanEntryTrigger: 100 }),
    ];
    expect(filterTriggerMet(tickers)).toHaveLength(0);
  });

  it('excludes candidates with null scanPrice', () => {
    const tickers = [
      makeTicker({ ticker: 'NULL_PRICE', scanPrice: null, scanEntryTrigger: 100 }),
    ];
    expect(filterTriggerMet(tickers)).toHaveLength(0);
  });

  it('excludes candidates with null scanEntryTrigger', () => {
    const tickers = [
      makeTicker({ ticker: 'NULL_TRIGGER', scanPrice: 105, scanEntryTrigger: null }),
    ];
    expect(filterTriggerMet(tickers)).toHaveLength(0);
  });

  it('excludes Auto-No candidates (FWS > 65)', () => {
    const tickers = [
      makeTicker({ ticker: 'REJECTED', scanPrice: 110, scanEntryTrigger: 100, dualAction: 'Auto-No' }),
    ];
    expect(filterTriggerMet(tickers)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterTriggerMet([])).toEqual([]);
  });

  it('sorts by NCS descending', () => {
    const tickers = [
      makeTicker({ ticker: 'LOW', dualNCS: 40, scanPrice: 105, scanEntryTrigger: 100 }),
      makeTicker({ ticker: 'HIGH', dualNCS: 85, scanPrice: 110, scanEntryTrigger: 100 }),
      makeTicker({ ticker: 'MID', dualNCS: 60, scanPrice: 102, scanEntryTrigger: 100 }),
    ];
    const result = filterTriggerMet(tickers);
    expect(result.map((r) => r.ticker)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('calculates aboveTriggerPct correctly', () => {
    const tickers = [
      makeTicker({ scanPrice: 110, scanEntryTrigger: 100 }),
    ];
    const result = filterTriggerMet(tickers);
    expect(result[0].aboveTriggerPct).toBeCloseTo(10, 1);
  });

  it('falls back to agreementScore when NCS is equal', () => {
    const tickers = [
      makeTicker({ ticker: 'LOW_AGR', dualNCS: 60, agreementScore: 50, scanPrice: 105, scanEntryTrigger: 100 }),
      makeTicker({ ticker: 'HIGH_AGR', dualNCS: 60, agreementScore: 90, scanPrice: 110, scanEntryTrigger: 100 }),
    ];
    const result = filterTriggerMet(tickers);
    expect(result[0].ticker).toBe('HIGH_AGR');
  });
});

// ── getSnapshotAge ───────────────────────────────────────────

describe('getSnapshotAge', () => {
  const mondayMorning = new Date('2026-08-10T09:00:00.000Z');

  it('returns critical for null input', () => {
    const age = getSnapshotAge(null, mondayMorning);
    expect(age.stale).toBe(true);
    expect(age.critical).toBe(true);
    expect(age.label).toBe('No snapshot data');
  });

  it('returns critical for invalid date', () => {
    const age = getSnapshotAge('not-a-date', mondayMorning);
    expect(age.critical).toBe(true);
  });

  it('returns fresh for recent snapshot', () => {
    const recentDate = '2026-08-10T07:00:00.000Z';
    const age = getSnapshotAge(recentDate, mondayMorning);
    expect(age.stale).toBe(false);
    expect(age.critical).toBe(false);
    expect(age.hours).toBeCloseTo(2, 0);
  });

  it('returns stale (not critical) for 3-day-old snapshot', () => {
    const fridayMorning = new Date('2026-08-07T09:00:00.000Z');
    const age = getSnapshotAge('2026-08-04T09:00:00.000Z', fridayMorning);
    expect(age.stale).toBe(true);
    expect(age.critical).toBe(false);
    expect(age.label).toBe('3d ago');
  });

  it('returns critical after more than 7 weekday days', () => {
    const fridayMorning = new Date('2026-08-14T09:00:00.000Z');
    const age = getSnapshotAge('2026-08-04T09:00:00.000Z', fridayMorning);
    expect(age.stale).toBe(true);
    expect(age.critical).toBe(true);
    expect(age.label).toBe('10d ago');
  });

  it('shows "Just now" for very recent data', () => {
    const age = getSnapshotAge('2026-08-10T08:30:00.000Z', mondayMorning);
    expect(age.label).toBe('Just now');
  });

  it('keeps a Friday evening snapshot fresh on Monday morning', () => {
    const age = getSnapshotAge('2026-08-07T18:00:00.000Z', mondayMorning);

    expect(age.hours).toBe(63);
    expect(age.label).toBe('3d ago');
    expect(age.stale).toBe(false);
    expect(age.critical).toBe(false);
  });

  it('becomes stale after more than 48 weekday hours', () => {
    const thursdayMorning = new Date('2026-08-13T09:00:00.000Z');
    const age = getSnapshotAge('2026-08-07T09:00:00.000Z', thursdayMorning);

    expect(age.stale).toBe(true);
    expect(age.critical).toBe(false);
  });
});

// ── getClusterWarnings ───────────────────────────────────────

describe('getClusterWarnings', () => {
  it('returns empty when no cluster data', () => {
    const warnings = getClusterWarnings('AAPL', undefined, undefined, [
      { ticker: 'MSFT', cluster: 'Tech' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('detects shared cluster with open position', () => {
    const warnings = getClusterWarnings('AAPL', 'US_Tech', undefined, [
      { ticker: 'MSFT', cluster: 'US_Tech' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MSFT');
    expect(warnings[0]).toContain('US_Tech');
  });

  it('does not warn for different clusters', () => {
    const warnings = getClusterWarnings('AAPL', 'US_Tech', undefined, [
      { ticker: 'XOM', cluster: 'Energy' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('skips self-comparison', () => {
    const warnings = getClusterWarnings('AAPL', 'US_Tech', undefined, [
      { ticker: 'AAPL', cluster: 'US_Tech' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('returns multiple warnings for multiple matches', () => {
    const warnings = getClusterWarnings('AAPL', 'US_Tech', undefined, [
      { ticker: 'MSFT', cluster: 'US_Tech' },
      { ticker: 'GOOG', cluster: 'US_Tech' },
    ]);
    expect(warnings).toHaveLength(2);
  });
});

// ── getBuyButtonState ────────────────────────────────────────

describe('getBuyButtonState', () => {
  it('Sunday: disabled grey (planning)', () => {
    const state = getBuyButtonState(0);
    expect(state.enabled).toBe(false);
    expect(state.color).toBe('grey');
  });

  it('Monday: enabled green (execution)', () => {
    const state = getBuyButtonState(1);
    expect(state.enabled).toBe(true);
    expect(state.color).toBe('green');
  });

  it('Tuesday: enabled green (execution)', () => {
    const state = getBuyButtonState(2);
    expect(state.enabled).toBe(true);
    expect(state.color).toBe('green');
  });

  it('Wednesday: enabled green (execution)', () => {
    const state = getBuyButtonState(3);
    expect(state.enabled).toBe(true);
    expect(state.color).toBe('green');
  });

  it('Thursday: enabled green', () => {
    const state = getBuyButtonState(4);
    expect(state.enabled).toBe(true);
    expect(state.color).toBe('green');
  });

  it('Friday: enabled green', () => {
    const state = getBuyButtonState(5);
    expect(state.enabled).toBe(true);
    expect(state.color).toBe('green');
  });

  it('Saturday: disabled grey (markets closed)', () => {
    const state = getBuyButtonState(6);
    expect(state.enabled).toBe(false);
    expect(state.color).toBe('grey');
  });
});
