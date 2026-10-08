/**
 * DEPENDENCIES
 * Consumed by: src/cron/auto-trade.ts (earnings gate), src/lib/telegram-commands.ts
 * Consumes: yahoo-finance2 (already installed, free, no API key)
 * Risk-sensitive: NO — read-only public news + calendar data, no trade execution
 * Notes: Free internet-context fetcher. Pulls public Yahoo Finance news headlines
 *        and the next earnings date for a ticker. Best-effort: Yahoo failures are
 *        swallowed and an empty payload returned so the analyst pipeline degrades
 *        gracefully rather than 500ing.
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const FETCH_TIMEOUT_MS = 6000;
const DEFAULT_NEWS_COUNT = 5;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── In-memory TTL cache to avoid hammering Yahoo for repeated lookups ──

interface CacheEntry {
  data: NewsContext;
  expiresAt: number;
}

const newsCache = new Map<string, CacheEntry>();

function getCached(ticker: string, newsCount: number): NewsContext | null {
  const key = `${ticker}:${newsCount}`;
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    newsCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, newsCount: number, data: NewsContext): void {
  const key = `${ticker}:${newsCount}`;
  newsCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict stale entries periodically (keep cache bounded)
  if (newsCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of newsCache) {
      if (now > v.expiresAt) newsCache.delete(k);
    }
  }
}

/** Clear the news cache. Exported for test use only. */
export function clearNewsCache(): void {
  newsCache.clear();
}

export interface NewsHeadline {
  title: string;
  publisher: string;
  link: string;
  publishedAt: string; // ISO timestamp
  ageHours: number;
}

export interface EarningsInfo {
  nextEarningsDate: string | null; // ISO date
  daysUntil: number | null;
  isEstimate: boolean;
}

export interface NewsContext {
  ticker: string;
  fetchedAt: string;
  headlines: NewsHeadline[];
  earnings: EarningsInfo;
  warnings: string[]; // e.g. "Yahoo news fetch failed", "earnings unavailable"
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function fetchHeadlines(ticker: string, count: number): Promise<NewsHeadline[]> {
  const result = await withTimeout(
    yahooFinance.search(ticker, { newsCount: count, quotesCount: 0 }),
    FETCH_TIMEOUT_MS,
    'Yahoo news search'
  );

  if (!result?.news?.length) return [];

  const now = Date.now();
  return result.news
    .filter((n: { title?: string; link?: string; providerPublishTime?: Date | string }) => n.title && n.link)
    .map((n: { title?: string; publisher?: string; link?: string; providerPublishTime?: Date | string }) => {
      const publishedDate = n.providerPublishTime
        ? new Date(n.providerPublishTime)
        : new Date();
      const ageMs = Math.max(0, now - publishedDate.getTime());
      return {
        title: n.title!,
        publisher: n.publisher ?? 'Unknown',
        link: n.link!,
        publishedAt: publishedDate.toISOString(),
        ageHours: ageMs / 3600000,
      };
    })
    .slice(0, count);
}

async function fetchEarnings(ticker: string): Promise<EarningsInfo> {
  const result = await withTimeout(
    yahooFinance.quoteSummary(ticker, { modules: ['calendarEvents'] }),
    FETCH_TIMEOUT_MS,
    'Yahoo earnings calendar'
  );

  const earnings = result?.calendarEvents?.earnings;
  const dates = earnings?.earningsDate;
  if (!dates?.length) {
    return { nextEarningsDate: null, daysUntil: null, isEstimate: false };
  }

  // earningsDate is ascending; pick first future date if any, else first
  const now = Date.now();
  const future = dates.find((d: Date) => new Date(d).getTime() >= now) ?? dates[0];
  const dateObj = new Date(future);
  const daysUntil = Math.round((dateObj.getTime() - now) / 86400000);

  return {
    nextEarningsDate: dateObj.toISOString(),
    daysUntil,
    isEstimate: earnings?.isEarningsDateEstimate ?? false,
  };
}

/**
 * Fetch news + earnings context for a ticker.
 * Always resolves (no throws); failures are reported in `warnings`.
 */
export async function fetchNewsContext(ticker: string, newsCount: number = DEFAULT_NEWS_COUNT): Promise<NewsContext> {
  // Check cache first
  const cached = getCached(ticker, newsCount);
  if (cached) return cached;

  const warnings: string[] = [];

  const [headlinesResult, earningsResult] = await Promise.allSettled([
    fetchHeadlines(ticker, newsCount),
    fetchEarnings(ticker),
  ]);

  const headlines = headlinesResult.status === 'fulfilled' ? headlinesResult.value : [];
  if (headlinesResult.status === 'rejected') {
    warnings.push(`news fetch failed: ${(headlinesResult.reason as Error).message}`);
  }

  const earnings = earningsResult.status === 'fulfilled'
    ? earningsResult.value
    : { nextEarningsDate: null, daysUntil: null, isEstimate: false };
  if (earningsResult.status === 'rejected') {
    warnings.push(`earnings fetch failed: ${(earningsResult.reason as Error).message}`);
  }

  const result: NewsContext = {
    ticker,
    fetchedAt: new Date().toISOString(),
    headlines,
    earnings,
    warnings,
  };

  // Cache successful results (even partial — warnings are informational)
  setCache(ticker, newsCount, result);

  return result;
}

/**
 * Fetch news + earnings for multiple tickers in parallel.
 * Concurrency is capped to avoid hammering Yahoo.
 * Always resolves — individual ticker failures are captured in their own `warnings`.
 */
export async function fetchBatchNewsContext(
  tickers: string[],
  newsCount: number = 3
): Promise<NewsContext[]> {
  const CONCURRENCY = 4;
  const results: NewsContext[] = [];

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(ticker => fetchNewsContext(ticker, newsCount))
    );
    results.push(...batchResults);
  }

  return results;
}
