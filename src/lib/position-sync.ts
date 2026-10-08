/**
 * DEPENDENCIES
 * Consumed by: nightly.ts
 * Consumes: trading212-dual.ts, trading212.ts, prisma.ts, market-data.ts, alert-service.ts, ev-tracker.ts
 * Risk-sensitive: YES — auto-closes positions based on T212 state
 * Last modified: 2026-03-02
 * Notes: NEVER closes positions if T212 API fails or returns zero positions.
 *        Uses Position.t212Ticker or Stock.t212Ticker for matching.
 *        Dual-account aware (ISA + INVEST).
 */

import prisma from '@/lib/prisma';
import {
  DualT212Client,
  getCredentialsForAccount,
  validateDualCredentials,
} from '@/lib/trading212-dual';
import {
  mapT212Position,
  type T212HistoricalOrder,
  type T212Position,
  Trading212Client,
  Trading212Error,
  type Trading212Environment,
} from '@/lib/trading212';
import { sendAlert } from '@/lib/alert-service';
import { logEVRecord } from '@/lib/ev-tracker';
import { persistCache, rehydrateCache } from '@/lib/cache-persistence';
import { CACHE_KEYS } from '@/lib/cache-keys';
import { recordPriceSnapshots } from '@/lib/price-snapshot';
import { PENDING_BROKER_RECONCILIATION, reconcileClosureEvidence } from './closure-evidence';

// ── Types ────────────────────────────────────────────────────────────

export interface PositionSyncResult {
  checked: number;
  closed: number;
  skipped: number;
  updated: number;
  errors: string[];
}

export interface PositionSyncOptions {
  detectUntrackedSales?: boolean;
}

export function shouldFetchOrderHistoryForSync(options: {
  hasMissingTrackedPosition: boolean;
  detectUntrackedSales: boolean;
}): boolean {
  return options.hasMissingTrackedPosition || options.detectUntrackedSales;
}

interface LocalBrokerPosition {
  accountType: string | null;
  t212Ticker: string | null;
  stock: { t212Ticker: string | null };
}

interface LiveBrokerPosition {
  accountType: string;
  fullTicker: string;
  shares: number;
}

export function findUntrackedBrokerPositions(
  localPositions: LocalBrokerPosition[],
  brokerPositions: LiveBrokerPosition[],
): LiveBrokerPosition[] {
  const tracked = new Set(localPositions.map((position) => {
    const accountType = position.accountType === 'isa' ? 'isa' : 'invest';
    return `${accountType}:${position.t212Ticker || position.stock.t212Ticker || ''}`;
  }));

  return brokerPositions.filter((position) => (
    !tracked.has(`${position.accountType}:${position.fullTicker}`)
  ));
}

// ── T212 Price Cache (in-memory) ─────────────────────────────────────
// Stores last-known T212 prices from the most recent fetch.
// Primary price source for portfolio display (real-time, not delayed).
interface T212PriceEntry {
  price: number;
  updatedAt: number; // epoch ms
}

const t212PriceCache = new Map<string, T212PriceEntry>();
let t212PriceCacheAge = 0; // epoch ms of last T212 price fetch
const T212_PRICE_TTL = 60_000; // 60 seconds — balanced between freshness and T212 rate limits (1 req/1s)

// ── T212 API call rate tracking ──
// Tracks calls per rolling hour window for rate limit monitoring.
interface T212ApiCallLog {
  timestamps: number[];
}
const t212ApiCallLog: T212ApiCallLog = { timestamps: [] };
const t212RateLimitBackoffUntil = new Map<string, number>();

function recordT212ApiCall(): void {
  const now = Date.now();
  t212ApiCallLog.timestamps.push(now);
  // Prune entries older than 1 hour
  const oneHourAgo = now - 3600_000;
  t212ApiCallLog.timestamps = t212ApiCallLog.timestamps.filter(t => t > oneHourAgo);
}

// Rate limit alert cooldown — max once per 30 minutes per process; sendAlert also
// applies persisted dedupe so restarts/render workers don't stack duplicates.
let lastRateLimitAlertAt = 0;
const RATE_LIMIT_ALERT_COOLDOWN = 30 * 60_000;
const RATE_LIMIT_ALERT_PERSISTED_COOLDOWN = 6 * 60 * 60_000;

function sendRateLimitAlert(account: string): void {
  const now = Date.now();
  if (now - lastRateLimitAlertAt < RATE_LIMIT_ALERT_COOLDOWN) return;
  lastRateLimitAlertAt = now;
  const stats = getT212ApiStats();
  sendAlert({
    type: 'BROKER_SYNC_FAILURE',
    title: 'T212 Rate Limited',
    message: `Trading 212 ${account} account rate-limited. Portfolio prices falling back to Yahoo Finance (delayed). ${stats.callsLastHour} API calls in the last hour.`,
    priority: 'WARNING',
    data: { account, callsLastHour: stats.callsLastHour },
    notificationDedupeKey: `t212-rate-limit:${account}`,
    notificationThrottleMs: RATE_LIMIT_ALERT_PERSISTED_COOLDOWN,
    telegramDedupeKey: `t212-rate-limit:${account}`,
    telegramThrottleMs: RATE_LIMIT_ALERT_PERSISTED_COOLDOWN,
  }).catch(() => { /* alert delivery is best-effort */ });
}

