import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  Trading212Client,
  Trading212Error,
  mapT212Position,
  mapT212AccountSummary,
} from './trading212';
import type { T212Position, T212AccountSummary, T212PendingOrder } from './trading212';

// ── isStopTooFar ──

describe('Trading212Client.isStopTooFar', () => {
  it('returns tooFar=false when stop is within threshold', () => {
    const result = Trading212Client.isStopTooFar(95, 100, 50);
    expect(result.tooFar).toBe(false);
    expect(result.distancePct).toBeCloseTo(5);
  });

  it('returns tooFar=true when stop exceeds threshold', () => {
    const result = Trading212Client.isStopTooFar(40, 100, 50);
    expect(result.tooFar).toBe(true);
    expect(result.distancePct).toBeCloseTo(60);
  });

  it('returns tooFar=false for zero/negative prices', () => {
    expect(Trading212Client.isStopTooFar(0, 100).tooFar).toBe(false);
    expect(Trading212Client.isStopTooFar(100, 0).tooFar).toBe(false);
    expect(Trading212Client.isStopTooFar(-1, 100).tooFar).toBe(false);
  });

  it('uses default maxDistancePct of 50', () => {
    // 49% distance → within default 50% threshold
    const within = Trading212Client.isStopTooFar(51, 100);
    expect(within.tooFar).toBe(false);

    // 51% distance → exceeds default 50% threshold
    const beyond = Trading212Client.isStopTooFar(49, 100);
    expect(beyond.tooFar).toBe(true);
  });

  it('handles custom maxDistancePct', () => {
    // 10% distance, threshold 5% → too far
    const result = Trading212Client.isStopTooFar(90, 100, 5);
    expect(result.tooFar).toBe(true);
    expect(result.distancePct).toBeCloseTo(10);
  });
});

// ── Trading212Error ──

