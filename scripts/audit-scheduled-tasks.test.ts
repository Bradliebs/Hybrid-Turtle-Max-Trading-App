import { describe, expect, it, vi } from 'vitest';
import { existsSync as realExistsSync } from 'fs';
import path from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((filePath: string) => !filePath.includes('HybridTurtle-v6.0')),
  };
});

const { auditScheduledTasks, parseCsvLine, parseSchtasksCsv, auditRegisterScripts, auditDatabaseBackup, auditTimeLimits, auditAutomationRuntime, WATCHDOG_TIMES, EXPECTED_TASKS } = await import('./audit-scheduled-tasks.mjs');

describe('runtime automation coverage', () => {
  const expectedTasks = [{ name: 'HybridTurtle Watchdog' }];
  const daily = (time: string) => ({ type: 'CalendarTrigger', enabled: true,
    startBoundary: `2026-01-01T${time}:00`, endBoundary: '', daysInterval: '1', interval: '', duration: '', randomDelay: '' });
  const state = () => ({ name: expectedTasks[0].name, logonType: 'S4U', wakeToRun: true,
    startWhenAvailable: true, triggers: WATCHDOG_TIMES.map(daily) });
  const audit = (states: unknown) => auditAutomationRuntime({ states, expectedTasks, nowMs: Date.parse('2026-09-13T00:00:00Z') });

  it('accepts five daily checks and unattended settings', () => {
    expect(audit([state()])).toEqual([]);
  });

  it('detects the observed morning-only watchdog even if task exits successfully', () => {
    expect(audit([{ ...state(), triggers: [daily('10:05')] }])).toContainEqual(
      expect.objectContaining({ reason: 'WATCHDOG_SCHEDULE_DRIFT', severity: 'ERROR' }));
  });

  it('accepts the existing registration script repetition', () => {
    expect(audit([{ ...state(), triggers: [{ ...daily('10:05'), interval: 'PT3H', duration: 'PT12H' }] }])).toEqual([]);
  });

  it.each([
    { enabled: false }, { daysInterval: '2' }, { endBoundary: '2026-01-02T00:00:00' },
    { startBoundary: '2099-01-01T22:05:00' }, { randomDelay: 'PT2H' },
  ])('rejects incomplete or unavailable coverage %j', (change) => {
    const current = state();
    current.triggers[4] = { ...current.triggers[4], ...change };
    expect(audit([current])).toContainEqual(expect.objectContaining({ reason: 'WATCHDOG_SCHEDULE_DRIFT' }));
  });

  it.each([{ logonType: 'InteractiveToken' }, { wakeToRun: false }, { startWhenAvailable: false }])(
    'reports unattended drift %j', (change) => {
      expect(audit([{ ...state(), ...change }])).toContainEqual(expect.objectContaining({ reason: 'UNATTENDED_SETTINGS_DRIFT' }));
    },
  );

  it('does not treat missing or corrupt runtime evidence as healthy', () => {
    expect(audit([])[0].reason).toBe('RUNTIME_TASK_MISSING');
    expect(audit({})[0].reason).toBe('RUNTIME_INSPECTION_FAILED');
  });
});

