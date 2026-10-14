/**
 * DEPENDENCIES
 * Consumed by: midday-sync-task.bat, Windows Task Scheduler
 * Consumes: position-sync.ts, prisma.ts, telegram.ts
 * Risk-sensitive: YES — auto-closes positions based on T212 state
 * Last modified: 2026-03-02
 * Notes: Lightweight intra-day sync — only runs position detection (no stops, no scans).
 *        Designed to run every 2-3 hours during market hours so stop-outs are detected quickly.
 */

import prisma from '@/lib/prisma';
import type { PositionSyncResult } from '@/lib/position-sync';
import { sendAlert } from '@/lib/alert-service';
import { refreshUserEquityFromBroker } from '@/lib/equity-refresh';
import { createCronLogger } from '@/lib/cron-logger';
import { getUKDayOfWeek } from '@/lib/uk-time';

process.env.HYBRIDTURTLE_SKIP_STARTUP_PRECACHE = 'true';

const log = createCronLogger('midday-sync');

/**
 * Maximum allowed change in open-position count between same-day midday-sync
 * runs before a drift alert is raised. Set to 2 because legitimate intra-day
 * activity (a new buy + an exit) can plausibly shift the count by ±2 without
 * being a duplication bug. Anything larger is suspicious.
 */
export const POSITION_DRIFT_THRESHOLD = 2;

export interface DriftDecision {
  /** Whether the drift exceeds the threshold and an alert should be raised. */
  shouldAlert: boolean;
  /** Absolute change in count. Always non-negative. */
  delta: number;
  /** Human-readable direction, useful for alert text. */
  direction: 'increased' | 'decreased' | 'unchanged';
}

/**
 * Pure drift evaluator — extracted so it can be unit-tested without prisma.
 *
 * Returns `shouldAlert=false` when there is no prior measurement to compare
 * against (first run of the day). Threshold is exclusive: a delta exactly
 * equal to the threshold does NOT alert.
 */
export function evaluatePositionDrift(
  prior: number | null,
  current: number,
  threshold: number = POSITION_DRIFT_THRESHOLD,
): DriftDecision {
  if (prior == null) {
    return { shouldAlert: false, delta: 0, direction: 'unchanged' };
  }
  const delta = Math.abs(current - prior);
  const direction: DriftDecision['direction'] =
    current > prior ? 'increased' : current < prior ? 'decreased' : 'unchanged';
  return { shouldAlert: delta > threshold, delta, direction };
}

