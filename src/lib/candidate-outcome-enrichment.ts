/**
 * DEPENDENCIES
 * Consumed by: /api/analytics/candidate-outcomes/route.ts (POST enrich), nightly.ts (optional hook)
 * Consumes: prisma.ts, market-data.ts
 * Risk-sensitive: NO — analytics only, read-only market data calls
 * Last modified: 2026-03-06
 * Notes: Enriches CandidateOutcome rows with forward price returns, MFE/MAE,
 *        and R-threshold crossings. Only processes rows that are old enough to
 *        have forward data, restricted to the prospective cohort below.
 *        Calls Yahoo/EODHD for price data — respects rate limits via getDailyPrices.
 */
import prisma from './prisma';
import { getDailyPrices } from './market-data';
import { toYahooTicker } from './ticker-maps';

export const ENRICHMENT_COHORT_START = new Date('2026-09-11T00:00:00Z');
const ENRICHMENT_CURSOR_KEY = 'candidate-outcome-enrichment.cursor.v1';

const positiveFinite = (value: number) => Number.isFinite(value) && value > 0;
const sameValue = (left: number, right: number) =>
  Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-6;

// ── Types ───────────────────────────────────────────────────────────

interface PriceBar {
  date: string;
  close: number;
  high: number;
  low: number;
  rawClose?: number;
  adjustedClose?: number;
  fetchedAt?: number;
}

interface EnrichmentResult {
  fwdReturn5d: number | null;
  fwdReturn10d: number | null;
  fwdReturn20d: number | null;
  mfeR: number | null;
  maeR: number | null;
  reached1R: boolean | null;
  reached2R: boolean | null;
  reached3R: boolean | null;
  stopHit: boolean | null;
}

// ── Pure computation ────────────────────────────────────────────────

/**
 * Compute forward returns and R-based metrics from price bars.
 * Pure function — no DB or API calls.
 *
 * @param scanPrice  - close price at the time of scan
 * @param entryTrigger - planned entry price
 * @param stopPrice - planned stop price
 * @param forwardBars - daily bars AFTER the scan date, chronological
 */
export function computeForwardMetrics(
  scanPrice: number,
  entryTrigger: number,
  stopPrice: number,
  forwardBars: PriceBar[]
): EnrichmentResult {
  if (forwardBars.length === 0 || !positiveFinite(scanPrice)) {
    return {
      fwdReturn5d: null, fwdReturn10d: null, fwdReturn20d: null,
      mfeR: null, maeR: null,
      reached1R: null, reached2R: null, reached3R: null, stopHit: null,
    };
  }

  // Forward returns (% change from scan close)
  const fwdReturn5d = forwardBars.length >= 5
    ? ((forwardBars[4].close - scanPrice) / scanPrice) * 100
    : null;
  const fwdReturn10d = forwardBars.length >= 10
    ? ((forwardBars[9].close - scanPrice) / scanPrice) * 100
    : null;
  const fwdReturn20d = forwardBars.length >= 20
    ? ((forwardBars[19].close - scanPrice) / scanPrice) * 100
    : null;

  // R-based metrics require valid entry/stop
  const rPerShare = entryTrigger - stopPrice;
  if (!positiveFinite(entryTrigger) || !positiveFinite(stopPrice) || !positiveFinite(rPerShare)) {
    return {
      fwdReturn5d, fwdReturn10d, fwdReturn20d,
      mfeR: null, maeR: null,
      reached1R: null, reached2R: null, reached3R: null, stopHit: null,
    };
  }

  // Compute MFE/MAE over 20 bars (or however many are available, up to 20)
  const barsToCheck = forwardBars.slice(0, 20);
  let maxFavourable = 0;  // highest R above entry
  let maxAdverse = 0;     // lowest R below entry (stored as negative)
  let hit1R = false;
  let hit2R = false;
  let hit3R = false;
  let hitStop = false;

  for (const bar of barsToCheck) {
    // Favourable: how high did price go above entry?
    const favR = (bar.high - entryTrigger) / rPerShare;
    if (favR > maxFavourable) maxFavourable = favR;

    // Adverse: how low did price go below entry?
    const advR = (entryTrigger - bar.low) / rPerShare;
    if (advR > maxAdverse) maxAdverse = advR;

    // R-threshold crossings (using close, not intraday)
    const closeR = (bar.close - entryTrigger) / rPerShare;
    if (closeR >= 1) hit1R = true;
    if (closeR >= 2) hit2R = true;
    if (closeR >= 3) hit3R = true;

    // Stop hit: low touched or breached stop level
    if (bar.low <= stopPrice) hitStop = true;
  }

  return {
    fwdReturn5d,
    fwdReturn10d,
    fwdReturn20d,
    mfeR: Math.round(maxFavourable * 100) / 100,
    maeR: Math.round(-maxAdverse * 100) / 100,  // negative = adverse
    reached1R: hit1R,
    reached2R: hit2R,
    reached3R: hit3R,
    stopHit: hitStop,
  };
}

