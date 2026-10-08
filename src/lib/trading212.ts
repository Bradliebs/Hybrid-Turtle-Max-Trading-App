/**
 * DEPENDENCIES
 * Consumed by: /api/stops/t212/route.ts, /api/trading212/*, T212SyncPanel.tsx, /api/positions/execute/route.ts
 * Consumes: fetch (T212 REST API)
 * Risk-sensitive: YES
 * Last modified: 2026-02-28
 * Notes: isStopTooFar() pre-validates stop distance before T212 API call (instrument-specific, ~50% heuristic)
 */
// ============================================================
// Trading 212 API Client — HybridTurtle Integration
// ============================================================

export type Trading212Environment = 'demo' | 'live';

/** Which T212 account a position belongs to — re-exported from trading212-dual.ts */
export type T212AccountType = 'invest' | 'isa';

const BASE_URLS: Record<Trading212Environment, string> = {
  demo: 'https://demo.trading212.com/api/v0',
  live: 'https://live.trading212.com/api/v0',
};

// ---- Response Types ----

export interface T212Position {
  averagePricePaid: number;
  createdAt: string; // ISO 8601
  currentPrice: number;
  instrument: {
    isin: string;
    currencyCode: string;
    name: string;
    ticker: string;
  };
  quantity: number;
  quantityAvailableForTrading: number;
  quantityInPies: number;
  walletImpact: {
    investedValue: number;
    result: number;
    resultCoef: number;
    value: number;
    valueInAccountCurrency: number;
  };
}

export interface T212AccountSummary {
  cash: {
    availableToTrade: number;
    inPies: number;
    reservedForOrders: number;
  };
  currency: string;
  id: number;
  investments: {
    currentValue: number;
    realizedProfitLoss: number;
    totalCost: number;
    unrealizedProfitLoss: number;
  };
  totalValue: number;
}

export interface T212Instrument {
  /** Full T212 instrument identifier, e.g. AAPL_US_EQ, AZNl_EQ. */
  ticker: string;
  /** Bare/display ticker, e.g. AAPL, AZN, RBOT. Prefer this over stripping
   *  the suffix off `ticker` — it's what T212 considers the canonical name. */
  shortName?: string;
  isin: string;
  currencyCode: string;
  name: string;
  type: string;
  /** Internal T212 schedule id; not a tradable concept but useful for grouping. */
  workingScheduleId?: number;
  /** Documented in T212 docs but not actually returned by the live API
   *  in our tenant — keep optional for forward-compat but never rely on it. */
  exchange?: string;
  minTradeQuantity?: number;
  maxOpenQuantity: number;
  extendedHours?: boolean;
  addedOn: string;
}

export interface T212HistoricalOrderFill {
  id?: number;
  price: number;
  quantity: number;
  filledAt: string;
  walletImpact?: {
    currency?: string;
    fxRate?: number;
    netValue?: number;
    realisedProfitLoss?: number;
  };
}

/** Raw T212 API response shape for each history item: { order, fill } */
interface T212RawHistoryItem {
  order: {
    id: number;
    ticker: string;
    type: string;
    strategy?: string;
    side?: 'BUY' | 'SELL';
    status: string;
    limitPrice?: number;
    stopPrice?: number;
    quantity?: number;
    filledQuantity?: number;
    value?: number;
    filledValue?: number;
    currency?: string;
    extendedHours?: boolean;
    initiatedFrom?: string;
    createdAt: string;
    instrument?: {
      ticker: string;
      name: string;
      isin: string;
      currency: string;
    };
  };
  fill?: {
    id: number;
    quantity: number;
    price: number;
    type: string;
    tradingMethod?: string;
    filledAt: string;
    walletImpact?: {
      currency?: string;
      netValue?: number;
      realisedProfitLoss?: number;
      fxRate?: number;
    };
  };
}

/**
 * Flattened historical order — produced by getOrderHistory() from T212 raw response.
 * This is the format consumed by the importer.
 */
export interface T212HistoricalOrder {
  id: number;
  ticker: string;
  type: string;
  side?: 'BUY' | 'SELL';
  status: string;
  limitPrice?: number;
  stopPrice?: number;
  quantity: number;
  filledQuantity: number;
  filledValue: number;
  dateCreated: string;
  dateExecuted?: string;
  initiatedFrom?: string;
  fills?: T212HistoricalOrderFill[];
}

export interface T212PendingOrder {
  id: number;
  createdAt: string;
  currency: string;
  extendedHours: boolean;
  filledQuantity: number;
  filledValue: number;
  initiatedFrom: string;
  instrument: {
    currency: string;
    isin: string;
    name: string;
    ticker: string;
  };
  limitPrice?: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  status: string;
  stopPrice?: number;
  strategy: string;
  ticker: string;
  timeInForce: 'DAY' | 'GOOD_TILL_CANCEL';
  type: 'LIMIT' | 'STOP' | 'MARKET' | 'STOP_LIMIT';
  value: number;
}

export interface T212PlaceStopOrderRequest {
  quantity: number;       // Negative for sell (stop-loss)
  stopPrice: number;
  ticker: string;         // T212 format: AAPL_US_EQ
  timeValidity: 'DAY' | 'GOOD_TILL_CANCEL';
}

export interface T212PlaceMarketOrderRequest {
  quantity: number;       // Positive = buy, Negative = sell
  ticker: string;         // T212 format: AAPL_US_EQ
}

export interface T212PaginatedResponse<T> {
  items: T[];
  nextPagePath: string | null;
}

