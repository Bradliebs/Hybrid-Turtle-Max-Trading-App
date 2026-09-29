import { describe, expect, it } from 'vitest';
import { checkSchedulerKills, checkZeroTradesOnBullishDay, checkNightlyHeartbeatStatus, type AuditFinding } from './watchdog-checks';
import { checkSchedulerFindings, checkNightlyNotification, parseSchedulerAuditOutput, BUY_DECISION_PHASES, buyableAGradeWhere } from './watchdog-checks';

describe('zero-trades inputs for ETF-only and Jev', () => {
  it('counts only ETF A-grades when ETF-only mode is on', () => {
    expect(buyableAGradeWhere('s1', false)).toEqual({ scanId: 's1', grade: 'A_GRADE_BUY', shares: { gt: 0 } });
    expect(buyableAGradeWhere('s1', true)).toEqual({ scanId: 's1', grade: 'A_GRADE_BUY', shares: { gt: 0 }, stock: { sleeve: 'ETF' } });
  });
  it('treats a Jev veto as a live buy decision, not a silent session death', () => {
    expect(BUY_DECISION_PHASES).toEqual(expect.arrayContaining(['BUY_PLACED', 'BUY_FAILED', 'JEV_VETO']));
    expect(BUY_DECISION_PHASES).not.toContain('JEV_SKIPPED');
  });
});

describe('structured scheduler evidence', () => {
  it.each(['HybridTurtle Nightly', 'HybridTurtle Midday Sync', 'HybridTurtle-Trade-US'])(
    'preserves the full task name %s', (taskName) => {
      const finding = { severity: 'ERROR', taskName, reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: 'timeout' };
      const parsed = parseSchedulerAuditOutput(JSON.stringify([finding]));
      expect(parsed).toEqual([finding]);
      expect(checkSchedulerFindings(parsed)[0]).toContain(taskName);
    },
  );

  it.each(['', 'not json', '{}', '[{"severity":"OK"}]'])('rejects invalid output %s', (output) => {
    expect(() => parseSchedulerAuditOutput(output)).toThrow();
  });

  it('accepts an explicitly clean result', () => {
    expect(checkSchedulerFindings(parseSchedulerAuditOutput('[]'))).toEqual([]);
  });

  it('surfaces schedule drift as well as kills', () => {
    expect(checkSchedulerFindings([{ severity: 'ERROR', taskName: 'HybridTurtle Watchdog',
      reason: 'WATCHDOG_SCHEDULE_DRIFT', detail: 'missing afternoon checks' }])[0]).toContain('missing afternoon checks');
  });
});

describe('nightly notification evidence', () => {
  it('alerts on failed delivery even when core processing succeeded', () => {
    expect(checkNightlyNotification('{"telegramSent":false,"hadFailure":false}')[0]).toContain('not delivered');
  });

  it.each([null, '{}', '{"telegramSent":true}'])('accepts success or legacy absent evidence %s', (details) => {
    expect(checkNightlyNotification(details)).toEqual([]);
  });

  it.each(['bad json', '{"telegramSent":"false"}'])('reports corrupt evidence %s', (details) => {
    expect(checkNightlyNotification(details)[0]).toContain('cannot be verified');
  });
});

describe('checkSchedulerKills', () => {
  it('returns empty array when no SCHEDULER_TERMINATED findings present', () => {
    const findings: AuditFinding[] = [
      { severity: 'WARNING', taskName: 'HybridTurtle-Foo', reason: 'NON_ZERO_LAST_RESULT', detail: 'Last Result is 1' },
    ];
    expect(checkSchedulerKills(findings)).toEqual([]);
  });

  it('returns one alert listing every killed task', () => {
    const findings: AuditFinding[] = [
      { severity: 'ERROR', taskName: 'HybridTurtle-Trade-UK', reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: 'killed at limit' },
      { severity: 'ERROR', taskName: 'HybridTurtle-Scan', reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: 'killed at limit' },
      { severity: 'WARNING', taskName: 'HybridTurtle-WeeklyDigest', reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: 'killed at limit' },
    ];
    const alerts = checkSchedulerKills(findings);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/HybridTurtle-Trade-UK/);
    expect(alerts[0]).toMatch(/HybridTurtle-Scan/);
    expect(alerts[0]).toMatch(/HybridTurtle-WeeklyDigest/);
    expect(alerts[0]).toMatch(/tasks:apply-limits/);
  });

  it('uses ❌ for ERROR severity and ⚠️ for WARNING severity', () => {
    const findings: AuditFinding[] = [
      { severity: 'ERROR', taskName: 'A', reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: '' },
      { severity: 'WARNING', taskName: 'B', reason: 'SCHEDULER_TERMINATED_LAST_RUN', detail: '' },
    ];
    const alerts = checkSchedulerKills(findings);
    expect(alerts[0]).toMatch(/❌\s+A/);
    expect(alerts[0]).toMatch(/⚠️\s+B/);
  });
});