describe('audit-scheduled-tasks.mjs', () => {
  it('parses schtasks CSV rows with quoted commands', () => {
    const output = '"TaskName","Task To Run","Start In"\r\n"\\HybridTurtle-Scan","C:\\Repo\\auto-trade-task.bat scan --scheduled","C:\\Repo"\r\n';

    expect(parseSchtasksCsv(output)).toEqual([
      {
        TaskName: '\\HybridTurtle-Scan',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat scan --scheduled',
        'Start In': 'C:\\Repo',
      },
    ]);
  });

  it('handles escaped quotes inside a CSV field', () => {
    expect(parseCsvLine('"cmd.exe /c ""C:\\Repo\\task.bat"" --scheduled","Ready"')).toEqual([
      'cmd.exe /c "C:\\Repo\\task.bat" --scheduled',
      'Ready',
    ]);
  });

  it('splits unescaped schtasks quotes into separate paths and recognises optional tasks', () => {
    // The fs mock treats any path containing 'HybridTurtle-v6.0' as missing.
    const [row] = parseSchtasksCsv('"TaskName","Task To Run","Scheduled Task State","Last Result"\r\n"\\HybridTurtle-TypesafeReview","C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\Repo\\typesafe-review-task.bat" "C:\\HybridTurtle-v6.0\\node js\\node.exe""","Enabled","0"\r\n');
    const findings = auditScheduledTasks([row], { repoRoot: 'C:\\Repo', expectedTasks: [], retiredTasks: [] });
    const missing = findings.filter((finding: { reason: string }) => finding.reason === 'MISSING_TARGET_PATH').map((finding: { detail: string }) => finding.detail);
    expect(missing).toEqual(['C:\\HybridTurtle-v6.0\\node js\\node.exe']);
    expect(findings.some((finding: { reason: string }) => finding.reason === 'UNTRACKED_HYBRIDTURTLE_TASK')).toBe(false);
  });

  it('flags stale missing paths and untracked HybridTurtle tasks', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle Intraday Alert',
        'Task To Run': 'cmd.exe /c "C:\\HybridTurtle-v6.0\\intraday-alert-task.bat" --scheduled',
        'Start In': 'C:\\HybridTurtle-v6.0',
        'Scheduled Task State': 'Enabled',
        'Last Result': '-2147024629',
      },
    ], { repoRoot: 'C:\\Repo', expectedTasks: [], retiredTasks: [] });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'MISSING_TARGET_PATH', severity: 'ERROR' }),
      expect.objectContaining({ reason: 'UNTRACKED_HYBRIDTURTLE_TASK', severity: 'WARNING' }),
      expect.objectContaining({ reason: 'NON_ZERO_LAST_RESULT', severity: 'WARNING' }),
    ]));
  });

  it('reports disabled retired tasks without missing-target noise', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle Intraday Alert',
        'Task To Run': 'cmd.exe /c "C:\\HybridTurtle-v6.0\\intraday-alert-task.bat" --scheduled',
        'Start In': 'C:\\HybridTurtle-v6.0',
        'Scheduled Task State': 'Disabled',
        'Last Result': '-2147024629',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [],
      retiredTasks: [{ name: 'HybridTurtle Intraday Alert', reason: 'retired legacy task' }],
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'RETIRED_TASK_DISABLED', severity: 'WARNING' }),
    ]);
    expect(findings.some((finding) => finding.severity === 'ERROR')).toBe(false);
  });

  it('fails when a retired task is still enabled', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle Intraday Alert',
        'Task To Run': 'cmd.exe /c "C:\\HybridTurtle-v6.0\\intraday-alert-task.bat" --scheduled',
        'Start In': 'C:\\HybridTurtle-v6.0',
        'Scheduled Task State': 'Enabled',
        'Last Result': '0',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [],
      retiredTasks: [{ name: 'HybridTurtle Intraday Alert', reason: 'retired legacy task' }],
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'RETIRED_TASK_ENABLED', severity: 'ERROR' }),
    ]);
  });

  it('passes expected current-repo tasks with valid command arguments', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-Trade-UK',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat uk --scheduled',
        'Start In': 'C:\\Repo',
        'Scheduled Task State': 'Enabled',
        'Last Result': '0',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-Trade-UK', requiredPath: 'auto-trade-task.bat', requiredArgument: 'uk' }],
    });

    expect(findings).toEqual([]);
  });

  it('does not warn on N/A Start In when the action path is absolute and valid', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-Scan',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat scan --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '0',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-Scan', requiredPath: 'auto-trade-task.bat', requiredArgument: 'scan' }],
    });

    expect(findings).toEqual([]);
  });

  it('does not warn when a task is currently running', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-Trade-US',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat us --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Running',
        'Last Result': '267009',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-Trade-US', requiredPath: 'auto-trade-task.bat', requiredArgument: 'us' }],
    });

    expect(findings).toEqual([]);
  });

  it('flags BATTERY_RESILIENCE_DRIFT when Power Management indicates Vista compat', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-TickerAudit',
        'Task To Run': 'C:\\Repo\\ticker-audit-task.bat --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '0',
        'Power Management': 'Stop On Battery Mode, No Start On Batteries',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-TickerAudit', requiredPath: 'ticker-audit-task.bat', requiredArgument: '--scheduled' }],
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'BATTERY_RESILIENCE_DRIFT', severity: 'WARNING', taskName: 'HybridTurtle-TickerAudit' }),
    ]);
  });

  it('does not flag BATTERY_RESILIENCE_DRIFT when Power Management is the Win7 default', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-WeeklyDigest',
        'Task To Run': 'C:\\Repo\\weekly-digest-task.bat',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '0',
        'Power Management': '',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-WeeklyDigest', requiredPath: 'weekly-digest-task.bat' }],
    });

    expect(findings).toEqual([]);
  });

  it('flags SCHEDULER_TERMINATED_LAST_RUN as ERROR for trade-critical tasks (267014)', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-Trade-UK',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat uk --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '267014',
      },
      {
        TaskName: '\\HybridTurtle-Scan',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat scan --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '267014',
      },
      {
        TaskName: '\\HybridTurtle Nightly',
        'Task To Run': 'C:\\Repo\\nightly-task.bat',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '267014',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [
        { name: 'HybridTurtle-Trade-UK', requiredPath: 'auto-trade-task.bat', requiredArgument: 'uk' },
        { name: 'HybridTurtle-Scan', requiredPath: 'auto-trade-task.bat', requiredArgument: 'scan' },
        { name: 'HybridTurtle Nightly', requiredPath: 'nightly-task.bat' },
      ],
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'SCHEDULER_TERMINATED_LAST_RUN', severity: 'ERROR', taskName: 'HybridTurtle-Trade-UK' }),
      expect.objectContaining({ reason: 'SCHEDULER_TERMINATED_LAST_RUN', severity: 'ERROR', taskName: 'HybridTurtle-Scan' }),
      expect.objectContaining({ reason: 'SCHEDULER_TERMINATED_LAST_RUN', severity: 'ERROR', taskName: 'HybridTurtle Nightly' }),
    ]));
    expect(findings.some((f: { reason: string }) => f.reason === 'NON_ZERO_LAST_RESULT')).toBe(false);
  });

  it('flags SCHEDULER_TERMINATED_LAST_RUN as WARNING for non-trading tasks (267014)', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-WeeklyDigest',
        'Task To Run': 'C:\\Repo\\weekly-digest-task.bat',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '267014',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-WeeklyDigest', requiredPath: 'weekly-digest-task.bat' }],
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'SCHEDULER_TERMINATED_LAST_RUN', severity: 'WARNING', taskName: 'HybridTurtle-WeeklyDigest' }),
    ]));
  });

  it('keeps NON_ZERO_LAST_RESULT for other non-zero results', () => {
    const findings = auditScheduledTasks([
      {
        TaskName: '\\HybridTurtle-Trade-US',
        'Task To Run': 'C:\\Repo\\auto-trade-task.bat us --scheduled',
        'Start In': 'N/A',
        'Scheduled Task State': 'Enabled',
        'Last Result': '1',
      },
    ], {
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle-Trade-US', requiredPath: 'auto-trade-task.bat', requiredArgument: 'us' }],
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'NON_ZERO_LAST_RESULT', severity: 'WARNING' }),
    ]));
  });
});

