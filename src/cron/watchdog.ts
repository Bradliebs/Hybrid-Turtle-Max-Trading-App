/**
 * DEPENDENCIES
 * Consumed by: watchdog-task.bat, Task Scheduler
 * Consumes: prisma.ts, telegram.ts
 * Risk-sensitive: NO — monitoring only
 * Last modified: 2026-06-11
 * Notes: Lightweight watchdog that checks for missed nightly/midday heartbeats
 *        and sends a Telegram alert if the nightly hasn't run in 26+ hours.
 *        Runs daily at 10:00 AM via Task Scheduler.
 */

import prisma from '@/lib/prisma';
import { escapeHtml, sendThrottledTelegramAlert } from '@/lib/telegram';
import { ALERT_CATEGORY, buildAlertKey } from '@/lib/alert-categories';
import { createCronLogger } from '@/lib/cron-logger';
import { spawn, execFile } from 'child_process';
import path from 'path';
import { waitForDashboardRecovery } from './watchdog-recovery';
import {
  readRestartState,
  recordFailure,
  recordRecovery,
  isBudgetExhausted,
  MAX_CONSECUTIVE_RESTART_FAILURES,
} from './watchdog-restart-budget';
import { getUKDayOfWeek, getUKHour } from '@/lib/uk-time';
import { checkSchedulerFindings, parseSchedulerAuditOutput, checkNightlyNotification, checkZeroTradesOnBullishDay, checkNightlyHeartbeatStatus, BUY_DECISION_PHASES, buyableAGradeWhere, type AuditFinding } from './watchdog-checks';
import { getKillSwitchSettings } from '../../packages/workflow/src';

const log = createCronLogger('watchdog');
const NIGHTLY_STALE_HOURS = 26;

export async function countBuyAttemptsSince(since: Date): Promise<number> {
  return prisma.executionLog.count({
    where: { createdAt: { gte: since }, phase: { in: [...BUY_DECISION_PHASES] } },
  });
}

/**
 * Read structured audit findings; malformed or unavailable output rejects.
 */
