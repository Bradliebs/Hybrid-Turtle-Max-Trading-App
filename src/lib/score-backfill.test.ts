import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ outcomes: vi.fn(), scores: vi.fn(), updateMany: vi.fn(), transaction: vi.fn() }));
vi.mock('./prisma', () => ({ default: {
  candidateOutcome: { findMany: mocks.outcomes, updateMany: mocks.updateMany },
  scoreBreakdown: { findMany: mocks.scores },
  $transaction: mocks.transaction,
} }));

import { backfillScoresOnOutcomes, pickPrecedingScore } from './score-backfill';

const at = (iso: string) => new Date(iso);
const score = (iso: string, ncs: number) => ({ ticker: 'AAA', scoredAt: at(iso), bqsTotal: 60, fwsTotal: 20, ncsTotal: ncs });

describe('point-in-time score matching', () => {
  const series = [score('2026-09-20T20:00:00Z', 50), score('2026-09-21T20:00:00Z', 60), score('2026-09-22T20:00:00Z', 70)];

  it('uses the latest score at or before the scan, never a later one', () => {
    expect(pickPrecedingScore(series, at('2026-09-22T19:00:00Z'))?.ncsTotal).toBe(60);
    expect(pickPrecedingScore(series, at('2026-09-22T20:00:00Z'))?.ncsTotal).toBe(70);
    expect(pickPrecedingScore(series, at('2026-09-20T19:59:59Z'))).toBeNull();
  });

  it('rejects scores older than the maximum age', () => {
    expect(pickPrecedingScore(series, at('2026-09-25T19:00:00Z'))).toBeNull();
    expect(pickPrecedingScore(series, at('2026-09-24T19:00:00Z'))?.ncsTotal).toBe(70);
  });

  it('handles empty series', () => {
    expect(pickPrecedingScore([], at('2026-09-22T19:00:00Z'))).toBeNull();
  });
});

describe('backfillScoresOnOutcomes', () => {
  beforeEach(() => {
    mocks.updateMany.mockReset().mockImplementation(args => args);
    mocks.transaction.mockReset().mockImplementation(async (ops: unknown[]) => ops.map(() => ({ count: 1 })));
  });

  it('scores every unscored row point-in-time and skips rows with no preceding score', async () => {
    mocks.outcomes.mockResolvedValue([
      { id: 'o1', ticker: 'AAA', scanDate: at('2026-09-22T19:00:00Z') },
      { id: 'o2', ticker: 'AAA', scanDate: at('2026-09-19T19:00:00Z') },
      { id: 'o3', ticker: 'ZZZ', scanDate: at('2026-09-22T19:00:00Z') },
    ]);
    mocks.scores.mockResolvedValue([score('2026-09-21T20:00:00Z', 60), score('2026-09-22T20:00:00Z', 90)]);
    expect(await backfillScoresOnOutcomes()).toEqual({ updated: 1, skipped: 2, errors: 0 });
    expect(mocks.outcomes.mock.calls[0][0]).not.toHaveProperty('take');
    const write = mocks.updateMany.mock.calls[0][0];
    expect(write.where).toEqual({ id: 'o1', bqs: null });
    expect(write.data).toMatchObject({ ncs: 60, dualScoreAction: 'Conditional' });
  });

  it('counts a failed batch as errors without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.outcomes.mockResolvedValue([{ id: 'o1', ticker: 'AAA', scanDate: at('2026-09-22T21:00:00Z') }]);
    mocks.scores.mockResolvedValue([score('2026-09-22T20:00:00Z', 80)]);
    mocks.transaction.mockRejectedValueOnce(new Error('db busy'));
    expect(await backfillScoresOnOutcomes()).toEqual({ updated: 0, skipped: 0, errors: 1 });
  });
});