describe('Trading212Error', () => {
  it('extends Error with statusCode', () => {
    const err = new Trading212Error('Rate limited', 429, 1700000000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('Trading212Error');
    expect(err.message).toBe('Rate limited');
    expect(err.statusCode).toBe(429);
    expect(err.rateLimitReset).toBe(1700000000);
  });

  it('works without rateLimitReset', () => {
    const err = new Trading212Error('Forbidden', 403);
    expect(err.statusCode).toBe(403);
    expect(err.rateLimitReset).toBeUndefined();
  });
});

// ── Diagnostic hints in T212 error messages ──
//
// Auto-trade catches `Trading212Error` and surfaces `err.message` directly
// to the per-trade Telegram alert. The hints we attach to specific error
// bodies turn opaque T212 strings into actionable operator instructions.

describe('Trading212Client error diagnostic hints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubErrorResponse(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: 'Error',
        headers: new Headers(),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      } as unknown as Response),
    );
  }

  it('attaches the price-too-far hint when present', async () => {
    stubErrorResponse(400, { code: 'price-too-far' });
    const client = new Trading212Client('key', '', 'demo');
    await expect(client.getPositions()).rejects.toMatchObject({
      message: expect.stringContaining('Consider using a tighter stop'),
    });
  });

  it('attaches the selling-equity-not-owned hint when present', async () => {
    stubErrorResponse(400, { code: 'selling-equity-not-owned' });
    const client = new Trading212Client('key', '', 'demo');
    await expect(client.getPositions()).rejects.toMatchObject({
      message: expect.stringContaining('check the accountType on the position'),
    });
  });

  it('attaches the instrument-disabled hint when T212 returns the canonical body', async () => {
    // The exact body shape from the 29 July 2026 CCRN trailing-stop failure:
    //   "Trading 212 API error 400: Error while placing the order
    //    (/api-errors/instrument-disabled)"
    stubErrorResponse(400, {
      title: 'Error while placing the order',
      type: '/api-errors/instrument-disabled',
    });
    const client = new Trading212Client('key', '', 'demo');
    let caught: Trading212Error | undefined;
    try {
      await client.getPositions();
    } catch (err) {
      caught = err as Trading212Error;
    }
    expect(caught).toBeInstanceOf(Trading212Error);
    expect(caught?.statusCode).toBe(400);
    expect(caught?.message).toContain('disabled trading on this instrument');
    expect(caught?.message).toContain('may now have NO stop at the broker');
  });

  it('attaches the 404 entity-not-found hint when T212 returns the canonical body', async () => {
    // The exact body shape from the 11 May 2026 RBOT incident:
    //   "Trading 212 API error 404: Requested entity not found
    //    (/api-errors/entity-not-found)"
    stubErrorResponse(404, {
      code: 'entity-not-found',
      message: 'Requested entity not found',
      type: '/api-errors/entity-not-found',
    });
    const client = new Trading212Client('key', '', 'demo');
    let caught: Trading212Error | undefined;
    try {
      await client.getPositions();
    } catch (err) {
      caught = err as Trading212Error;
    }
    expect(caught).toBeInstanceOf(Trading212Error);
    expect(caught?.statusCode).toBe(404);
    expect(caught?.message).toContain('Stock.t212Ticker mapping problem');
    expect(caught?.message).toContain('scripts/fix-invalid-t212-tickers.ts');
    expect(caught?.message).toContain('scripts/repair-t212-tickers-from-instruments.ts');
  });

  it('does NOT attach the 404 hint to non-404 entity-not-found bodies', async () => {
    // Defensive: only attach when status really is 404.
    stubErrorResponse(400, { code: 'entity-not-found' });
    const client = new Trading212Client('key', '', 'demo');
    let caught: Trading212Error | undefined;
    try {
      await client.getPositions();
    } catch (err) {
      caught = err as Trading212Error;
    }
    expect(caught?.statusCode).toBe(400);
    expect(caught?.message).not.toContain('Stock.t212Ticker mapping problem');
  });

  it('does NOT attach the 404 hint to 404s without entity-not-found in the body', async () => {
    // The auto-trade poll-fill path uses a 404 to detect "order vanished
    // because it filled". That body doesn't say entity-not-found, and the
    // existing handler doesn't read err.message, but we explicitly verify
    // the hint stays off so future readers aren't misled by the 404 text.
    stubErrorResponse(404, { message: 'something else' });
    const client = new Trading212Client('key', '', 'demo');
    let caught: Trading212Error | undefined;
    try {
      await client.getPositions();
    } catch (err) {
      caught = err as Trading212Error;
    }
    expect(caught?.statusCode).toBe(404);
    expect(caught?.message).not.toContain('Stock.t212Ticker mapping problem');
  });
});

// ── getOrderHistory pagination ──