// ── Batch enrichment ────────────────────────────────────────────────

const REGULAR_OPEN: Record<'US' | 'UK', { timeZone: string; minutes: number }> = {
  US: { timeZone: 'America/New_York', minutes: 9 * 60 + 30 },
  UK: { timeZone: 'Europe/London', minutes: 8 * 60 },
};

/**
 * True only when the scan provably ran before the listing's regular open on the
 * scan day (exchange local time). Unknown exchanges are never proven.
 */
export function scannedBeforeRegularOpen(scanDate: Date, priceSymbol: string): boolean {
  const symbol = priceSymbol.trim().toUpperCase();
  const market = symbol.endsWith('.L') ? 'UK' : /\.[A-Z]{1,4}$/.test(symbol) || symbol.startsWith('^') ? null : 'US';
  if (!market || !Number.isFinite(scanDate.getTime())) return false;
  const { timeZone, minutes } = REGULAR_OPEN[market];
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(scanDate).map(part => [part.type, part.value]));
  const localDay = `${parts.year}-${parts.month}-${parts.day}`;
  if (localDay !== scanDate.toISOString().slice(0, 10)) return false;
  return Number(parts.hour) * 60 + Number(parts.minute) < minutes;
}

export function prepareEnrichmentWindow(
  scanDate: Date,
  scanPrice: number,
  providerBars: PriceBar[],
  asOf: Date,
  priceSymbol?: string
): { bars: PriceBar[]; reason: string | null } {
  const reject = (reason: string) => ({ bars: [], reason });
  if (!Number.isFinite(scanDate.getTime()) || !Number.isFinite(asOf.getTime())
    || scanDate >= asOf || !positiveFinite(scanPrice)) return reject('INVALID_SCAN');
  const scanDay = scanDate.toISOString().slice(0, 10);
  const today = asOf.toISOString().slice(0, 10);
  for (const bar of providerBars) {
    const timestamp = Date.parse(bar.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !Number.isFinite(timestamp)
      || new Date(timestamp).toISOString().slice(0, 10) !== bar.date) return reject('INVALID_BAR_DATE');
  }
  const sorted = [...providerBars].sort((left, right) => left.date.localeCompare(right.date));
  const anchors = sorted.filter(bar => bar.date <= scanDay);
  const scanAnchor = anchors.at(-1);
  if (!scanAnchor || Date.parse(scanDay) - Date.parse(scanAnchor.date) > 3 * 86400000) {
    return reject('MISSING_SCAN_ANCHOR');
  }
  if (anchors.filter(bar => bar.date === scanAnchor.date).length !== 1) return reject('DUPLICATE_ANCHOR');
  const observedComplete = (bar: PriceBar) => bar.fetchedAt !== undefined && Number.isFinite(bar.fetchedAt)
    && bar.fetchedAt >= Date.parse(bar.date) + 86400000 && bar.fetchedAt <= asOf.getTime();
  if (!observedComplete(scanAnchor)) return reject('UNPROVEN_ANCHOR_FINALIZATION');
  if ([0, 6].includes(new Date(scanAnchor.date).getUTCDay())) return reject('NON_SESSION_ANCHOR');
  let anchor: PriceBar = scanAnchor;
  const nextWeekday = (day: string) => {
    const date = new Date(`${day}T00:00:00Z`);
    do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
    return date.toISOString().slice(0, 10);
  };
  // A scan before 22:00 UTC may have seen the scan-day session before it was final.
  // (Every scheduled scan runs before then, so rejecting them all left the cohort
  // with no outcomes.) Accept it only when the scan price is explained exactly:
  //  - it equals the finalized close → the scan ran after that market closed;
  //  - it lies inside the finalized session's raw range with no price adjustment
  //    → treated as an intraday quote and used as the baseline; counting starts at
  //    the next session (range proves units, not identity). A price equal to the
  //    previous close also lands here: equality alone does not prove the session
  //    had not opened, so the scan day is never counted from it;
  //  - it equals the previous session close AND lies outside the scan-day range
  //    AND the scan clock is before the listing's regular open → pre-open scan:
  //    anchor on that close and count the scan-day session as bar 1. Without the
  //    clock proof it could be a stale quote seen mid-session, so it is rejected.
  // Anything else is rejected. Scans at or after 22:00 UTC keep the exact-close rule.
  let windowStart = scanDay;
  let intradayBaseline = false;
  if (anchor.date === scanDay && scanDate.getUTCHours() < 22 && !sameValue(anchor.close, scanPrice)) {
    const inSessionRange = positiveFinite(anchor.low) && positiveFinite(anchor.high)
      && scanPrice >= anchor.low * (1 - 1e-6) && scanPrice <= anchor.high * (1 + 1e-6);
    const previous = anchors.filter(bar => bar.date < scanDay).at(-1);
    if (inSessionRange) {
      if (anchor.rawClose === undefined || anchor.adjustedClose === undefined
        || !sameValue(anchor.rawClose, anchor.adjustedClose)) return reject('SCAN_PRICE_UNEXPLAINED');
      intradayBaseline = true;
    } else if (previous && anchors.filter(bar => bar.date === previous.date).length === 1
      && nextWeekday(previous.date) === scanDay && observedComplete(previous)
      && positiveFinite(previous.close) && sameValue(previous.close, scanPrice)) {
      if (!priceSymbol || !scannedBeforeRegularOpen(scanDate, priceSymbol)) return reject('PRE_OPEN_UNPROVEN');
      anchor = previous;
      windowStart = previous.date;
    } else {
      return reject('SCAN_PRICE_UNEXPLAINED');
    }
  }
  if (!intradayBaseline && (!positiveFinite(anchor.close) || !sameValue(anchor.close, scanPrice))) {
    return reject('SCAN_BASELINE_MISMATCH');
  }
  if (anchor.rawClose === undefined || anchor.adjustedClose === undefined
    || !positiveFinite(anchor.rawClose) || !positiveFinite(anchor.adjustedClose)
    || !sameValue(anchor.close, anchor.adjustedClose)) return reject('MISSING_PRICE_BASIS');
  const adjustmentFactor = anchor.adjustedClose / anchor.rawClose;
  if (!positiveFinite(adjustmentFactor)) return reject('INVALID_PRICE_BASIS');
  if (![anchor.high, anchor.low].every(positiveFinite)
    || anchor.high < anchor.rawClose || anchor.low > anchor.rawClose) return reject('INVALID_ANCHOR_BAR');
  if (windowStart === scanDay && anchor.date < scanDay && nextWeekday(anchor.date) <= scanDay) {
    return reject('UNPROVEN_ANCHOR_GAP');
  }
  const candidates = sorted.filter(bar => bar.date > windowStart && bar.date < today);
  const bars: PriceBar[] = [];
  let expected = nextWeekday(windowStart);
  for (const bar of candidates) {
    if (bars.length === 20) break;
    if (bar.date !== expected) return { bars, reason: 'MISSING_OR_NON_SESSION_BAR' };
    if (candidates.filter(other => other.date === bar.date).length !== 1) {
      return { bars, reason: 'DUPLICATE_SESSION' };
    }
    if (!observedComplete(bar)) return { bars, reason: 'UNPROVEN_BAR_FINALIZATION' };
    if (bar.rawClose === undefined || bar.adjustedClose === undefined
      || !positiveFinite(bar.rawClose) || !positiveFinite(bar.adjustedClose)
      || !sameValue(bar.close, bar.adjustedClose)) return { bars, reason: 'MISSING_PRICE_BASIS' };
    const factor = bar.adjustedClose / bar.rawClose;
    if (!positiveFinite(factor) || Math.abs(factor / adjustmentFactor - 1) > 1e-6) {
      return { bars, reason: 'ADJUSTMENT_FACTOR_CHANGED' };
    }
    if (![bar.close, bar.high, bar.low].every(positiveFinite)
      || bar.low > bar.rawClose || bar.high < bar.rawClose) return { bars, reason: 'INVALID_PRICE_BAR' };
    bars.push({ ...bar, high: bar.high * adjustmentFactor, low: bar.low * adjustmentFactor });
    expected = nextWeekday(bar.date);
  }
  return { bars, reason: null };
}