function setRateLimitBackoff(account: string, error: Trading212Error): void {
  const resetMs = error.rateLimitReset ? error.rateLimitReset * 1000 : 0;
  const fallbackMs = Date.now() + 30 * 60_000;
  const backoffUntil = Math.max(resetMs, fallbackMs);
  t212RateLimitBackoffUntil.set(account, backoffUntil);
}

function isRateLimitBackedOff(account: string): boolean {
  return (t212RateLimitBackoffUntil.get(account) ?? 0) > Date.now();
}

function staleT212PriceResult(): Record<string, number> {
  const result: Record<string, number> = {};
  t212PriceCache.forEach((entry, ticker) => result[ticker] = entry.price);
  return result;
}

// T212 connection drop alert — fires when API returns 0 positions during market hours
let lastDropAlertAt = 0;
const DROP_ALERT_COOLDOWN = 60 * 60_000; // max once per hour

function checkT212ConnectionDrop(): void {
  // Only alert during market hours when we expected prices
  if (!isAnyMarketOpen()) return;
  if (t212PriceCache.size > 0) return; // Cache still has data — no drop

  const now = Date.now();
  if (now - lastDropAlertAt < DROP_ALERT_COOLDOWN) return;
  lastDropAlertAt = now;

  sendAlert({
    type: 'BROKER_SYNC_FAILURE',
    title: 'T212 Prices Unavailable',
    message: 'Trading 212 returned no position data during market hours. Portfolio prices are using Yahoo Finance (delayed). Check T212 credentials and connection.',
    priority: 'WARNING',
  }).catch(() => { /* best-effort */ });
}

/** Get T212 API usage stats for the last hour. */
export function getT212ApiStats(): { callsLastHour: number; lastCallAt: number | null; cacheSize: number; cacheAge: number } {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const recentCalls = t212ApiCallLog.timestamps.filter(t => t > oneHourAgo);
  return {
    callsLastHour: recentCalls.length,
    lastCallAt: recentCalls.length > 0 ? recentCalls[recentCalls.length - 1] : null,
    cacheSize: t212PriceCache.size,
    cacheAge: t212PriceCacheAge > 0 ? Math.round((now - t212PriceCacheAge) / 1000) : -1,
  };
}

/** Update the T212 price cache from a sync or live fetch. */
export function updateT212PriceCache(prices: Map<string, number>): void {
  const now = Date.now();
  for (const [ticker, price] of prices) {
    if (price > 0) {
      t212PriceCache.set(ticker, { price, updatedAt: now });
    }
  }
  t212PriceCacheAge = now;

  // Persist to disk (fire-and-forget)
  if (prices.size > 0) {
    const diskObj: Record<string, T212PriceEntry> = {};
    t212PriceCache.forEach((v, k) => { diskObj[k] = v; });
    persistCache(CACHE_KEYS.T212_PRICES, diskObj).catch((err) => {
      console.warn('[position-sync] Failed to persist T212 price cache:', (err as Error).message);
    });

    // Record T212 vs Yahoo price snapshots (fire-and-forget, rate-limited internally)
    const priceRecord: Record<string, number> = {};
    prices.forEach((price, ticker) => { priceRecord[ticker] = price; });
    recordPriceSnapshots(priceRecord).catch(() => { /* swallowed */ });
  }
}

/**
 * Rehydrate the T212 price cache from disk on server startup.
 * Prevents cold-start staleness — positions immediately show last-known T212 prices.
 */