describe('Trading212Client.getOrderHistory', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockHistoryResponse(nextPagePath: string | null, id: number) {
    return {
      ok: true,
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => ({
        items: [{
          order: {
            id,
            ticker: 'VOD_UK_EQ',
            type: 'SELL',
            side: 'SELL',
            status: 'FILLED',
            quantity: -10,
            filledQuantity: 10,
            filledValue: 720,
            createdAt: '2026-04-30T09:59:00Z',
          },
          fill: {
            id,
            quantity: -10,
            price: 72,
            type: 'FILL',
            filledAt: '2026-04-30T10:00:00Z',
          },
        }],
        nextPagePath,
      })),
    } as unknown as Response;
  }

  it('continues through pages by default for full import callers', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(mockHistoryResponse('/api/v0/equity/history/orders?limit=50&cursor=next', 1))
      .mockResolvedValueOnce(mockHistoryResponse(null, 2));

    const client = new Trading212Client('key', 'secret', 'demo');
    const orders = await client.getOrderHistory(50);

    expect(orders.map((order) => order.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://demo.trading212.com/api/v0/equity/history/orders?limit=50&cursor=next', expect.any(Object));
  });

  it('stops after maxPages when callers only need recent history', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(mockHistoryResponse('/api/v0/equity/history/orders?limit=50&cursor=next', 1));

    const client = new Trading212Client('key', 'secret', 'demo');
    const orders = await client.getOrderHistory(50, { maxPages: 1 });

    expect(orders.map((order) => order.id)).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pages through cash transactions with GET only', async () => {
    const fetchMock = vi.mocked(fetch);
    const page = (items: unknown[], nextPagePath: string | null) => new Response(JSON.stringify({ items, nextPagePath }));
    fetchMock
      .mockResolvedValueOnce(page([{ type: 'WITHDRAW', amount: -400, currency: 'GBP', dateTime: '2026-08-03T09:00:00Z', reference: 'w1' }],
        '/api/v0/equity/history/transactions?limit=50&cursor=c2'))
      .mockResolvedValueOnce(page([{ type: 'DEPOSIT', amount: 1000, currency: 'GBP', dateTime: '2026-01-02T09:00:00Z', reference: 'd1' }], null));

    const client = new Trading212Client('key', 'secret', 'demo');
    const items = await client.getCashTransactions(50);

    expect(items.map(item => item.reference)).toEqual(['w1', 'd1']);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://demo.trading212.com/api/v0/equity/history/transactions?limit=50&cursor=c2', expect.any(Object));
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it.each([
    { maxPages: 1, expectedRows: 1, expectedQuantity: 2, expectedPnl: 1 },
    { maxPages: 2, expectedRows: 2, expectedQuantity: 10, expectedPnl: 5 },
  ])('characterizes fill-level history for one order with maxPages=$maxPages', async ({
    maxPages, expectedRows, expectedQuantity, expectedPnl,
  }) => {
    const order = {
      id: 101, ticker: 'TEST_US_EQ', type: 'STOP', side: 'SELL', status: 'FILLED',
      quantity: -10, filledQuantity: 10, filledValue: 1100,
      createdAt: '2026-06-01T09:00:00Z',
    };
    const response = (fillId: number, quantity: number, filledAt: string,
      realisedProfitLoss: number, nextPagePath: string | null) => new Response(JSON.stringify({
      items: [{ order, fill: {
        id: fillId, quantity, price: 110, filledAt, type: 'FILL',
        walletImpact: { currency: 'GBP', realisedProfitLoss, fxRate: 0.75 },
      } }],
      nextPagePath,
    }));
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(202, -2, '2026-06-02T10:02:00Z', 1,
        '/api/v0/equity/history/orders?limit=50&cursor=earlier'))
      .mockResolvedValueOnce(response(201, -8, '2026-06-02T10:01:00Z', 4, null));

    const client = new Trading212Client('key', 'secret', 'demo');
    const orders = await client.getOrderHistory(50, { maxPages });

    expect(fetchMock).toHaveBeenCalledTimes(expectedRows);
    expect(orders).toHaveLength(expectedRows);
    expect(orders.every((entry) => entry.id === 101 && entry.quantity === 10)).toBe(true);
    expect(orders.map((entry) => entry.filledQuantity)).toEqual(maxPages === 1 ? [2] : [2, 8]);
    expect(orders.reduce((total, entry) => total + entry.filledQuantity, 0)).toBe(expectedQuantity);
    expect(orders.reduce((total, entry) => total
      + (entry.fills?.[0].walletImpact?.realisedProfitLoss ?? 0), 0)).toBe(expectedPnl);
    expect(orders[0]).toMatchObject({ filledQuantity: 2, filledValue: 220,
      dateExecuted: '2026-06-02T10:02:00Z', fills: [{ quantity: 2 }] });
    expect(orders[0].fills?.[0]).toMatchObject({ id: 202, walletImpact: { currency: 'GBP' } });
  });
});

// ── Auth scheme ──

