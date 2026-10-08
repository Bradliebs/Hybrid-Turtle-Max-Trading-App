import { describe, expect, it } from 'vitest';
import { computeCapitalAdjustedDrawdown, fromFirstBrokerSnapshot, toCapitalEvents } from './capital-adjusted-drawdown';

const at = (day: string) => new Date(`2026-08-${day}T20:00:00Z`);

describe('capital-adjusted drawdown', () => {
  it('does not count a withdrawal as a trading loss', () => {
    const snapshots = [
      { capturedAt: at('01'), equity: 800 },
      { capturedAt: at('02'), equity: 816 }, // +2% trading
      { capturedAt: at('03'), equity: 416 }, // £400 withdrawn, flat trading
    ];
    const events = [{ at: '2026-08-03T09:18:00Z', amount: -400, type: 'WITHDRAW' }];
    const result = computeCapitalAdjustedDrawdown(snapshots, events);
    expect(result.currentDrawdownPct).toBeCloseTo(0, 6);
    expect(computeCapitalAdjustedDrawdown(snapshots, []).currentDrawdownPct).toBeCloseTo(49.0, 1);
  });

  it('still reports real losses after a withdrawal', () => {
    const snapshots = [
      { capturedAt: at('01'), equity: 1000 },
      { capturedAt: at('02'), equity: 500 }, // £500 withdrawn
      { capturedAt: at('03'), equity: 450 }, // then a 10% trading loss
    ];
    const events = [{ at: '2026-08-02T10:00:00Z', amount: -500, type: 'WITHDRAW' }];
    const result = computeCapitalAdjustedDrawdown(snapshots, events);
    expect(result.currentDrawdownPct).toBeCloseTo(10, 6);
    expect(result.maxDrawdownPct).toBeCloseTo(10, 6);
  });

  it('treats a deposit as money in, not a gain', () => {
    const snapshots = [
      { capturedAt: at('01'), equity: 100 },
      { capturedAt: at('02'), equity: 190 }, // £100 deposited, 10% trading loss
    ];
    const result = computeCapitalAdjustedDrawdown(snapshots, [{ at: '2026-08-02T08:00:00Z', amount: 100, type: 'DEPOSIT' }]);
    expect(result.series[1].index).toBeCloseTo(90, 6);
    expect(result.currentDrawdownPct).toBeCloseTo(10, 6);
  });

  it('reports the last step so an unrecorded withdrawal can be flagged', () => {
    const snapshots = [{ capturedAt: at('01'), equity: 300 }, { capturedAt: at('02'), equity: 200 }];
    expect(computeCapitalAdjustedDrawdown(snapshots, []).lastStepPct).toBeCloseTo(-33.33, 2);
    expect(computeCapitalAdjustedDrawdown(snapshots, [{ at: '2026-08-02T09:00:00Z', amount: -100, type: 'WITHDRAW' }]).lastStepPct)
      .toBeCloseTo(0, 6);
    expect(computeCapitalAdjustedDrawdown([snapshots[0]], []).lastStepPct).toBeNull();
  });

  it('starts history at the first broker snapshot so seed-default rows are ignored', () => {
    const rows = [{ source: 'NIGHTLY', equity: 10000 }, { source: 'BROKER', equity: 900 }, { source: 'NIGHTLY', equity: 910 }];
    expect(fromFirstBrokerSnapshot(rows).map(row => row.equity)).toEqual([900, 910]);
    expect(fromFirstBrokerSnapshot([{ source: 'NIGHTLY', equity: 10000 }])).toEqual([]);
  });

  it('normalises broker transactions: GBP deposits in, withdrawals out, other types and currencies ignored', () => {
    expect(toCapitalEvents([
      { type: 'WITHDRAW', amount: -150, currency: 'GBP', dateTime: '2026-07-03T20:28:00Z', reference: 'w' },
      { type: 'DEPOSIT', amount: 25, currency: 'GBP', dateTime: '2026-04-24T10:00:00Z' },
      { type: 'INTEREST_ON_FREE_CASH', amount: 0.4, currency: 'GBP', dateTime: '2026-07-01T00:00:00Z' },
      { type: 'DEPOSIT', amount: 10, currency: 'EUR', dateTime: '2026-05-01T00:00:00Z' },
    ])).toEqual([
      { at: '2026-04-24T10:00:00.000Z', amount: 25, type: 'DEPOSIT', reference: undefined },
      { at: '2026-07-03T20:28:00.000Z', amount: -150, type: 'WITHDRAW', reference: 'w' },
    ]);
  });
});