export async function rehydrateT212PriceCache(): Promise<boolean> {
  if (t212PriceCache.size > 0) return true; // Already warm
  try {
    const persisted = await rehydrateCache<Record<string, T212PriceEntry>>(CACHE_KEYS.T212_PRICES);
    if (persisted && persisted.data) {
      let count = 0;
      for (const [ticker, entry] of Object.entries(persisted.data)) {
        if (entry && typeof entry.price === 'number' && entry.price > 0) {
          t212PriceCache.set(ticker, entry);
          count++;
        }
      }
      if (count > 0) {
        t212PriceCacheAge = Math.max(...[...t212PriceCache.values()].map(e => e.updatedAt));
        console.log(`[position-sync] Rehydrated ${count} T212 prices from disk (age: ${Math.round(persisted.age / 60000)}m)`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[position-sync] Failed to rehydrate T212 price cache:', (err as Error).message);
    return false;
  }
}

/** Get cached T212 price for a ticker (from last sync). */
export function getT212Price(ticker: string): T212PriceEntry | null {
  return t212PriceCache.get(ticker) ?? null;
}

/** Get all cached T212 prices. */
export function getT212Prices(tickers: string[]): Record<string, T212PriceEntry> {
  const result: Record<string, T212PriceEntry> = {};
  for (const t of tickers) {
    const entry = t212PriceCache.get(t);
    if (entry) result[t] = entry;
  }
  return result;
}

/**
 * Check if any major market is currently open or recently closed.
 * UK: Mon-Fri 8:00-16:35, US: Mon-Fri 14:30-21:05 (UK time).
 * Returns false on weekends and outside these windows.
 * Uses a 5-min buffer after close so final prices settle.
 */
function isAnyMarketOpen(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hour = now.getHours();
  const min = now.getMinutes();
  const timeMinutes = hour * 60 + min;
  // UK market: 08:00 – 16:35, US market: 14:30 – 21:05 (UK time)
  return timeMinutes >= 480 && timeMinutes <= 1265; // 8:00 to 21:05
}

/**
 * Fetch live T212 prices for portfolio display.
 * Returns a ticker → price map. Uses 30s cache to avoid T212 rate limits.
 * Skips T212 API calls outside market hours (serves stale cache instead).
 * Falls back gracefully — returns empty map on failure (caller uses Yahoo fallback).
 *
 * CONCURRENCY GUARD: When multiple routes call simultaneously (e.g. dashboard load),
 * only the first call hits the T212 API. Subsequent callers await the same promise.
 */
let inflight: Promise<Record<string, number>> | null = null;

export async function fetchT212LivePrices(userId: string = 'default-user'): Promise<Record<string, number>> {
  // Return cached prices if fresh enough
  if (Date.now() - t212PriceCacheAge < T212_PRICE_TTL && t212PriceCache.size > 0) {
    const result: Record<string, number> = {};
    t212PriceCache.forEach((entry, ticker) => result[ticker] = entry.price);
    return result;
  }

  // Outside market hours: serve stale cache to save T212 rate limit budget
  if (!isAnyMarketOpen() && t212PriceCache.size > 0) {
    return staleT212PriceResult();
  }

  if (t212PriceCache.size > 0 && (isRateLimitBackedOff('Invest') || isRateLimitBackedOff('ISA'))) {
    return staleT212PriceResult();
  }

  // Concurrency dedup: if another call is already in flight, await it
  if (inflight) return inflight;

  inflight = fetchT212LivePricesInner(userId).finally(() => { inflight = null; });
  return inflight;
}

async function fetchT212LivePricesInner(userId: string): Promise<Record<string, number>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        t212ApiKey: true,
        t212ApiSecret: true,
        t212Environment: true,
        t212Connected: true,
        t212IsaApiKey: true,
        t212IsaApiSecret: true,
        t212IsaConnected: true,
      },
    });

    if (!user) return {};

    const creds = validateDualCredentials(user);
    if (!creds.canFetch) return {};

    // Lightweight: only fetch positions (not account summary) for price data
    const investCreds = getCredentialsForAccount(user, 'invest');
    const isaCreds = getCredentialsForAccount(user, 'isa');

    // Fetch accounts SEQUENTIALLY with delay to avoid T212 rate limits (1 req/1s per account)
    const allPositions: T212Position[] = [];

    if (investCreds && !isRateLimitBackedOff('Invest')) {
      recordT212ApiCall();
      try {
        const positions = await new Trading212Client(investCreds.apiKey, investCreds.apiSecret, investCreds.environment)
          .getPositions();
        allPositions.push(...positions);
      } catch (err) {
        if (err instanceof Trading212Error && err.statusCode === 429) {
          console.warn('[position-sync] T212 Invest rate-limited — serving stale cache');
          setRateLimitBackoff('Invest', err);
          sendRateLimitAlert('Invest');
        }
      }
    }

    // ISA: skip if same API key as Invest (duplicate), otherwise wait 1.5s
    if (isaCreds && !(investCreds && investCreds.apiKey === isaCreds.apiKey) && !isRateLimitBackedOff('ISA')) {
      // T212 rate limit is per-account but same IP — add delay to be safe
      await new Promise(resolve => setTimeout(resolve, 1500));
      recordT212ApiCall();
      try {
        const positions = await new Trading212Client(isaCreds.apiKey, isaCreds.apiSecret, isaCreds.environment)
          .getPositions();
        allPositions.push(...positions);
      } catch (err) {
        if (err instanceof Trading212Error && err.statusCode === 429) {
          console.warn('[position-sync] T212 ISA rate-limited — serving stale cache');
          setRateLimitBackoff('ISA', err);
          sendRateLimitAlert('ISA');
        }
      }
    }

    // If T212 returned no positions (rate-limited or error), serve stale cache
    if (allPositions.length === 0 && t212PriceCache.size > 0) {
      console.warn('[position-sync] T212 returned no positions — serving stale cache');
      checkT212ConnectionDrop();
      return staleT212PriceResult();
    }

    // If T212 returned nothing and no cache exists, alert
    if (allPositions.length === 0) {
      checkT212ConnectionDrop();
    }

    const prices: Record<string, number> = {};
    const priceMap = new Map<string, number>();

    for (const pos of allPositions) {
      if (pos.currentPrice > 0) {
        const mapped = mapT212Position(pos);
        prices[mapped.ticker] = pos.currentPrice;
        priceMap.set(mapped.ticker, pos.currentPrice);
      }
    }

    // Update the cache
    updateT212PriceCache(priceMap);

    return prices;
  } catch (error) {
    console.warn('[position-sync] T212 live price fetch failed:', (error as Error).message);
    // Serve stale cache on any failure — stale T212 prices are still better than nothing
    if (t212PriceCache.size > 0) {
      return staleT212PriceResult();
    }
    return {};
  }
}