describe('Trading212Client auth scheme', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Basic key:secret when secret is provided', async () => {
    const fetchMock = vi.mocked(fetch);
    const client = new Trading212Client('myKey', 'mySecret', 'demo');
    await client.getPositions();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('myKey:mySecret').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });

  it('uses legacy single-token auth when secret is empty', async () => {
    const fetchMock = vi.mocked(fetch);
    const client = new Trading212Client('soloToken', '', 'demo');
    await client.getPositions();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('soloToken');
  });

  it('defaults secret to empty when omitted entirely', async () => {
    const fetchMock = vi.mocked(fetch);
    const client = new Trading212Client('soloToken', undefined, 'demo');
    await client.getPositions();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('soloToken');
  });
});

describe('Trading212Client.setStopLoss', () => {
  function makeStop(id: number, stopPrice: number, quantity = -10): T212PendingOrder {
    return {
      id,
      createdAt: '2026-08-04T10:00:00Z',
      currency: 'USD',
      extendedHours: false,
      filledQuantity: 0,
      filledValue: 0,
      initiatedFrom: 'API',
      instrument: { currency: 'USD', isin: 'US1', name: 'Apple', ticker: 'AAPL_US_EQ' },
      quantity,
      side: 'SELL',
      status: 'NEW',
      stopPrice,
      strategy: 'QUANTITY',
      ticker: 'AAPL_US_EQ',
      timeInForce: 'GOOD_TILL_CANCEL',
      type: 'STOP',
      value: 0,
    };
  }

  it('restores the exact prior stop when replacement placement fails', async () => {
    const client = new Trading212Client('key', 'secret', 'demo');
    const oldStop = makeStop(10, 175, -10);
    vi.spyOn(client, 'getPendingOrders').mockResolvedValue([oldStop]);
    vi.spyOn(client, 'cancelOrder').mockResolvedValue(undefined);
    const placeStop = vi.spyOn(client, 'placeStopOrder')
      .mockRejectedValueOnce(new Trading212Error('replacement rejected', 422))
      .mockResolvedValueOnce(makeStop(11, 175, -10));

    await expect(client.setStopLoss('AAPL_US_EQ', 10, 180, 190))
      .rejects.toThrow('Previous stop protection was restored');
    expect(placeStop).toHaveBeenNthCalledWith(2, {
      quantity: -10,
      stopPrice: 175,
      ticker: 'AAPL_US_EQ',
      timeValidity: 'GOOD_TILL_CANCEL',
    });
  });

  it('raises a critical error when replacement and rollback both fail', async () => {
    const client = new Trading212Client('key', 'secret', 'demo');
    vi.spyOn(client, 'getPendingOrders').mockResolvedValue([makeStop(10, 175)]);
    vi.spyOn(client, 'cancelOrder').mockResolvedValue(undefined);
    vi.spyOn(client, 'placeStopOrder')
      .mockRejectedValueOnce(new Trading212Error('replacement rejected', 422))
      .mockRejectedValueOnce(new Trading212Error('restore rejected', 422));

    await expect(client.setStopLoss('AAPL_US_EQ', 10, 180, 190))
      .rejects.toThrow('CRITICAL: stop replacement failed');
  });

  it('restores already-cancelled stops when a later cancellation fails', async () => {
    const client = new Trading212Client('key', 'secret', 'demo');
    vi.spyOn(client, 'getPendingOrders').mockResolvedValue([
      makeStop(10, 175, -6),
      makeStop(11, 176, -4),
    ]);
    vi.spyOn(client, 'cancelOrder')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Trading212Error('cancel unavailable', 503));
    const placeStop = vi.spyOn(client, 'placeStopOrder').mockResolvedValue(makeStop(12, 175, -6));

    await expect(client.setStopLoss('AAPL_US_EQ', 10, 180, 190))
      .rejects.toThrow('Previous stop protection was restored');
    expect(placeStop).toHaveBeenCalledOnce();
    expect(placeStop).toHaveBeenCalledWith(expect.objectContaining({ quantity: -6, stopPrice: 175 }));
  });
});

// ── mapT212Position ──