export interface T212OrderHistoryOptions {
  maxPages?: number;
}

/** A cash movement from GET /equity/history/transactions. */
export interface T212CashTransaction {
  type: 'WITHDRAW' | 'DEPOSIT' | 'FEE' | 'TRANSFER' | 'INTEREST_ON_FREE_CASH' | 'LENDING_INTEREST' | string;
  amount: number;
  currency?: string;
  dateTime: string;
  reference?: string;
}

// ---- API Client ----

/**
 * Per-endpoint minimum spacing (milliseconds) for known-tight T212 endpoints.
 * Source: per-endpoint Rate limit lines in https://docs.trading212.com/api/orders, /positions,
 * /instruments, /historical-events. Values include a small safety margin.
 *
 * Used by `Trading212Client.paceCall()` to proactively wait when a recent call to the same
 * endpoint would otherwise burn a 429 (which we already retry on, but at the cost of latency).
 */
const MIN_INTERVAL_MS: Record<string, number> = {
  // Orders
  'GET /equity/orders': 5_100,             // 1 req / 5s — pending-orders list
  'GET /equity/orders/_id': 1_100,         // 1 req / 1s — single order by id
  'DELETE /equity/orders/_id': 1_300,      // 50 req / 1m — cancel order by id
  'POST /equity/orders/market': 1_300,     // 50 req / 1m ≈ 1.2s avg; pace at 1.3s
  'POST /equity/orders/stop': 2_100,       // 1 req / 2s
  'POST /equity/orders/limit': 2_100,      // 1 req / 2s
  'POST /equity/orders/stop_limit': 2_100, // 1 req / 2s
  // Positions
  'GET /equity/positions': 1_100,          // 1 req / 1s
  // Account
  'GET /equity/account/summary': 5_100,    // 1 req / 5s
  // Instruments (very strict)
  'GET /equity/metadata/instruments': 50_500, // 1 req / 50s
  'GET /equity/metadata/exchanges': 30_500,   // 1 req / 30s
  // Historical events (6 req / 1m)
  'GET /equity/history/orders': 10_500,
  'GET /equity/history/dividends': 10_500,
  'GET /equity/history/transactions': 10_500,
};

/**
 * Pending-order safety cap. T212 documents "maximum of 50 pending orders allowed per ticker,
 * per account" (https://docs.trading212.com/api/section/rate-limiting#Function-Specific-Limits).
 * We abort stop placement at 45 to leave headroom for retries and concurrent flows.
 */
const PENDING_ORDER_CAP_PER_TICKER = 45;

export class Trading212Client {
  private baseUrl: string;
  private authHeader: string;
  /** Last-call timestamps per endpoint key ("METHOD /path"). Per-instance, not shared. */
  private lastCallAt: Map<string, number> = new Map();

  /**
   * Construct a Trading 212 API client.
   *
   * Auth modes (both documented at https://docs.trading212.com/api/section/authentication):
   * - Key-pair (preferred): pass `apiKey` and `apiSecret` → sent as `Authorization: Basic base64(key:secret)`.
   * - Single-token (legacy): pass only `apiKey` (leave `apiSecret` empty) → sent as `Authorization: <apiKey>`.
   *   This is the form T212 issues when generating an API key from the mobile app today; many
   *   users only ever see a single token and never receive a separate secret.
   */
  // `environment` is REQUIRED (audit F3): a silent default would let a caller
  // that forgot the argument transact on the wrong account. The live/demo
  // choice must be an explicit, compile-time-enforced decision at every site.
  constructor(apiKey: string, apiSecret: string = '', environment: Trading212Environment) {
    this.baseUrl = BASE_URLS[environment];
    if (apiSecret && apiSecret.length > 0) {
      // HTTP Basic Auth: base64(API_KEY:API_SECRET) — the documented key-pair scheme
      const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
      this.authHeader = `Basic ${credentials}`;
    } else {
      // Legacy single-token scheme — the cURL examples in the T212 docs show this form too
      this.authHeader = apiKey;
    }
  }

  private async request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const method = options?.method ?? 'GET';
    const maxRetries = 2; // Retry up to 2 times on rate limit (429)

