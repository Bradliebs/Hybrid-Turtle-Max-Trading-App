import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), update: vi.fn(), prices: vi.fn(),
  cursorRead: vi.fn(), cursorWrite: vi.fn(), transaction: vi.fn() }));
vi.mock('./prisma', () => ({ default: {
  candidateOutcome: { updateMany: mocks.update }, $transaction: mocks.transaction,
} }));
vi.mock('./market-data', () => ({ getDailyPrices: mocks.prices }));

import { computeForwardMetrics, enrichCandidateOutcomes, ENRICHMENT_COHORT_START, prepareEnrichmentWindow, scannedBeforeRegularOpen } from './candidate-outcome-enrichment';

const row = { id: 'candidate-1', ticker: 'TEST', scanDate: new Date('2026-09-11T22:00:00Z'),
  price: 100, entryTrigger: 100, stopPrice: 95, enrichedAt: null as Date | null,
  fwdReturn5d: null as number | null, fwdReturn10d: null as number | null, fwdReturn20d: null as number | null };
const bars = Array.from({ length: 45 }, (_, index) => new Date(Date.UTC(2026, 8, 14 + index)))
  .filter(date => ![0, 6].includes(date.getUTCDay())).slice(0, 30)
  .map((date, index) => ({ date: date.toISOString().slice(0, 10),
    close: 101 + index, high: 102 + index, low: 100 + index, rawClose: 101 + index, adjustedClose: 101 + index,
    fetchedAt: date.getTime() + 86400000 }));
const anchor = { date: '2026-09-11', close: 100, high: 101, low: 99, rawClose: 100, adjustedClose: 100,
  fetchedAt: Date.parse('2026-09-12') };
const history = [anchor, ...bars];

