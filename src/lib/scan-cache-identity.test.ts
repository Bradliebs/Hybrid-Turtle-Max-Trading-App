import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./cache-persistence', () => ({ persistCache: vi.fn().mockResolvedValue(undefined), invalidateCache: vi.fn().mockResolvedValue(undefined), rehydrateCache: vi.fn() }));
import { clearScanCache, getScanCache, setScanCache } from './scan-cache';

const scan = { regime: 'BULLISH', candidates: [], readyCount: 0, watchCount: 0, farCount: 0,
  totalScanned: 0, passedFilters: 0, passedRiskGates: 0, passedAntiChase: 0,
  userId: 'owner', riskProfile: 'BALANCED', equity: 1000 };
beforeEach(() => clearScanCache());
describe('scan identity metadata', () => {
  it('preserves exact identity and replaces it on new scans', () => {
    setScanCache({ ...scan, scanId: 'first' });
    expect(getScanCache()?.scanId).toBe('first');
    setScanCache({ ...scan, scanId: 'second' });
    expect(getScanCache()?.scanId).toBe('second');
  });
  it('does not infer identity for legacy or failed persistence', () => {
    setScanCache(scan);
    expect(getScanCache()?.scanId).toBeUndefined();
    setScanCache({ ...scan, scanId: null });
    expect(getScanCache()?.scanId).toBeNull();
  });
});