    // Proactive pacing for known-tight endpoints — cheaper than burning a 429 + retry.
    await this.paceCall(method, path);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
        ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
      });

      if (!response.ok) {
        const rateLimitReset = response.headers.get('x-ratelimit-reset');

        if (response.status === 429) {
          // Auto-retry after waiting for the rate limit window to reset
          if (attempt < maxRetries) {
            const waitMs = rateLimitReset
              ? Math.max(1000, (parseInt(rateLimitReset) * 1000) - Date.now() + 500)
              : 6000; // Default 6s wait (covers the 5s getPendingOrders limit)
            const clampedWait = Math.min(waitMs, 15000); // Cap at 15s
            console.warn(`T212 rate limited on ${method} ${path}, retrying in ${clampedWait}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, clampedWait));
            continue;
          }
          throw new Trading212Error(
            `Rate limited. Resets at ${rateLimitReset}`,
            429,
            rateLimitReset ? parseInt(rateLimitReset) : undefined
          );
        }

        if (response.status === 401) {
          throw new Trading212Error('Invalid API credentials', 401);
        }

        if (response.status === 403) {
          throw new Trading212Error('Access forbidden — check API key permissions', 403);
        }

        // Read the response body for the actual T212 error detail
        let errorDetail = '';
        try {
          const errorBody = await response.text();
          // T212 returns JSON with varying field names: message, code, type, title
          try {
            const parsed = JSON.parse(errorBody);
            errorDetail = parsed.message || parsed.code || parsed.errorMessage
              || (parsed.title ? `${parsed.title}${parsed.type ? ` (${parsed.type})` : ''}` : '')
              || errorBody;
          } catch {
            errorDetail = errorBody;
          }
        } catch {
          errorDetail = response.statusText;
        }

        // Add diagnostic hints for known T212 error types
        if (errorDetail.includes('price-too-far')) {
          errorDetail += '. T212 rejected this stop because it is outside the instrument\'s acceptable price range (typically ~50% from the current market price, but varies per instrument). For UK stocks (.L), also check that your stop is in pence (GBX), not pounds (GBP) — e.g. 1350 not 13.50. Consider using a tighter stop or setting it manually in the T212 app.';
        }
        if (errorDetail.includes('selling-equity-not-owned')) {
          errorDetail += '. T212 says you don\'t own this equity on this account. This usually means the position is in a different account (ISA vs Invest) — check the accountType on the position matches where the shares are actually held.';
        }
        // T212 refuses ALL orders on this instrument — it is suspended, delisted, or
        // otherwise withdrawn from trading (corporate action, acquisition, halt).
        // No stop price will work; retrying is pointless. Critically, setStopLoss
        // cancels the existing stop BEFORE placing the new one, so a failure here can
        // leave the position with no stop at the broker at all.
        if (errorDetail.includes('instrument-disabled')) {
          errorDetail += '. T212 has disabled trading on this instrument entirely (suspension, delisting, or a corporate action) — no stop price will be accepted and retrying will not help. IMPORTANT: the previous stop order was cancelled before this placement was attempted, so this position may now have NO stop at the broker. Check the pending orders for this ticker in the T212 app and manage the position manually.';
        }
        // 404 "entity not found" on order endpoints almost always means the
        // instrument identifier we sent (the Stock.t212Ticker) does not match
        // any T212 instrument. Diagnosed during the 11 May 2026 RBOT incident
        // (Stock.t212Ticker was bare 'RBOT' instead of 'RBOTl_EQ'). Hint
        // the operator at the repair script that uses the cached instruments
        // snapshot to find the right value.
        if (
          response.status === 404 &&
          (errorDetail.includes('entity-not-found') || errorDetail.includes('Requested entity not found'))
        ) {
          errorDetail += '. T212 does not recognise the instrument identifier sent in this request. This is almost always a Stock.t212Ticker mapping problem (the value is missing the _EQ suffix or points at a delisted/wrong-region listing). Run `npx tsx scripts/fix-invalid-t212-tickers.ts` (database-only) and `npx tsx scripts/repair-t212-tickers-from-instruments.ts` (queries the live T212 instruments universe) to identify and repair the mapping.';
        }

        throw new Trading212Error(
          `Trading 212 API error ${response.status}: ${errorDetail}`,
          response.status
        );
      }

      // Log rate-limit quota on successful responses for observability
      const remaining = response.headers.get('x-ratelimit-remaining');
      const limit = response.headers.get('x-ratelimit-limit');
      if (remaining !== null && limit !== null) {
        const rem = parseInt(remaining);
        const lim = parseInt(limit);
        if (rem <= Math.ceil(lim * 0.2)) {
          console.warn(`[T212] Rate quota low: ${remaining}/${limit} remaining on ${method} ${path}`);
          // Fire-and-forget observability sink; never blocks or throws into the API path
          void import('./t212-quota-log')
            .then(({ recordT212QuotaEvent }) =>
              recordT212QuotaEvent({
                timestamp: new Date().toISOString(),
                remaining: rem,
                limit: lim,
                method,
                path,
              })
            )
            .catch(() => undefined);
        }
      }

      return response.json();
    }

    // Should never reach here, but TypeScript needs a return
    throw new Trading212Error('Max retries exceeded', 429);
  }

  /**
   * Proactive endpoint pacing. For known-tight T212 endpoints (e.g. /metadata/instruments
   * at 1 req / 50s), waits the remainder of the minimum interval before issuing another call
   * on the same Trading212Client instance. Cheaper than absorbing a 429 + retry round-trip.
   *
   * Path normalization: strips query strings and numeric path segments (e.g. `/orders/{id}`)
   * so paginated GETs and per-id lookups all share the same endpoint key.
   *
   * Disabled under Vitest so unit tests don't pay multi-second pacing costs.
   */
  private async paceCall(method: string, path: string): Promise<void> {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

    // Normalise path → strip query, replace numeric ids with `/_id` sentinel.
    // Sentinel preserves the distinction between list endpoints (e.g. GET /equity/orders
    // at 1 req/5s) and per-id endpoints (e.g. GET /equity/orders/{id} at 1 req/1s).
    // Stripping ids outright caused getOrder(buyOrderId) polling to inherit the 5s
    // list-endpoint pacing, slowing Phase B fill detection ~5× and producing orphan
    // positions when the actual fill arrived after the poll loop had given up.
    const cleanPath = path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/_id');
    const key = `${method} ${cleanPath}`;
    const minInterval = MIN_INTERVAL_MS[key];
    if (!minInterval) return; // Endpoint isn't on the tight list — no pacing needed

    const last = this.lastCallAt.get(key);
    const now = Date.now();
    if (last !== undefined) {
      const elapsed = now - last;
      const wait = minInterval - elapsed;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    this.lastCallAt.set(key, Date.now());
  }

  // ---- Positions ----

  /** Fetch all open positions. Rate limit: 1 req / 1s */
  async getPositions(): Promise<T212Position[]> {
    return this.request<T212Position[]>('/equity/positions');
  }

  /** Fetch a single position by ticker. Rate limit: 1 req / 1s */
  async getPosition(ticker: string): Promise<T212Position[]> {
    return this.request<T212Position[]>(`/equity/positions?ticker=${encodeURIComponent(ticker)}`);
  }

  // ---- Account ----

  /** Get account summary with cash and investment metrics. Rate limit: 1 req / 5s */
  async getAccountSummary(): Promise<T212AccountSummary> {
    return this.request<T212AccountSummary>('/equity/account/summary');
  }

  // ---- Instruments ----

  /** Get list of tradable instruments */
  async getInstruments(): Promise<T212Instrument[]> {
    return this.request<T212Instrument[]>('/equity/metadata/instruments');
  }

  // ---- Historical Orders (paginated) ----

  /**
   * Fetch historical orders with automatic pagination.
   * T212 API returns { order, fill } pairs — we flatten them into T212HistoricalOrder
   * for the importer to consume.
   */
  async getOrderHistory(limit: number = 50, options: T212OrderHistoryOptions = {}): Promise<T212HistoricalOrder[]> {
    const allOrders: T212HistoricalOrder[] = [];
    let nextPath: string | null = `/equity/history/orders?limit=${limit}`;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    let pagesFetched = 0;

    while (nextPath && pagesFetched < maxPages) {
      const page: T212PaginatedResponse<T212RawHistoryItem> = await this.request(nextPath);
      pagesFetched++;

      for (const item of page.items) {
        const o = item.order;
        const f = item.fill;

        // Flatten the { order, fill } pair into a single T212HistoricalOrder
        const filledQty = f
          ? Math.abs(f.quantity)
          : Math.abs(o.filledQuantity ?? 0);
        const filledVal = f
          ? Math.abs(f.quantity) * f.price
          : (o.filledValue ?? 0);

        const flat: T212HistoricalOrder = {
          id: o.id,
          ticker: o.ticker,
          type: o.type,
          side: o.side,
          status: o.status,
          limitPrice: o.limitPrice,
          stopPrice: o.stopPrice,
          quantity: Math.abs(o.quantity ?? filledQty),
          filledQuantity: filledQty,
          filledValue: filledVal,
          dateCreated: o.createdAt,
          dateExecuted: f?.filledAt,
          initiatedFrom: o.initiatedFrom,
        };

        // Attach fill data in the fills[] format the importer expects
        if (f) {
          flat.fills = [{
            id: f.id,
            price: f.price,
            quantity: Math.abs(f.quantity),
            filledAt: f.filledAt,
            walletImpact: f.walletImpact ? {
              currency: f.walletImpact.currency,
              fxRate: f.walletImpact.fxRate,
              netValue: f.walletImpact.netValue,
              realisedProfitLoss: f.walletImpact.realisedProfitLoss,
            } : undefined,
          }];
        }

        allOrders.push(flat);
      }

      // T212 nextPagePath includes /api/v0/ prefix — strip it to avoid doubling
      // since baseUrl already contains /api/v0
      const raw = page.nextPagePath;
      if (raw && pagesFetched < maxPages) {
        nextPath = raw.startsWith('/api/v0') ? raw.replace('/api/v0', '') : raw;
      } else {
        nextPath = null;
      }
    }

    return allOrders;
  }

  /**
   * Fetch cash movements (deposits, withdrawals, fees, interest) with pagination.
   * Read-only. Rate limit: 20 req / 1min. Needs the history:transactions API scope.
   */
  async getCashTransactions(limit: number = 50, options: T212OrderHistoryOptions = {}): Promise<T212CashTransaction[]> {
    const all: T212CashTransaction[] = [];
    let nextPath: string | null = `/equity/history/transactions?limit=${limit}`;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    let pagesFetched = 0;
    while (nextPath && pagesFetched < maxPages) {
      const page: T212PaginatedResponse<T212CashTransaction> = await this.request(nextPath);
      pagesFetched++;
      all.push(...page.items);
      const raw = page.nextPagePath;
      nextPath = raw && pagesFetched < maxPages ? (raw.startsWith('/api/v0') ? raw.replace('/api/v0', '') : raw) : null;
    }
    return all;
  }

  // ---- Orders ----

  /** Get all pending (active) orders. Rate limit: 1 req / 5s */
  async getPendingOrders(): Promise<T212PendingOrder[]> {
    return this.request<T212PendingOrder[]>('/equity/orders');
  }

  /** Get a single pending order by ID. Rate limit: 1 req / 1s */
  async getOrder(orderId: number): Promise<T212PendingOrder> {
    return this.request<T212PendingOrder>(`/equity/orders/${orderId}`);
  }

  /**
   * Place a Market order (buy or sell at current market price).
   * Positive quantity = buy, negative = sell.
   * Rate limit: 1 req / 2s
   */
  async placeMarketOrder(order: T212PlaceMarketOrderRequest): Promise<T212PendingOrder> {
    return this.request<T212PendingOrder>('/equity/orders/market', {
      method: 'POST',
      body: order,
    });
  }

  /**
   * Place a Stop order (sell stop-loss).
   * Quantity must be NEGATIVE for a sell-side stop-loss.
   * Rate limit: 1 req / 2s
   */
  async placeStopOrder(order: T212PlaceStopOrderRequest): Promise<T212PendingOrder> {
    return this.request<T212PendingOrder>('/equity/orders/stop', {
      method: 'POST',
      body: order,
    });
  }

  /**
   * Cancel a pending order by ID.
   * Rate limit: 50 req / 1m
   * Includes 429 retry logic (up to 2 retries with backoff).
   */
  async cancelOrder(orderId: number): Promise<void> {
    const url = `${this.baseUrl}/equity/orders/${orderId}`;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) return;

      if (response.status === 429) {
        if (attempt < maxRetries) {
          const rateLimitReset = response.headers.get('x-ratelimit-reset');
          const waitMs = rateLimitReset
            ? Math.max(1000, (parseInt(rateLimitReset) * 1000) - Date.now() + 500)
            : 3000;
          const clampedWait = Math.min(waitMs, 10000);
          console.warn(`T212 rate limited on DELETE order ${orderId}, retrying in ${clampedWait}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, clampedWait));
          continue;
        }
        throw new Trading212Error(`Rate limited cancelling order ${orderId}`, 429);
      }

      if (response.status === 404) {
        // Already cancelled/filled — not an error in batch context
        return;
      }
      throw new Trading212Error(`Failed to cancel order: ${response.status}`, response.status);
    }
  }

  /**
   * Place or replace a stop-loss for a position.
   * MONOTONIC RULE: the new stop must be >= any existing T212 stop.
   * 1. Finds any existing STOP sell orders for this ticker
   * 2. Enforces monotonic rule (stops only go UP)
   * 3. Cancels old stops
   * 4. Places a new stop order at the given price
   * Returns the new order, or null if shares is 0.
   * Throws Trading212Error if the new stop would lower an existing one.
   */
  async setStopLoss(
    t212Ticker: string,
    shares: number,
    stopPrice: number,
    /** Optional current price for pre-validation; if not supplied, fetched from T212 positions */
    currentPrice?: number
  ): Promise<T212PendingOrder | null> {
    if (shares <= 0) return null;

    // Pre-validate ownership and stop distance against T212 positions
    let livePrice = currentPrice;
    if (!livePrice) {
      try {
        const prices = await this.getPositionPrices();
        livePrice = prices.get(t212Ticker);
        // If we successfully fetched positions but this ticker isn't there,
        // the position doesn't exist on this T212 account
        if (!livePrice && prices.size > 0) {
          throw new Trading212Error(
            `Ticker ${t212Ticker} not found in T212 positions for this account. ` +
            `The position may be in a different account (ISA vs Invest) or was already sold on T212. ` +
            `Check the position's account type in the portfolio page.`,
            400
          );
        }
      } catch (e) {
        // Re-throw our ownership check error; swallow network errors
        if (e instanceof Trading212Error && e.statusCode === 400) throw e;
        /* proceed without validation on network errors */
      }
    }
    if (livePrice && livePrice > 0) {
      const { tooFar, distancePct } = Trading212Client.isStopTooFar(stopPrice, livePrice);
      if (tooFar) {
        throw new Trading212Error(
          `Stop price ${stopPrice.toFixed(2)} is ${distancePct.toFixed(1)}% from current price ${livePrice.toFixed(2)} — T212 will reject this (instrument-specific limit, typically ~50%). Consider a tighter stop or set it manually in the T212 app.`,
          400
        );
      }
    }

    // 1. Find existing stop orders for this ticker
    const pending = await this.getPendingOrders();
    const existingStops = pending.filter(
      (o) => o.ticker === t212Ticker && o.type === 'STOP' && o.side === 'SELL'
    );

    // 1a. Pending-order safety cap. T212 limits 50 pending orders per ticker per account
    // (https://docs.trading212.com/api/section/rate-limiting#Function-Specific-Limits).
    // If something has gone wrong upstream and we've accumulated near the limit, abort
    // before placing a 51st rather than letting T212 reject after we've cancelled the old stop.
    const totalPendingForTicker = pending.filter((o) => o.ticker === t212Ticker).length;
    if (totalPendingForTicker >= PENDING_ORDER_CAP_PER_TICKER) {
      throw new Trading212Error(
        `Pending-order safety cap: ${totalPendingForTicker} pending orders already exist for ${t212Ticker} on this T212 account (cap: ${PENDING_ORDER_CAP_PER_TICKER}, T212 hard limit: 50). Inspect the T212 app and cancel stale orders before retrying.`,
        400
      );
    }

    // 2. MONOTONIC ENFORCEMENT — never lower an existing stop
    const highestExisting = existingStops.reduce(
      (max, o) => Math.max(max, o.stopPrice ?? 0),
      0
    );
    if (highestExisting > 0 && stopPrice < highestExisting) {
      throw new Trading212Error(
        `Monotonic rule: cannot lower stop from ${highestExisting.toFixed(2)} to ${stopPrice.toFixed(2)}. Stops can only move UP.`,
        400
      );
    }

    // If the stop price is the same as what's already on T212, skip
    if (
      existingStops.length === 1 &&
      Math.abs((existingStops[0].stopPrice ?? 0) - stopPrice) < 0.005
    ) {
      return existingStops[0]; // Already set — no change needed
    }

    const cancelledStops: T212PendingOrder[] = [];
    try {
      // 3. Cancel existing stop orders. A cancellation failure aborts the
      // replacement so we never continue from an unknown protection state.
      for (const old of existingStops) {
        await this.cancelOrder(old.id);
        cancelledStops.push(old);
        await new Promise((r) => setTimeout(r, 250));
      }

      // 4. Wait a moment after cancellations
      if (cancelledStops.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // 5. Place new stop order (negative quantity = sell)
      return await this.placeStopOrder({
        quantity: -shares,
        stopPrice,
        ticker: t212Ticker,
        timeValidity: 'GOOD_TILL_CANCEL',
      });
    } catch (replacementError) {
      const restoreErrors: string[] = [];
      for (const old of cancelledStops) {
        if (!old.stopPrice || old.stopPrice <= 0) {
          restoreErrors.push(`stop ${old.id} has no valid stop price`);
          continue;
        }
        try {
          await this.placeStopOrder({
            quantity: -Math.abs(old.quantity),
            stopPrice: old.stopPrice,
            ticker: t212Ticker,
            timeValidity: 'GOOD_TILL_CANCEL',
          });
        } catch (restoreError) {
          restoreErrors.push(`stop ${old.id}: ${(restoreError as Error).message}`);
        }
      }

      const replacementMessage = (replacementError as Error).message;
      if (restoreErrors.length > 0) {
        throw new Trading212Error(
          `CRITICAL: stop replacement failed (${replacementMessage}) and previous protection could not be fully restored (${restoreErrors.join('; ')}). Check T212 immediately.`,
          replacementError instanceof Trading212Error ? replacementError.statusCode : 500,
        );
      }

      const restoredMessage = cancelledStops.length > 0
        ? ' Previous stop protection was restored.'
        : '';
      throw new Trading212Error(
        `Stop replacement failed: ${replacementMessage}.${restoredMessage}`,
        replacementError instanceof Trading212Error ? replacementError.statusCode : 500,
      );
    }
  }

  /** Shares held for a ticker on this account (0 if none). Uses the full positions list. */
  async heldQuantity(t212Ticker: string): Promise<number> {
    const positions = await this.getPositions();
    return positions
      .filter(p => p.instrument?.ticker === t212Ticker)
      .reduce((sum, p) => sum + Math.max(0, (p.quantity ?? 0) - (p.quantityInPies ?? 0)), 0);
  }

  /**
   * Sell part or all of a holding at market, and confirm it happened.
   * T212 reserves shares for a pending stop, so the ticker's sell stops are
   * cancelled first. The sell counts only when the broker's holding has fallen;
   * if it has not after the wait, the order is cancelled and the stop is put
   * back. Any shares still held afterwards get a stop at the highest cancelled
   * price. If protection cannot be restored the error says CRITICAL.
   */
  async sellAtMarket(
    t212Ticker: string,
    quantity: number,
    options: { checks?: number; waitMs?: number } = {},
  ): Promise<{ order: T212PendingOrder; soldQuantity: number; remainingQuantity: number }> {
    if (!(quantity > 0)) throw new Trading212Error(`Sell quantity must be positive, got ${quantity}`, 400);
    const checks = options.checks ?? 4;
    const waitMs = options.waitMs ?? 5000;
    const before = await this.heldQuantity(t212Ticker);
    if (before + 1e-9 < quantity) {
      throw new Trading212Error(`Cannot sell ${quantity} ${t212Ticker}: only ${before} held`, 400);
    }
    const pending = await this.getPendingOrders();
    const stops = pending.filter(o => o.ticker === t212Ticker && o.type === 'STOP' && o.side === 'SELL');
    const stopPrice = stops.reduce((max, o) => Math.max(max, o.stopPrice ?? 0), 0);
    const cancelled: T212PendingOrder[] = [];

    const protect = async (held: number, reason: string): Promise<string | null> => {
      // Shares still covered by a stop that was not cancelled stay reserved; protect only the rest.
      const covered = stops.filter(s => !cancelled.includes(s)).reduce((sum, s) => sum + Math.abs(s.quantity), 0);
      const remaining = held - covered;
      if (remaining <= 1e-9 || cancelled.length === 0) return null;
      if (!(stopPrice > 0)) return `${reason}; no valid stop price to restore`;
      try {
        await this.placeStopOrder({ quantity: -remaining, stopPrice, ticker: t212Ticker, timeValidity: 'GOOD_TILL_CANCEL' });
        return null;
      } catch (error) {
        return `${reason}; stop restore failed: ${(error as Error).message}`;
      }
    };

    let order: T212PendingOrder;
    try {
      for (const stop of stops) {
        await this.cancelOrder(stop.id);
        cancelled.push(stop);
        await new Promise(r => setTimeout(r, 250));
      }
      if (cancelled.length > 0) await new Promise(r => setTimeout(r, 500));
      order = await this.placeMarketOrder({ quantity: -quantity, ticker: t212Ticker });
    } catch (sellError) {
      const restoreError = await protect(before, 'sell rejected');
      const status = sellError instanceof Trading212Error ? sellError.statusCode : 500;
      throw new Trading212Error(restoreError
        ? `CRITICAL: market sell of ${t212Ticker} failed (${(sellError as Error).message}) and its stop could not be restored (${restoreError}). Check T212 immediately.`
        : `Market sell of ${t212Ticker} failed: ${(sellError as Error).message}.${cancelled.length ? ' Stop protection was restored.' : ''}`,
      status);
    }

    // Confirm: the holding must actually fall.
    let held = before;
    for (let i = 0; i < checks; i++) {
      await new Promise(r => setTimeout(r, waitMs));
      try { held = await this.heldQuantity(t212Ticker); } catch { continue; }
      if (held <= before - quantity + 1e-6) break;
    }
    const sold = Math.max(0, before - held);
    if (sold + 1e-6 < quantity) {
      // Positions can lag a fill. An order that is no longer pending may have filled.
      let stillPending = true;
      try { await this.getOrder(order.id); } catch { stillPending = false; }
      if (stillPending) {
        try { await this.cancelOrder(order.id); } catch { /* may have filled meanwhile */ }
      }
      try { held = await this.heldQuantity(t212Ticker); } catch { /* keep last known */ }
      if (before - held + 1e-6 >= quantity) {
        const leftover = await protect(held, 'shares left after the sell');
        if (leftover) throw new Trading212Error(`CRITICAL: sold ${before - held} ${t212Ticker} but ${held} remain without a stop (${leftover}). Check T212 immediately.`, 500);
        return { order, soldQuantity: before - held, remainingQuantity: held };
      }
      const restoreError = await protect(held, 'sell not confirmed');
      const maybeFilled = stillPending ? '' : ' The order is no longer pending, so it may have filled; verify in T212.';
      throw new Trading212Error(restoreError
        ? `CRITICAL: market sell of ${t212Ticker} was not confirmed (${Math.max(0, before - held)} of ${quantity} sold) and protection could not be restored (${restoreError}).${maybeFilled} Check T212 immediately.`
        : `Market sell of ${t212Ticker} was not confirmed (${Math.max(0, before - held)} of ${quantity} sold); order cancelled and stop restored for the rest.${maybeFilled}`,
      409);
    }
    const restoreError = await protect(held, 'shares left after the sell');
    if (restoreError) {
      throw new Trading212Error(`CRITICAL: sold ${sold} ${t212Ticker} but ${held} remain without a stop (${restoreError}). Check T212 immediately.`, 500);
    }
    return { order, soldQuantity: sold, remainingQuantity: held };
  }

  /**
   * Remove all stop-loss orders for a ticker.
   */
  async removeStopLoss(t212Ticker: string): Promise<number> {
    const pending = await this.getPendingOrders();
    const stops = pending.filter(
      (o) => o.ticker === t212Ticker && o.type === 'STOP' && o.side === 'SELL'
    );
    let cancelled = 0;
    for (const order of stops) {
      try {
        await this.cancelOrder(order.id);
        cancelled++;
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        // Ignore
      }
    }
    return cancelled;
  }

  // ---- Bulk Stop Management ----

  /**
   * Bulk push stop-losses for multiple positions.
   * Fetches pending orders ONCE, then processes each position sequentially.
   * Rate limit: ~2s between cancel/place operations (T212: 1 req/1s for orders, 50/min for cancels).
   *
   * @param stops Array of { t212Ticker, shares, stopPrice } to set
   * @returns Per-position results
   */
  async setStopLossBatch(
    stops: Array<{ t212Ticker: string; shares: number; stopPrice: number }>
  ): Promise<Array<{ t212Ticker: string; stopPrice: number; action: string; orderId?: number; error?: string }>> {
    // 1. Fetch ALL pending orders once
    const pending = await this.getPendingOrders();
    const allStopOrders = pending.filter(
      (o) => o.type === 'STOP' && o.side === 'SELL'
    );

    // Pre-fetch current prices for stop distance validation
    let livePrices = new Map<string, number>();
    try {
      livePrices = await this.getPositionPrices();
    } catch {
      console.warn('[T212] Could not fetch live prices for stop range validation — proceeding without pre-check');
    }

    // Index by ticker for O(1) lookup
    const stopsByTicker = new Map<string, T212PendingOrder[]>();
    for (const order of allStopOrders) {
      const existing = stopsByTicker.get(order.ticker) ?? [];
      existing.push(order);
      stopsByTicker.set(order.ticker, existing);
    }

    const results: Array<{ t212Ticker: string; stopPrice: number; action: string; orderId?: number; error?: string }> = [];

    for (const { t212Ticker, shares, stopPrice } of stops) {
      if (shares <= 0) {
        results.push({ t212Ticker, stopPrice, action: 'SKIPPED_NO_SHARES' });
        continue;
      }

      const existingStops = stopsByTicker.get(t212Ticker) ?? [];

      // Pre-validate ownership: if we fetched prices successfully but this ticker isn't there,
      // the position doesn't exist on this T212 account (wrong account type or already sold)
      const livePrice = livePrices.get(t212Ticker);
      if (livePrices.size > 0 && !livePrice) {
        results.push({
          t212Ticker, stopPrice, action: 'SKIPPED_NOT_OWNED',
          error: `Ticker ${t212Ticker} not found in T212 positions — may be in wrong account (ISA vs Invest) or already sold`,
        });
        continue;
      }

      // Pre-validate stop distance against current market price
      if (livePrice && livePrice > 0) {
        const { tooFar, distancePct } = Trading212Client.isStopTooFar(stopPrice, livePrice);
        if (tooFar) {
          results.push({
            t212Ticker, stopPrice, action: 'SKIPPED_PRICE_TOO_FAR',
            error: `Stop ${stopPrice.toFixed(2)} is ${distancePct.toFixed(1)}% from live price ${livePrice.toFixed(2)} — exceeds T212 acceptable range`,
          });
          continue;
        }
      }

      // Monotonic enforcement
      const highestExisting = existingStops.reduce(
        (max, o) => Math.max(max, o.stopPrice ?? 0), 0
      );
      if (highestExisting > 0 && stopPrice < highestExisting) {
        results.push({
          t212Ticker, stopPrice,
          action: 'FAILED',
          error: `Monotonic rule: cannot lower stop from ${highestExisting.toFixed(2)} to ${stopPrice.toFixed(2)}`,
        });
        continue;
      }

      // Skip if already set to same price
      if (
        existingStops.length === 1 &&
        Math.abs((existingStops[0].stopPrice ?? 0) - stopPrice) < 0.005
      ) {
        results.push({ t212Ticker, stopPrice, action: 'SKIPPED_SAME', orderId: existingStops[0].id });
        continue;
      }

      try {
        // Cancel existing stops for this ticker
        for (const old of existingStops) {
          try {
            await this.cancelOrder(old.id);
            await new Promise((r) => setTimeout(r, 300));
          } catch { /* already cancelled/filled */ }
        }

        // Brief pause after cancels before placing new order
        if (existingStops.length > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }

        // Place new stop
        const order = await this.placeStopOrder({
          quantity: -shares,
          stopPrice,
          ticker: t212Ticker,
          timeValidity: 'GOOD_TILL_CANCEL',
        });

        results.push({ t212Ticker, stopPrice, action: 'PLACED', orderId: order?.id });

        // Rate limit: 2.5s between positions (place order limit is 1 req/2s, extra buffer for safety)
        await new Promise((r) => setTimeout(r, 2500));
      } catch (error) {
        const errMsg = (error as Error).message;
        // Distinguish price-too-far rejections from other failures
        const action = errMsg.includes('price-too-far') ? 'FAILED_PRICE_TOO_FAR' : 'FAILED';
        results.push({
          t212Ticker, stopPrice, action,
          error: errMsg,
        });
        // Still wait even on failure to avoid burning rate limit
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    return results;
  }

  // ---- Stop Price Range Validation ----

  /**
   * Check if a stop price is likely too far from the current market price for T212 to accept.
   * T212 enforces instrument-specific acceptable ranges (~50% from live price is a common ceiling,
   * but individual instruments may have tighter limits).
   * Returns { tooFar, distancePct } so callers can decide whether to skip or warn.
   */
  static isStopTooFar(
    stopPrice: number,
    currentPrice: number,
    /** Conservative max distance — default 50%. Some instruments reject at ~20-30%. */
    maxDistancePct: number = 50
  ): { tooFar: boolean; distancePct: number } {
    if (currentPrice <= 0 || stopPrice <= 0) return { tooFar: false, distancePct: 0 };
    const distancePct = Math.abs((currentPrice - stopPrice) / currentPrice) * 100;
    return { tooFar: distancePct > maxDistancePct, distancePct };
  }

  /**
   * Fetch current prices for all T212 positions, keyed by T212 ticker.
   * Useful for pre-validating stop distances before placing orders.
   */
  async getPositionPrices(): Promise<Map<string, number>> {
    const positions = await this.getPositions();
    const prices = new Map<string, number>();
    for (const pos of positions) {
      if (pos.currentPrice > 0) {
        prices.set(pos.instrument.ticker, pos.currentPrice);
      }
    }
    return prices;
  }

  // ---- Connection Test ----

  /** Test the API connection by fetching account summary */
  async testConnection(): Promise<{ ok: boolean; accountId?: number; currency?: string; error?: string }> {
    try {
      const summary = await this.getAccountSummary();
      return {
        ok: true,
        accountId: summary.id,
        currency: summary.currency,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Trading212Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ---- Error Class ----

export class Trading212Error extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly rateLimitReset?: number
  ) {
    super(message);
    this.name = 'Trading212Error';
  }
}

// ---- Position Mapper ----

/**
 * Maps a Trading 212 position to HybridTurtle's internal format.
 * @param accountType — which T212 account this position came from (invest or isa).
 *                      Defaults to 'invest' for backward compatibility.
 */
export function mapT212Position(t212Pos: T212Position, accountType?: T212AccountType) {
  const ticker = t212Pos.instrument.ticker
    // Trading 212 uses format like "AAPL_US_EQ" — extract the base ticker
    .replace(/_US_EQ$/, '')
    .replace(/_UK_EQ$/, '')
    .replace(/_EQ$/, '')
    .replace(/_ETF$/, '');

  return {
    ticker,
    fullTicker: t212Pos.instrument.ticker,
    name: t212Pos.instrument.name,
    isin: t212Pos.instrument.isin,
    currency: t212Pos.instrument.currencyCode,
    shares: t212Pos.quantity,
    entryPrice: t212Pos.averagePricePaid,
    currentPrice: t212Pos.currentPrice,
    entryDate: t212Pos.createdAt,
    investedValue: t212Pos.walletImpact?.investedValue || 0,
    currentValue: t212Pos.walletImpact?.value || 0,
    profitLoss: t212Pos.walletImpact?.result || 0,
    profitLossPercent: (t212Pos.walletImpact?.resultCoef || 0) * 100,
    valueInAccountCurrency: t212Pos.walletImpact?.valueInAccountCurrency || 0,
    source: 'trading212' as const,
    accountType: accountType ?? 'invest',
  };
}

/** Maps a Trading 212 account summary to HybridTurtle metrics */
export function mapT212AccountSummary(summary: T212AccountSummary) {
  return {
    accountId: summary.id,
    currency: summary.currency,
    cash: summary.cash.availableToTrade,
    cashInPies: summary.cash.inPies,
    cashReservedForOrders: summary.cash.reservedForOrders,
    totalCash: summary.cash.availableToTrade + summary.cash.inPies + summary.cash.reservedForOrders,
    investmentsValue: summary.investments.currentValue,
    investmentsCost: summary.investments.totalCost,
    realizedPL: summary.investments.realizedProfitLoss,
    unrealizedPL: summary.investments.unrealizedProfitLoss,
    totalValue: summary.totalValue,
  };
}
