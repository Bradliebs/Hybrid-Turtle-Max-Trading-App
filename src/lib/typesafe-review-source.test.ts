import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reviewDatabasePath, TypesafeReviewSource } from './typesafe-review-source';

describe('read-only snapshot source', () => {
  it('reads exact provenance and persisted scores, limits shortlist and preserves source bytes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-source-'));
    const databasePath = path.join(directory, 'fixture.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE Scan (id TEXT, userId TEXT, regime TEXT, runDate INTEGER);
      CREATE TABLE Stock (id TEXT, ticker TEXT);
      CREATE TABLE ScanResult (id TEXT, scanId TEXT, stockId TEXT, price REAL, ma200 REAL, entryTrigger REAL,
        adx REAL, ncs REAL, bqs REAL, fws REAL, grade TEXT, gradeReason TEXT, passesAllFilters INTEGER, status TEXT, rankScore REAL);
      CREATE TABLE CandidateOutcome (scanId TEXT, ticker TEXT, volumeRatio REAL, relativeStrength REAL, dataSource TEXT, dataAsOf INTEGER,
        price REAL, ma200 REAL, entryTrigger REAL, adx REAL, ncs REAL, actualFill REAL);
      INSERT INTO Scan VALUES ('old', 'owner', 'BULLISH', 1), ('new', 'owner', 'BULLISH', 2), ('other', 'private', 'BULLISH', 3);
    `);
    for (let index = 0; index < 7; index++) {
      database.prepare('INSERT INTO Stock VALUES (?, ?)').run(String(index), `TEST${index}`);
      database.prepare('INSERT INTO ScanResult VALUES (?, ?, ?, 100, 90, 101, 25, 60, 60, 20, ?, ?, 1, ?, ?)')
        .run(String(index), 'new', String(index), 'B_GRADE_WATCH', 'Passes filters but not A-grade. NCS 60 < 70', 'READY', 100 - index);
      if (index < 4) database.prepare('INSERT INTO CandidateOutcome VALUES (?, ?, 1, 1, ?, 1, 100, 90, 101, 25, 999, 888)').run('new', `TEST${index}`, 'LIVE');
    }
    database.close();
    const before = fs.readFileSync(databasePath);
    const source = new TypesafeReviewSource(databasePath);
    try {
      const snapshot = source.latest('owner')!;
      expect(snapshot.id).toBe('new');
      expect(snapshot.candidates).toHaveLength(5);
      expect(snapshot.candidates[0].evidence.ncs).toBe(60);
      expect(snapshot.candidates[0].evidence.provenanceMatches).toBe(true);
      expect(snapshot.candidates[4].evidence.provenanceMatches).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain('actualFill');
      expect(source.ownsScan('new', 'private')).toBe(false);
      expect(source.latest('missing')).toBeNull();
      const named = source.forScan('new', 'owner', ['TEST5', 'TEST0', 'MISSING'])!;
      expect(named.candidates.map(candidate => candidate.evidence.ticker)).toEqual(['TEST5', 'TEST0']);
      expect(named.candidates[1].evidence.provenanceMatches).toBe(true);
      expect(source.forScan('new', 'private', ['TEST0'])).toBeNull();
    } finally {
      source.close();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuses non-file database URLs', () => {
    expect(() => reviewDatabasePath('postgres://example')).toThrow('REVIEW_SQLITE_URL_REQUIRED');
    expect(() => reviewDatabasePath('file::memory:')).toThrow();
    expect(reviewDatabasePath('file:./dev.db')).toBe(path.resolve('prisma/dev.db'));
  });
});