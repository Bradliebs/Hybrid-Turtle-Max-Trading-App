/**
 * DEPENDENCIES
 * Consumed by: Dashboard system status panel, mobile alerts
 * Consumes: prisma.ts, health-check.ts
 * Risk-sensitive: NO — read-only aggregation
 * Notes: Single endpoint returning overall system readiness.
 *        Serves Job 5 (dashboard actions) + Job 6 (broker sync).
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { apiError } from '@/lib/api-response';
import { ensureDefaultUser } from '@/lib/default-user';
import { OPERATING_MODES, type OperatingMode } from '@/types';
import { getT212ApiStats } from '@/lib/position-sync';

type SystemReadiness = 'READY' | 'WARNING' | 'BLOCKED';

export async function GET() {
  try {
    const userId = await ensureDefaultUser();

    const [user, latestHealth, latestHeartbeat, openPositionCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          equity: true,
          riskProfile: true,
          operatingMode: true,
          t212Connected: true,
          t212IsaConnected: true,
          t212LastSync: true,
          t212IsaLastSync: true,
        },
      }),
      prisma.healthCheck.findFirst({
        where: { userId },
        orderBy: { runDate: 'desc' },
        select: { overall: true, runDate: true },
      }),
      prisma.heartbeat.findFirst({
        orderBy: { timestamp: 'desc' },
        select: { status: true, timestamp: true },
      }),
      prisma.position.count({ where: { userId, status: 'OPEN' } }),
    ]);

    const now = Date.now();
    const heartbeatAgeH = latestHeartbeat
      ? (now - latestHeartbeat.timestamp.getTime()) / 3600000
      : 999;
    const healthAge = latestHealth
      ? (now - latestHealth.runDate.getTime()) / 3600000
      : 999;
    // Use the most recent sync from whichever T212 account(s) are connected
    const syncDates = [user?.t212LastSync, user?.t212IsaLastSync].filter((d): d is Date => d != null);
    const latestSyncDate = syncDates.length > 0 ? new Date(Math.max(...syncDates.map(d => d.getTime()))) : null;
    const t212SyncAgeH = latestSyncDate
      ? (now - latestSyncDate.getTime()) / 3600000
      : null;

    const checks = [
      { id: 'health', label: 'System Health', ok: latestHealth?.overall !== 'RED', value: latestHealth?.overall ?? 'UNKNOWN' },
      { id: 'heartbeat', label: 'Nightly Ran', ok: heartbeatAgeH < 26, value: `${heartbeatAgeH.toFixed(0)}h ago` },
      { id: 'equity', label: 'Equity Set', ok: (user?.equity ?? 0) > 0, value: `£${(user?.equity ?? 0).toFixed(0)}` },
      { id: 'broker', label: 'T212 Connected', ok: !!(user?.t212Connected || user?.t212IsaConnected), value: user?.t212Connected ? 'Invest' : user?.t212IsaConnected ? 'ISA' : 'Not connected' },
      { id: 'broker_sync', label: 'T212 Sync', ok: t212SyncAgeH != null && t212SyncAgeH < 24, value: t212SyncAgeH != null ? `${t212SyncAgeH.toFixed(0)}h ago` : 'Never' },
      { id: 'health_age', label: 'Health Check Age', ok: healthAge < 36, value: `${healthAge.toFixed(0)}h ago` },
      // T212 prices are required only when there are open positions to value.
      (() => {
        const t212Stats = getT212ApiStats();
        const cacheOk = openPositionCount === 0
          || (t212Stats.cacheSize > 0 && t212Stats.cacheAge < 300);
        return {
          id: 't212_prices',
          label: 'T212 Prices',
          ok: cacheOk,
          value: openPositionCount === 0
            ? 'No open positions'
            : t212Stats.cacheSize > 0
            ? `${t212Stats.cacheSize} tickers, ${t212Stats.cacheAge}s old`
            : 'No cache',
        };
      })(),
    ];

    const failCount = checks.filter(c => !c.ok).length;
    const readiness: SystemReadiness = failCount === 0
      ? 'READY'
      : failCount <= 2
        ? 'WARNING'
        : 'BLOCKED';

    const operatingMode = (user?.operatingMode || 'NORMAL') as OperatingMode;
    const modeConfig = OPERATING_MODES[operatingMode];

    return NextResponse.json({
      readiness,
      checks,
      operatingMode,
      operatingModeName: modeConfig?.name ?? operatingMode,
      riskProfile: user?.riskProfile ?? 'BALANCED',
      summary: readiness === 'READY'
        ? 'System is healthy and ready to operate.'
        : readiness === 'WARNING'
          ? `System has ${failCount} warning(s). Review before trading.`
          : `System is blocked — ${failCount} issue(s) must be resolved.`,
    });
  } catch (error) {
    return apiError(500, 'STATUS_FAILED', 'Failed to compute system status', (error as Error).message);
  }
}
