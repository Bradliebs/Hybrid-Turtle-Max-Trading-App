import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTypesafeReview } from './typesafe-review';
import { TypesafeReviewStore } from '../lib/typesafe-review-store';
import { TypesafeReviewError, type TypesafeResponse } from '../lib/typesafe-client';
import { TYPESAFE_MODEL } from '../lib/typesafe-candidate-review';
import type { ReviewSnapshot } from '../lib/typesafe-review-source';

const now = new Date('2026-09-22T10:05:00Z');
const directories: string[] = [];
const response: TypesafeResponse = { model: TYPESAFE_MODEL,
  answers: { evidence: { type: 'choice', choice: 'SUPPORTED', confidence: 1,
    probabilities: { SUPPORTED: 1, CONTRADICTED: 0, MIXED: 0, INSUFFICIENT_EVIDENCE: 0 } } },
  usage: { input_tokens: 100, output_tokens: 10 } };
const shadowAnswers = {
  pick: { type: 'choice', choice: 'TAKE', confidence: 0.6, probabilities: { TAKE: 0.7, PASS: 0.3 } },
  move20d: { type: 'score', score: 3.1, confidence: 0.4, legend: {}, probabilities: { 0: 0.05, 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.25 } },
};
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-worker-'));
  directories.push(directory);
  const store = new TypesafeReviewStore(directory);
  store.acquire(); store.initialize(now); store.release();
  const snapshot: ReviewSnapshot = { id: 'scan', ownerId: 'owner', scanTime: '2026-09-22T10:01:00.000Z', candidates: Array.from({ length: 8 }, (_, index) => ({
    resultId: String(index), evidence: { ticker: `TEST${index}`, regime: 'BULLISH', price: 100, ma200: 90, entryTrigger: 101,
      adx: 25, ncs: 60, bqs: 60, fws: 20, volumeRatio: 1, relativeStrength: 1,
      grade: 'B_GRADE_WATCH', gradeReason: 'Passes filters but not A-grade. NCS 60 < 70',
      source: 'LIVE', dataAsOf: '2026-09-22T10:00:00.000Z', scanTime: '2026-09-22T10:01:00.000Z', provenanceMatches: true } })) };
  return { enabled: true, ownerId: 'owner', hasKey: true, store, latest: vi.fn(() => snapshot),
    evaluate: vi.fn().mockResolvedValue(response), now: () => now, snapshot };
}
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

