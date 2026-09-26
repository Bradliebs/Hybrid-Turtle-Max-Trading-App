/**
 * DEPENDENCIES
 * Consumed by: packages/workflow/src/execution.ts, packages/workflow/src/index.ts, src/app/api/scan/route.ts, src/app/api/settings/kill-switches/route.ts, src/components/settings/SafetyControlsPanel.tsx, scripts/verify-phase10.ts
 * Consumes: packages/data/src/prisma.ts
 * Risk-sensitive: YES — blocks scan and submission flows when safety toggles are enabled
 * Last modified: 2026-03-09
 * Notes: Phase 10 kill-switch persistence and enforcement helpers.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, toInputJson } from '../../data/src/prisma';

const KILL_SWITCH_SETTINGS_KEY = 'phase10.kill-switches';

export interface KillSwitchSettings {
  disableAllSubmissions: boolean;
  disableAutomatedSubmissions: boolean;
  disableScansWhenDataStale: boolean;
  enableAutoTrading: boolean;
  /** When true, scheduled auto-trade only buys ETF-sleeve candidates. Manual execution is unaffected. */
  etfOnlyAutoTrading: boolean;
  updatedAt: string | null;
}

export interface MarketDataSafetyStatus {
  isStale: boolean;
  staleSymbolCount: number;
  latestRefreshStatus: string | null;
  latestRefreshAt: string | null;
}

export class SafetyControlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SafetyControlError';
  }
}

const DEFAULT_KILL_SWITCH_SETTINGS: KillSwitchSettings = {
  disableAllSubmissions: false,
  disableAutomatedSubmissions: false,
  disableScansWhenDataStale: true,
  enableAutoTrading: false,
  etfOnlyAutoTrading: false,
  updatedAt: null,
};

const killSwitchSchema = z.object({
  disableAllSubmissions: z.boolean(),
  disableAutomatedSubmissions: z.boolean(),
  disableScansWhenDataStale: z.boolean(),
  enableAutoTrading: z.boolean().default(false),
  etfOnlyAutoTrading: z.boolean().default(false),
  updatedAt: z.string().nullable(),
});

function normalizeSettings(value: unknown): KillSwitchSettings {
  const parsed = killSwitchSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return DEFAULT_KILL_SWITCH_SETTINGS;
}

export async function getKillSwitchSettings(): Promise<KillSwitchSettings> {
  const record = await prisma.appSetting.findUnique({
    where: { key: KILL_SWITCH_SETTINGS_KEY },
    select: { valueJson: true },
  });

  return normalizeSettings(record?.valueJson);
}

export async function updateKillSwitchSettings(
  patch: Partial<Omit<KillSwitchSettings, 'updatedAt'>>,
): Promise<KillSwitchSettings> {
  const current = await getKillSwitchSettings();
  const updated: KillSwitchSettings = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await prisma.appSetting.upsert({
    where: { key: KILL_SWITCH_SETTINGS_KEY },
    update: {
      value: JSON.stringify(updated),
      valueJson: toInputJson(updated),
      description: 'Phase 10 kill-switch safety controls',
    },
    create: {
      key: KILL_SWITCH_SETTINGS_KEY,
      value: JSON.stringify(updated),
      valueJson: toInputJson(updated),
      description: 'Phase 10 kill-switch safety controls',
    },
  });

  return updated;
}

export async function getMarketDataSafetyStatus(): Promise<MarketDataSafetyStatus> {
  const [latestRefresh, staleSymbolCount] = await Promise.all([
    prisma.jobRun.findFirst({
      where: { jobName: 'market-data.refresh-universe-daily-bars' },
      orderBy: { startedAt: 'desc' },
      select: { status: true, finishedAt: true },
    }),
    prisma.instrument.count({
      where: { isActive: true, isPriceDataStale: true },
    }),
  ]);

  const refreshFailed = latestRefresh?.status === 'FAILED';
  const isStale = refreshFailed || staleSymbolCount > 0;

  return {
    isStale,
    staleSymbolCount,
    latestRefreshStatus: latestRefresh?.status ?? null,
    latestRefreshAt: latestRefresh?.finishedAt?.toISOString() ?? null,
  };
}

export async function assertSubmissionAllowed(options: { automated: boolean }) {
  const settings = await getKillSwitchSettings();

  if (settings.disableAllSubmissions) {
    throw new SafetyControlError(
      'ALL_SUBMISSIONS_DISABLED',
      'All order submissions are currently disabled by the Phase 10 kill switch.'
    );
  }

  if (options.automated && settings.disableAutomatedSubmissions) {
    throw new SafetyControlError(
      'AUTOMATED_SUBMISSIONS_DISABLED',
      'Automated order submissions are currently disabled by the Phase 10 kill switch.'
    );
  }
}

/**
 * Check if auto-trading is enabled.
 * DB kill switch is the sole authority. The env var is only used as an initial
 * default when no DB setting has been saved yet (first run in headless mode).
 * Once the dashboard sets the DB value, env var is ignored.
 */
export async function isAutoTradingEnabled(): Promise<boolean> {
  const settings = await getKillSwitchSettings();
  // If the DB setting has been explicitly saved (updatedAt is set), use DB only.
  // Otherwise fall back to env var for first-run headless setups.
  if (settings.updatedAt) {
    return settings.enableAutoTrading;
  }
  return settings.enableAutoTrading || process.env.ENABLE_AUTO_TRADING === 'true';
}

export async function assertScanAllowed() {
  const settings = await getKillSwitchSettings();
  if (!settings.disableScansWhenDataStale) {
    return;
  }

  const marketData = await getMarketDataSafetyStatus();
  if (marketData.isStale) {
    throw new SafetyControlError(
      'SCANS_DISABLED_STALE_DATA',
      `Scans are blocked because market data is stale (${marketData.staleSymbolCount} stale symbols; latest refresh ${marketData.latestRefreshStatus ?? 'UNKNOWN'}).`
    );
  }
}