import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isReviewWeekday, reviewDay, TypesafeReviewStore, type ReviewRecord } from './typesafe-review-store';

const directories: string[] = [];
const now = new Date('2026-09-22T10:00:00Z');
function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-review-'));
  directories.push(directory);
  const store = new TypesafeReviewStore(directory);
  store.acquire();
  store.initialize(now);
  return store;
}
function record(index: number): ReviewRecord {
  return { scanId: `scan-${Math.floor(index / 5)}`, resultId: String(index), ticker: 'TEST', ownerId: 'owner', scanTime: now.toISOString(),
    reviewedAt: now.toISOString(), inputHash: 'hash', claim: null, status: 'RESERVED', flags: [], answer: null, elapsedMs: 0 };
}
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

describe('durable review budget', () => {
  it('requires explicit initialization and refuses destructive reinitialization', () => {
    const store = makeStore();
    expect(() => store.initialize(now)).toThrow('REVIEW_ALREADY_INITIALIZED');
    fs.unlinkSync(path.join(store.directory, 'ledger.json'));
    expect(() => store.read()).toThrow();
    expect(() => store.initialize(now)).toThrow('REVIEW_ALREADY_INITIALIZED');
    store.release();
  });
  it('reserves before completion and preserves cap/dedup across restarts', () => {
    const store = makeStore();
    const ledger = store.read();
    for (let index = 0; index < 20; index++) expect(store.reserve(ledger, record(index), now)).toBe(true);
    expect(store.reserve(ledger, record(20), now)).toBe(false);
    store.release();
    const restarted = new TypesafeReviewStore(store.directory);
    restarted.acquire();
    expect(restarted.reserve(restarted.read(), record(0), now)).toBe(false);
    expect(restarted.reserve(restarted.read(), record(21), now)).toBe(false);
    expect(restarted.reserve(restarted.read(), record(21), new Date('2026-09-23T10:00:00Z'))).toBe(true);
    restarted.release();
  });
  it('rejects overlap, corruption and clock rollback', () => {
    const store = makeStore();
    expect(() => new TypesafeReviewStore(store.directory).acquire()).toThrow();
    expect(() => store.observe(store.read(), new Date('2026-09-21'))).toThrow('REVIEW_CLOCK_ROLLBACK');
    fs.writeFileSync(path.join(store.directory, 'ledger.json'), '{corrupt');
    expect(() => store.read()).toThrow();
    store.release();
  });
  it('caps a changing shortlist at five charged candidates per scan', () => {
    const store = makeStore();
    const ledger = store.read();
    for (let index = 0; index < 5; index++) expect(store.reserve(ledger, record(index), now)).toBe(true);
    expect(store.reserve(ledger, { ...record(5), scanId: record(0).scanId }, now)).toBe(false);
    expect(ledger.attempts).toHaveLength(5);
    store.release();
  });
  it('does not treat a failed persistence as an authorized send', () => {
    const store = makeStore();
    const ledger = store.read();
    fs.unlinkSync(path.join(store.directory, 'ledger.json'));
    fs.mkdirSync(path.join(store.directory, 'ledger.json'));
    expect(() => store.reserve(ledger, record(0), now)).toThrow();
    store.release();
  });
  it('uses London calendar days across midnight and DST', () => {
    expect(reviewDay(new Date('2026-09-22T23:30:00Z'))).toBe('2026-09-23');
    expect(reviewDay(new Date('2026-12-22T23:30:00Z'))).toBe('2026-12-22');
    expect(isReviewWeekday(new Date('2026-09-25T23:30:00Z'))).toBe(false);
    expect(isReviewWeekday(now)).toBe(true);
  });
});