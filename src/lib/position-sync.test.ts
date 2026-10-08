import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Trading212Error, type T212Position } from './trading212';
import { findUntrackedBrokerPositions, shouldFetchOrderHistoryForSync } from './position-sync';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  userUpdate: vi.fn(async () => ({})),
  positionFindMany: vi.fn(),
  positionUpdate: vi.fn(),
  tradeLogCreate: vi.fn(),
  tradeLogFindFirst: vi.fn(),
  transaction: vi.fn(),
  getPositions: vi.fn(),
  getAccountSummary: vi.fn(),
  getOrderHistory: vi.fn(),
  sendAlert: vi.fn(),
  logEVRecord: vi.fn(),
  persistCache: vi.fn(),
  rehydrateCache: vi.fn(),
  recordPriceSnapshots: vi.fn(),
  decryptField: vi.fn((value: string) => value),
  constructedApiKeys: [] as string[],
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findUnique: mocks.findUnique,
      update: mocks.userUpdate,
    },
    position: {
      findMany: mocks.positionFindMany,
      update: mocks.positionUpdate,
    },
    tradeLog: {
      create: mocks.tradeLogCreate,
      findFirst: mocks.tradeLogFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('./crypto', () => ({
  decryptField: mocks.decryptField,
}));

vi.mock('@/lib/alert-service', () => ({
  sendAlert: mocks.sendAlert,
}));

vi.mock('@/lib/cache-persistence', () => ({
  persistCache: mocks.persistCache,
  rehydrateCache: mocks.rehydrateCache,
}));

vi.mock('@/lib/price-snapshot', () => ({
  recordPriceSnapshots: mocks.recordPriceSnapshots,
}));

vi.mock('@/lib/ev-tracker', () => ({
  logEVRecord: mocks.logEVRecord,
}));

vi.mock('./trading212', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trading212')>();

  class MockTrading212Client {
    constructor(
      public apiKey: string,
      public apiSecret: string,
      public environment: string
    ) {
      mocks.constructedApiKeys.push(apiKey);
    }

    async getPositions(): Promise<T212Position[]> {
      return mocks.getPositions(this.apiKey);
    }

    async getAccountSummary() {
      return mocks.getAccountSummary(this.apiKey);
    }

    async getOrderHistory(limit = 50, options = {}) {
      return mocks.getOrderHistory(this.apiKey, limit, options);
    }
  }

  return {
    ...actual,
    Trading212Client: MockTrading212Client,
  };
});

function makePosition(ticker: string, currentPrice: number): T212Position {
  return {
    averagePricePaid: currentPrice - 5,
    createdAt: '2026-04-30T09:00:00Z',
    currentPrice,
    instrument: {
      isin: `ISIN-${ticker}`,
      currencyCode: 'GBP',
      name: `${ticker} plc`,
      ticker: `${ticker}_UK_EQ`,
    },
    quantity: 10,
    quantityAvailableForTrading: 10,
    quantityInPies: 0,
    walletImpact: {
      investedValue: 1000,
      result: 50,
      resultCoef: 0.05,
      value: 1050,
      valueInAccountCurrency: 1050,
    },
  };
}

function connectedDualUser() {
  return {
    t212ApiKey: 'invest-key',
    t212ApiSecret: 'invest-secret',
    t212Environment: 'live',
    t212Connected: true,
    t212IsaApiKey: 'isa-key',
    t212IsaApiSecret: 'isa-secret',
    t212IsaConnected: true,
  };
}

function connectedSameKeyUser() {
  return {
    ...connectedDualUser(),
    t212ApiKey: 'shared-key',
    t212IsaApiKey: 'shared-key',
  };
}

function makeAccountSummary() {
  return {
    cash: { availableToTrade: 5000, inPies: 0, reservedForOrders: 0 },
    currency: 'GBP',
    id: 123,
    investments: {
      currentValue: 1000,
      realizedProfitLoss: 0,
      totalCost: 950,
      unrealizedProfitLoss: 50,
    },
    totalValue: 6000,
  };
}

