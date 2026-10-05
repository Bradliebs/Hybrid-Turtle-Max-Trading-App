import { describe, expect, it } from 'vitest';
import { screenEntryPolicy, type EntryPolicyObservation } from './entry-policy-screen';
import { classifyCandidate, DEFAULT_GRADE_THRESHOLDS } from '../src/lib/candidate-grade';
import type { ScanCandidate } from '../src/types';

const observed: EntryPolicyObservation = {
  regime: 'BULLISH', status: 'READY', price: 100, trigger: 100,
  ncs: 70, bqs: 55, fws: 30, volumeRatio: 0.15, relativeStrength: 0, atrSpiking: false,
};

describe('necessary entry-policy conditions, not execution approval', () => {
  it('keeps exact threshold matches incomplete rather than granting eligibility', () => {
    expect(screenEntryPolicy(observed, 0.15)).toMatchObject({
      verdict: 'INCOMPLETE', rejected: [], missing: [],
    });
    expect(screenEntryPolicy(observed, 0.15).unresolved).toHaveLength(4);
  });

  it.each([
    ['regime', { regime: 'BEARISH' }], ['status', { status: 'COOLDOWN' }],
    ['status', { status: 'EARNINGS_BLOCK' }], ['status', { status: 'WAIT_PULLBACK' }],
    ['ncs', { ncs: 69.99 }], ['bqs', { bqs: 54.99 }], ['fws', { fws: 30.01 }],
    ['volume', { volumeRatio: 0.149 }], ['relativeStrength', { relativeStrength: -0.01 }],
    ['trigger', { price: 99.99 }], ['atrSpike', { atrSpiking: true }],
  ] as Array<[string, Partial<EntryPolicyObservation>]>)('rejects failing %s', (reason, change) => {
    expect(screenEntryPolicy({ ...observed, ...change }, 0.15)).toMatchObject({
      verdict: 'REJECTED', rejected: [reason],
    });
  });

  it.each(Object.keys(observed) as Array<keyof EntryPolicyObservation>)(
    'does not replace missing %s with a favorable default', field => {
      const result = screenEntryPolicy({ ...observed, [field]: null }, 0.15);
      expect(result.verdict).toBe('INCOMPLETE');
      expect(result.missing).toHaveLength(1);
    },
  );

  it('separates known rejection from other missing evidence', () => {
    expect(screenEntryPolicy({ ...observed, ncs: null, regime: 'NEUTRAL' }, 0.15))
      .toMatchObject({ verdict: 'REJECTED', rejected: ['regime'], missing: ['ncs'] });
  });

  it.each([NaN, Infinity, 0, -1])('does not treat invalid prices as a crossing: %s', price => {
    expect(screenEntryPolicy({ ...observed, price }, 0.15).missing).toContain('trigger');
  });

  it('uses the supplied session threshold without tuning it', () => {
    expect(screenEntryPolicy(observed, 0.4).rejected).toEqual(['volume']);
    expect(() => screenEntryPolicy(observed, NaN)).toThrow('threshold');
  });

  it('agrees with production classification on each necessary-condition rejection', () => {
    const variants: EntryPolicyObservation[] = [
      observed, { ...observed, regime: 'NEUTRAL' }, { ...observed, status: 'COOLDOWN' },
      { ...observed, status: 'EARNINGS_BLOCK' }, { ...observed, status: 'WAIT_PULLBACK' },
      { ...observed, ncs: 69 }, { ...observed, bqs: 54 }, { ...observed, fws: 31 },
      { ...observed, volumeRatio: 0.1 }, { ...observed, relativeStrength: -1 },
      { ...observed, price: 99 }, { ...observed, atrSpiking: true },
    ];
    for (const observation of variants) {
      const candidate: ScanCandidate = {
        id: 'synthetic', ticker: 'TEST', name: 'Synthetic only', sleeve: 'CORE',
        sector: 'TEST', cluster: 'TEST', price: observation.price!,
        entryTrigger: observation.trigger!, stopPrice: 90, distancePercent: 0,
        status: observation.status as ScanCandidate['status'], rankScore: 80,
        passesAllFilters: true, passesRiskGates: true, passesAntiChase: true,
        shares: 1, riskDollars: 10, riskPercent: 1, totalCost: 100,
        technicals: {
          currentPrice: observation.price!, ma200: 80, adx: 30, plusDI: 25, minusDI: 15,
          atr: 2, atr20DayAgo: 2, atrSpiking: observation.atrSpiking!, medianAtr14: 2,
          atrPercent: 2, twentyDayHigh: 100, efficiency: 55,
          // Production RS is a 0–100 score; 50 + excess% keeps the sign that both rules test.
          relativeStrength: 50 + observation.relativeStrength!, volumeRatio: observation.volumeRatio!,
          failedBreakoutAt: null,
        },
        filterResults: {
          priceAboveMa200: true, adxAbove20: true, plusDIAboveMinusDI: true,
          atrPercentBelow8: true, efficiencyAbove30: true, dataQuality: true,
          atrSpiking: observation.atrSpiking!, atrSpikeAction: 'NONE',
        },
      };
      const grade = classifyCandidate(candidate, {
        regime: observation.regime!, healthOverall: 'GREEN', ncs: observation.ncs,
        bqs: observation.bqs, fws: observation.fws,
      }, { ...DEFAULT_GRADE_THRESHOLDS, minVolumeRatio: 0.15 });
      expect(screenEntryPolicy(observation, 0.15).rejected.length === 0)
        .toBe(grade.grade === 'A_GRADE_BUY');
    }
  });
});