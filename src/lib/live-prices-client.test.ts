import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({ apiRequest }));

import { fetchLivePrices, LIVE_PRICES_BATCH_SIZE } from './live-prices-client';

describe('fetchLivePrices', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (_url: string, options: { body: string }) => {
      const { tickers } = JSON.parse(options.body) as { tickers: string[] };
      return {
        prices: Object.fromEntries(tickers.map((t) => [t, { price: 1, change: 0, changePercent: 0 }])),
        fetchedAt: '2026-10-08T20:00:00.000Z',
      };
    });
  });

  it('splits more than 50 tickers into batches and merges the prices', async () => {
    const tickers = Array.from({ length: 61 }, (_, i) => `T${i}`);
    const result = await fetchLivePrices(tickers);

    expect(apiRequest).toHaveBeenCalledTimes(2);
    const sizes = apiRequest.mock.calls.map(([, options]) => JSON.parse(options.body).tickers.length);
    expect(sizes).toEqual([LIVE_PRICES_BATCH_SIZE, 11]);
    expect(Object.keys(result.prices)).toHaveLength(61);
  });

  it('sends one request for a small list and drops duplicates', async () => {
    await fetchLivePrices(['AAPL', 'AAPL', 'MSFT', '']);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiRequest.mock.calls[0][1].body).tickers).toEqual(['AAPL', 'MSFT']);
  });

  it('makes no request for an empty list', async () => {
    const result = await fetchLivePrices([]);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result.prices).toEqual({});
  });
});