interface ClosureCandidate {
  positionId: string;
  recordedClosureDate?: Date | null;
  ticker: string;
  stockName: string;
  t212Ticker: string;
  entryPrice: number;
  entryDate: Date;
  shares: number;
  currentStop: number;
  initialRisk: number;
  initial_R: number | null;
  atr_at_entry: number | null;
  stockId: string;
  stockCurrency: string | null;
  stockCluster: string | null;
  stockSleeve: string;
  userId: string;
  accountType: string | null;
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Sync HybridTurtle open positions against Trading 212.
 * If T212 no longer holds a position, close it with actual exit data.
 *
 * SAFETY: Aborts entirely (no closures) if T212 API fails or returns 0 positions.
 */
export async function syncClosedPositions(userId: string = 'default-user', options: PositionSyncOptions = {}): Promise<PositionSyncResult> {
  const detectUntrackedSalesEnabled = options.detectUntrackedSales ?? true;
  const result: PositionSyncResult = { checked: 0, closed: 0, skipped: 0, updated: 0, errors: [] };

  // 1. Fetch all OPEN positions from DB
  const positions = await prisma.position.findMany({
    where: { userId, OR: [{ status: 'OPEN' },
      { status: 'CLOSED', exitReason: PENDING_BROKER_RECONCILIATION }] },
    include: { stock: true },
  });
  const openPositions = positions.filter(position => position.status === 'OPEN');

  result.checked = positions.length;

  // 2. Load T212 credentials and fetch live positions
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      t212ApiKey: true,
      t212ApiSecret: true,
      t212Environment: true,
      t212Connected: true,
      t212IsaApiKey: true,
      t212IsaApiSecret: true,
      t212IsaConnected: true,
    },
  });

  if (!user) {
    result.errors.push('User not found');
    return result;
  }

  const creds = validateDualCredentials(user);
  if (!creds.canFetch) {
    result.errors.push('No T212 credentials configured — position sync skipped');
    return result;
  }

  const investCreds = getCredentialsForAccount(user, 'invest');
  const isaCreds = getCredentialsForAccount(user, 'isa');
  const dualClient = new DualT212Client(investCreds, isaCreds);

  let dualResult;
  try {
    dualResult = await dualClient.fetchBothAccounts();
  } catch (err) {
    result.errors.push(`T212 API call failed: ${(err as Error).message}`);
    return result; // SAFETY: do not close anything
  }

  // SAFETY: If both accounts failed, abort entirely
  const investFailed = !investCreds || !!dualResult.errors.invest || !dualResult.invest?.positionsFetched;
  const duplicateAccountKey = !!(investCreds && isaCreds && investCreds.apiKey === isaCreds.apiKey);
  const isaFailed = duplicateAccountKey || !isaCreds || !!dualResult.errors.isa || !dualResult.isa?.positionsFetched;

  if (investFailed && isaFailed) {
    result.errors.push('T212 position fetch failed for all accounts — no positions auto-closed');
    if (dualResult.errors.invest) result.errors.push(`Invest: ${dualResult.errors.invest}`);
    if (dualResult.errors.isa) result.errors.push(`ISA: ${dualResult.errors.isa}`);
    return result;
  }

  // Build set of T212 tickers currently held across both accounts
  const combinedPositions = dualClient.getCombinedPositions(dualResult);

  // SAFETY: If T212 returns 0 positions across all accounts, suspect API error
  if (combinedPositions.length === 0 && openPositions.length > 0) {
    result.errors.push('T212 returned 0 positions — possible API error. No positions auto-closed.');
    return result;
  }

  // Scheduled syncs verify holdings too, so record when each account was last read
  // successfully (system-status and Settings otherwise only see manual syncs).
  try {
    const syncedAt = new Date();
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(!investFailed ? { t212LastSync: syncedAt } : {}),
        ...(!isaFailed ? { t212IsaLastSync: syncedAt } : {}),
      },
    });
  } catch (err) {
    result.errors.push(`Could not record sync time: ${(err as Error).message}`);
  }

  const untrackedBrokerPositions = findUntrackedBrokerPositions(openPositions, combinedPositions);
  for (const position of untrackedBrokerPositions) {
    const message = `${position.fullTicker} has ${position.shares} share(s) in the ${position.accountType.toUpperCase()} account but no OPEN HybridTurtle position. Reconcile the broker holding and add a protective stop.`;
    result.errors.push(`Untracked broker position: ${position.accountType}:${position.fullTicker}`);
    await sendAlert({
      type: 'ORPHAN_T212_FILL',
      title: `Untracked T212 position — ${position.fullTicker}`,
      message,
      priority: 'CRITICAL',
      data: {
        source: 'position-sync',
        accountType: position.accountType,
        t212Ticker: position.fullTicker,
        quantity: position.shares,
      },
      notificationDedupeKey: `untracked-position:${position.accountType}:${position.fullTicker}`,
      notificationThrottleMs: 24 * 60 * 60 * 1000,
      telegramDedupeKey: `untracked-position:${position.accountType}:${position.fullTicker}`,
      telegramThrottleMs: 24 * 60 * 60 * 1000,
    });
  }

  // Map: t212Ticker → T212 position data (for price updates)
  const t212TickerMap = new Map<string, { currentPrice: number; fullTicker: string }>();
  const priceMap = new Map<string, number>();
  for (const pos of combinedPositions) {
    // fullTicker is the raw T212 ticker (AME_US_EQ). Use it for matching.
    t212TickerMap.set(`${pos.accountType}:${pos.fullTicker}`, {
      currentPrice: pos.currentPrice,
      fullTicker: pos.fullTicker,
    });
    if (pos.currentPrice > 0) {
      priceMap.set(pos.ticker, pos.currentPrice);
    }
  }
  // Update the shared T212 price cache
  updateT212PriceCache(priceMap);

  // Also build a set of just the T212 full tickers for quick lookups
  const t212OpenTickers = new Set(combinedPositions.map(p => `${p.accountType}:${p.fullTicker}`));

  const hasMissingTrackedPosition = positions.some((pos) => {
    const t212Ticker = pos.t212Ticker || pos.stock.t212Ticker;
    return Boolean(t212Ticker && !t212OpenTickers.has(`${pos.accountType || 'invest'}:${t212Ticker}`));
  });

  // Fetch order history once only when needed. Routine midday syncs where all
  // tracked positions are still open should not burn T212 history quota.
  const accountHistory: Record<string, T212HistoricalOrder[]> = { invest: [], isa: [] };
  if (shouldFetchOrderHistoryForSync({ hasMissingTrackedPosition, detectUntrackedSales: detectUntrackedSalesEnabled })) {
    for (const [account, credentials] of [['invest', investCreds], ['isa', isaCreds]] as const) {
      if (!credentials || (account === 'invest' ? investFailed : isaFailed)) continue;
      try {
        const client = new Trading212Client(credentials.apiKey, credentials.apiSecret, credentials.environment);
        accountHistory[account] = await client.getOrderHistory(50, { maxPages: 1 });
      } catch (err) {
        result.errors.push(`${account}: order history fetch failed: ${(err as Error).message}`);
      }
    }
  }

  // 3. For each OPEN position in HybridTurtle, check T212 status
  for (const pos of positions) {
    // Resolve T212 ticker: Position.t212Ticker > Stock.t212Ticker
    const t212Ticker = pos.t212Ticker || pos.stock.t212Ticker;

    if (!t212Ticker) {
      // Cannot sync — no T212 ticker mapping
      result.skipped++;
      continue;
    }

    const accountTicker = `${pos.accountType || 'invest'}:${t212Ticker}`;
    if (t212OpenTickers.has(accountTicker)) {
      // Position still open in T212 — update currentPrice from live data
      const t212Data = t212TickerMap.get(accountTicker);
      if (t212Data && t212Data.currentPrice > 0) {
        result.updated++;
      }
      continue;
    }

    // Position was closed in T212 — only close if the account we depend on
    // actually returned data. If the account that owns this position failed
    // to fetch, skip it rather than incorrectly closing.
    const posAcct = pos.accountType;
    if (!posAcct || !['invest', 'isa'].includes(posAcct) || (pos.status === 'CLOSED'
      && (!pos.exitDate || pos.closedBy !== `PENDING_BROKER:${user.t212Environment}`))) {
      result.skipped++;
      result.errors.push(`${pos.stock.ticker}: accounting skipped - account or environment provenance unavailable`);
      continue;
    }
    if (posAcct === 'invest' && investFailed) {
      result.skipped++;
      result.errors.push(`${pos.stock.ticker}: skipped — Invest account fetch failed`);
      continue;
    }
    if (posAcct === 'isa' && isaFailed) {
      result.skipped++;
      result.errors.push(`${pos.stock.ticker}: skipped — ISA account fetch failed`);
      continue;
    }

    // Confirmed closed — build closure candidate
    const candidate: ClosureCandidate = {
      positionId: pos.id,
      recordedClosureDate: pos.status === 'CLOSED' ? pos.exitDate : null,
      ticker: pos.stock.ticker,
      stockName: pos.stock.name || pos.stock.ticker,
      t212Ticker,
      entryPrice: pos.entryPrice,
      entryDate: pos.entryDate,
      shares: pos.shares,
      currentStop: pos.currentStop,
      initialRisk: pos.initialRisk,
      initial_R: pos.initial_R,
      atr_at_entry: pos.atr_at_entry,
      stockId: pos.stockId,
      stockCurrency: pos.stock.currency,
      stockCluster: pos.stock.cluster,
      stockSleeve: pos.stock.sleeve,
      userId: pos.userId,
      accountType: pos.accountType,
    };

    try {
      const pendingReason = await closePosition(candidate, accountHistory[posAcct], user.t212Environment);
      if (pos.status === 'OPEN') result.closed++;
      else if (!pendingReason) result.updated++;
      if (pendingReason) result.errors.push(`${pos.stock.ticker}: closure accounting pending - ${pendingReason}`);
    } catch (err) {
      result.errors.push(`${pos.stock.ticker}: close failed — ${(err as Error).message}`);
    }
  }

  // 4. Detect untracked T212 sales — sells in order history that don't match any DB position
  if (detectUntrackedSalesEnabled) {
    await detectUntrackedSales([...accountHistory.invest, ...accountHistory.isa], openPositions, userId, result);
  }

  return result;
}

