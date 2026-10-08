/**
 * DEPENDENCIES
 * Consumed by: src/app/plan/page.tsx, src/app/scan/page.tsx
 * Consumes: /api/scan/live-prices (POST, max 50 tickers per request)
 * Risk-sensitive: NO — display prices only
 * Notes: Splits large ticker lists into sequential batches so the route's
 *        50-ticker limit is respected without bursting Yahoo requests.
 */

import { apiRequest } from '@/lib/api-client';

export const LIVE_PRICES_BATCH_SIZE = 50;

export interface LivePrice {
  price: number;
  change: number;
  changePercent: number;
  source?: string;
}

export async function fetchLivePrices(tickers: string[]): Promise<{ prices: Record<string, LivePrice>; fetchedAt: string }> {
  const unique = [...new Set(tickers.filter(Boolean))];
  const prices: Record<string, LivePrice> = {};
  let fetchedAt = new Date().toISOString();
  for (let i = 0; i < unique.length; i += LIVE_PRICES_BATCH_SIZE) {
    const data = await apiRequest<{ prices: Record<string, LivePrice>; fetchedAt: string }>('/api/scan/live-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: unique.slice(i, i + LIVE_PRICES_BATCH_SIZE) }),
    });
    Object.assign(prices, data.prices ?? {});
    fetchedAt = data.fetchedAt ?? fetchedAt;
  }
  return { prices, fetchedAt };
}