describe('outcome enrichment regressions and evidence limitations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    mocks.findMany.mockReset().mockResolvedValue([row]);
    mocks.update.mockReset().mockResolvedValue({ count: 1 });
    mocks.prices.mockReset();
    mocks.cursorRead.mockReset().mockResolvedValue(null);
    mocks.cursorWrite.mockReset().mockResolvedValue({});
    mocks.transaction.mockReset().mockImplementation(async callback => callback({
      candidateOutcome: { findMany: mocks.findMany },
      appSetting: { findUnique: mocks.cursorRead, upsert: mocks.cursorWrite },
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('persists chronological horizons without mutating newest-first provider bars', async () => {
    const providerBars = [...history].reverse();
    mocks.prices.mockResolvedValue(providerBars);
    await enrichCandidateOutcomes();
    const chronological = computeForwardMetrics(100, 100, 95, bars);
    expect(chronological.fwdReturn5d).toBe(5);
    expect(chronological.fwdReturn20d).toBe(20);
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      fwdReturn5d: 5, fwdReturn10d: 10, fwdReturn20d: 20,
    });
    expect(providerBars[0]).toBe(bars.at(-1));
  });

  it('revisits partial horizons and stops after all three are complete', async () => {
    const stored = { ...row };
    mocks.findMany.mockImplementation(async ({ where }) => {
      expect(where.scanDate.gte).toEqual(ENRICHMENT_COHORT_START);
      expect(where.OR).toContainEqual({ fwdReturn20d: null });
      return stored.fwdReturn20d === null ? [{ ...stored }] : [];
    });
    mocks.update.mockImplementation(async ({ data }) => { Object.assign(stored, data); return { count: 1 }; });
    mocks.prices.mockResolvedValueOnce([anchor, ...bars.slice(0, 7)]);
    await enrichCandidateOutcomes();
    expect(stored.fwdReturn20d).toBeNull();
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty('stopHit');
    mocks.prices.mockResolvedValue(history);
    await enrichCandidateOutcomes();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0].data).not.toHaveProperty('fwdReturn5d');
    expect(stored.fwdReturn20d).toBe(20);
    await enrichCandidateOutcomes();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.prices).toHaveBeenCalledTimes(2);
  });

  it('excludes historical cohorts and refuses invalid arguments before querying', async () => {
    mocks.findMany.mockResolvedValue([{ ...row, scanDate: new Date('2026-06-01') }]);
    mocks.prices.mockResolvedValue(history);
    expect(await enrichCandidateOutcomes()).toEqual({ enriched: 0, skipped: 1, errors: 0 });
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.findMany.mockClear();
    await expect(enrichCandidateOutcomes(-1)).rejects.toThrow();
    await expect(enrichCandidateOutcomes(8, 0)).rejects.toThrow();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('does not overwrite changed prior returns or count concurrent writes as success', async () => {
    mocks.findMany.mockResolvedValue([{ ...row, fwdReturn5d: 99, enrichedAt: new Date('2026-09-21') }]);
    mocks.prices.mockResolvedValue(history);
    expect((await enrichCandidateOutcomes()).skipped).toBe(1);
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.findMany.mockResolvedValue([row]);
    mocks.update.mockResolvedValue({ count: 0 });
    expect((await enrichCandidateOutcomes()).enriched).toBe(0);
    expect(mocks.update.mock.calls[0][0].where).toMatchObject({
      id: row.id, price: 100, enrichedAt: null, fwdReturn5d: null, fwdReturn20d: null,
    });
  });

  it('does not rewrite unchanged partial horizons, including a recorded zero', async () => {
    mocks.findMany.mockResolvedValue([{ ...row, fwdReturn5d: 0, enrichedAt: new Date('2026-09-21') }]);
    mocks.prices.mockResolvedValue([anchor, ...bars.slice(0, 7).map(bar => ({
      ...bar, close: 100, low: 99, rawClose: 100, adjustedClose: 100,
    }))]);
    expect((await enrichCandidateOutcomes()).skipped).toBe(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('checks complete prefixes rather than shifting missing sessions or including today', () => {
    const prepare = (prices: typeof history, asOf = new Date('2026-11-01')) =>
      prepareEnrichmentWindow(row.scanDate, row.price, prices, asOf);
    expect(prepare(history.filter(bar => bar.date !== bars[7].date))).toMatchObject({
      bars: bars.slice(0, 7), reason: 'MISSING_OR_NON_SESSION_BAR',
    });
    expect(prepare(history, new Date(`${bars[4].date}T23:00Z`)).bars).toHaveLength(4);
    expect(prepare([...history, bars[2]]).reason).toBe('DUPLICATE_SESSION');
    expect(prepare(bars).reason).toBe('MISSING_SCAN_ANCHOR');
    expect(prepare([{ ...anchor, close: 99 }, ...bars]).reason).toBe('SCAN_BASELINE_MISMATCH');
    expect(prepare([{ ...anchor, date: '2026-02-30' }, ...bars]).reason).toBe('INVALID_BAR_DATE');
    expect(prepare([anchor, ...bars.map(bar => ({ ...bar, rawClose: NaN }))]).reason).toBe('MISSING_PRICE_BASIS');
    expect(prepare([anchor, ...bars.map(bar => ({ ...bar, low: bar.high + 1 }))]).reason).toBe('INVALID_PRICE_BAR');
    expect(prepare([anchor, ...bars.map(bar => ({ ...bar, fetchedAt: Date.parse(bar.date) }))]).reason)
      .toBe('UNPROVEN_BAR_FINALIZATION');
    expect(prepare([anchor, ...bars.map(bar => ({ ...bar, fetchedAt: Date.parse('2026-12-01') }))]).reason)
      .toBe('UNPROVEN_BAR_FINALIZATION');
  });

  it('requires adjustment evidence, rejects factor changes and scales raw excursions to scan basis', () => {
    const adjusted = history.map(bar => ({ ...bar, close: bar.close * 0.5, adjustedClose: bar.close * 0.5 }));
    const prepare = (prices = adjusted) => prepareEnrichmentWindow(row.scanDate, 50, prices, new Date('2026-11-01'));
    const valid = prepare();
    expect(valid.reason).toBeNull();
    expect(valid.bars[0]).toMatchObject({ close: 50.5, high: 51, low: 50 });
    const result = computeForwardMetrics(50, 50, 47.5, valid.bars);
    expect(result.fwdReturn20d).toBe(20);
    expect(result.mfeR).toBe(4.2);
    expect(prepare(adjusted.map(bar => ({ ...bar, rawClose: NaN }))).reason).toBe('MISSING_PRICE_BASIS');
    const changed = adjusted.map((bar, index) => index === 8 ? { ...bar, adjustedClose: bar.close * 0.9, close: bar.close * 0.9 } : bar);
    expect(prepare(changed)).toMatchObject({ bars: valid.bars.slice(0, 7), reason: 'ADJUSTMENT_FACTOR_CHANGED' });
  });

  describe('scans before 22:00 UTC (every scheduled scan)', () => {
    // anchor = finalized scan-day bar (2026-09-11: close 100, range 99–101)
    const eveningScan = new Date('2026-09-11T19:00:00Z');
    const previousSession = { date: '2026-09-10', close: 98, high: 99, low: 97, rawClose: 98, adjustedClose: 98,
      fetchedAt: Date.parse('2026-09-11') };
    const prepareAt = (price: number, prices: typeof history = [previousSession, ...history]) =>
      prepareEnrichmentWindow(eveningScan, price, prices, new Date('2026-11-01'));

    it('accepts a scan that already saw the final close (e.g. LSE stock in the evening scan)', () => {
      const result = prepareAt(100);
      expect(result.reason).toBeNull();
      expect(result.bars[0].date).toBe(bars[0].date);
    });

    it('accepts an intraday quote inside the finalized session range as the baseline', () => {
      const result = prepareAt(100.5);
      expect(result.reason).toBeNull();
      expect(result.bars[0].date).toBe(bars[0].date);
      expect(computeForwardMetrics(100.5, 100, 95, result.bars).fwdReturn5d).toBeCloseTo(((105 - 100.5) / 100.5) * 100, 9);
    });

    it('treats a scan priced at the previous close as pre-open only with clock proof and a gap', () => {
      // 13:00 UTC = 09:00 New York (before the 09:30 open)
      const usMorning = prepareEnrichmentWindow(new Date('2026-09-11T13:00:00Z'), 98, [previousSession, ...history],
        new Date('2026-11-01'), 'AAPL');
      expect(usMorning.reason).toBeNull();
      expect(usMorning.bars[0].date).toBe('2026-09-11');
      expect(usMorning.bars).toHaveLength(20);
      // 06:30 UTC = 07:30 London (before the 08:00 open)
      expect(prepareEnrichmentWindow(new Date('2026-09-11T06:30:00Z'), 98, [previousSession, ...history],
        new Date('2026-11-01'), 'RIO.L').reason).toBeNull();
    });

    it('rejects a previous-close match seen after the open (stale quote) or with no provable exchange clock', () => {
      expect(prepareAt(98).reason).toBe('PRE_OPEN_UNPROVEN');
      expect(prepareEnrichmentWindow(eveningScan, 98, [previousSession, ...history], new Date('2026-11-01'), 'AAPL').reason)
        .toBe('PRE_OPEN_UNPROVEN');
      expect(prepareEnrichmentWindow(new Date('2026-09-11T13:00:00Z'), 98, [previousSession, ...history],
        new Date('2026-11-01'), 'RIO.L').reason).toBe('PRE_OPEN_UNPROVEN');
      expect(prepareEnrichmentWindow(new Date('2026-09-11T06:30:00Z'), 98, [previousSession, ...history],
        new Date('2026-11-01'), 'SAP.DE').reason).toBe('PRE_OPEN_UNPROVEN');
    });

    it('proves the regular open in exchange local time across daylight-saving changes', () => {
      // Winter: New York opens 14:30 UTC, London 08:00 UTC.
      expect(scannedBeforeRegularOpen(new Date('2026-12-01T14:00:00Z'), 'AAPL')).toBe(true);
      expect(scannedBeforeRegularOpen(new Date('2026-12-01T14:30:00Z'), 'AAPL')).toBe(false);
      expect(scannedBeforeRegularOpen(new Date('2026-12-01T07:59:00Z'), 'RIO.L')).toBe(true);
      // Summer: New York opens 13:30 UTC, London 07:00 UTC.
      expect(scannedBeforeRegularOpen(new Date('2026-07-01T13:30:00Z'), 'AAPL')).toBe(false);
      expect(scannedBeforeRegularOpen(new Date('2026-07-01T07:00:00Z'), 'RIO.L')).toBe(false);
      // Late UTC evening is the previous New York day, never pre-open for the UTC scan day.
      expect(scannedBeforeRegularOpen(new Date('2026-07-01T02:00:00Z'), 'AAPL')).toBe(false);
    });

    it('never infers pre-open from a previous-close match inside the scan-day range', () => {
      // Previous close 100.5 also traded during the scan day (range 99–101): ambiguous,
      // so it is treated as intraday and the scan day (with its earlier low) is not counted.
      const flatPrevious = { ...previousSession, close: 100.5, rawClose: 100.5, adjustedClose: 100.5, high: 101, low: 100 };
      const scanDayWithEarlyBreach = { ...anchor, low: 90 };
      const result = prepareAt(100.5, [flatPrevious, scanDayWithEarlyBreach, ...bars]);
      expect(result.reason).toBeNull();
      expect(result.bars[0].date).toBe(bars[0].date);
      expect(computeForwardMetrics(100.5, 100, 95, result.bars).stopHit).toBe(false);
    });

    it('rejects prices it cannot explain: wrong units, outside the range, or an adjusted anchor', () => {
      expect(prepareAt(10_050).reason).toBe('SCAN_PRICE_UNEXPLAINED');
      expect(prepareAt(102.5).reason).toBe('SCAN_PRICE_UNEXPLAINED');
      const adjustedAnchor = [previousSession, { ...anchor, close: 99, adjustedClose: 99 }, ...bars];
      expect(prepareAt(100.5, adjustedAnchor).reason).toBe('SCAN_PRICE_UNEXPLAINED');
    });

    it('does not treat the previous close as pre-open when a session is missing in between', () => {
      const olderSession = { ...previousSession, date: '2026-09-09' };
      expect(prepareAt(98, [olderSession, ...history]).reason).toBe('SCAN_PRICE_UNEXPLAINED');
    });

    it('keeps the exact-close rule for scans at or after 22:00 UTC', () => {
      expect(prepareEnrichmentWindow(row.scanDate, 100.5, [previousSession, ...history], new Date('2026-11-01')).reason)
        .toBe('SCAN_BASELINE_MISMATCH');
    });
  });

  it('enriches every eligible scan of a claimed ticker with one price fetch', async () => {
    const later = { ...row, id: 'candidate-2' };
    mocks.findMany.mockImplementation(async ({ where }) => where.ticker?.in ? [row, later] : [row]);
    mocks.prices.mockResolvedValue(history);
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 2, skipped: 0, errors: 0 });
    expect(mocks.prices).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls.map(call => call[0].where.id).sort()).toEqual(['candidate-1', 'candidate-2']);
  });

  it('counts fetch and database failures without reporting successful enrichment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.prices.mockRejectedValueOnce(new Error('provider down'));
    expect((await enrichCandidateOutcomes()).errors).toBe(1);
    mocks.prices.mockResolvedValue(history);
    mocks.update.mockRejectedValueOnce(new Error('database down'));
    expect((await enrichCandidateOutcomes()).errors).toBe(1);
  });

  it('advances past rejected pages, stays bounded and retries them after wrapping', async () => {
    let cursor: string | null = null;
    const candidates = [
      { ...row, id: 'candidate-1', ticker: 'REJECTED' },
      { ...row, id: 'candidate-2', ticker: 'VALID' },
      { ...row, id: 'candidate-3', ticker: 'FAILED' },
    ];
    mocks.cursorRead.mockImplementation(async () => cursor ? { value: cursor } : null);
    mocks.cursorWrite.mockImplementation(async ({ update }) => { cursor = update.value; return {}; });
    mocks.findMany.mockImplementation(async ({ where, take, orderBy }) => {
      expect(where.scanDate.gte).toEqual(ENRICHMENT_COHORT_START);
      expect(orderBy).toEqual({ id: 'asc' });
      // Sibling expansion: every eligible row of the claimed page's tickers (unbounded by design).
      if (where.ticker?.in) return candidates.filter(candidate => where.ticker.in.includes(candidate.ticker));
      expect(take).toBe(1);
      return candidates.filter(candidate => !where.id || candidate.id > where.id.gt).slice(0, take);
    });
    mocks.prices.mockImplementation(async ticker => {
      expect(cursor).not.toBeNull();
      if (ticker === 'FAILED') throw new Error('provider unavailable');
      return ticker === 'VALID' ? history : [];
    });
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 0, skipped: 1, errors: 0 });
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 1, skipped: 0, errors: 0 });
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 0, skipped: 0, errors: 1 });
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 0, skipped: 1, errors: 0 });
    expect(mocks.prices.mock.calls.map(call => call[0])).toEqual(['REJECTED', 'VALID', 'FAILED', 'REJECTED']);
    // 5 page claims (one wrap) + 4 sibling expansions; still one fetch per ticker per run.
    expect(mocks.findMany).toHaveBeenCalledTimes(9);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('does not fetch or write outcomes if cursor persistence fails', async () => {
    mocks.cursorWrite.mockRejectedValue(new Error('cursor unavailable'));
    await expect(enrichCandidateOutcomes()).rejects.toThrow('cursor unavailable');
    expect(mocks.prices).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('handles an empty cohort without moving the cursor or fetching prices', async () => {
    mocks.cursorRead.mockResolvedValue({ value: 'deleted-last-candidate' });
    mocks.findMany.mockResolvedValue([]);
    expect(await enrichCandidateOutcomes()).toEqual({ enriched: 0, skipped: 0, errors: 0 });
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    expect(mocks.cursorWrite).not.toHaveBeenCalled();
    expect(mocks.prices).not.toHaveBeenCalled();
  });

  it('accepts finalized bars fetched after batch start without moving the age cutoff', async () => {
    const fetchedAt = Date.parse('2026-11-01T00:00:01Z');
    mocks.prices.mockImplementation(async () => {
      vi.setSystemTime(fetchedAt);
      return history.map(bar => ({ ...bar, fetchedAt }));
    });
    expect(await enrichCandidateOutcomes()).toEqual({ enriched: 1, skipped: 0, errors: 0 });
    expect(mocks.findMany.mock.calls[0][0].where.scanDate.lte).toEqual(new Date('2026-10-24T00:00:00Z'));
    expect(mocks.update.mock.calls[0][0].data.enrichedAt).toEqual(new Date(fetchedAt));
  });

  it('includes favorable movement after a stop touch, so MFE is not an achieved trade exit', () => {
    const result = computeForwardMetrics(100, 100, 95, [
      { date: '2026-01-02', close: 96, high: 100, low: 94 },
      { date: '2026-01-05', close: 115, high: 120, low: 110 },
    ]);
    expect(result.stopHit).toBe(true);
    expect(result.mfeR).toBe(4);
    expect(result.reached3R).toBe(true);
  });
});