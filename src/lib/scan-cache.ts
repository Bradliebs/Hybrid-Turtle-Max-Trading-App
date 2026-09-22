// ============================================================
// Scan Result Cache
// ============================================================
// Holds the last scan result in memory so the UI can display
// it across page navigations without re-hitting Yahoo Finance.
// Uses globalThis to survive Next.js hot-reloads in dev mode
// (same pattern as Prisma singleton).
// Clears automatically on server restart or when a new scan runs.
// Persists to disk via cache-persistence so it survives full restarts.

import { persistCache, rehydrateCache, invalidateCache } from './cache-persistence';
import { CACHE_KEYS } from './cache-keys';

export interface CachedScanResult {
  scanId?: string | null;
  regime: string;
  candidates: unknown[];
  readyCount: number;
  watchCount: number;
  farCount: number;
  totalScanned: number;
  passedFilters: number;
  passedRiskGates: number;
  passedAntiChase: number;
  // metadata
  cachedAt: string;       // ISO timestamp
  userId: string;
  riskProfile: string;
  equity: number;
}

export const SCAN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Persist cache on globalThis so Next.js hot-reloads don't wipe it
const globalForScan = globalThis as unknown as {
  __scanCache: CachedScanResult | null;
};

if (!globalForScan.__scanCache) {
  globalForScan.__scanCache = null;
}

/** Store the latest scan result. Also persists to disk (fire-and-forget). */
export function setScanCache(
  result: Omit<CachedScanResult, 'cachedAt'>,
): CachedScanResult {
  globalForScan.__scanCache = {
    ...result,
    cachedAt: new Date().toISOString(),
  };
  // Persist to disk asynchronously — do not block the caller
  persistCache(CACHE_KEYS.SCAN_RESULTS, globalForScan.__scanCache).catch((err) => {
    console.warn('[scan-cache] Failed to persist to disk:', (err as Error).message);
  });
  return globalForScan.__scanCache;
}

/** Retrieve the cached scan result (or null if none). Synchronous — disk used only at warmup. */
export function getScanCache(): CachedScanResult | null {
  return globalForScan.__scanCache;
}

/** Returns true when cache entry timestamp is within TTL window. */
export function isScanCacheFresh(
  cached: CachedScanResult,
  now: number = Date.now(),
  ttlMs: number = SCAN_CACHE_TTL_MS
): boolean {
  const cachedAt = new Date(cached.cachedAt).getTime();
  if (!Number.isFinite(cachedAt)) return false;
  return now - cachedAt <= ttlMs;
}

/** Clear the cache (e.g. before a new scan). Also removes persisted file. */
export function clearScanCache(): void {
  globalForScan.__scanCache = null;
  invalidateCache(CACHE_KEYS.SCAN_RESULTS).catch(() => {});
}

/**
 * Attempt to rehydrate the in-memory scan cache from disk.
 * Called once at server startup by cache-warmup.ts.
 */
export async function rehydrateScanCacheFromDisk(): Promise<boolean> {
  if (globalForScan.__scanCache) return true; // Already warm
  try {
    const persisted = await rehydrateCache<CachedScanResult>(CACHE_KEYS.SCAN_RESULTS);
    if (persisted) {
      globalForScan.__scanCache = persisted.data;
      console.log(`[scan-cache] Rehydrated from disk (age: ${Math.round(persisted.age / 1000)}s)`);
      return true;
    }
  } catch {
    // Silent — treat as cache miss
  }
  return false;
}