async function fetchAuditFindings(): Promise<AuditFinding[]> {
  if (process.platform !== 'win32') return [];
  const auditScript = path.resolve(__dirname, '..', '..', 'scripts', 'audit-scheduled-tasks.mjs');
  return new Promise((resolve, reject) => {
    execFile('node', [auditScript, '--json'], { timeout: 30_000 }, (error, stdout) => {
      try {
        const findings = parseSchedulerAuditOutput(stdout);
        if (error && (error.code !== 1 || !findings.some((finding) => finding.severity === 'ERROR'))) {
          reject(new Error('Scheduler audit did not complete successfully'));
          return;
        }
        resolve(findings);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function runWatchdog(): Promise<void> {
  log.info('Watchdog check starting');

  const alerts: string[] = [];

  // Check nightly heartbeat.
  // Nightly writes kind = 'NIGHTLY'. Midday-sync writes kind = 'MIDDAY_SYNC',
  // auto-trade writes its own kind. Filter strictly by NIGHTLY so a daily
  // midday-OK row can never silently mask a missed nightly. Audit 2026-05-16 (H2/M1).
  const latestNightly = await prisma.heartbeat.findFirst({
    where: { kind: 'NIGHTLY' },
    orderBy: { timestamp: 'desc' },
  });

  if (!latestNightly) {
    alerts.push('🚨 WATCHDOG: No nightly heartbeat found at all. Has the nightly pipeline ever run?');
  } else {
    const hoursSince = (Date.now() - latestNightly.timestamp.getTime()) / (1000 * 60 * 60);
    if (hoursSince > NIGHTLY_STALE_HOURS) {
      const lastRun = latestNightly.timestamp.toISOString().replace('T', ' ').slice(0, 19);
      alerts.push(
        `🚨 WATCHDOG: No nightly heartbeat in ${Math.round(hoursSince)}+ hours. Last run: ${lastRun}. Check Task Scheduler.`
      );
    }
    // Liveness (above) is not health: a recent heartbeat can still report a
    // PARTIAL/FAILED run or a stuck RUNNING state. Surface those outcomes so a
    // degraded nightly is not silent for up to 26h (audit 2026-05-29, R1).
    alerts.push(...checkNightlyHeartbeatStatus(latestNightly.status));
    alerts.push(...checkNightlyNotification(latestNightly.details));
  }

  // Check midday sync on weekdays (Mon-Fri = 1-5)
  const now = new Date();
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  if (isWeekday) {
    // Check for a midday heartbeat today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const middayHeartbeat = await prisma.heartbeat.findFirst({
      where: {
        timestamp: { gte: todayStart },
        kind: 'MIDDAY_SYNC',
      },
      orderBy: { timestamp: 'desc' },
    });

    // Also check for SKIPPED status (intentional skip, e.g. market closed)
    const skippedHeartbeat = await prisma.heartbeat.findFirst({
      where: {
        timestamp: { gte: todayStart },
        status: 'SKIPPED',
      },
      orderBy: { timestamp: 'desc' },
    });

    if (!middayHeartbeat && !skippedHeartbeat && now.getHours() >= 13) {
      // Only alert after 1 PM — midday sync runs at noon
      alerts.push(
        '⚠️ WATCHDOG: No midday sync heartbeat found for today. Check Task Scheduler or midday-sync-task.bat.'
      );
    }
  }

  // Check dashboard server on weekdays during market hours (8AM-5PM UK)
  if (isWeekday && now.getHours() >= 8 && now.getHours() < 17) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('http://localhost:3000/api/system-status', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        alerts.push(
          `⚠️ WATCHDOG: Dashboard responded with HTTP ${res.status}. It may need a restart (run start.bat).`
        );
      }
    } catch {
      // Auto-restart with a failure budget. A broken build/install can leave
      // start.bat exiting immediately; without a budget the watchdog would
      // restart the dead process every 10 minutes forever, hidden behind
      // Telegram throttling on identical alerts. See audit 2026-05-16 (H5).
      const priorState = await readRestartState();
      if (isBudgetExhausted(priorState)) {
        log.error('Auto-restart budget exhausted — skipping restart attempt', {
          consecutiveFailures: priorState.consecutiveFailures,
          budget: MAX_CONSECUTIVE_RESTART_FAILURES,
        });
        alerts.push(
          `🚨 WATCHDOG: Dashboard down and auto-restart budget exhausted (${priorState.consecutiveFailures} consecutive failures). ` +
          `Restart attempts are now PAUSED. Run start.bat manually, then delete .watchdog-restart-state.json to re-enable auto-restart. ` +
          `Likely cause: broken build, failing typecheck, DB migration issue, or port 3000 stuck.`
        );
      } else {
        const rootDir = path.resolve(__dirname, '..', '..');
        const startBat = path.join(rootDir, 'start.bat');
        log.warn('Dashboard not responding — attempting auto-restart via start.bat', {
          consecutiveFailures: priorState.consecutiveFailures,
          budget: MAX_CONSECUTIVE_RESTART_FAILURES,
        });
        // Detach the launcher so its (persistent) server child does not keep
        // this watchdog's event loop alive. Without detached+unref the watchdog
        // never exits naturally and Task Scheduler kills it at PT10M, leaving
        // Last Result 267014 — which Check 4 below then misreads as a killed
        // task and alerts about the watchdog itself. See audit 2026-06-11.
        const restartChild = spawn(`start "" /min cmd /c "${startBat}"`, {
          cwd: rootDir,
          detached: true,
          stdio: 'ignore',
          shell: true,
        });
        restartChild.unref();

        const recovered = await waitForDashboardRecovery();
        if (recovered) {
          await recordRecovery().catch((err) =>
            log.warn('Failed to persist recovery state', { error: (err as Error).message })
          );
          log.info('Dashboard recovered after auto-restart');
          alerts.push(
            '✅ WATCHDOG: Dashboard was not responding on port 3000. Auto-restart succeeded — dashboard recovered.'
          );
        } else {
          const nextState = await recordFailure().catch((err) => {
            log.warn('Failed to persist failure state', { error: (err as Error).message });
            return null;
          });
          const failsNow = nextState?.consecutiveFailures ?? priorState.consecutiveFailures + 1;
          log.error('Dashboard auto-restart failed to recover within timeout', {
            consecutiveFailures: failsNow,
            budget: MAX_CONSECUTIVE_RESTART_FAILURES,
          });
          alerts.push(
            `🚨 WATCHDOG: Dashboard was not responding on port 3000. Auto-restart FAILED ` +
            `(${failsNow}/${MAX_CONSECUTIVE_RESTART_FAILURES} consecutive failures). ` +
            (failsNow >= MAX_CONSECUTIVE_RESTART_FAILURES
              ? 'Budget exhausted — restart attempts will pause until manually cleared. Run start.bat.'
              : 'Will retry on next watchdog tick. Run start.bat to recover manually.')
          );
        }
      }
    }
  }

  // Check 4: scheduler-killed tasks (Last Result = 267014). Catches the
  // 5–8 May 2026 silent failure pattern where Windows Task Scheduler killed
  // every auto-trade session at PT10M before any buy was placed.
  try {
    const findings = await fetchAuditFindings();
    alerts.push(...checkSchedulerFindings(findings));
  } catch (err) {
    log.warn('Scheduler audit check failed', { error: (err as Error).message });
    alerts.push('WATCHDOG: Scheduler audit could not be completed; task health is unknown. Inspect the watchdog logs.');
  }

  // Check 5: BULLISH regime + valid A-grade candidates + zero buy attempts
  // today. On a normal trading day all three auto-trade sessions complete by
  // ~21:00 UK; checking after 16:00 catches problems while there's still
  // time to react. Skipped on weekends.
  if (isWeekday) {
    try {
      const ukDay = getUKDayOfWeek(now);
      const ukHour = getUKHour();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const buyAttemptsToday = await countBuyAttemptsSince(todayStart);

      const latestScan = await prisma.scan.findFirst({
        orderBy: { runDate: 'desc' },
        select: { id: true, regime: true },
      });

      let aGradeWithShares = 0;
      if (latestScan) {
        const etfOnly = (await getKillSwitchSettings().catch(() => null))?.etfOnlyAutoTrading ?? false;
        aGradeWithShares = await prisma.scanResult.count({ where: buyableAGradeWhere(latestScan.id, etfOnly) });
      }

      alerts.push(
        ...checkZeroTradesOnBullishDay({
          regime: latestScan?.regime,
          aGradeWithShares,
          buyAttemptsToday,
          ukDayOfWeek: ukDay,
          ukHourOfDay: ukHour,
        })
      );
    } catch (err) {
      log.warn('Zero-trades check failed', { error: (err as Error).message });
    }
  }

  if (alerts.length === 0) {
    log.info('All heartbeats within expected window', { alertCount: 0 });
    return;
  }

  // Send Telegram alert (throttled — same alert text suppressed for 1 hour)
  const message = alerts.join('\n\n');
  log.warn('Sending watchdog alert', { alertCount: alerts.length });

  // Use a stable dedupe discriminator derived from the alert categories present.
  // Repeated identical alert mix within an hour is suppressed; a new condition
  // (different alert mix) produces a different key and still fires.
  const discriminator = alerts
    .map((a) => a.slice(0, 60).replace(/\s+/g, '_'))
    .sort()
    .join('|');
  const dedupeKey = buildAlertKey(ALERT_CATEGORY.WATCHDOG_DASHBOARD, discriminator);

  const sent = await sendThrottledTelegramAlert(
    {
      text: escapeHtml(message),
      parseMode: 'HTML',
    },
    dedupeKey
  );

  if (sent) {
    log.info('Watchdog alert sent via Telegram');
  } else {
    log.info('Watchdog alert suppressed by throttle (sent within last hour) or send failed');
  }
}

// Only auto-execute when run as a script, not when imported by a test.
// Production cron invokes via watchdog-task.bat → tsx with neither VITEST
// nor NODE_ENV=test set, so this gate is a no-op there.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  runWatchdog()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      log.error('Watchdog error', { error: (err as Error).message });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      // Force a clean exit. As a one-shot monitoring script the watchdog must
      // never linger on a dangling handle; otherwise Task Scheduler kills it at
      // PT10M (Last Result 267014). Exit with the code set above.
      process.exit(process.exitCode ?? 0);
    });
}