/**
 * Enrich CandidateOutcome rows with forward price data.
 *
 * Only processes rows where:
 * - scanDate is in the prospective cohort and at least minDaysOld calendar days old
 * - one or more return horizons remain missing
 *
 * @param minDaysOld - minimum calendar days since scan to attempt enrichment (default: 8 — gives ~5 trading days)
 * @param maxRows - rows claimed per batch (default: 100). Every other eligible row of the
 *                  claimed tickers is enriched from the same fetch, so this bounds fetches.
 * @returns count of rows enriched
 */
export async function enrichCandidateOutcomes(
  minDaysOld = 8,
  maxRows = 100
): Promise<{ enriched: number; skipped: number; errors: number }> {
  if (!Number.isInteger(minDaysOld) || minDaysOld < 0 || !Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error('Enrichment requires nonnegative integer minDaysOld and positive integer maxRows');
  }
  const asOf = new Date();
  const cutoff = new Date(asOf.getTime() - minDaysOld * 86400000);

  const eligibility = {
    scanDate: { gte: ENRICHMENT_COHORT_START, lte: cutoff },
    OR: [{ fwdReturn5d: null }, { fwdReturn10d: null }, { fwdReturn20d: null }],
  };
  const rowSelect = {
    id: true,
    ticker: true,
    scanDate: true,
    price: true,
    entryTrigger: true,
    stopPrice: true,
    enrichedAt: true,
    fwdReturn5d: true,
    fwdReturn10d: true,
    fwdReturn20d: true,
  } as const;

  const rows = await prisma.$transaction(async (transaction) => {
    const cursor = await transaction.appSetting.findUnique({
      where: { key: ENRICHMENT_CURSOR_KEY },
      select: { value: true },
    });
    const selectPage = (afterId?: string) => transaction.candidateOutcome.findMany({
      where: { ...eligibility, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: maxRows,
      select: rowSelect,
    });
    let claimed = await selectPage(cursor?.value);
    if (claimed.length === 0 && cursor?.value) claimed = await selectPage();
    if (claimed.length === 0) return claimed;
    const value = claimed[claimed.length - 1].id;
    await transaction.appSetting.upsert({
      where: { key: ENRICHMENT_CURSOR_KEY },
      create: { key: ENRICHMENT_CURSOR_KEY, value },
      update: { value },
    });

    // Each scan repeats the whole universe, so a page holds ~one row per ticker.
    // One price fetch serves every eligible row of that ticker, so enrich them all
    // now instead of fetching the same ticker again for each later scan. Rows the
    // cursor reaches later are then complete (no longer eligible) or retried
    // safely: writes are expected-state updates and never overwrite a return.
    const siblings = await transaction.candidateOutcome.findMany({
      where: { ...eligibility, ticker: { in: Array.from(new Set(claimed.map(row => row.ticker))) } },
      orderBy: { id: 'asc' },
      select: rowSelect,
    });
    const byId = new Map(claimed.map(row => [row.id, row]));
    for (const row of siblings ?? []) if (!byId.has(row.id)) byId.set(row.id, row);
    return Array.from(byId.values());
  });

  let enriched = 0;
  let skipped = 0;
  let errors = 0;

  // Group by ticker to minimize Yahoo calls (one call per ticker)
  const byTicker = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = byTicker.get(row.ticker) || [];
    existing.push(row);
    byTicker.set(row.ticker, existing);
  }

  for (const ticker of Array.from(byTicker.keys())) {
    const tickerRows = byTicker.get(ticker)!;
    let bars: PriceBar[];
    try {
      const rawBars = await getDailyPrices(ticker, 'compact');
      bars = rawBars.map((b) => ({
        date: b.date,
        close: b.close,
        high: b.high,
        low: b.low,
        rawClose: b.rawClose,
        adjustedClose: b.adjustedClose,
        fetchedAt: b.fetchedAt,
      }));
    } catch (e) {
      console.warn(`[CandidateOutcome] Failed to fetch prices for ${ticker}:`, e);
      errors += tickerRows.length;
      continue;
    }

    if (bars.length === 0) {
      skipped += tickerRows.length;
      continue;
    }

    const observedAt = new Date();
    for (const row of tickerRows) {
      if (row.scanDate < ENRICHMENT_COHORT_START || row.scanDate > cutoff) {
        skipped++;
        continue;
      }
      const window = prepareEnrichmentWindow(row.scanDate, row.price, bars, observedAt, toYahooTicker(ticker));
      const forwardBars = window.bars;
      if (window.reason) console.warn(`[CandidateOutcome] ${row.id}: ${window.reason}`);

      if (forwardBars.length < 5) {
        skipped++;
        continue;
      }

      const metrics = computeForwardMetrics(
        row.price,
        row.entryTrigger,
        row.stopPrice,
        forwardBars
      );
      if (Object.values(metrics).some(value => typeof value === 'number' && !Number.isFinite(value))) {
        console.warn(`[CandidateOutcome] ${row.id}: NONFINITE_METRICS`);
        skipped++;
        continue;
      }

      const returns = ['fwdReturn5d', 'fwdReturn10d', 'fwdReturn20d'] as const;
      if (returns.some(key => row[key] !== null
        && (metrics[key] === null || !sameValue(row[key], metrics[key])))) {
        console.warn(`[CandidateOutcome] ${row.id}: PRIOR_HORIZON_MISMATCH`);
        skipped++;
        continue;
      }
      const missingReturns: Partial<EnrichmentResult> = {};
      for (const key of returns) {
        if (row[key] === null && metrics[key] !== null) missingReturns[key] = metrics[key];
      }
      if (Object.keys(missingReturns).length === 0) {
        skipped++;
        continue;
      }

      try {
        const updated = await prisma.candidateOutcome.updateMany({
          where: {
            id: row.id, scanDate: row.scanDate, price: row.price,
            entryTrigger: row.entryTrigger, stopPrice: row.stopPrice,
            enrichedAt: row.enrichedAt,
            fwdReturn5d: row.fwdReturn5d, fwdReturn10d: row.fwdReturn10d, fwdReturn20d: row.fwdReturn20d,
          },
          data: {
            ...missingReturns,
            ...(forwardBars.length >= 20 ? {
              mfeR: metrics.mfeR, maeR: metrics.maeR,
              reached1R: metrics.reached1R, reached2R: metrics.reached2R,
              reached3R: metrics.reached3R, stopHit: metrics.stopHit,
            } : {}),
            enrichedAt: observedAt,
          },
        });
        if (updated.count === 1) enriched++;
        else {
          console.warn(`[CandidateOutcome] ${row.id}: CONCURRENT_CHANGE`);
          skipped++;
        }
      } catch (e) {
        console.error(`[CandidateOutcome] Enrichment update failed for ${ticker}:`, e);
        errors++;
      }
    }
  }

  return { enriched, skipped, errors };
}
