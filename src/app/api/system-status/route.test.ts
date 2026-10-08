import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  positionCount: vi.fn(),
  apiStats: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        equity: 417,
        riskProfile: 'SMALL_ACCOUNT',
        operatingMode: 'NORMAL',
        t212Connected: false,
        t212IsaConnected: true,
        t212LastSync: null,
        t212IsaLastSync: new Date(),
      }),
    },
    healthCheck: {
      findFirst: vi.fn().mockResolvedValue({ overall: 'GREEN', runDate: new Date() }),
    },
    heartbeat: {
      findFirst: vi.fn().mockResolvedValue({ status: 'OK', timestamp: new Date() }),
    },
    position: { count: (...args: unknown[]) => mocks.positionCount(...args) },
  },
}));
vi.mock('@/lib/default-user', () => ({ ensureDefaultUser: vi.fn().mockResolvedValue('default-user') }));
vi.mock('@/lib/position-sync', () => ({ getT212ApiStats: () => mocks.apiStats() }));

import { GET } from './route';

describe('GET /api/system-status', () => {
  beforeEach(() => {
    mocks.positionCount.mockReset();
    mocks.apiStats.mockReset().mockReturnValue({ cacheSize: 0, cacheAge: -1 });
  });

  it('does not require a T212 price cache for a cash-only account', async () => {
    mocks.positionCount.mockResolvedValue(0);

    const response = await GET();
    const body = await response.json();

    expect(body.readiness).toBe('READY');
    expect(body.checks.find((check: { id: string }) => check.id === 't212_prices'))
      .toMatchObject({ ok: true, value: 'No open positions' });
  });

  it('still flags an empty price cache when a position is open', async () => {
    mocks.positionCount.mockResolvedValue(1);

    const response = await GET();
    const body = await response.json();

    expect(body.checks.find((check: { id: string }) => check.id === 't212_prices'))
      .toMatchObject({ ok: false, value: 'No cache' });
  });
});