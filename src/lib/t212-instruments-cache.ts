/**
 * Cached snapshot of Trading 212's instruments universe.
 *
 * Trading 212's `/equity/metadata/instruments` endpoint is rate-limited
 * to 1 request per 50s and returns ~1 MB of data covering every tradable
 * symbol on the platform. Calling it from the auto-trade hot path would
 * either (a) burn the rate limit cap on a routine validation step or
 * (b) introduce noticeable latency on every session run.
 *
 * Instead, the snapshot is written to a JSON file under `prisma/cache/`
 * by the audit/repair scripts. Auto-trade reads it as a soft validation
 * layer — when present, candidates whose `t212Ticker` is structurally
 * valid but absent from T212's universe are skipped with a clear reason.
 * When absent or stale, callers fall back to the static-suffix sieve
 * (so the trading path never fails open or fails closed because of
 * cache state alone).
 *
 * Pure module on the read path (no `server-only`); the write path is
 * only used by scripts.
 *
 * Used by:
 *  - scripts/repair-t212-tickers-from-instruments.ts (writes + reads)
 *  - src/cron/auto-trade.ts, src/app/api/positions/execute/route.ts (getT212LineCurrency: UK line units)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { T212Instrument } from './trading212';
import { stripT212Suffix } from './t212-ticker-validator';

/** On-disk cache file. Lives next to the other prisma/cache JSON files. */
export const DEFAULT_CACHE_PATH = path.join(
  process.cwd(),
  'prisma',
  'cache',
  't212-instruments.json',
);

/** Default freshness window for the snapshot. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface T212InstrumentsCacheFile {
  fetchedAt: string; // ISO 8601
  count: number;
  instruments: T212Instrument[];
}

export interface T212InstrumentsLookup {
  fetchedAt: Date;
  count: number;
  /** Indexed by full T212 ticker (e.g. AAPL_US_EQ) for O(1) hot-path checks. */
  byT212Ticker: Map<string, T212Instrument>;
  /** Indexed by stripped bare ticker (e.g. AAPL) → all listings of that base. */
  byBareTicker: Map<string, T212Instrument[]>;
  /** Indexed by `shortName` (T212's canonical bare display ticker, e.g. AZN
   *  for both AZN_US_EQ and AZNl_EQ) → all listings. Strongest key for
   *  cross-listing lookups; falls back to bare-ticker stripping when an
   *  instrument is missing `shortName`. */
  byShortName: Map<string, T212Instrument[]>;
}

/**
 * Read and index the cache. Returns `null` when the file is missing,
 * unreadable, or older than `maxAgeMs` (default: TTL constant above).
 *
 * Never throws — caller is expected to fall back to the static-suffix
 * check when this returns `null`.
 */
export function loadT212InstrumentsCache(
  cachePath: string = DEFAULT_CACHE_PATH,
  maxAgeMs: number = DEFAULT_TTL_MS,
): T212InstrumentsLookup | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: T212InstrumentsCacheFile;
  try {
    parsed = JSON.parse(raw) as T212InstrumentsCacheFile;
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed.fetchedAt !== 'string' ||
    !Array.isArray(parsed.instruments)
  ) {
    return null;
  }

  const fetchedAt = new Date(parsed.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) return null;
  if (Date.now() - fetchedAt.getTime() > maxAgeMs) return null;

  return indexInstruments(parsed.instruments, fetchedAt);
}

/** Build the indexed lookup from a raw instruments list (exported for tests). */
export function indexInstruments(
  instruments: T212Instrument[],
  fetchedAt: Date,
): T212InstrumentsLookup {
  const byT212Ticker = new Map<string, T212Instrument>();
  const byBareTicker = new Map<string, T212Instrument[]>();
  const byShortName = new Map<string, T212Instrument[]>();
  for (const inst of instruments) {
    if (!inst?.ticker) continue;
    byT212Ticker.set(inst.ticker, inst);
    const bare = stripT212Suffix(inst.ticker);
    const bareList = byBareTicker.get(bare) ?? [];
    bareList.push(inst);
    byBareTicker.set(bare, bareList);
    if (inst.shortName) {
      const key = inst.shortName.toUpperCase();
      const shortList = byShortName.get(key) ?? [];
      shortList.push(inst);
      byShortName.set(key, shortList);
    }
  }
  return { fetchedAt, count: instruments.length, byT212Ticker, byBareTicker, byShortName };
}

/**
 * Write the snapshot to disk. Writes via a tmp file + rename so a
 * concurrent reader can never see a half-written JSON document.
 */
export function writeT212InstrumentsCache(
  instruments: T212Instrument[],
  cachePath: string = DEFAULT_CACHE_PATH,
): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  const payload: T212InstrumentsCacheFile = {
    fetchedAt: new Date().toISOString(),
    count: instruments.length,
    instruments,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, cachePath);
}

/**
 * Quick existence check used by auto-trade's pre-flight sieve.
 *
 * Returns:
 *  - `true`  → instrument is in the cache (safe to trade)
 *  - `false` → cache present and instrument NOT in it (skip with reason)
 *  - `null`  → cache absent / stale (caller falls back to static check)
 */
export function isKnownT212Ticker(
  lookup: T212InstrumentsLookup | null,
  t212Ticker: string,
): boolean | null {
  if (!lookup) return null;
  return lookup.byT212Ticker.has(t212Ticker);
}

/**
 * Currency of a T212 instrument from the on-disk snapshot, or null when the
 * snapshot or instrument is missing. Age is ignored: an instrument's trading
 * currency does not change, and a missing answer blocks UK buys (fail closed).
 */
export function getT212LineCurrency(t212Ticker: string, cachePath: string = DEFAULT_CACHE_PATH): string | null {
  const lookup = loadT212InstrumentsCache(cachePath, Number.POSITIVE_INFINITY);
  return lookup?.byT212Ticker.get(t212Ticker)?.currencyCode ?? null;
}