function makeDbPosition(ticker: string, t212Ticker = `${ticker}_UK_EQ`) {
  return {
    id: `position-${ticker}`,
    status: 'OPEN',
    userId: 'default-user',
    stockId: `stock-${ticker}`,
    t212Ticker,
    entryPrice: 75,
    entryDate: new Date('2026-04-01T09:00:00Z'),
    shares: 10,
    currentStop: 68,
    initialRisk: 7,
    initial_R: 7,
    atr_at_entry: 2,
    accountType: 'invest',
    stock: {
      ticker,
      name: `${ticker} plc`,
      t212Ticker,
      currency: 'GBP',
      cluster: 'core',
      sleeve: 'stock',
    },
  };
}

function makeSellOrder(ticker: string) {
  return {
    id: 12345,
    ticker: `${ticker}_UK_EQ`,
    type: 'SELL',
    side: 'SELL' as const,
    status: 'FILLED',
    quantity: 10,
    filledQuantity: 10,
    filledValue: 720,
    dateCreated: '2026-04-30T09:59:00Z',
    dateExecuted: '2026-04-30T10:00:00Z',
    initiatedFrom: 'STOP_LOSS',
    fills: [{
      id: 1,
      price: 72,
      quantity: 10,
      filledAt: '2026-04-30T10:00:00Z',
      walletImpact: { currency: 'GBP', netValue: 720, realisedProfitLoss: -30, fxRate: 1 },
    }],
  };
}

describe('fetchT212LivePrices rate-limit handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 30, 10, 0, 0));

    mocks.constructedApiKeys.length = 0;
    mocks.findUnique.mockResolvedValue(connectedDualUser());
    mocks.positionFindMany.mockResolvedValue([]);
    mocks.positionUpdate.mockResolvedValue({});
    mocks.tradeLogCreate.mockResolvedValue({});
    mocks.tradeLogFindFirst.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (callback) => callback({
      position: { update: mocks.positionUpdate },
      tradeLog: { create: mocks.tradeLogCreate },
    }));
    mocks.getAccountSummary.mockResolvedValue(makeAccountSummary());
    mocks.getOrderHistory.mockResolvedValue([]);
    mocks.sendAlert.mockResolvedValue(undefined);
    mocks.logEVRecord.mockResolvedValue(undefined);
    mocks.persistCache.mockResolvedValue(undefined);
    mocks.rehydrateCache.mockResolvedValue(null);
    mocks.recordPriceSnapshots.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets Invest backoff after a 429 and still fetches ISA positions in the same pass', async () => {
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 600;
    mocks.getPositions.mockImplementation((apiKey: string) => {
      if (apiKey === 'invest-key') {
        throw new Trading212Error('Too many requests', 429, resetEpochSeconds);
      }
      return [makePosition('VOD', 72.4)];
    });

    const { fetchT212LivePrices, getT212ApiStats, updateT212PriceCache } = await import('./position-sync');

    updateT212PriceCache(new Map([['OLD', 99]]));
    vi.setSystemTime(new Date(2026, 3, 30, 10, 2, 0));

    const resultPromise = fetchT212LivePrices('default-user');
    await vi.advanceTimersByTimeAsync(1500);
    const result = await resultPromise;

    expect(result).toEqual({ VOD: 72.4 });
    expect(mocks.getPositions).toHaveBeenCalledTimes(2);
    expect(mocks.constructedApiKeys).toEqual(['invest-key', 'isa-key']);
    expect(mocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      title: 'T212 Rate Limited',
      data: { account: 'Invest', callsLastHour: 1 },
      notificationDedupeKey: 't212-rate-limit:Invest',
      telegramDedupeKey: 't212-rate-limit:Invest',
    }));
    expect(getT212ApiStats().callsLastHour).toBe(2);
  });

  it('serves stale cached prices during a later backoff without calling T212 again', async () => {
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 600;
    mocks.getPositions.mockImplementation((apiKey: string) => {
      if (apiKey === 'invest-key') {
        throw new Trading212Error('Too many requests', 429, resetEpochSeconds);
      }
      return [makePosition('VOD', 72.4)];
    });

    const { fetchT212LivePrices, updateT212PriceCache } = await import('./position-sync');

    updateT212PriceCache(new Map([['OLD', 99]]));
    vi.setSystemTime(new Date(2026, 3, 30, 10, 2, 0));

    const firstResultPromise = fetchT212LivePrices('default-user');
    await vi.advanceTimersByTimeAsync(1500);
    await firstResultPromise;
    expect(mocks.getPositions).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(2026, 3, 30, 10, 4, 0));
    const secondResult = await fetchT212LivePrices('default-user');

    expect(secondResult).toEqual({ OLD: 99, VOD: 72.4 });
    expect(mocks.getPositions).toHaveBeenCalledTimes(2);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it('skips ISA fetch when Invest and ISA share the same API key', async () => {
    mocks.findUnique.mockResolvedValue(connectedSameKeyUser());
    mocks.getPositions.mockResolvedValue([makePosition('VOD', 72.4)]);
    const { fetchT212LivePrices } = await import('./position-sync');

    const result = await fetchT212LivePrices('default-user');

    expect(result).toEqual({ VOD: 72.4 });
    expect(mocks.getPositions).toHaveBeenCalledTimes(1);
    expect(mocks.constructedApiKeys).toEqual(['shared-key']);
  });
});

