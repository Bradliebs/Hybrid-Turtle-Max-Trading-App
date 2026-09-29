import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reviewLabelSchema, TYPESAFE_MODEL } from './typesafe-candidate-review';
import { shadowPredictionSchema, type ShadowPrediction } from './typesafe-shadow';

const answerSchema = z.object({
  choice: reviewLabelSchema,
  confidence: z.number().min(0).max(1),
  probabilities: z.record(reviewLabelSchema, z.number().min(0).max(1)),
  model: z.literal(TYPESAFE_MODEL),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).strict();

export const reviewRecordSchema = z.object({
  scanId: z.string(), resultId: z.string(), ticker: z.string(), ownerId: z.string(),
  scanTime: z.string().datetime(), reviewedAt: z.string().datetime(),
  inputHash: z.string().nullable(), claim: z.string().nullable(),
  status: z.enum(['RESERVED', 'COMPLETE', 'UNAVAILABLE', 'INSUFFICIENT_EVIDENCE', 'BUDGET_EXHAUSTED', 'CHANGED_EVIDENCE']),
  flags: z.array(z.string()), answer: answerSchema.nullable(), elapsedMs: z.number().nonnegative(),
}).strict();
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
const ledgerSchema = z.object({
  version: z.literal(1), lastObservedAt: z.string().datetime(),
  attempts: z.array(z.object({ key: z.string(), day: z.string(), reservedAt: z.string().datetime() }).strict()).max(200),
  reviews: z.record(z.string(), reviewRecordSchema),
  lastRun: z.object({ at: z.string().datetime(), status: z.string(), ownerId: z.string() }).strict().nullable(),
  cooldownUntil: z.number().nonnegative(),
}).strict();
export type ReviewLedger = z.infer<typeof ledgerSchema>;
export const DEFAULT_REVIEW_DIRECTORY = path.join(process.cwd(), 'data', 'typesafe-review');
/** A lock this old whose owning process no longer exists is left over from a crash. */
export const STALE_LOCK_MS = 10 * 60_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function reviewDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isReviewWeekday(now: Date): boolean {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', weekday: 'short' }).format(now);
  return day !== 'Sat' && day !== 'Sun';
}

export function reviewKey(scanId: string, resultId: string): string {
  return JSON.stringify([scanId, resultId]);
}

export class TypesafeReviewStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  readonly shadowPath: string;
  private lockToken: string | null = null;

  constructor(readonly directory = DEFAULT_REVIEW_DIRECTORY) {
    this.ledgerPath = path.join(directory, 'ledger.json');
    this.lockPath = path.join(directory, 'worker.lock');
    this.shadowPath = path.join(directory, 'shadow-predictions.jsonl');
  }

  acquire(): void {
    if (this.lockToken) throw new Error('REVIEW_LOCK_ALREADY_HELD');
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      this.createLock();
    } catch (error) {
      // A crashed or killed holder (e.g. an auto-trade session stopped at its
      // time limit) must not block Jev forever. Only a lock that is both old
      // and owned by a process that no longer exists is removed.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !this.removeDeadLock()) throw error;
      this.createLock();
    }
  }

  private createLock(): void {
    const token = randomUUID();
    const descriptor = fs.openSync(this.lockPath, 'wx');
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.fsyncSync(descriptor);
      this.lockToken = token;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private removeDeadLock(): boolean {
    try {
      if (Date.now() - fs.statSync(this.lockPath).mtimeMs < STALE_LOCK_MS) return false;
      const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: unknown; token?: unknown };
      if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || isProcessAlive(lock.pid)) return false;
      // Re-read just before deleting: if another process already reclaimed the
      // lock (new token), leave its fresh lock alone.
      const current = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { token?: unknown };
      if (current.token !== lock.token) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (!this.lockToken) return;
    const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { token?: unknown };
    if (lock.token !== this.lockToken) throw new Error('REVIEW_LOCK_OWNERSHIP_CHANGED');
    fs.unlinkSync(this.lockPath);
    this.lockToken = null;
  }

  initialize(now: Date): void {
    if (!this.lockToken) throw new Error('REVIEW_LOCK_REQUIRED');
    if (fs.existsSync(this.ledgerPath) || fs.existsSync(path.join(this.directory, 'initialized'))) throw new Error('REVIEW_ALREADY_INITIALIZED');
    fs.writeFileSync(path.join(this.directory, 'initialized'), now.toISOString(), { flag: 'wx' });
    this.save({ version: 1, lastObservedAt: now.toISOString(), attempts: [], reviews: {}, lastRun: null, cooldownUntil: 0 });
  }

  read(): ReviewLedger {
    if (!fs.existsSync(path.join(this.directory, 'initialized'))) throw new Error('REVIEW_NOT_INITIALIZED');
    if (fs.statSync(this.ledgerPath).size > 2_000_000) throw new Error('REVIEW_LEDGER_TOO_LARGE');
    return ledgerSchema.parse(JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')));
  }

  save(ledger: ReviewLedger): void {
    if (!this.lockToken) throw new Error('REVIEW_LOCK_REQUIRED');
    const payload = JSON.stringify(ledgerSchema.parse(ledger));
    if (Buffer.byteLength(payload) > 2_000_000) throw new Error('REVIEW_LEDGER_TOO_LARGE');
    const temporaryPath = `${this.ledgerPath}.${this.lockToken}.tmp`;
    const descriptor = fs.openSync(temporaryPath, 'w');
    try {
      fs.writeFileSync(descriptor, payload);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporaryPath, this.ledgerPath);
  }

  // Never pruned: 20-day outcomes arrive long after the 7-day ledger retention.
  appendShadow(prediction: ShadowPrediction): void {
    if (!this.lockToken) throw new Error('REVIEW_LOCK_REQUIRED');
    const descriptor = fs.openSync(this.shadowPath, 'a');
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(shadowPredictionSchema.parse(prediction))}\n`);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }

  findShadow(scanId: string, resultId: string, inputHash: string): ShadowPrediction | null {
    if (!fs.existsSync(this.shadowPath)) return null;
    const lines = fs.readFileSync(this.shadowPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const parsed = shadowPredictionSchema.safeParse(JSON.parse(lines[i]));
        if (parsed.success && parsed.data.scanId === scanId && parsed.data.resultId === resultId && parsed.data.inputHash === inputHash) {
          return parsed.data;
        }
      } catch { /* skip a torn line */ }
    }
    return null;
  }

  observe(ledger: ReviewLedger, now: Date): void {
    if (now.getTime() < Date.parse(ledger.lastObservedAt)) throw new Error('REVIEW_CLOCK_ROLLBACK');
    ledger.lastObservedAt = now.toISOString();
    const cutoff = now.getTime() - 7 * 86_400_000;
    ledger.attempts = ledger.attempts.filter(attempt => Date.parse(attempt.reservedAt) >= cutoff);
    ledger.reviews = Object.fromEntries(Object.entries(ledger.reviews).filter(([, review]) => Date.parse(review.reviewedAt) >= cutoff));
  }

  reserve(ledger: ReviewLedger, review: ReviewRecord, now: Date): boolean {
    this.observe(ledger, now);
    const key = reviewKey(review.scanId, review.resultId);
    if (ledger.attempts.some(attempt => attempt.key === key)) return false;
    if (ledger.attempts.filter(attempt => ledger.reviews[attempt.key]?.scanId === review.scanId).length >= 5) return false;
    if (ledger.attempts.filter(attempt => attempt.day === reviewDay(now)).length >= 20) return false;
    ledger.attempts.push({ key, day: reviewDay(now), reservedAt: now.toISOString() });
    ledger.reviews[key] = { ...review, status: 'RESERVED' };
    this.save(ledger);
    return true;
  }
}