describe('auditRegisterScripts', () => {
  const expectedTasks = [
    { name: 'HybridTurtle Nightly', requiredPath: 'nightly-task.bat', registerScript: 'register-nightly-task.bat' },
    { name: 'HybridTurtle-ResearchRefresh', requiredPath: 'research-refresh-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1' },
  ];

  it('passes when register script exists and references task name + target', () => {
    const findings = auditRegisterScripts({
      repoRoot: 'C:\\Repo',
      expectedTasks,
      existsSync: () => true,
      readFile: (p: string) => p.endsWith('register-nightly-task.bat')
        ? '"HybridTurtle Nightly" /tr "%~dp0nightly-task.bat"'
        : '"HybridTurtle-ResearchRefresh" /TR "$root\\research-refresh-task.bat" --scheduled',
    });

    expect(findings).toEqual([]);
  });

  it('flags missing register scripts as ERROR', () => {
    const findings = auditRegisterScripts({
      repoRoot: 'C:\\Repo',
      expectedTasks,
      existsSync: () => false,
      readFile: () => '',
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'REGISTER_SCRIPT_MISSING', severity: 'ERROR', taskName: 'HybridTurtle Nightly' }),
      expect.objectContaining({ reason: 'REGISTER_SCRIPT_MISSING', severity: 'ERROR', taskName: 'HybridTurtle-ResearchRefresh' }),
    ]));
  });

  it('flags register script that omits the task name', () => {
    const findings = auditRegisterScripts({
      repoRoot: 'C:\\Repo',
      expectedTasks: [expectedTasks[0]],
      existsSync: () => true,
      readFile: () => 'no task name here',
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'REGISTER_SCRIPT_TASK_NAME_NOT_FOUND', severity: 'ERROR' }),
    ]);
  });

  it('warns when target bat is not referenced in register script', () => {
    const findings = auditRegisterScripts({
      repoRoot: 'C:\\Repo',
      expectedTasks: [expectedTasks[0]],
      existsSync: () => true,
      readFile: () => '"HybridTurtle Nightly"',
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'REGISTER_SCRIPT_TARGET_NOT_REFERENCED', severity: 'WARNING' }),
    ]);
  });

  it('warns when manifest entry has no registerScript', () => {
    const findings = auditRegisterScripts({
      repoRoot: 'C:\\Repo',
      expectedTasks: [{ name: 'HybridTurtle Orphan', requiredPath: 'orphan.bat' }],
      existsSync: () => true,
      readFile: () => '',
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'MANIFEST_MISSING_REGISTER_SCRIPT', severity: 'WARNING' }),
    ]);
  });
});