async function runMiddaySync() {
  const userId = 'default-user';

  log.info('Midday position sync started');

  // Skip weekends (UK time)
  const ukDay = getUKDayOfWeek();
  if (ukDay === 0 || ukDay === 6) {
    console.log('  Weekend — skipping sync.');
    await prisma.heartbeat.create({
      data: {
        kind: 'MIDDAY_SYNC',
        status: 'SKIPPED',
        details: JSON.stringify({ type: 'midday-sync', reason: 'weekend', ranAt: new Date().toISOString() }),
      },
    });
    await prisma.$disconnect();
    return;
  }

  let result: PositionSyncResult = { checked: 0, closed: 0, skipped: 0, updated: 0, errors: [] };

  try {
    // Check if there are open positions to sync
    const openCount = await prisma.position.count({ where: { userId, status: 'OPEN' } });
    if (openCount === 0) {
      console.log('  No open positions — nothing to sync.');
      await prisma.heartbeat.create({
        data: {
          kind: 'MIDDAY_SYNC',
          status: 'SKIPPED',
          details: JSON.stringify({ type: 'midday-sync', reason: 'no-open-positions', ranAt: new Date().toISOString() }),
        },
      });
      await prisma.$disconnect();
      return;
    }

    console.log(`  ${openCount} open position(s) — syncing against Trading 212...`);
    const { syncClosedPositions } = await import('@/lib/position-sync');
    result = await syncClosedPositions(userId, { detectUntrackedSales: false });

    console.log(`  Result: ${result.checked} checked, ${result.closed} closed, ${result.skipped} skipped, ${result.updated} updated`);

    // Audit fix F4 (2026-): refresh User.equity from T212 combined totalValue.
    // syncClosedPositions already fetches the account summary and persists
    // User.equity when all configured accounts succeed; only call
    // refreshUserEquityFromBroker as a fallback so we don't hit
    // GET /equity/account/summary twice in 1 second and trip a 429.
    try {
      const eq = result.equityRefreshed
        ? { ...result.equityRefreshed, written: true }
        : await refreshUserEquityFromBroker(userId);
      if (eq.written) {
        console.log(`  Equity refreshed: £${eq.combinedTotalValueGbp.toFixed(2)} (invest=${eq.investTotalValue ?? 'n/a'}, isa=${eq.isaTotalValue ?? 'n/a'})`);
      } else {
        console.warn('  Equity refresh skipped or failed — User.equity unchanged.');
      }
    } catch (eqErr) {
      console.warn(`  Equity refresh threw unexpectedly: ${(eqErr as Error).message}`);
    }

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.warn(`  Warning: ${err}`);
      }
    }

    if (result.closed > 0) {
      console.log(`  ** ${result.closed} position(s) detected as closed in T212 **`);
      // Alert is already sent by syncClosedPositions — just log for the batch file
    }

    // ── Drift detection ──
    // Compare today's open count against the most recent prior midday-sync
    // heartbeat. A swing >POSITION_DRIFT_THRESHOLD between runs is a strong
    // signal that the auto-trade × broker-sync duplication bug class has
    // recurred (see incident 2026-05-01 "9 vs 6"). The alert is throttled
    // by dedupe key so we don't spam if the drift persists across runs.
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const priorMidday = await prisma.heartbeat.findFirst({
        where: {
          kind: 'MIDDAY_SYNC',
          status: 'OK',
          timestamp: { gte: todayStart },
        },
        orderBy: { timestamp: 'desc' },
      });
      let priorChecked: number | null = null;
      if (priorMidday?.details) {
        try {
          const parsed = JSON.parse(priorMidday.details) as { checked?: number };
          if (typeof parsed.checked === 'number') priorChecked = parsed.checked;
        } catch {
          // Heartbeat details not parseable — treat as no prior measurement.
        }
      }
      const drift = evaluatePositionDrift(priorChecked, openCount);
      if (drift.shouldAlert && priorChecked != null) {
        log.warn('Position count drift detected', {
          prior: priorChecked,
          current: openCount,
          delta: drift.delta,
        });
        await sendAlert({
          type: 'SYSTEM',
          title: `Position count ${drift.direction} by ${drift.delta} since last midday sync`,
          message: `Open positions ${drift.direction} from ${priorChecked} to ${openCount} between midday-sync runs today. ` +
            `A swing this large within the same trading day usually means duplicate rows were created (auto-trade × broker-sync) or a sync collapsed real holdings. ` +
            `Check the portfolio screen and run scripts/dedupe-broker-vs-autotrade-positions.ts if duplicates are confirmed.`,
          data: { prior: priorChecked, current: openCount, delta: drift.delta },
          priority: 'WARNING',
          telegramDedupeKey: `midday-sync:drift:${todayStart.toISOString().slice(0, 10)}`,
        });
      }
    } catch (driftErr) {
      // Drift check is advisory — never block the sync on it
      console.warn(`  Drift check failed: ${(driftErr as Error).message}`);
    }

    // Write a heartbeat so the dashboard knows the midday sync ran
    await prisma.heartbeat.create({
      data: {
        kind: 'MIDDAY_SYNC',
        status: 'OK',
        details: JSON.stringify({
          type: 'midday-sync',
          ranAt: new Date().toISOString(),
          checked: result.checked,
          closed: result.closed,
          errors: result.errors,
        }),
      },
    });

  } catch (error) {
    const msg = (error as Error).message;
    log.error('Midday sync failed', { error: msg });

    process.exitCode = 1;

    try {
      await prisma.heartbeat.create({
        data: {
          kind: 'MIDDAY_SYNC',
          status: 'FAILED',
          details: JSON.stringify({ error: msg, failedAt: new Date().toISOString() }),
        },
      });
    } catch (heartbeatError) {
      console.error('  Could not write failed midday heartbeat:', (heartbeatError as Error).message);
    }

    // Send alert on failure so the user knows
    try {
      await sendAlert({
        type: 'SYSTEM',
        title: 'Midday position sync failed',
        message: `The intra-day T212 position sync failed.\n\nError: ${msg}\n\nYour nightly sync at 9 PM will still run. You can also click Sync manually in the dashboard.`,
        data: { error: msg },
        priority: 'WARNING',
        telegramDedupeKey: 'midday-sync:failure',
      });
    } catch {
      // Alert itself failed — just log
      console.error('  Could not send failure alert.');
    }
  } finally {
    await prisma.$disconnect();
  }

  log.info('Midday sync finished', { checked: result.checked, closed: result.closed, errors: result.errors.length });
}


// ── Entry point ──────────────────────────────────────────────────────
// Only auto-execute when run as a script (via `tsx src/cron/midday-sync.ts`),
// not when imported by a test or another module. The previous unconditional
// call ran the full sync on `import` from vitest, which only happened to be
// safe because today was a weekend (the function early-returned on day=0/6).
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runMiddaySync().catch((err) => {
    console.error('Fatal error in midday sync:', err);
    process.exit(1);
  });
}
