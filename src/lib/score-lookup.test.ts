/**
 * Unit tests for src/lib/score-lookup.ts
 *
 * Mocks prisma.scoreBreakdown.findMany so the helper can be tested without
 * a database. Verifies most-recent-per-ticker reduction and stale-score
 * detection.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
vi.mock('@/lib/prisma', () => ({
  default: { scoreBreakdown: { findMany: (args: unknown) => findMany(args) } },
}));

const { getLatestScoresByTicker, isScoreStale } = await import('./score-lookup');

beforeEach(() => {
  findMany.mockReset();
});

describe('getLatestScoresByTicker', () => {
  it('returns an empty map when given no tickers without hitting the DB', async () => {
    const result = await getLatestScoresByTicker([]);
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns the most recent ScoreBreakdown row per ticker', async () => {
    findMany.mockResolvedValueOnce([
      // Pre-sorted desc by scoredAt as the function expects from prisma.
      { ticker: 'EZPW', ncsTotal: 100, fwsTotal: 12, bqsTotal: 100, scoredAt: new Date('2026-04-29T20:00:00Z') },
      { ticker: 'EZPW', ncsTotal: 87, fwsTotal: 24, bqsTotal: 96, scoredAt: new Date('2026-04-29T13:00:00Z') },
      { ticker: 'AAPL', ncsTotal: 75, fwsTotal: 20, bqsTotal: 80, scoredAt: new Date('2026-04-29T20:00:00Z') },
    ]);

    const result = await getLatestScoresByTicker(['EZPW', 'AAPL']);
    expect(result.size).toBe(2);
    expect(result.get('EZPW')).toEqual({
      ncs: 100,
      fws: 12,
      bqs: 100,
      scoredAt: new Date('2026-04-29T20:00:00Z'),
    });
    expect(result.get('AAPL')).toMatchObject({ ncs: 75, fws: 20, bqs: 80 });
  });

  it('omits tickers with no ScoreBreakdown rows', async () => {
    findMany.mockResolvedValueOnce([
      { ticker: 'AAPL', ncsTotal: 75, fwsTotal: 20, bqsTotal: 80, scoredAt: new Date('2026-04-29T20:00:00Z') },
    ]);

    const result = await getLatestScoresByTicker(['AAPL', 'UNKNOWN']);
    expect(result.has('AAPL')).toBe(true);
    expect(result.has('UNKNOWN')).toBe(false);
  });
});

describe('isScoreStale', () => {
  const now = new Date('2026-04-30T12:00:00Z').getTime();

  it('treats undefined scores as stale', () => {
    expect(isScoreStale(undefined, 36, now)).toBe(true);
  });

  it('returns false when the score is within the freshness window', () => {
    const scores = { ncs: 80, fws: 20, bqs: 80, scoredAt: new Date('2026-04-30T00:00:00Z') };
    expect(isScoreStale(scores, 36, now)).toBe(false);
  });

  it('returns true when the score is older than the freshness window', () => {
    const scores = { ncs: 80, fws: 20, bqs: 80, scoredAt: new Date('2026-04-28T00:00:00Z') };
    expect(isScoreStale(scores, 36, now)).toBe(true);
  });

  it('treats a missing or invalid timestamp as stale', () => {
    expect(isScoreStale({ ncs: 80, fws: 20, bqs: 80, scoredAt: new Date('invalid') }, 36, now)).toBe(true);
    expect(isScoreStale({ ncs: 80, fws: 20, bqs: 80 } as never, 36, now)).toBe(true);
  });
});