describe('isolated advisory worker', () => {
  it('reviews only five and sends no duplicate requests on second tick', async () => {
    const options = setup();
    expect(await runTypesafeReview(options)).toEqual({ status: 'COMPLETE', failed: false });
    expect(options.evaluate).toHaveBeenCalledTimes(5);
    await runTypesafeReview(options);
    expect(options.evaluate).toHaveBeenCalledTimes(5);
    expect(options.store.read().attempts).toHaveLength(5);
  });
  it.each(['disabled', 'weekend', 'missing-key', 'stale', 'unsettled', 'owner', 'incomplete'])(
    'sends no requests when %s', async condition => {
      const options = setup();
      if (condition === 'disabled') options.enabled = false;
      if (condition === 'weekend') options.now = () => new Date('2026-09-26T10:00:00Z');
      if (condition === 'missing-key') options.hasKey = false;
      if (condition === 'stale') options.snapshot.scanTime = '2026-09-21T10:00:00.000Z';
      if (condition === 'unsettled') options.snapshot.scanTime = now.toISOString();
      if (condition === 'owner') options.snapshot.ownerId = 'other';
      if (condition === 'incomplete') options.snapshot.candidates.forEach(candidate => candidate.evidence.provenanceMatches = false);
      await runTypesafeReview(options);
      expect(options.evaluate).not.toHaveBeenCalled();
      if (['disabled', 'weekend', 'missing-key'].includes(condition)) expect(options.latest).not.toHaveBeenCalled();
    });
  it('stops on rate limit, records failure, reserves quota and honors cooldown', async () => {
    const options = setup();
    options.evaluate.mockRejectedValue(new TypesafeReviewError('PROVIDER_UNAVAILABLE', 429, now.getTime() + 3_600_000));
    expect((await runTypesafeReview(options)).failed).toBe(true);
    expect(options.evaluate).toHaveBeenCalledTimes(1);
    expect(options.store.read().attempts).toHaveLength(1);
    expect((await runTypesafeReview(options)).status).toBe('PROVIDER_COOLDOWN');
    expect(options.evaluate).toHaveBeenCalledTimes(1);
  });
  it('rechecks incomplete evidence but never retries a charged failure', async () => {
    const options = setup();
    options.snapshot.candidates = options.snapshot.candidates.slice(0, 1);
    options.snapshot.candidates[0].evidence.provenanceMatches = false;
    await runTypesafeReview(options);
    expect(options.store.read().attempts).toHaveLength(0);
    options.snapshot.candidates[0].evidence.provenanceMatches = true;
    options.evaluate.mockRejectedValue(new Error('private error body'));
    await runTypesafeReview(options);
    await runTypesafeReview(options);
    expect(options.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(options.store.read())).not.toContain('private error');
  });
  it('marks changed evidence without issuing a replacement request', async () => {
    const options = setup();
    await runTypesafeReview(options);
    options.snapshot.candidates[0].evidence.price = 99;
    await runTypesafeReview(options);
    expect(Object.values(options.store.read().reviews)[0].status).toBe('CHANGED_EVIDENCE');
    expect(options.evaluate).toHaveBeenCalledTimes(5);
  });
  it('abandons an older scan when a new scan arrives', async () => {
    const options = setup();
    options.latest.mockReturnValueOnce(options.snapshot).mockReturnValue({ ...options.snapshot, id: 'newer' });
    expect((await runTypesafeReview(options)).status).toBe('SUPERSEDED_SNAPSHOT');
    expect(options.evaluate).not.toHaveBeenCalled();
  });
  it('never exceeds five assessments when the shortlist changes between ticks', async () => {
    const options = setup();
    await runTypesafeReview(options);
    options.snapshot.candidates = options.snapshot.candidates.slice(3);
    expect((await runTypesafeReview(options)).status).toBe('SCAN_LIMIT_REACHED');
    expect(options.evaluate).toHaveBeenCalledTimes(5);
  });
  it('uses the refreshed evidence and retains failure status after later successes', async () => {
    const options = setup();
    const refreshed = structuredClone(options.snapshot);
    refreshed.candidates[0].evidence.price = 99;
    options.latest.mockReturnValueOnce(options.snapshot).mockReturnValue(refreshed);
    options.evaluate.mockRejectedValueOnce(new Error('unavailable'));
    expect(await runTypesafeReview(options)).toEqual({ status: 'PROVIDER_UNAVAILABLE', failed: true });
    expect(options.evaluate.mock.calls[0][0].price).toBe(99);
  });
  it('appends shadow picks and price calls without changing the evidence review', async () => {
    const options = setup();
    options.snapshot.candidates = options.snapshot.candidates.slice(0, 2);
    options.evaluate.mockResolvedValueOnce({ ...response, answers: { ...response.answers, ...shadowAnswers } })
      .mockResolvedValueOnce({ ...response, answers: { ...response.answers, pick: { type: 'choice', choice: 'BUY' } } });
    expect(await runTypesafeReview(options)).toEqual({ status: 'COMPLETE', failed: false });
    const lines = fs.readFileSync(options.store.shadowPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ticker: 'TEST0', scanPrice: 100, pick: { choice: 'TAKE' }, move20d: { score: 3.1 } });
    const reviews = Object.values(options.store.read().reviews);
    expect(reviews.every(review => review.status === 'COMPLETE' && review.answer?.choice === 'SUPPORTED')).toBe(true);
    expect(reviews.find(review => review.ticker === 'TEST1')?.flags).toEqual(['SHADOW_ANSWER_INVALID']);
    expect(JSON.stringify(reviews)).not.toContain('TAKE');
  });
});