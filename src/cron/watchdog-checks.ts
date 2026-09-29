/**
 * DEPENDENCIES
 * Consumed by: src/cron/watchdog.ts, src/cron/watchdog-checks.test.ts
 * Consumes: nothing (pure functions over plain inputs)
 * Risk-sensitive: NO — produces alert text only, no state changes
 * Notes: Pure helpers added 2026-05-09 to detect two failure modes that
 *        previously went silent for days (Tue 5 May → Fri 8 May): Windows
 *        Task Scheduler killing auto-trade tasks at PT10M before any buy,
 *        and BULLISH-regime days with valid A-grade candidates but zero
 *        execution attempts. Both are derived from existing data sources
 *        (the audit script + ExecutionLog/Scan tables) so this module
 *        introduces no new state.
 */

import { z } from 'zod';

export interface AuditFinding {
  severity: string;
  taskName: string;
  reason: string;
  detail: string;
}

export function parseSchedulerAuditOutput(output: string): AuditFinding[] {
  return z.array(z.object({
    severity: z.enum(['ERROR', 'WARNING']),
    taskName: z.string().min(1),
    reason: z.string().min(1),
    detail: z.string(),
  })).parse(JSON.parse(output));
}

export function checkNightlyNotification(details: string | null): string[] {
  if (!details) return [];
  try {
    const parsed = z.object({ telegramSent: z.boolean().optional() }).parse(JSON.parse(details));
    return parsed.telegramSent === false
      ? ['WATCHDOG: The latest nightly Telegram summary was not delivered. Core processing may have succeeded; inspect nightly.log for delivery errors.']
      : [];
  } catch {
    return ['WATCHDOG: Nightly heartbeat details are invalid; notification delivery cannot be verified.'];
  }
}

export function checkSchedulerFindings(findings: readonly AuditFinding[]): string[] {
  return [
    ...checkSchedulerKills(findings),
    ...findings.filter((finding) => finding.reason !== 'SCHEDULER_TERMINATED_LAST_RUN')
      .map((finding) => `WATCHDOG: ${finding.severity}: ${finding.taskName} ${finding.reason} - ${finding.detail}`),
  ];
}

/**
 * Detect tasks Windows Task Scheduler killed at their ExecutionTimeLimit
 * (Last Result = 267014). Returns one alert string per affected task.
 * Empty array means no kills detected.
 */
export function checkSchedulerKills(findings: readonly AuditFinding[]): string[] {
  const kills = findings.filter((f) => f.reason === 'SCHEDULER_TERMINATED_LAST_RUN');
  if (kills.length === 0) return [];

  const lines = ['🚨 WATCHDOG: Scheduler killed scheduled task(s) at their time limit:'];
  for (const kill of kills) {
    const tag = kill.severity === 'ERROR' ? '❌' : '⚠️';
    lines.push(`  ${tag} ${kill.taskName}`);
  }
  lines.push('');
  lines.push('No buys/syncs were placed by the killed runs. Run `npm run tasks:apply-limits` (admin) to push the updated PT30M/PT45M ExecutionTimeLimits.');
  return [lines.join('\n')];
}

/**
 * ExecutionLog phases that prove an auto-trade session reached a buy decision.
 * A Jev veto is a deliberate "no" from a live session, not a silent death.
 */
export const BUY_DECISION_PHASES = ['BUY_PLACED', 'BUY_FAILED', 'JEV_VETO'] as const;

/**
 * Which A-grade rows can actually be bought. In ETF-only mode stock A-grades are
 * skipped by design, so counting them would raise a false "zero trades" alarm.
 */
export function buyableAGradeWhere(scanId: string, etfOnly: boolean) {
  return {
    scanId,
    grade: 'A_GRADE_BUY',
    shares: { gt: 0 },
    ...(etfOnly ? { stock: { sleeve: 'ETF' } } : {}),
  };
}

export interface ZeroTradesInputs {
  /** Latest scan regime (BULLISH | NEUTRAL | BEARISH | undefined). */
  regime: string | null | undefined;
  /** Count of A_GRADE_BUY rows in the latest scan with shares > 0. */
  aGradeWithShares: number;
  /** Count of ExecutionLog rows whose phase indicates a buy attempt today. */
  buyAttemptsToday: number;
  /** UK weekday (1=Mon … 5=Fri), 0=Sun, 6=Sat. */
  ukDayOfWeek: number;
  /** UK hour-of-day (0-23). Check fires only after `minHourUk`. */
  ukHourOfDay: number;
  /** Earliest UK hour at which the check is meaningful. */
  minHourUk?: number;
}

/**
 * On a BULLISH UK weekday, after all 3 auto-trade sessions should have run,
 * if there are valid A-grade candidates but zero buy attempts in the
 * ExecutionLog today, surface a warning. This catches silent auto-trade
 * deaths even when the scheduler reports success — for example, the .bat
 * exited cleanly but the tsx subprocess crashed before any logExecution call.
 */
export function checkZeroTradesOnBullishDay(input: ZeroTradesInputs): string[] {
  const minHour = input.minHourUk ?? 16;
  if (input.ukDayOfWeek < 1 || input.ukDayOfWeek > 5) return [];
  if (input.ukHourOfDay < minHour) return [];
  if (String(input.regime ?? '').toUpperCase() !== 'BULLISH') return [];
  if (input.aGradeWithShares <= 0) return [];
  if (input.buyAttemptsToday > 0) return [];

  return [
    `⚠️ WATCHDOG: Regime is BULLISH and the latest scan has ${input.aGradeWithShares} valid A-grade buy candidate(s), but auto-trade has logged 0 buy attempts today (UK). All three sessions should have run by ${minHour}:00 UK. Inspect auto-trade.log and run \`npm run sanity:scheduler\`.`,
  ];
}

/**
 * Health (not just liveness) check for the most recent nightly heartbeat.
 *
 * The existence/recency check in watchdog.ts confirms the nightly RAN within
 * NIGHTLY_STALE_HOURS, but it does not look at the run's outcome. Nightly
 * writes a status of SUCCESS | PARTIAL | FAILED (and RUNNING at start), so a
 * run that completed PARTIAL/FAILED — or crashed mid-run leaving RUNNING —
 * still produces a recent heartbeat and would otherwise pass silently. This
 * surfaces those degraded outcomes (audit 2026-05-29, R1).
 *
 * Conservative on unknown input: an empty / missing status returns no alert,
 * because liveness is owned by the existence/recency check; this helper only
 * speaks to outcome. SUCCESS and SKIPPED are the healthy terminal states.
 *
 * Pure — unit-testable without prisma/network.
 */
export function checkNightlyHeartbeatStatus(status: string | null | undefined): string[] {
  const s = String(status ?? '').trim().toUpperCase();
  if (s === '' || s === 'SUCCESS' || s === 'SKIPPED') return [];
  if (s === 'RUNNING') {
    return [
      '🚨 WATCHDOG: Most recent nightly heartbeat is still RUNNING — the pipeline started but never reported a final status (crashed or killed mid-run). Stops/prices/signals may not have updated. Check nightly.log.',
    ];
  }
  // PARTIAL, FAILED, or any unknown non-healthy status.
  return [
    `🚨 WATCHDOG: Most recent nightly completed with status ${s} (not SUCCESS). One or more steps failed — stops/prices/signals may be stale. Check nightly.log.`,
  ];
}