describe('shouldFetchOrderHistoryForSync', () => {
  it('skips order history for routine midday sync when tracked positions are still open and untracked sales are disabled', () => {
    expect(shouldFetchOrderHistoryForSync({
      hasMissingTrackedPosition: false,
      detectUntrackedSales: false,
    })).toBe(false);
  });

  it('fetches order history when a tracked position is missing from T212', () => {
    expect(shouldFetchOrderHistoryForSync({
      hasMissingTrackedPosition: true,
      detectUntrackedSales: false,
    })).toBe(true);
  });

  it('fetches order history for full syncs that detect untracked sales', () => {
    expect(shouldFetchOrderHistoryForSync({
      hasMissingTrackedPosition: false,
      detectUntrackedSales: true,
    })).toBe(true);
  });
});

describe('findUntrackedBrokerPositions', () => {
  it('matches positions by account and full T212 ticker', () => {
    const local = [makeDbPosition('ALV', 'ALVd_EQ')];
    const broker = [
      { accountType: 'invest', fullTicker: 'ALVd_EQ', shares: 0.54 },
      { accountType: 'isa', fullTicker: 'ALVd_EQ', shares: 0.54 },
    ];

    expect(findUntrackedBrokerPositions(local, broker)).toEqual([broker[1]]);
  });
});