// ── Untracked Sale Detection ─────────────────────────────────────────

/**
 * Check T212 order history for recent SELL orders that don't match any
 * tracked open position. This catches stop-outs on positions that were
 * never added to HybridTurtle (e.g. BESI).
 */
async function detectUntrackedSales(
  orderHistory: T212HistoricalOrder[],
  openPositions: Array<{ t212Ticker: string | null; stock: { t212Ticker: string | null; ticker: string } }>,
  userId: string,
  result: PositionSyncResult
): Promise<void> {
  if (orderHistory.length === 0) return;

  // Build set of all tracked T212 tickers (from positions)
  const trackedT212Tickers = new Set<string>();
  for (const pos of openPositions) {
    const t = pos.t212Ticker || pos.stock.t212Ticker;
    if (t) trackedT212Tickers.add(t);
  }

  // Also include recently-closed positions (last 7 days) to avoid repeat alerts
  const recentlyClosed = await prisma.position.findMany({
    where: {
      userId,
      status: 'CLOSED',
      exitDate: { gte: new Date(Date.now() - 7 * 86400000) },
    },
    select: { t212Ticker: true, stock: { select: { t212Ticker: true } } },
  });
  for (const pos of recentlyClosed) {
    const t = pos.t212Ticker || pos.stock.t212Ticker;
    if (t) trackedT212Tickers.add(t);
  }

  // Find recent sells (last 48 hours) that are not tracked
  const cutoff = new Date(Date.now() - 48 * 3600000);
  const recentSells = orderHistory.filter(o =>
    o.type === 'SELL' &&
    o.status === 'FILLED' &&
    o.filledQuantity > 0 &&
    o.dateExecuted &&
    new Date(o.dateExecuted) >= cutoff
  );

  const untrackedSells = recentSells.filter(o => !trackedT212Tickers.has(o.ticker));

  for (const sell of untrackedSells) {
    const fillPrice = sell.filledQuantity > 0
      ? sell.filledValue / sell.filledQuantity
      : 0;
    const baseTicker = sell.ticker
      .replace(/_US_EQ$/, '')
      .replace(/_UK_EQ$/, '')
      .replace(/_NL_EQ$/, '')
      .replace(/_DE_EQ$/, '')
      .replace(/_FR_EQ$/, '')
      .replace(/_CH_EQ$/, '')
      .replace(/_DK_EQ$/, '')
      .replace(/_SE_EQ$/, '')
      .replace(/_FI_EQ$/, '')
      .replace(/_IT_EQ$/, '')
      .replace(/_EQ$/, '')
      .replace(/_ETF$/, '');

    try {
      await sendAlert({
        type: 'SYSTEM',
        title: `Untracked sale detected — ${baseTicker}`,
        message: `Trading 212 shows a recent SELL for ${baseTicker} (${sell.ticker}) that is not tracked in HybridTurtle.\n\nFill price: ${fillPrice.toFixed(2)} · Qty: ${sell.filledQuantity}\nDate: ${sell.dateExecuted}\n\nThis position was not in your portfolio. Use "Record Past Trade" on the Trade Review page to log it.`,
        data: { t212Ticker: sell.ticker, baseTicker, fillPrice, quantity: sell.filledQuantity, dateExecuted: sell.dateExecuted },
        priority: 'WARNING',
        telegramDedupeKey: `position-sync:untracked-sale:${sell.ticker}:${sell.dateExecuted}`,
      });
    } catch {
      // Alert send failure — non-blocking
    }

    result.errors.push(`${baseTicker}: untracked T212 sale detected (not in portfolio) — use Record Past Trade to log it`);
  }
}