describe('mapT212Position', () => {
  const mockPosition: T212Position = {
    averagePricePaid: 150.25,
    createdAt: '2026-04-01T10:00:00Z',
    currentPrice: 165.50,
    instrument: {
      isin: 'US0378331005',
      currencyCode: 'USD',
      name: 'Apple Inc',
      ticker: 'AAPL_US_EQ',
    },
    quantity: 10,
    quantityAvailableForTrading: 10,
    quantityInPies: 0,
    walletImpact: {
      investedValue: 1502.50,
      result: 152.50,
      resultCoef: 0.1015,
      value: 1655.00,
      valueInAccountCurrency: 1320.00,
    },
  };

  it('strips _US_EQ suffix from ticker', () => {
    const mapped = mapT212Position(mockPosition);
    expect(mapped.ticker).toBe('AAPL');
    expect(mapped.fullTicker).toBe('AAPL_US_EQ');
  });

  it('strips _UK_EQ suffix', () => {
    const ukPos = { ...mockPosition, instrument: { ...mockPosition.instrument, ticker: 'GSK_UK_EQ' } };
    expect(mapT212Position(ukPos).ticker).toBe('GSK');
  });

  it('strips _EQ suffix', () => {
    const eqPos = { ...mockPosition, instrument: { ...mockPosition.instrument, ticker: 'DPLMl_EQ' } };
    expect(mapT212Position(eqPos).ticker).toBe('DPLMl');
  });

  it('strips _ETF suffix', () => {
    const etfPos = { ...mockPosition, instrument: { ...mockPosition.instrument, ticker: 'SPY_ETF' } };
    expect(mapT212Position(etfPos).ticker).toBe('SPY');
  });

  it('maps all required fields correctly', () => {
    const mapped = mapT212Position(mockPosition, 'isa');
    expect(mapped.name).toBe('Apple Inc');
    expect(mapped.isin).toBe('US0378331005');
    expect(mapped.currency).toBe('USD');
    expect(mapped.shares).toBe(10);
    expect(mapped.entryPrice).toBe(150.25);
    expect(mapped.currentPrice).toBe(165.50);
    expect(mapped.entryDate).toBe('2026-04-01T10:00:00Z');
    expect(mapped.profitLoss).toBe(152.50);
    expect(mapped.profitLossPercent).toBeCloseTo(10.15);
    expect(mapped.source).toBe('trading212');
    expect(mapped.accountType).toBe('isa');
  });

  it('defaults accountType to invest', () => {
    const mapped = mapT212Position(mockPosition);
    expect(mapped.accountType).toBe('invest');
  });

  it('handles missing walletImpact gracefully', () => {
    const posNoWallet = { ...mockPosition, walletImpact: {} as T212Position['walletImpact'] };
    const mapped = mapT212Position(posNoWallet);
    expect(mapped.investedValue).toBe(0);
    expect(mapped.profitLoss).toBe(0);
  });
});

// ── mapT212AccountSummary ──

describe('mapT212AccountSummary', () => {
  const mockSummary: T212AccountSummary = {
    cash: {
      availableToTrade: 5000,
      inPies: 200,
      reservedForOrders: 100,
    },
    currency: 'GBP',
    id: 12345,
    investments: {
      currentValue: 15000,
      realizedProfitLoss: 500,
      totalCost: 14000,
      unrealizedProfitLoss: 1000,
    },
    totalValue: 20300,
  };

  it('maps all account fields correctly', () => {
    const mapped = mapT212AccountSummary(mockSummary);
    expect(mapped.accountId).toBe(12345);
    expect(mapped.currency).toBe('GBP');
    expect(mapped.cash).toBe(5000);
    expect(mapped.cashInPies).toBe(200);
    expect(mapped.cashReservedForOrders).toBe(100);
    expect(mapped.totalCash).toBe(5300); // 5000 + 200 + 100
    expect(mapped.investmentsValue).toBe(15000);
    expect(mapped.investmentsCost).toBe(14000);
    expect(mapped.realizedPL).toBe(500);
    expect(mapped.unrealizedPL).toBe(1000);
    expect(mapped.totalValue).toBe(20300);
  });
});