describe('syncClosedPositions order-history usage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 30, 10, 0, 0));

    mocks.constructedApiKeys.length = 0;
    mocks.findUnique.mockResolvedValue({
      ...connectedDualUser(),
      t212IsaConnected: false,
      t212IsaApiKey: null,
      t212IsaApiSecret: null,
    });
    mocks.positionUpdate.mockResolvedValue({});
    mocks.tradeLogCreate.mockResolvedValue({});
    mocks.tradeLogFindFirst.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (callback) => callback({
      position: { update: mocks.positionUpdate },
      tradeLog: { create: mocks.tradeLogCreate },
    }));
    mocks.getAccountSummary.mockResolvedValue(makeAccountSummary());
    mocks.getOrderHistory.mockResolvedValue([]);
    mocks.sendAlert.mockResolvedValue(undefined);
    mocks.logEVRecord.mockResolvedValue(undefined);
    mocks.persistCache.mockResolvedValue(undefined);
    mocks.rehydrateCache.mockResolvedValue(null);
    mocks.recordPriceSnapshots.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fetch order history when every tracked position is still open and untracked sale detection is disabled', async () => {
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('VOD', 72.4)]);

    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });

    expect(result).toMatchObject({ checked: 1, closed: 0, skipped: 0, updated: 1, errors: [] });
    expect(mocks.getOrderHistory).not.toHaveBeenCalled();
    expect(mocks.positionUpdate).not.toHaveBeenCalled();
  });

  it('records the sync time only for accounts whose holdings were read', async () => {
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('VOD', 72.4)]);

    const { syncClosedPositions } = await import('./position-sync');
    await syncClosedPositions('default-user', { detectUntrackedSales: false });

    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'default-user' },
      data: { t212LastSync: new Date(2026, 3, 30, 10, 0, 0) },
    });
  });

  it('does not record a sync time when the broker read fails', async () => {
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockRejectedValue(new Error('network down'));

    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('alerts when T212 holds a position that has no local OPEN row', async () => {
    mocks.positionFindMany.mockResolvedValue([]);
    mocks.getPositions.mockResolvedValue([makePosition('ALV', 423.3)]);

    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });

    expect(result).toMatchObject({
      checked: 0,
      closed: 0,
      errors: ['Untracked broker position: invest:ALV_UK_EQ'],
    });
    expect(mocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ORPHAN_T212_FILL',
      title: 'Untracked T212 position — ALV_UK_EQ',
      priority: 'CRITICAL',
      notificationDedupeKey: 'untracked-position:invest:ALV_UK_EQ',
      telegramDedupeKey: 'untracked-position:invest:ALV_UK_EQ',
    }));
    expect(mocks.getOrderHistory).not.toHaveBeenCalled();
  });

  it('fetches one history page and closes when a tracked position is missing from T212', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('SHEL', 2500)]);
    mocks.getOrderHistory.mockResolvedValue([makeSellOrder('VOD')]);

    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });

    expect(result).toMatchObject({
      checked: 1,
      closed: 1,
      skipped: 0,
      updated: 0,
      errors: ['Untracked broker position: invest:SHEL_UK_EQ'],
    });
    expect(mocks.getOrderHistory).toHaveBeenCalledWith('invest-key', 50, { maxPages: 1 });
    expect(mocks.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'position-VOD', userId: 'default-user', accountType: 'invest',
        shares: 10, entryPrice: 75, entryDate: new Date('2026-04-01T09:00:00Z'), status: 'OPEN' },
      data: expect.objectContaining({
        status: 'CLOSED',
        exitPrice: 72,
        closedBy: 'AUTO_SYNC',
      }),
    }));
  });

  it('aggregates same-order fills instead of recording just the latest fill', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('SHEL', 2500)]);
    const sell = makeSellOrder('VOD');
    const first = { ...sell, fills: [{ ...sell.fills[0], id: 1, quantity: 8,
      walletImpact: { currency: 'GBP', realisedProfitLoss: -24 } }] };
    const last = { ...sell, fills: [{ ...sell.fills[0], id: 2, quantity: 2,
      walletImpact: { currency: 'GBP', realisedProfitLoss: -6 } }] };
    mocks.getOrderHistory.mockResolvedValue([last, first, first]);
    const { syncClosedPositions } = await import('./position-sync');
    await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(mocks.tradeLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      fillQuantity: 10, realisedPnlT212: -30, gainLossGbp: -30, fillPrice: 72,
    }) }));
  });

  it('keeps partial evidence pending without fabricated P&L or an EV record', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('SHEL', 2500)]);
    const sell = makeSellOrder('VOD');
    sell.fills[0].quantity = 2;
    mocks.getOrderHistory.mockResolvedValue([sell]);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.closed).toBe(1);
    expect(result.errors).toContain('VOD: closure accounting pending - INCOMPLETE_QUANTITY');
    expect(mocks.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'CLOSED', exitPrice: null, realisedPnlGbp: null, realisedPnlR: null,
      exitReason: 'PENDING_BROKER_RECONCILIATION', closedBy: 'PENDING_BROKER:live',
    }) }));
    expect(mocks.tradeLogCreate).not.toHaveBeenCalled();
    expect(mocks.logEVRecord).not.toHaveBeenCalled();
  });

  it('revisits only marked pending closures even when the account now has no holdings', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([{ ...makeDbPosition('VOD'), status: 'CLOSED',
      exitDate: new Date('2026-04-30T10:01:00Z'), closedBy: 'PENDING_BROKER:live' }]);
    mocks.getPositions.mockResolvedValue([]);
    mocks.getOrderHistory.mockResolvedValue([makeSellOrder('VOD')]);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result).toMatchObject({ closed: 0, updated: 1, errors: [] });
    expect(mocks.positionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: 'default-user', OR: [{ status: 'OPEN' }, { status: 'CLOSED', exitReason: 'PENDING_BROKER_RECONCILIATION' }],
    } }));
    expect(mocks.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      exitDate: new Date('2026-04-30T10:00:00Z'), realisedPnlGbp: -30,
    }) }));
  });

  it('does not use another accounts holding or sell evidence for an ISA closure', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.findUnique.mockResolvedValue(connectedDualUser());
    mocks.positionFindMany.mockResolvedValue([{ ...makeDbPosition('VOD'), accountType: 'isa' }]);
    mocks.getPositions.mockImplementation((key: string) => key === 'invest-key' ? [makePosition('VOD', 72)] : []);
    mocks.getOrderHistory.mockImplementation((key: string) => key === 'invest-key' ? [makeSellOrder('VOD')] : []);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.closed).toBe(1);
    expect(result.errors).toContain('VOD: closure accounting pending - NO_SELL_EVIDENCE');
    expect(mocks.tradeLogCreate).not.toHaveBeenCalled();
  });

  it('does not reconcile pending closures after the broker environment changes', async () => {
    mocks.positionFindMany.mockResolvedValue([{ ...makeDbPosition('VOD'), status: 'CLOSED',
      closedBy: 'PENDING_BROKER:demo', exitDate: new Date('2026-04-30') }]);
    mocks.getPositions.mockResolvedValue([]);
    mocks.getOrderHistory.mockResolvedValue([makeSellOrder('VOD')]);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.skipped).toBe(1);
    expect(mocks.positionUpdate).not.toHaveBeenCalled();
  });

  it('preserves the zero-broker-holdings guard for OPEN positions', async () => {
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([]);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.closed).toBe(0);
    expect(mocks.positionUpdate).not.toHaveBeenCalled();
    expect(mocks.getOrderHistory).not.toHaveBeenCalled();
  });

  it('propagates exit-log failure out of the closure transaction and does not emit EV success', async () => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('SHEL', 2500)]);
    mocks.getOrderHistory.mockResolvedValue([makeSellOrder('VOD')]);
    mocks.tradeLogCreate.mockRejectedValueOnce(new Error('log write failed'));
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.closed).toBe(0);
    expect(result.errors).toContain('VOD: close failed — log write failed');
    expect(mocks.logEVRecord).not.toHaveBeenCalled();
    await expect(mocks.transaction.mock.results[0].value).rejects.toThrow('log write failed');
  });

  it.each(['missing', 'failed', 'duplicate'] as const)('skips ISA accounting with %s account evidence', async (problem) => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.findUnique.mockResolvedValue(problem === 'duplicate' ? connectedSameKeyUser() : {
      ...connectedDualUser(), t212IsaConnected: problem !== 'missing',
    });
    mocks.positionFindMany.mockResolvedValue([{ ...makeDbPosition('VOD'), accountType: 'isa' }]);
    mocks.getPositions.mockImplementation(async (key: string) => {
      if (key === 'isa-key' && problem === 'failed') throw new Error('positions unavailable');
      return [makePosition('SHEL', 2500)];
    });
    mocks.getOrderHistory.mockResolvedValue([makeSellOrder('VOD')]);
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result).toMatchObject({ closed: 0, skipped: 1 });
    expect(mocks.positionUpdate).not.toHaveBeenCalled();
    expect(mocks.tradeLogCreate).not.toHaveBeenCalled();
    expect(mocks.getOrderHistory).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('rejects a stale closure write after reconciliation, complete evidence: %s', async (complete) => {
    vi.setSystemTime(new Date('2026-04-30T10:05:00Z'));
    mocks.positionFindMany.mockResolvedValue([makeDbPosition('VOD')]);
    mocks.getPositions.mockResolvedValue([makePosition('SHEL', 2500)]);
    mocks.getOrderHistory.mockResolvedValue(complete ? [makeSellOrder('VOD')] : []);
    mocks.positionUpdate.mockImplementationOnce(async ({ where }) => {
      expect(where).toMatchObject({ id: 'position-VOD', status: 'OPEN', shares: 10 });
      throw Object.assign(new Error('stale closure state'), { code: 'P2025' });
    });
    const { syncClosedPositions } = await import('./position-sync');
    const result = await syncClosedPositions('default-user', { detectUntrackedSales: false });
    expect(result.closed).toBe(0);
    expect(result.errors).toContain('VOD: close failed — stale closure state');
    expect(mocks.tradeLogCreate).not.toHaveBeenCalled();
    expect(mocks.logEVRecord).not.toHaveBeenCalled();
  });
});
