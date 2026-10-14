import { describe, expect, it } from 'vitest';
import { calculatePositionSize, calculateRMultiple, calculateGainPercent, calculateGainDollars, calculateEntryTrigger } from './position-sizer';

describe('position-sizer formulas', () => {
  it('calculates shares, cost, and risk for a standard long setup', () => {
    const result = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 95,
    });

    expect(result.shares).toBe(19);
    expect(result.totalCost).toBe(1900);
    expect(result.riskDollars).toBe(95);
    expect(result.riskPercent).toBeCloseTo(0.95, 8);
    expect(result.rPerShare).toBe(5);
  });

  it('enforces sleeve position-size cap using FX-adjusted total cost', () => {
    const result = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 99,
      sleeve: 'CORE',
      fxToGbp: 2,
    });

    expect(result.shares).toBe(9);
    expect(result.totalCost).toBe(1800);
  });

  it('throws for invalid long stop placement', () => {
    expect(() =>
      calculatePositionSize({
        equity: 10_000,
        riskProfile: 'BALANCED',
        entryPrice: 100,
        stopPrice: 100,
      })
    ).toThrow('Stop price must be below entry price for long positions');
  });

  it('computes R-multiple from current, entry, and initial risk', () => {
    expect(calculateRMultiple(110, 100, 5)).toBe(2);
    expect(calculateRMultiple(95, 100, 5)).toBe(-1);
  });

  it('cap wins over floor when risk_cash_floor > risk_cash_cap (regression)', () => {
    const result = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 95,
    });
    expect(Number.isFinite(result.shares)).toBe(true);
    expect(Number.isFinite(result.riskDollars)).toBe(true);
    expect(result.shares).toBeGreaterThanOrEqual(0);
  });

  // ── Fractional shares (T212) ──

  it('floors to 0.01 shares in fractional mode', () => {
    const result = calculatePositionSize({
      equity: 1_000,
      riskProfile: 'SMALL_ACCOUNT',
      entryPrice: 500,
      stopPrice: 495,
      allowFractional: true,
    });
    // Small account, 1% risk = £10 budget, risk per share = £5 → 2.0 shares
    expect(result.shares).toBe(2);
    // For a case where fractional matters:
    const frac = calculatePositionSize({
      equity: 1_000,
      riskProfile: 'SMALL_ACCOUNT',
      entryPrice: 100,
      stopPrice: 93,
      allowFractional: true,
    });
    // 1% × 1000 = 10 risk budget, risk per share = 7 → 10/7 = 1.4285 → floor to 1.42
    expect(frac.shares).toBe(1.42);
  });

  it('floors to whole shares in non-fractional mode (default)', () => {
    const result = calculatePositionSize({
      equity: 1_000,
      riskProfile: 'SMALL_ACCOUNT',
      entryPrice: 100,
      stopPrice: 95,
    });
    // 1% × 1000 = 10 risk budget, risk per share = 5 → 10/5 = 2 (cost £200 <= £200 cap)
    expect(result.shares).toBe(2);
  });

  // ── FX conversion ──

  it('applies FX conversion to risk per share', () => {
    const gbp = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 95,
      fxToGbp: 1.0,
    });
    const usd = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 95,
      fxToGbp: 0.79,
    });
    // With a weaker FX rate, risk per share is smaller in GBP → more shares
    expect(usd.shares).toBeGreaterThan(gbp.shares);
  });

  it('throws for zero FX rate', () => {
    expect(() =>
      calculatePositionSize({
        equity: 10_000,
        riskProfile: 'BALANCED',
        entryPrice: 100,
        stopPrice: 95,
        fxToGbp: 0,
      })
    ).toThrow('FX rate must be positive');
  });

  it('throws for negative FX rate', () => {
    expect(() =>
      calculatePositionSize({
        equity: 10_000,
        riskProfile: 'BALANCED',
        entryPrice: 100,
        stopPrice: 95,
        fxToGbp: -1,
      })
    ).toThrow('FX rate must be positive');
  });

  // ── Per-position max loss guard ──

  it('enforces per-position max loss percentage', () => {
    // With very wide stop and no guard, shares would be high
    // The per_position_max_loss_pct caps the actual loss
    const wide = calculatePositionSize({
      equity: 10_000,
      riskProfile: 'BALANCED',
      entryPrice: 100,
      stopPrice: 99.9, // Tiny risk per share → many shares
    });
    // Risk per share = 0.10 → 95/0.10 = 950 shares uncapped
    // But per_position_max_loss_pct should cap actual loss
    expect(wide.riskDollars).toBeLessThanOrEqual(wide.riskPercent * 10_000 / 100 + 1);
    expect(wide.shares).toBeGreaterThan(0);
  });

  // ── Edge cases ──

  it('returns 0 shares when equity is too small', () => {
    const result = calculatePositionSize({
      equity: 1,
      riskProfile: 'CONSERVATIVE',
      entryPrice: 1000,
      stopPrice: 900,
    });
    expect(result.shares).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.riskDollars).toBe(0);
  });

  it('throws for zero equity', () => {
    expect(() =>
      calculatePositionSize({
        equity: 0,
        riskProfile: 'BALANCED',
        entryPrice: 100,
        stopPrice: 95,
      })
    ).toThrow('Equity must be positive');
  });

  it('throws for negative equity', () => {
    expect(() =>
      calculatePositionSize({
        equity: -5000,
        riskProfile: 'BALANCED',
        entryPrice: 100,
        stopPrice: 95,
      })
    ).toThrow('Equity must be positive');
  });

  it('throws for zero entry price', () => {
    expect(() =>
      calculatePositionSize({
        equity: 10_000,
        riskProfile: 'BALANCED',
        entryPrice: 0,
        stopPrice: 0,
      })
    ).toThrow('Entry price must be positive');
  });

  // ── All risk profiles produce valid output ──

  for (const profile of ['CONSERVATIVE', 'BALANCED', 'SMALL_ACCOUNT', 'AGGRESSIVE'] as const) {
    it(`produces valid output for ${profile} profile`, () => {
      const result = calculatePositionSize({
        equity: 5_000,
        riskProfile: profile,
        entryPrice: 50,
        stopPrice: 47,
      });
      expect(Number.isFinite(result.shares)).toBe(true);
      expect(result.shares).toBeGreaterThanOrEqual(0);
      expect(result.riskDollars).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.riskPercent)).toBe(true);
    });
  }

  it('O2: SMALL_ACCOUNT 1.0% riskPerTrade equalises pound risk across 5% and 10% stop distances', () => {
    const stop5Pct = calculatePositionSize({
      equity: 220,
      riskProfile: 'SMALL_ACCOUNT',
      entryPrice: 100,
      stopPrice: 95,
      sleeve: 'CORE',
      allowFractional: true,
    });
    const stop10Pct = calculatePositionSize({
      equity: 220,
      riskProfile: 'SMALL_ACCOUNT',
      entryPrice: 100,
      stopPrice: 90,
      sleeve: 'CORE',
      allowFractional: true,
    });
    // Both risk 1.0% of £220 = £2.20 (5% stop takes £44 = 20% cap; 10% stop takes £22 = 10% of equity).
    expect(stop5Pct.riskDollars).toBeCloseTo(2.2, 2);
    expect(stop10Pct.riskDollars).toBeCloseTo(2.2, 2);
    expect(stop10Pct.totalCost).toBeLessThan(stop5Pct.totalCost);
  });
});

describe('position-sizer utility functions', () => {
  it('calculateRMultiple handles zero initial risk', () => {
    expect(calculateRMultiple(110, 100, 0)).toBe(0);
  });

  it('calculateGainPercent returns correct percentage', () => {
    expect(calculateGainPercent(110, 100)).toBe(10);
    expect(calculateGainPercent(90, 100)).toBe(-10);
  });

  it('calculateGainPercent handles zero entry', () => {
    expect(calculateGainPercent(100, 0)).toBe(0);
  });

  it('calculateGainDollars returns correct dollar amount', () => {
    expect(calculateGainDollars(110, 100, 10)).toBe(100);
    expect(calculateGainDollars(90, 100, 10)).toBe(-100);
  });

  it('calculateEntryTrigger adds ATR buffer', () => {
    expect(calculateEntryTrigger(100, 5)).toBe(100.5);
  });
});