describe('auditDatabaseBackup', () => {
  const nowMs = new Date('2026-04-30T12:00:00Z').getTime();

  it('passes when newest backup is within max age', () => {
    const findings = auditDatabaseBackup({
      backupDir: 'C:\\Repo\\prisma\\backups',
      nowMs,
      maxAgeHours: 48,
      existsSync: () => true,
      readdirSync: () => ['dev.db.backup-2026-04-30-0900', 'dev.db.stable-2026-04-29'],
      statSync: (p: string) => ({
        mtimeMs: p.includes('2026-04-30') ? new Date('2026-04-30T09:00:00Z').getTime() : 0,
      }),
    });

    expect(findings).toEqual([]);
  });

  it('flags ERROR when newest backup is older than max age', () => {
    const findings = auditDatabaseBackup({
      backupDir: 'C:\\Repo\\prisma\\backups',
      nowMs,
      maxAgeHours: 48,
      existsSync: () => true,
      readdirSync: () => ['dev.db.backup-2026-04-27-2200'],
      statSync: () => ({ mtimeMs: new Date('2026-04-27T22:00:00Z').getTime() }),
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'BACKUP_STALE', severity: 'ERROR', taskName: 'db-backup' }),
    ]);
  });

  it('flags ERROR when no managed backups exist', () => {
    const findings = auditDatabaseBackup({
      backupDir: 'C:\\Repo\\prisma\\backups',
      nowMs,
      existsSync: () => true,
      readdirSync: () => ['dev.db.stable-2026-04-29'],
      statSync: () => ({ mtimeMs: 0 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'NO_NIGHTLY_BACKUP', severity: 'ERROR' }),
    ]);
  });

  it('warns when backup dir does not exist', () => {
    const findings = auditDatabaseBackup({
      backupDir: 'C:\\Repo\\prisma\\backups',
      nowMs,
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: 0 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({ reason: 'BACKUP_DIR_MISSING', severity: 'WARNING' }),
    ]);
  });
});