// ── Closure Flow ─────────────────────────────────────────────────────

async function closePosition(
  candidate: ClosureCandidate,
  orderHistory: T212HistoricalOrder[],
  environment: string
): Promise<string | null> {
  const now = new Date();
  const closureWhere = {
    id: candidate.positionId,
    userId: candidate.userId,
    accountType: candidate.accountType,
    shares: candidate.shares,
    entryPrice: candidate.entryPrice,
    entryDate: candidate.entryDate,
    ...(candidate.recordedClosureDate
      ? { status: 'CLOSED', exitReason: PENDING_BROKER_RECONCILIATION,
        closedBy: `PENDING_BROKER:${environment}`, exitDate: candidate.recordedClosureDate }
      : { status: 'OPEN' }),
  };

  // 1. Determine exit price from order history
  const evidence = reconcileClosureEvidence(candidate, orderHistory, candidate.recordedClosureDate ?? now);
  if (!evidence.ok) {
    await prisma.position.update({ where: closureWhere, data: {
      status: 'CLOSED', exitDate: candidate.recordedClosureDate ?? now,
      exitReason: PENDING_BROKER_RECONCILIATION, closedBy: `PENDING_BROKER:${environment}`,
      exitPrice: null, exitProfitR: null, realisedPnlR: null, realisedPnlGbp: null,
    } });
    await sendAlert({
      type: 'BROKER_SYNC_FAILURE', priority: 'WARNING',
      title: `Closure accounting pending - ${candidate.ticker}`,
      message: `${candidate.ticker} is absent from its broker account. The holding is closed locally, but exit price and P&L remain unknown: ${evidence.reason}. Review account-scoped fill history.`,
      data: { positionId: candidate.positionId, accountType: candidate.accountType, reason: evidence.reason },
      notificationDedupeKey: `closure-accounting:${candidate.positionId}`,
      notificationThrottleMs: 24 * 60 * 60_000,
      telegramDedupeKey: `closure-accounting:${candidate.positionId}`,
      telegramThrottleMs: 24 * 60 * 60_000,
    });
    return evidence.reason;
  }
  const { exitPrice, order: matchedOrder } = evidence;
  const confidence = 'CONFIRMED' as const;

  // 2. Determine exit reason
  const exitReason = determineExitReason(exitPrice, candidate.currentStop, matchedOrder);

  const { pnlGbp: realisedPnlGbp, fxRate: fxRateUsed, netValueGbp } = evidence;
  const realisedPnlT212 = realisedPnlGbp;

  const initialR = candidate.initial_R ?? candidate.initialRisk;
  const realisedPnlR = initialR > 0
    ? (exitPrice - candidate.entryPrice) / initialR
    : null;

  // 4. Calculate holding days
  const daysHeld = Math.floor((evidence.exitDate.getTime() - candidate.entryDate.getTime()) / 86400000);

  // 5. Atomic update: position + trade log in a single transaction
  await prisma.$transaction(async (tx) => {
    // Update position
    await tx.position.update({
      where: closureWhere,
      data: {
        status: 'CLOSED',
        exitPrice,
        exitDate: evidence.exitDate,
        exitReason,
        exitProfitR: realisedPnlR,
        realisedPnlGbp,
        realisedPnlR,
        closedBy: 'AUTO_SYNC',
      },
    });

    // Create trade log entry with T212-specific fields
    const tradeType = exitReason === 'STOP_HIT' ? 'STOP_HIT' : 'EXIT';
    const fillDate = matchedOrder?.dateExecuted ? new Date(matchedOrder.dateExecuted) : null;
    await tx.tradeLog.create({
        data: {
          userId: candidate.userId,
          positionId: candidate.positionId,
          ticker: candidate.ticker,
          tradeDate: now,
          tradeType,
          decision: 'TAKEN',
          entryPrice: candidate.entryPrice,
          initialStop: candidate.currentStop,
          initialR,
          shares: candidate.shares,
          exitPrice,
          exitReason,
          finalRMultiple: realisedPnlR,
          gainLossGbp: realisedPnlGbp,
          daysHeld,
          atrAtEntry: candidate.atr_at_entry,
          // T212-specific fields for confirmed fills
          t212OrderId: matchedOrder ? matchedOrder.id.toString() : null,
          t212Ticker: candidate.t212Ticker,
          fillPrice: exitPrice,
          fillQuantity: matchedOrder?.filledQuantity ?? candidate.shares,
          fillTimestamp: fillDate,
          fxRateAtFill: fxRateUsed,
          netValueGbp,
          realisedPnlT212,
          initiatedFrom: matchedOrder?.initiatedFrom ?? null,
        },
    });
  });

  // 6. Log EV record (non-blocking, outside transaction)
  const entryLog = await prisma.tradeLog.findFirst({
    where: { positionId: candidate.positionId, tradeType: { in: ['ENTRY', 'STOP_HIT', 'EXIT'] } },
    orderBy: { tradeDate: 'asc' },
    select: { id: true, regime: true, ncsScore: true },
  });

  if (realisedPnlR != null) logEVRecord({
    tradeId: entryLog?.id ?? candidate.positionId,
    regime: entryLog?.regime,
    atrAtEntry: candidate.atr_at_entry,
    cluster: candidate.stockCluster,
    sleeve: candidate.stockSleeve,
    entryNCS: entryLog?.ncsScore ?? null,
    rMultiple: realisedPnlR,
    closedAt: evidence.exitDate,
  }).catch(() => { /* already logged inside logEVRecord */ });

  // 7. Send notifications
  await sendClosureNotifications(candidate, exitPrice, exitReason, realisedPnlGbp, realisedPnlR, daysHeld, confidence);
  return null;
}

