import { describe, expect, it } from 'vitest';
import { chasingLastN, volumeRatio } from './snapshot-sync';

describe('snapshot-sync indicator algorithms', () => {
  it('chasingLastN returns false on a fresh Day-1 breakout where the prior 20-day high was set >5 bars ago', () => {
    // Newest-first: bar 0 is today's breakout (high=110); bars 1..5 consolidated around 100;
    // bar 12 set the prior 20-day high at 105.
    const bars = Array.from({ length: 25 }, (_, i) => ({
      high: i === 0 ? 110 : i === 12 ? 105 : 100,
    }));
    expect(chasingLastN(bars, 20, 5)).toBe(false);
  });

  it('chasingLastN returns true when the prior 20-day high was set within the last 5 prior bars (multi-day run)', () => {
    // Bar 2 (two days ago) already reached the prior 20-day high of 108, and today (bar 0) is 110.
    const bars = Array.from({ length: 25 }, (_, i) => ({
      high: i === 0 ? 110 : i === 2 ? 108 : 100,
    }));
    expect(chasingLastN(bars, 20, 5)).toBe(true);
  });

  it('volumeRatio excludes today from the 20-day average denominator so a volume surge is not diluted', () => {
    // Today's volume = 300, prior 20 days = 100 each → true ratio = 3.0 (not 300 / 110 = 2.727).
    const bars = [
      { volume: 300 },
      ...Array.from({ length: 20 }, () => ({ volume: 100 })),
    ];
    expect(volumeRatio(bars)).toBeCloseTo(3.0, 5);
  });
});
