import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  calculateMA,
  calculateEMA,
  calculateATR,
  calculateADX,
  calculateTrendEfficiency,
  calculate20DayHigh,
  getPriorNDayHigh,
  getActiveProvider,
  getDataFreshness,
  normalizeBatchPricesToGBP,
  normalizePriceToGBP,
  shouldSkipStartupPreCache,
} from './market-data';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: generate N bars of OHLCV data sorted newest-first ──
function makeBars(count: number, base = 100, step = 1) {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-04-${String(count - i).padStart(2, '0')}`,
    open: base + (count - 1 - i) * step,
    high: base + (count - 1 - i) * step + 2,
    low: base + (count - 1 - i) * step - 2,
    close: base + (count - 1 - i) * step,
    volume: 1_000_000,
  }));
}

describe('shouldSkipStartupPreCache', () => {
  it('skips startup pre-cache during production build and standalone CLI cron/script runs', () => {
    expect(shouldSkipStartupPreCache({ NEXT_PHASE: 'phase-production-build' })).toBe(true);
    expect(shouldSkipStartupPreCache({ HYBRIDTURTLE_SKIP_STARTUP_PRECACHE: 'true' })).toBe(true);
    expect(shouldSkipStartupPreCache({ VITEST: 'true' })).toBe(true);
    expect(shouldSkipStartupPreCache({ argv1: 'H:\\Hybrid-Turtle-Max\\src\\cron\\auto-trade.ts' })).toBe(true);
    expect(shouldSkipStartupPreCache({ argv1: 'src/cron/hourly-status.ts' })).toBe(true);
    expect(shouldSkipStartupPreCache({ argv1: 'scripts/system-check.ts' })).toBe(true);
    expect(shouldSkipStartupPreCache({ argv1: 'node_modules/next/dist/bin/next' })).toBe(false);
    expect(shouldSkipStartupPreCache({ HYBRIDTURTLE_SKIP_STARTUP_PRECACHE: 'false' })).toBe(false);
  });
});

describe('GBP price normalization', () => {
  it('treats Yahoo .L prices as GBX even when Stock.currency is stale GBP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const normalized = await normalizeBatchPricesToGBP(
      { 'AZN.L': 12750, RIO: 70 },
      { 'AZN.L': 'GBP', RIO: 'GBP' }
    );

    expect(normalized['AZN.L']).toBe(127.5);
    expect(normalized.RIO).toBe(70);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AZN.L is a UK ticker with Stock.currency='GBP'"));
  });

  it('treats Trading212-style UK tickers as GBX when Stock.currency is stale GBP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const normalized = await normalizeBatchPricesToGBP(
      { AZNl: 12750 },
      { AZNl: 'GBP' }
    );

    expect(normalized.AZNl).toBe(127.5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AZNl is a UK ticker with Stock.currency='GBP'"));
  });

  it('preserves exact GBp as pence before canonicalising currency codes', async () => {
    const normalized = await normalizePriceToGBP(512.4, 'TEST', 'GBp');

    expect(normalized).toBeCloseTo(5.124);
  });
});

describe('calculateMA', () => {
  it('calculates simple moving average of first N prices', () => {
    const prices = [10, 20, 30, 40, 50]; // newest-first
    expect(calculateMA(prices, 3)).toBeCloseTo(20); // (10+20+30)/3
    expect(calculateMA(prices, 5)).toBeCloseTo(30); // (10+20+30+40+50)/5
  });

  it('returns 0 when insufficient data', () => {
    expect(calculateMA([10, 20], 5)).toBe(0);
    expect(calculateMA([], 1)).toBe(0);
  });

  it('handles single-element period', () => {
    expect(calculateMA([42, 100, 200], 1)).toBe(42);
  });
});

describe('calculateEMA', () => {
  it('returns 0 when insufficient data', () => {
    expect(calculateEMA([10], 5)).toBe(0);
    expect(calculateEMA([], 3)).toBe(0);
  });

  it('returns SMA when data length equals period', () => {
    const prices = [10, 20, 30]; // newest-first
    // With exactly 3 bars and period 3, seed SMA = (10+20+30)/3 = 20
    // No forward walk → EMA = SMA = 20
    expect(calculateEMA(prices, 3)).toBeCloseTo(20);
  });

  it('EMA is closer to recent prices than SMA', () => {
    // 10 bars with a jump: newest bar is much higher than the rest
    const prices = [200, 90, 80, 70, 60, 50, 40, 30, 20, 10]; // newest-first, big spike at top
    const ema5 = calculateEMA(prices, 5);
    const ma5 = calculateMA(prices, 5);
    // EMA should be higher than SMA because EMA weights the recent 200 more
    expect(ema5).toBeGreaterThan(ma5);
  });

  it('produces stable value for flat prices', () => {
    const prices = [50, 50, 50, 50, 50, 50];
    expect(calculateEMA(prices, 3)).toBeCloseTo(50);
  });
});

describe('calculateATR', () => {
  it('returns 0 when insufficient data', () => {
    const bars = makeBars(5);
    expect(calculateATR(bars, 14)).toBe(0); // need 15 bars for period 14
  });

  it('calculates ATR for uniform bars', () => {
    // All bars have high-low range of 4 (base ± 2), no gaps
    const bars = makeBars(20, 100, 0); // flat prices, each bar: H=102, L=98, C=100
    const atr = calculateATR(bars, 14);
    // TR = max(H-L, |H-prevC|, |L-prevC|) = max(4, 2, 2) = 4
    expect(atr).toBeCloseTo(4);
  });

  it('ATR increases with larger price swings', () => {
    const calmBars = makeBars(20, 100, 0); // flat, H-L=4
    const wildBars = makeBars(20, 100, 0).map(b => ({
      ...b,
      high: b.close + 10,
      low: b.close - 10,
    }));
    expect(calculateATR(wildBars, 14)).toBeGreaterThan(calculateATR(calmBars, 14));
  });

  it('uses default period of 14', () => {
    const bars = makeBars(20);
    expect(calculateATR(bars)).toBeGreaterThan(0);
  });
});

describe('calculateADX', () => {
  it('returns zeros when insufficient data', () => {
    const bars = makeBars(10);
    const result = calculateADX(bars, 14); // need 29 bars
    expect(result.adx).toBe(0);
  });

  it('returns positive ADX for trending data', () => {
    // 40 bars trending up: each bar's high is higher than previous
    const bars = makeBars(40, 100, 2); // step=2, clear uptrend
    const result = calculateADX(bars, 14);
    expect(result.adx).toBeGreaterThan(0);
    expect(result.plusDI).toBeGreaterThan(0);
  });

  it('+DI > -DI in an uptrend', () => {
    const bars = makeBars(40, 100, 3); // strong uptrend
    const result = calculateADX(bars, 14);
    expect(result.plusDI).toBeGreaterThan(result.minusDI);
  });

  it('ADX structure has all required fields', () => {
    const bars = makeBars(40);
    const result = calculateADX(bars);
    expect(result).toHaveProperty('adx');
    expect(result).toHaveProperty('plusDI');
    expect(result).toHaveProperty('minusDI');
    expect(typeof result.adx).toBe('number');
  });
});

describe('calculateTrendEfficiency', () => {
  it('returns 0 when insufficient data', () => {
    expect(calculateTrendEfficiency([10, 20], 5)).toBe(0);
  });

  it('returns 100 for a perfectly straight trend', () => {
    // Perfectly linear: [20, 19, 18, 17, 16] → netMove=4, totalPath=4 → 100%
    const prices = [20, 19, 18, 17, 16];
    expect(calculateTrendEfficiency(prices, 5)).toBeCloseTo(100);
  });

  it('returns near 0 for choppy sideways movement', () => {
    // Goes up and down repeatedly, ends near start
    const prices = [100, 110, 100, 110, 100, 110, 100, 110, 100, 110,
                    100, 110, 100, 110, 100, 110, 100, 110, 100, 100];
    const te = calculateTrendEfficiency(prices, 20);
    expect(te).toBeLessThan(5); // very choppy, near 0
  });

  it('uses default period of 20', () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + i);
    expect(calculateTrendEfficiency(prices)).toBeGreaterThan(0);
  });
});

describe('calculate20DayHigh', () => {
  it('finds highest value in first 20 bars', () => {
    const data = Array.from({ length: 25 }, (_, i) => ({ high: 100 + i }));
    // First 20 bars: highs are 100..119 → max is 119
    expect(calculate20DayHigh(data)).toBe(119);
  });

  it('ignores bars beyond position 20', () => {
    const data = [
      ...Array.from({ length: 20 }, () => ({ high: 50 })),
      { high: 999 }, // position 20 — outside window
    ];
    expect(calculate20DayHigh(data)).toBe(50);
  });
});

describe('getPriorNDayHigh', () => {
  it('excludes the current bar (index 0)', () => {
    const data = [{ high: 999 }, { high: 100 }, { high: 200 }, { high: 150 }];
    expect(getPriorNDayHigh(data, 3)).toBe(200); // skips 999 at index 0
  });

  it('returns 0 for n <= 0', () => {
    expect(getPriorNDayHigh([{ high: 100 }], 0)).toBe(0);
    expect(getPriorNDayHigh([{ high: 100 }], -1)).toBe(0);
  });

  it('returns 0 for single-element data', () => {
    expect(getPriorNDayHigh([{ high: 100 }], 5)).toBe(0);
  });
});

describe('getActiveProvider', () => {
  it('defaults to yahoo when env is not set', () => {
    const original = process.env.MARKET_DATA_PROVIDER;
    delete process.env.MARKET_DATA_PROVIDER;
    expect(getActiveProvider()).toBe('yahoo');
    if (original) process.env.MARKET_DATA_PROVIDER = original;
  });

  it('returns eodhd when env is set', () => {
    const original = process.env.MARKET_DATA_PROVIDER;
    process.env.MARKET_DATA_PROVIDER = 'eodhd';
    expect(getActiveProvider()).toBe('eodhd');
    process.env.MARKET_DATA_PROVIDER = original ?? '';
  });
});

describe('getDataFreshness', () => {
  it('returns a valid FreshnessInfo shape', () => {
    const info = getDataFreshness();
    expect(info).toHaveProperty('source');
    expect(info).toHaveProperty('lastFetchTimestamp');
    expect(info).toHaveProperty('ageMinutes');
    expect(['LIVE', 'CACHE', 'STALE_CACHE']).toContain(info.source);
    expect(typeof info.ageMinutes).toBe('number');
  });
});
