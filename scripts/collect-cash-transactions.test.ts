import { describe, expect, it, vi } from 'vitest';
import { makeReadOnlyCashFetch } from './collect-cash-transactions';

describe('collect-cash-transactions read-only guard', () => {
  const ok = () => vi.fn(async () => new Response('{}'));

  it.each([
    ['https://live.trading212.com/api/v0/equity/orders/market', 'POST'],
    ['https://live.trading212.com/api/v0/equity/orders', 'GET'],
    ['https://live.trading212.com/api/v0/equity/history/transactions', 'POST'],
    ['https://demo.trading212.com/api/v0/equity/history/transactions', 'GET'],
    ['https://user:pw@live.trading212.com/api/v0/equity/history/transactions', 'GET'],
  ])('blocks %s %s', async (url, method) => {
    const transport = ok();
    const guard = makeReadOnlyCashFetch(transport);
    await expect(guard.fetch(url, { method })).rejects.toThrow('READ_ONLY_ENDPOINT_REQUIRED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('allows the two read-only endpoints and enforces the request budget', async () => {
    const transport = ok();
    const guard = makeReadOnlyCashFetch(transport, 2);
    await guard.fetch('https://live.trading212.com/api/v0/equity/account/summary');
    await guard.fetch('https://live.trading212.com/api/v0/equity/history/transactions?limit=50');
    await expect(guard.fetch('https://live.trading212.com/api/v0/equity/history/transactions?cursor=x'))
      .rejects.toThrow('REQUEST_BUDGET_EXHAUSTED');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