describe('EXPECTED_TASKS manifest integrity', () => {
  // Resolve repo root from this test file location: scripts/audit-scheduled-tasks.test.ts
  const repoRoot = path.resolve(__dirname, '..');

  it.each(EXPECTED_TASKS as Array<{ name: string; requiredPath: string; registerScript?: string }>)(
    '$name has a registerScript file that exists on disk',
    (task) => {
      expect(task.registerScript, `${task.name} is missing registerScript field`).toBeTruthy();
      const scriptPath = path.join(repoRoot, task.registerScript!);
      expect(realExistsSync(scriptPath), `Register script not found: ${task.registerScript}`).toBe(true);
    },
  );

  it.each(EXPECTED_TASKS as Array<{ name: string; requiredPath: string }>)(
    '$name target .bat exists on disk: $requiredPath',
    (task) => {
      const targetPath = path.join(repoRoot, task.requiredPath);
      expect(realExistsSync(targetPath), `Target not found: ${task.requiredPath}`).toBe(true);
    },
  );
});

describe('auditTimeLimits', () => {
  function xmlWith(limit: string): string {
    return `<?xml version="1.0"?>\n<Task><Settings><ExecutionTimeLimit>${limit}</ExecutionTimeLimit></Settings></Task>`;
  }

  it('returns no findings when every task matches its expected time limit', () => {
    const xmlByName = new Map<string, string>([
      ['HybridTurtle-Trade-UK', xmlWith('PT20M')],
      ['HybridTurtle Nightly', xmlWith('PT45M')],
    ]);
    const findings = auditTimeLimits({
      expectedTasks: [
        { name: 'HybridTurtle-Trade-UK', requiredPath: 'auto-trade-task.bat', expectedTimeLimit: 'PT20M' },
        { name: 'HybridTurtle Nightly', requiredPath: 'nightly-task.bat', expectedTimeLimit: 'PT45M' },
      ],
      xmlByName,
    });
    expect(findings).toEqual([]);
  });

  it('flags trade-critical drift as ERROR with the apply-limits remediation', () => {
    const xmlByName = new Map<string, string>([
      ['HybridTurtle-Trade-UK', xmlWith('PT10M')],
      ['HybridTurtle-Scan', xmlWith('PT10M')],
      ['HybridTurtle Nightly', xmlWith('PT10M')],
      ['HybridTurtle Midday Sync', xmlWith('PT10M')],
    ]);
    const findings = auditTimeLimits({
      expectedTasks: [
        { name: 'HybridTurtle-Trade-UK', requiredPath: 'auto-trade-task.bat', expectedTimeLimit: 'PT20M' },
        { name: 'HybridTurtle-Scan', requiredPath: 'auto-trade-task.bat', expectedTimeLimit: 'PT20M' },
        { name: 'HybridTurtle Nightly', requiredPath: 'nightly-task.bat', expectedTimeLimit: 'PT45M' },
        { name: 'HybridTurtle Midday Sync', requiredPath: 'midday-sync-task.bat', expectedTimeLimit: 'PT15M' },
      ],
      xmlByName,
    });
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.severity).toBe('ERROR');
      expect(f.reason).toBe('EXECUTION_TIME_LIMIT_DRIFT');
      expect(f.detail).toMatch(/tasks:apply-limits/);
    }
  });

  it('flags non-trading drift as WARNING', () => {
    const xmlByName = new Map<string, string>([
      ['HybridTurtle-WeeklyDigest', xmlWith('PT5M')],
    ]);
    const findings = auditTimeLimits({
      expectedTasks: [
        { name: 'HybridTurtle-WeeklyDigest', requiredPath: 'weekly-digest-task.bat', expectedTimeLimit: 'PT10M' },
      ],
      xmlByName,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('WARNING');
  });

  it('skips tasks without expectedTimeLimit field', () => {
    const xmlByName = new Map<string, string>([
      ['HybridTurtle-Foo', xmlWith('PT10M')],
    ]);
    const findings = auditTimeLimits({
      expectedTasks: [{ name: 'HybridTurtle-Foo', requiredPath: 'foo.bat' }],
      xmlByName,
    });
    expect(findings).toEqual([]);
  });

  it('skips tasks whose XML is missing (would be flagged by auditScheduledTasks)', () => {
    const findings = auditTimeLimits({
      expectedTasks: [{ name: 'HybridTurtle-Bar', requiredPath: 'bar.bat', expectedTimeLimit: 'PT20M' }],
      xmlByName: new Map(),
    });
    expect(findings).toEqual([]);
  });
});