// ── Exit Reason Determination ────────────────────────────────────────

/**
 * Classify how a position closed.
 *
 * Preference order:
 *   1. If we matched a T212 historical order, use broker metadata. A stop
 *      order always has `stopPrice` set; a market order does not. This is
 *      authoritative regardless of any drift between DB.currentStop and the
 *      broker stop (the F-2 audit finding — DB_LOWER drift could otherwise
 *      misclassify a real STOP_HIT as MANUAL_SALE).
 *   2. If we have no matched order (defensive fallback only), use the legacy
 *      price-vs-DB-stop heuristic. This path is intentionally narrow because
 *      it is the one that drifts when DB and broker stops disagree.
 */
function determineExitReason(
  exitPrice: number,
  currentStop: number,
  matchedOrder?: T212HistoricalOrder | null,
): string {
  if (matchedOrder) {
    // Broker metadata is authoritative. T212 sets `stopPrice` on stop orders
    // (including stop-loss) and leaves it undefined for market/limit orders.
    return matchedOrder.stopPrice != null ? 'STOP_HIT' : 'MANUAL_SALE';
  }
  // Fallback: price-vs-stop heuristic. Only reachable when we cannot match
  // the closing order to a T212 history record (rare).
  if (exitPrice <= currentStop) {
    return 'STOP_HIT';
  }
  if (exitPrice > currentStop) {
    return 'MANUAL_SALE';
  }
  return 'UNKNOWN';
}

