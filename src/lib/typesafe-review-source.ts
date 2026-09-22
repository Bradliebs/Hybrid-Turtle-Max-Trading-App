import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import type { CandidateReviewInput } from './typesafe-candidate-review';

const timestamp = z.union([z.number(), z.string()]).transform(value => new Date(value).toISOString());
const nullableNumber = z.number().finite().nullable();
const scanSchema = z.object({ id: z.string(), userId: z.string(), regime: z.string(), runDate: timestamp });
const rowSchema = z.object({
  resultId: z.string(), ticker: z.string(), price: nullableNumber, ma200: nullableNumber,
  entryTrigger: nullableNumber, adx: nullableNumber, ncs: nullableNumber, bqs: nullableNumber, fws: nullableNumber,
  grade: z.string().nullable(), gradeReason: z.string().nullable(),
  volumeRatio: nullableNumber, relativeStrength: nullableNumber,
  source: z.string().nullable(), dataAsOf: timestamp.nullable(),
  outcomePrice: nullableNumber, outcomeMa200: nullableNumber, outcomeEntry: nullableNumber, outcomeAdx: nullableNumber,
});

export interface ReviewSnapshot {
  id: string;
  ownerId: string;
  scanTime: string;
  candidates: Array<{ resultId: string; evidence: CandidateReviewInput }>;
}

export function reviewDatabasePath(databaseUrl: string | undefined): string {
  if (!databaseUrl?.startsWith('file:') || databaseUrl.includes('?') || databaseUrl.includes('\0')) throw new Error('REVIEW_SQLITE_URL_REQUIRED');
  const filePath = databaseUrl.slice(5);
  if (!filePath || filePath === ':memory:') throw new Error('REVIEW_DATABASE_FILE_REQUIRED');
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), 'prisma', filePath);
}

export class TypesafeReviewSource {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
    this.database.pragma('query_only = ON');
  }

  latest(ownerId: string): ReviewSnapshot | null {
    return this.database.transaction(() => {
      const rawScan = this.database.prepare('SELECT id, userId, regime, runDate FROM Scan WHERE userId = ? ORDER BY runDate DESC, id DESC LIMIT 1').get(ownerId);
      if (!rawScan) return null;
      const scan = scanSchema.parse(rawScan);
      const rows = this.database.prepare(`
        SELECT result.id AS resultId, stock.ticker, result.price, result.ma200,
          result.entryTrigger, result.adx, result.ncs, result.bqs, result.fws,
          result.grade, result.gradeReason, outcome.volumeRatio, outcome.relativeStrength,
          outcome.dataSource AS source, outcome.dataAsOf,
          outcome.price AS outcomePrice, outcome.ma200 AS outcomeMa200,
          outcome.entryTrigger AS outcomeEntry, outcome.adx AS outcomeAdx
        FROM ScanResult AS result
        JOIN Stock AS stock ON stock.id = result.stockId
        LEFT JOIN CandidateOutcome AS outcome ON outcome.scanId = result.scanId AND outcome.ticker = stock.ticker
        WHERE result.scanId = ? AND result.passesAllFilters = 1
          AND result.status IN ('READY', 'WATCH', 'WAIT_PULLBACK')
        ORDER BY result.rankScore DESC, stock.ticker ASC, result.id ASC LIMIT 5
      `).all(scan.id).map(row => rowSchema.parse(row));
      return {
        id: scan.id, ownerId: scan.userId, scanTime: scan.runDate,
        candidates: rows.map(row => ({
          resultId: row.resultId,
          evidence: {
            ticker: row.ticker, regime: scan.regime, scanTime: scan.runDate,
            price: row.price, ma200: row.ma200, entryTrigger: row.entryTrigger, adx: row.adx,
            ncs: row.ncs, bqs: row.bqs, fws: row.fws, grade: row.grade, gradeReason: row.gradeReason,
            volumeRatio: row.volumeRatio, relativeStrength: row.relativeStrength, source: row.source, dataAsOf: row.dataAsOf,
            provenanceMatches: row.price === row.outcomePrice && row.ma200 === row.outcomeMa200 &&
              row.entryTrigger === row.outcomeEntry && row.adx === row.outcomeAdx,
          },
        })),
      };
    })();
  }

  ownsScan(scanId: string, ownerId: string): boolean {
    return Boolean(this.database.prepare('SELECT id FROM Scan WHERE id = ? AND userId = ?').get(scanId, ownerId));
  }

  close(): void { this.database.close(); }
}