import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock('../../data/src/prisma', () => ({
  prisma: { appSetting: { findUnique: (...args: unknown[]) => findUnique(...args), upsert: (...args: unknown[]) => upsert(...args) } },
  toInputJson: (value: unknown) => value,
}));

const { getKillSwitchSettings, updateKillSwitchSettings } = await import('./safety-controls');

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe('kill-switch settings: ETF-only auto-trading', () => {
  it('defaults ETF-only to off when nothing is saved', async () => {
    findUnique.mockResolvedValue(null);
    expect((await getKillSwitchSettings()).etfOnlyAutoTrading).toBe(false);
  });

  it('keeps existing switches when a record saved before ETF-only existed is read', async () => {
    findUnique.mockResolvedValue({ valueJson: {
      disableAllSubmissions: false, disableAutomatedSubmissions: false, disableScansWhenDataStale: true,
      enableAutoTrading: true, updatedAt: '2026-09-01T00:00:00.000Z',
    } });
    const settings = await getKillSwitchSettings();
    expect(settings.enableAutoTrading).toBe(true);
    expect(settings.updatedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(settings.etfOnlyAutoTrading).toBe(false);
  });

  it('persists ETF-only without touching the other switches', async () => {
    findUnique.mockResolvedValue({ valueJson: {
      disableAllSubmissions: false, disableAutomatedSubmissions: false, disableScansWhenDataStale: true,
      enableAutoTrading: true, etfOnlyAutoTrading: false, updatedAt: null,
    } });
    const updated = await updateKillSwitchSettings({ etfOnlyAutoTrading: true });
    expect(updated).toMatchObject({ etfOnlyAutoTrading: true, enableAutoTrading: true, disableScansWhenDataStale: true });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