// ── Notifications ────────────────────────────────────────────────────

async function sendClosureNotifications(
  candidate: ClosureCandidate,
  exitPrice: number,
  exitReason: string,
  realisedPnlGbp: number,
  realisedPnlR: number | null,
  daysHeld: number,
  priceConfidence: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN'
): Promise<void> {
  const currSymbol = getCurrencySymbol(candidate.ticker, candidate.stockCurrency);
  const pnlSign = realisedPnlGbp >= 0 ? '+' : '';
  const rStr = realisedPnlR != null ? `${pnlSign}${realisedPnlR.toFixed(1)}R` : 'N/A';
  const pnlStr = `${pnlSign}£${realisedPnlGbp.toFixed(2)}`;
  const priceNote = priceConfidence === 'UNKNOWN' ? ' (estimated)' : '';

  if (exitReason === 'STOP_HIT') {
    await sendAlert({
      type: 'POSITION_CLOSED',
      title: `Position closed — ${candidate.ticker} stop triggered`,
      message: `Your stop-loss on ${candidate.ticker} (${candidate.stockName}) was triggered.\n\nBought: ${currSymbol}${candidate.entryPrice.toFixed(2)} · Sold: ${currSymbol}${exitPrice.toFixed(2)}${priceNote}\nResult: ${pnlStr} (${rStr})\nHeld: ${daysHeld} days\n\nOpen your journal to record what happened.`,
      data: { ticker: candidate.ticker, exitPrice, exitReason, realisedPnlGbp, realisedPnlR, daysHeld, priceConfidence },
      priority: 'WARNING',
    });
  } else if (exitReason === 'MANUAL_SALE') {
    await sendAlert({
      type: 'POSITION_CLOSED',
      title: `Position closed — ${candidate.ticker} sold`,
      message: `Your position in ${candidate.ticker} (${candidate.stockName}) was closed in Trading 212.\n\nBought: ${currSymbol}${candidate.entryPrice.toFixed(2)} · Sold: ${currSymbol}${exitPrice.toFixed(2)}${priceNote}\nResult: ${pnlStr} (${rStr})\nHeld: ${daysHeld} days\n\nOpen your journal to record your thoughts.`,
      data: { ticker: candidate.ticker, exitPrice, exitReason, realisedPnlGbp, realisedPnlR, daysHeld, priceConfidence },
      priority: 'INFO',
    });
  } else {
    await sendAlert({
      type: 'POSITION_CLOSED',
      title: `Position closed — ${candidate.ticker}`,
      message: `Your position in ${candidate.ticker} was closed in Trading 212.\n\nExit price: ${currSymbol}${exitPrice.toFixed(2)}${priceNote}\nResult: ${pnlStr}\n\nPlease verify in Trading 212 and update your journal.`,
      data: { ticker: candidate.ticker, exitPrice, exitReason, realisedPnlGbp, realisedPnlR, daysHeld, priceConfidence },
      priority: 'WARNING',
    });
  }

  // Journal prompt notification
  await sendAlert({
    type: 'JOURNAL_PROMPT',
    title: `Add a close note — ${candidate.ticker}`,
    message: `You closed ${candidate.ticker} for ${pnlStr}. What happened? What did you learn?\nOpen your journal to record it.`,
    data: { ticker: candidate.ticker, positionId: candidate.positionId },
    priority: 'INFO',
  });
}

function getCurrencySymbol(ticker: string, stockCurrency: string | null): string {
  const isUK = ticker.endsWith('.L') || /^[A-Z]{2,5}l$/.test(ticker);
  const currency = (stockCurrency || 'USD').toUpperCase();
  if (isUK || currency === 'GBP' || currency === 'GBX') return '£';
  if (currency === 'EUR') return '€';
  return '$';
}
