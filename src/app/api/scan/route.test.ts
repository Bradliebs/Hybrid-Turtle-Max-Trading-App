import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  persist: vi.fn(), scan: vi.fn(), cache: vi.fn(), cached: vi.fn(), latest: vi.fn(), user: vi.fn(),
}));
vi.mock('@/lib/scan-engine', () => ({ runFullScan: mocks.scan }));
vi.mock('@/lib/persist-scan-snapshot', () => ({ persistScanSnapshot: mocks.persist }));
vi.mock('@/lib/scan-cache', () => ({ clearScanCache: vi.fn(), getScanCache: mocks.cached,
  isScanCacheFresh: () => true, SCAN_CACHE_TTL_MS: 3600000, setScanCache: mocks.cache }));
vi.mock('@/lib/prisma', () => ({ default: { user: { findUnique: mocks.user }, scan: { findFirst: mocks.latest } } }));
vi.mock('@/lib/nightly-guard', () => ({ isNightlyRunning: async () => false }));
vi.mock('@/lib/scan-progress', () => ({ updateScanProgress: vi.fn(), clearScanProgress: vi.fn() }));
vi.mock('@/lib/slippage-tracker', () => ({ getSlippageStats: async () => ({ atrBufferAdjustment: 0 }) }));
vi.mock('../../../../packages/workflow/src', () => ({ assertScanAllowed: vi.fn(), SafetyControlError: class extends Error {} }));
vi.mock('../../../../packages/model/src', () => ({ applyModelLayerToCandidates: (candidates: unknown[]) => ({ candidates, settings: { enabled: false }, versions: {} }) }));
import { GET, POST } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'file:./fixture.db');
  mocks.user.mockResolvedValue({ modelLayerEnabled: false });
  mocks.scan.mockResolvedValue({ candidates: [], regime: 'BULLISH' });
  mocks.cache.mockImplementation(value => ({ ...value, cachedAt: new Date().toISOString() }));
  mocks.cached.mockReturnValue(null);
});
describe('scan API identity', () => {
  it.each(['persisted-scan', null])('returns and caches the persisted ID %s', async scanId => {
    mocks.persist.mockResolvedValue({ scanId, gradedCandidates: [], modelLayer: {} });
    const response = await POST(new NextRequest('http://localhost/api/scan', { method: 'POST', body: JSON.stringify({ userId: 'owner', riskProfile: 'BALANCED', equity: 1000 }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).scanId).toBe(scanId);
    expect(mocks.cache).toHaveBeenCalledWith(expect.objectContaining({ scanId }));
  });
  it('uses the exact database scan ID', async () => {
    mocks.latest.mockResolvedValue({ id: 'database-scan', userId: 'owner', regime: 'BULLISH', runDate: new Date(), results: [{
      stock: { ticker: 'TEST', sleeve: 'CORE', name: 'Test', currency: 'USD' },
      price: 100, ma200: 90, adx: 25, atrPercent: 2, efficiency: 40, passesAllFilters: true, status: 'READY',
    }] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).scanId).toBe('database-scan');
  });
});