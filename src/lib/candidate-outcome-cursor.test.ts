import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';

const fixture = vi.hoisted(() => ({ directory: '', prices: vi.fn() }));
vi.mock('./prisma', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PrismaClient } = await import('@prisma/client');
  fixture.directory = await mkdtemp(join(tmpdir(), 'candidate-cursor-'));
  const url = `file:${join(fixture.directory, 'fixture.db').replace(/\\/g, '/')}`;
  return { default: new PrismaClient({ datasources: { db: { url } } }) };
});
vi.mock('./market-data', () => ({ getDailyPrices: fixture.prices }));

import prisma from './prisma';
import { enrichCandidateOutcomes } from './candidate-outcome-enrichment';

const key = 'candidate-outcome-enrichment.cursor.v1';
const scanDate = new Date('2026-09-11T22:00:00Z');
const history = [{ date: '2026-09-11', close: 100 },
  ...Array.from({ length: 35 }, (_, index) => new Date(Date.UTC(2026, 8, 14 + index)))
    .filter(date => ![0, 6].includes(date.getUTCDay())).slice(0, 20)
    .map((date, index) => ({ date: date.toISOString().slice(0, 10), close: 101 + index })),
].map(bar => ({ ...bar, high: bar.close + 1, low: bar.close - 1,
  rawClose: bar.close, adjustedClose: bar.close, fetchedAt: Date.parse('2026-10-31') }));

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE TABLE AppSetting (
    id TEXT PRIMARY KEY NOT NULL, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL,
    valueText TEXT, valueJson JSONB, description TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE CandidateOutcome (
    id TEXT PRIMARY KEY NOT NULL, ticker TEXT NOT NULL, scanDate DATETIME NOT NULL,
    price REAL NOT NULL, entryTrigger REAL NOT NULL, stopPrice REAL NOT NULL,
    enrichedAt DATETIME, fwdReturn5d REAL, fwdReturn10d REAL, fwdReturn20d REAL,
    mfeR REAL, maeR REAL, reached1R BOOLEAN, reached2R BOOLEAN, reached3R BOOLEAN, stopHit BOOLEAN
  )`);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fixture.prices.mockReset().mockImplementation(async ticker => ticker === 'VALID' ? history : []);
  await prisma.$executeRawUnsafe('DELETE FROM AppSetting');
  await prisma.$executeRawUnsafe('DELETE FROM CandidateOutcome');
  for (const [id, ticker, date] of [
    ['00-historical', 'HISTORICAL', new Date('2026-06-01')],
    ['01-rejected', 'REJECTED', scanDate],
    ['02-valid', 'VALID', scanDate],
    ['03-immature', 'IMMATURE', new Date('2026-10-31')],
  ] as const) {
    await prisma.$executeRaw`INSERT INTO CandidateOutcome
      (id, ticker, scanDate, price, entryTrigger, stopPrice) VALUES (${id}, ${ticker}, ${date}, 100, 100, 95)`;
  }
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  await prisma.$disconnect();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('enrichment cursor with isolated SQLite and real Prisma', () => {
  it('persists progress across reconnects, fills a later row and wraps to the rejected row', async () => {
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 0, skipped: 1, errors: 0 });
    expect((await prisma.appSetting.findUnique({ where: { key } }))?.value).toBe('01-rejected');
    await prisma.$disconnect();
    await prisma.$connect();
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 1, skipped: 0, errors: 0 });
    expect(await prisma.candidateOutcome.findUnique({ where: { id: '02-valid' },
      select: { fwdReturn5d: true, fwdReturn10d: true, fwdReturn20d: true } }))
      .toEqual({ fwdReturn5d: 5, fwdReturn10d: 10, fwdReturn20d: 20 });
    expect(await enrichCandidateOutcomes(8, 1)).toEqual({ enriched: 0, skipped: 1, errors: 0 });
    expect(fixture.prices.mock.calls.map(call => call[0])).toEqual(['REJECTED', 'VALID', 'REJECTED']);
    expect(await prisma.candidateOutcome.findMany({ where: { id: { in: ['00-historical', '03-immature', '01-rejected'] } },
      select: { enrichedAt: true, fwdReturn5d: true } })).toEqual([
      { enrichedAt: null, fwdReturn5d: null }, { enrichedAt: null, fwdReturn5d: null },
      { enrichedAt: null, fwdReturn5d: null },
    ]);
  });

  it('wraps past a deleted cursor row', async () => {
    await prisma.appSetting.create({ data: { key, value: '99-deleted' } });
    expect((await enrichCandidateOutcomes(8, 1)).skipped).toBe(1);
    expect((await prisma.appSetting.findUnique({ where: { key } }))?.value).toBe('01-rejected');
    expect(fixture.prices).toHaveBeenCalledWith('REJECTED', 'compact');
  });

  it('includes rows inserted behind the cursor on the next sweep', async () => {
    await enrichCandidateOutcomes(8, 1);
    await enrichCandidateOutcomes(8, 1);
    await prisma.$executeRaw`INSERT INTO CandidateOutcome
      (id, ticker, scanDate, price, entryTrigger, stopPrice)
      VALUES ('00-new', 'NEW', ${scanDate}, 100, 100, 95)`;
    expect((await enrichCandidateOutcomes(8, 1)).skipped).toBe(1);
    expect(fixture.prices).toHaveBeenLastCalledWith('NEW', 'compact');
    expect((await prisma.appSetting.findUnique({ where: { key } }))?.value).toBe('00-new');
  });

  it('serializes concurrent page claims or fails a contending claim without duplicate fetches', async () => {
    const attempts = await Promise.allSettled([
      enrichCandidateOutcomes(8, 1), enrichCandidateOutcomes(8, 1),
    ]);
    const completed = attempts.filter(attempt => attempt.status === 'fulfilled');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    if (completed.length === 1) await enrichCandidateOutcomes(8, 1);
    expect(fixture.prices.mock.calls.map(call => call[0]).sort()).toEqual(['REJECTED', 'VALID']);
    expect((await prisma.appSetting.findUnique({ where: { key } }))?.value).toBe('02-valid');
  });

  it('two workers claiming different pages of the same ticker write each row exactly once', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM CandidateOutcome');
    for (const id of ['10-same-a', '11-same-b']) {
      await prisma.$executeRaw`INSERT INTO CandidateOutcome
        (id, ticker, scanDate, price, entryTrigger, stopPrice) VALUES (${id}, 'SAME', ${scanDate}, 100, 100, 95)`;
    }
    let releaseFetches: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseFetches = resolve; });
    const started: Array<() => void> = [];
    const fetchStarted = (index: number) => new Promise<void>(resolve => { started[index] = resolve; });
    const firstStarted = fetchStarted(0);
    const secondStarted = fetchStarted(1);
    let calls = 0;
    fixture.prices.mockImplementation(async () => {
      started[calls++]?.();
      await gate;
      return history;
    });
    // Each worker has committed its claim (snapshot of both unenriched rows) before either may write.
    const first = enrichCandidateOutcomes(8, 1);
    await firstStarted;
    const second = enrichCandidateOutcomes(8, 1);
    await secondStarted;
    releaseFetches();
    const [a, b] = await Promise.all([first, second]);
    expect(fixture.prices).toHaveBeenCalledTimes(2);
    expect(a.enriched + b.enriched).toBe(2);
    expect(a.skipped + b.skipped).toBe(2); // the losing worker's two expected-state writes match nothing
    expect(a.errors + b.errors).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CONCURRENT_CHANGE'));
    expect(await prisma.candidateOutcome.findMany({ orderBy: { id: 'asc' },
      select: { id: true, fwdReturn5d: true, fwdReturn10d: true, fwdReturn20d: true } })).toEqual([
      { id: '10-same-a', fwdReturn5d: 5, fwdReturn10d: 10, fwdReturn20d: 20 },
      { id: '11-same-b', fwdReturn5d: 5, fwdReturn10d: 10, fwdReturn20d: 20 },
    ]);
  });

  it('rolls back a failed cursor claim and retries the same page without fetching early', async () => {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_cursor BEFORE INSERT ON AppSetting
      BEGIN SELECT RAISE(ABORT, 'cursor unavailable'); END`);
    try {
      await expect(enrichCandidateOutcomes(8, 1)).rejects.toThrow();
      expect(await prisma.appSetting.count()).toBe(0);
      expect(fixture.prices).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_cursor');
    }
    expect((await enrichCandidateOutcomes(8, 1)).skipped).toBe(1);
    expect((await prisma.appSetting.findUnique({ where: { key } }))?.value).toBe('01-rejected');
  });
});