describe('checkZeroTradesOnBullishDay', () => {
  const baseInput = {
    regime: 'BULLISH',
    aGradeWithShares: 5,
    buyAttemptsToday: 0,
    ukDayOfWeek: 3, // Wednesday
    ukHourOfDay: 17,
  };

  it('fires on a BULLISH UK weekday afternoon with A-grade buys but no executions', () => {
    const alerts = checkZeroTradesOnBullishDay(baseInput);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/BULLISH/);
    expect(alerts[0]).toMatch(/5 valid A-grade/);
    expect(alerts[0]).toMatch(/0 buy attempts/);
  });

  it('does not fire on weekends', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, ukDayOfWeek: 6 })).toEqual([]);
    expect(checkZeroTradesOnBullishDay({ ...baseInput, ukDayOfWeek: 0 })).toEqual([]);
  });

  it('does not fire before the minimum hour', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, ukHourOfDay: 9 })).toEqual([]);
    expect(checkZeroTradesOnBullishDay({ ...baseInput, ukHourOfDay: 15, minHourUk: 16 })).toEqual([]);
  });

  it('does not fire when regime is NEUTRAL or BEARISH', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, regime: 'NEUTRAL' })).toEqual([]);
    expect(checkZeroTradesOnBullishDay({ ...baseInput, regime: 'BEARISH' })).toEqual([]);
    expect(checkZeroTradesOnBullishDay({ ...baseInput, regime: null })).toEqual([]);
  });

  it('does not fire when no A-grade candidates have positive shares', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, aGradeWithShares: 0 })).toEqual([]);
  });

  it('does not fire when at least one buy attempt exists today', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, buyAttemptsToday: 1 })).toEqual([]);
  });

  it('respects custom minHourUk parameter', () => {
    expect(
      checkZeroTradesOnBullishDay({ ...baseInput, ukHourOfDay: 14, minHourUk: 14 })
    ).toHaveLength(1);
  });

  it('handles lowercase regime strings', () => {
    expect(checkZeroTradesOnBullishDay({ ...baseInput, regime: 'bullish' })).toHaveLength(1);
  });
});

describe('checkNightlyHeartbeatStatus', () => {
  it('returns no alert for healthy terminal states', () => {
    expect(checkNightlyHeartbeatStatus('SUCCESS')).toEqual([]);
    expect(checkNightlyHeartbeatStatus('SKIPPED')).toEqual([]);
    expect(checkNightlyHeartbeatStatus('success')).toEqual([]);
  });

  it('returns no alert for empty / missing status (liveness owns that)', () => {
    expect(checkNightlyHeartbeatStatus('')).toEqual([]);
    expect(checkNightlyHeartbeatStatus('   ')).toEqual([]);
    expect(checkNightlyHeartbeatStatus(null)).toEqual([]);
    expect(checkNightlyHeartbeatStatus(undefined)).toEqual([]);
  });

  it('alerts on a PARTIAL run', () => {
    const alerts = checkNightlyHeartbeatStatus('PARTIAL');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/PARTIAL/);
    expect(alerts[0]).toMatch(/not SUCCESS/);
  });

  it('alerts on a FAILED run', () => {
    const alerts = checkNightlyHeartbeatStatus('FAILED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/FAILED/);
  });

  it('alerts with a dedicated message on a stuck RUNNING run', () => {
    const alerts = checkNightlyHeartbeatStatus('RUNNING');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/RUNNING/);
    expect(alerts[0]).toMatch(/never reported a final status/);
  });

  it('alerts on an unknown non-healthy status (fail-loud)', () => {
    const alerts = checkNightlyHeartbeatStatus('WEIRD_STATE');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/WEIRD_STATE/);
  });
});
