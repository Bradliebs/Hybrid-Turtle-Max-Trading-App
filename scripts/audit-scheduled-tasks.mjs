/**
 * DEPENDENCIES
 * Consumed by: manual operations, scheduler readiness checks
 * Consumes: Windows schtasks output
 * Risk-sensitive: YES — read-only audit of load-bearing automation.
 * Notes: Does not create, update, disable, or delete scheduled tasks.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

export const EXPECTED_TASKS = [
  { name: 'HybridTurtle Nightly', requiredPath: 'nightly-task.bat', registerScript: 'register-nightly-task.ps1', expectedTimeLimit: 'PT45M' },
  { name: 'HybridTurtle Watchdog', requiredPath: 'watchdog-task.bat', registerScript: 'register-watchdog-task.bat', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle Midday Sync', requiredPath: 'midday-sync-task.bat', registerScript: 'register-midday-sync.ps1', expectedTimeLimit: 'PT15M' },
  { name: 'HybridTurtle-Scan', requiredPath: 'auto-trade-task.bat', requiredArgument: 'scan', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-Trade-UK', requiredPath: 'auto-trade-task.bat', requiredArgument: 'uk', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-Trade-UKM', requiredPath: 'auto-trade-task.bat', requiredArgument: 'uk-mid', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-Trade-US', requiredPath: 'auto-trade-task.bat', requiredArgument: 'us', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-Trade-USM', requiredPath: 'auto-trade-task.bat', requiredArgument: 'us-mid', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-Trade-USC', requiredPath: 'auto-trade-task.bat', requiredArgument: 'us-close', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT30M' },
  { name: 'HybridTurtle-HourlyStatus', requiredPath: 'hourly-status-task.bat', registerScript: 'register-auto-trade.bat', expectedTimeLimit: 'PT5M' },
  { name: 'HybridTurtle-MondayBriefing', requiredPath: 'monday-briefing-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle-UKBriefing', requiredPath: 'uk-briefing-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle-USBriefing', requiredPath: 'us-briefing-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle-WeeklyDigest', requiredPath: 'weekly-digest-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle-TickerAudit', requiredPath: 'ticker-audit-task.bat', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT10M' },
  { name: 'HybridTurtle-ResearchRefresh', requiredPath: 'research-refresh-task.bat', requiredArgument: '--scheduled', registerScript: 'scripts/register-weekly-tasks.ps1', expectedTimeLimit: 'PT20M' },
  { name: 'HybridTurtle-TelegramHeartbeat', requiredPath: 'telegram-heartbeat-task.bat', registerScript: 'scripts/register-telegram-heartbeat.ps1', expectedTimeLimit: 'PT5M' },
];

// Known optional tasks: recognised (not "untracked") but never required. Each has its own dedicated audit.
export const OPTIONAL_TASKS = [
  { name: 'HybridTurtle-TypesafeReview', audit: 'scripts/audit-typesafe-review-task.ps1' },
];

export const RETIRED_TASKS = [
  {
    name: 'HybridTurtle-RescueStops',
    reason: 'One-shot 2026-04-30 incident rescue task. The rescued positions are stopped and the artifacts are archived under docs/incidents/2026-04-30-auto-trade-rescue/.',
  },
  {
    name: 'HybridTurtle Intraday Alert',
    reason: 'Legacy task target is absent from this repo; nightly near-stop checks and hourly status cover current monitoring paths.',
  },
];

export function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

export function parseSchtasksCsv(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
  });
}

function normalizeTaskName(name) {
  return name.replace(/^\\+/, '');
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function extractQuotedPaths(command) {
  // schtasks CSV does not escape inner quotes, so `""a.bat" "b.exe""` parses as one
  // quoted span holding both paths. Split spans at whitespace before a drive letter.
  const quoted = [...String(command ?? '').matchAll(/"([A-Za-z]:\\[^"<>|?*]+)"/g)]
    .flatMap((match) => match[1].split(/\s+(?=[A-Za-z]:\\)/));
  const unquoted = [...String(command ?? '').matchAll(/\b([A-Za-z]:\\[^\s"<>|?*]+\.(?:bat|cmd|ps1|mjs|js|ts))\b/gi)].map((match) => match[1]);
  return [...new Set([...quoted, ...unquoted])];
}

export function auditScheduledTasks(tasks, options = {}) {
  const repoRoot = options.repoRoot ?? ROOT;
  const expectedTasks = options.expectedTasks ?? EXPECTED_TASKS;
  const retiredTasks = options.retiredTasks ?? RETIRED_TASKS;
  const optionalNames = new Set((options.optionalTasks ?? OPTIONAL_TASKS).map((task) => task.name.toLowerCase()));
  const expectedByName = new Map(expectedTasks.map((task) => [task.name.toLowerCase(), task]));
  const retiredByName = new Map(retiredTasks.map((task) => [task.name.toLowerCase(), task]));
  const seenExpected = new Set();
  const findings = [];

  for (const task of tasks) {
    const taskName = normalizeTaskName(task.TaskName ?? task['TaskName'] ?? '');
    if (!taskName.toLowerCase().startsWith('hybridturtle')) continue;

    const expected = expectedByName.get(taskName.toLowerCase());
    const retired = retiredByName.get(taskName.toLowerCase());
    const taskToRun = task['Task To Run'] ?? '';
    const startIn = task['Start In'] ?? '';
    const state = task['Scheduled Task State'] ?? task.Status ?? '';
    const lastResult = task['Last Result'] ?? '';
    const disabled = /disabled/i.test(state);

    if (expected) {
      seenExpected.add(expected.name.toLowerCase());

      const requiredPath = path.join(repoRoot, expected.requiredPath);
      if (!normalizeText(taskToRun).includes(normalizeText(requiredPath))) {
        findings.push({ severity: 'ERROR', taskName, reason: 'EXPECTED_PATH_MISMATCH', detail: `Expected action to include ${requiredPath}` });
      }

      if (expected.requiredArgument && !normalizeText(taskToRun).includes(normalizeText(expected.requiredArgument))) {
        findings.push({ severity: 'ERROR', taskName, reason: 'EXPECTED_ARGUMENT_MISSING', detail: `Expected action argument ${expected.requiredArgument}` });
      }

      if (startIn && startIn !== 'N/A' && normalizeText(startIn) !== normalizeText(repoRoot)) {
        findings.push({ severity: 'WARNING', taskName, reason: 'START_IN_MISMATCH', detail: `Start In is ${startIn}` });
      }
    }

    if (disabled) {
      findings.push({ severity: 'WARNING', taskName, reason: retired ? 'RETIRED_TASK_DISABLED' : 'TASK_DISABLED', detail: retired?.reason ?? 'Task is disabled' });
    } else if (retired) {
      findings.push({ severity: 'ERROR', taskName, reason: 'RETIRED_TASK_ENABLED', detail: retired.reason });
    }

    if (retired) {
      continue;
    }

    if (lastResult && !['0', '267009', '267011'].includes(lastResult)) {
      // 267014 (0x41306 SCHED_S_TASK_TERMINATED) and 267015 (0x41307) almost
      // always mean Windows Task Scheduler killed the .bat at its
      // ExecutionTimeLimit. For load-bearing trading tasks this means the
      // session ran but never placed any trades — promote to ERROR so it
      // can't be ignored. For other tasks keep it as WARNING.
      if (lastResult === '267014' || lastResult === '267015') {
        const tradeCritical = expected && /^HybridTurtle(-Trade-|-Scan$|\sNightly$)/.test(taskName);
        findings.push({
          severity: tradeCritical ? 'ERROR' : 'WARNING',
          taskName,
          reason: 'SCHEDULER_TERMINATED_LAST_RUN',
          detail: `Last Result is ${lastResult} (SCHED_S_TASK_TERMINATED). Windows Task Scheduler killed the task at its ExecutionTimeLimit before it finished. Re-run npm run tasks:apply-limits (admin) to push the updated PT30M/PT45M limits to live tasks.`,
        });
      } else {
        findings.push({ severity: 'WARNING', taskName, reason: 'NON_ZERO_LAST_RESULT', detail: `Last Result is ${lastResult}` });
      }
    }

    // Vista-compat tasks (created by `schtasks /SC MONTHLY`) cannot accept
    // Set-ScheduledTask updates for StartWhenAvailable + battery settings, so
    // their Power Management string still shows the unwanted defaults. Surface
    // this as a WARNING so a future tasks:register-all run is prompted.
    const powerManagement = normalizeText(task['Power Management'] ?? '');
    if (expected && powerManagement.includes('stop on battery mode')) {
      findings.push({ severity: 'WARNING', taskName, reason: 'BATTERY_RESILIENCE_DRIFT', detail: `Power Management is "${task['Power Management']}". Re-run npm run tasks:register-all from an admin shell to apply Win7 compat + StartWhenAvailable.` });
    }

    const referencedPaths = extractQuotedPaths(taskToRun);
    for (const referencedPath of referencedPaths) {
      if (!existsSync(referencedPath)) {
        findings.push({ severity: disabled ? 'WARNING' : 'ERROR', taskName, reason: 'MISSING_TARGET_PATH', detail: referencedPath });
      }
    }

    if (!expected && !retired && !optionalNames.has(taskName.toLowerCase())) {
      findings.push({ severity: 'WARNING', taskName, reason: 'UNTRACKED_HYBRIDTURTLE_TASK', detail: 'Task is not in the expected scheduler manifest' });
    }
  }

  for (const expected of expectedTasks) {
    if (!seenExpected.has(expected.name.toLowerCase())) {
      findings.push({ severity: 'ERROR', taskName: expected.name, reason: 'EXPECTED_TASK_MISSING', detail: 'Task was not registered' });
    }
  }

  return findings;
}

export function runSchedulerAudit(options = {}) {
  if (process.platform !== 'win32' && !options.schtasksOutput) {
    return [{ severity: 'WARNING', taskName: '*', reason: 'UNSUPPORTED_PLATFORM', detail: 'Scheduler audit requires Windows schtasks output' }];
  }

  const output = options.schtasksOutput ?? execFileSync('schtasks', ['/Query', '/FO', 'CSV', '/V'], { encoding: 'utf8' });
  return auditScheduledTasks(parseSchtasksCsv(output), options);
}

/**
 * Compare the live ExecutionTimeLimit on each registered task against the
 * expected value declared in EXPECTED_TASKS. Catches the common drift class
 * where the registration scripts are updated (e.g. PT10M → PT20M) but
 * `tasks:apply-limits` was never run, so the live tasks still carry the old
 * value. Returns ERROR for trade-critical drift, WARNING otherwise.
 *
 * Live values are read via `schtasks /Query /TN <task> /XML`; in tests pass
 * `xmlByName` to avoid spawning processes.
 */
export function auditTimeLimits(options = {}) {
  const expectedTasks = options.expectedTasks ?? EXPECTED_TASKS;
  const xmlByName = options.xmlByName;
  // When the caller supplies xmlByName (tests), treat it as authoritative and
  // do not spawn schtasks. Without it, fall back to live schtasks queries on
  // Windows, and skip entirely off-Windows.
  const useLive = xmlByName === undefined;
  if (useLive && process.platform !== 'win32') {
    return [];
  }
  const tradeCriticalRegex = /^HybridTurtle(-Trade-|-Scan$|\sNightly$|\sMidday\sSync$)/;
  const findings = [];

  for (const expected of expectedTasks) {
    if (!expected.expectedTimeLimit) continue;
    let xml;
    if (useLive) {
      try {
        xml = execFileSync('schtasks', ['/Query', '/TN', expected.name, '/XML'], { encoding: 'utf8' });
      } catch {
        // Task missing — auditScheduledTasks already raises EXPECTED_TASK_MISSING.
        continue;
      }
    } else {
      xml = xmlByName.get(expected.name);
    }
    if (!xml) continue;
    const match = /<ExecutionTimeLimit>([^<]+)<\/ExecutionTimeLimit>/.exec(xml);
    const liveLimit = match ? match[1] : null;
    if (liveLimit && liveLimit !== expected.expectedTimeLimit) {
      const tradeCritical = tradeCriticalRegex.test(expected.name);
      findings.push({
        severity: tradeCritical ? 'ERROR' : 'WARNING',
        taskName: expected.name,
        reason: 'EXECUTION_TIME_LIMIT_DRIFT',
        detail: `Live ExecutionTimeLimit is ${liveLimit}, expected ${expected.expectedTimeLimit}. Run npm run tasks:apply-limits (admin) to align.`,
      });
    }
  }

  return findings;
}

export const WATCHDOG_TIMES = ['10:05', '13:05', '16:05', '19:05', '22:05'];

export function auditAutomationRuntime(options = {}) {
  if (options.states === undefined && process.platform !== 'win32') return [];
  const findings = [];
  let states;
  try {
    const raw = options.states ?? JSON.parse(execFileSync('pwsh', [
      '-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'Get-AutomationTaskState.ps1'),
    ], { encoding: 'utf8', timeout: 20_000 }));
    states = z.array(z.object({
      name: z.string(), logonType: z.string(), wakeToRun: z.boolean(), startWhenAvailable: z.boolean(),
      triggers: z.array(z.object({
        type: z.string(), enabled: z.boolean(), startBoundary: z.string(), endBoundary: z.string(),
        daysInterval: z.string(), interval: z.string(), duration: z.string(), randomDelay: z.string(),
      })),
    })).parse(raw);
  } catch {
    return [{ severity: 'ERROR', taskName: 'scheduler', reason: 'RUNTIME_INSPECTION_FAILED',
      detail: 'Could not read task triggers and unattended settings. Check PowerShell 7 and scheduler access.' }];
  }
  for (const expected of options.expectedTasks ?? EXPECTED_TASKS) {
    const state = states.find((candidate) => candidate.name === expected.name);
    if (!state) {
      findings.push({ severity: 'ERROR', taskName: expected.name, reason: 'RUNTIME_TASK_MISSING', detail: 'Task absent from runtime inspection.' });
      continue;
    }
    if (!['S4U', 'Password', 'ServiceAccount'].includes(state.logonType) || !state.wakeToRun || !state.startWhenAvailable) {
      findings.push({ severity: 'WARNING', taskName: state.name, reason: 'UNATTENDED_SETTINGS_DRIFT',
        detail: `Logon=${state.logonType}, WakeToRun=${state.wakeToRun}, StartWhenAvailable=${state.startWhenAvailable}. Preview scripts/Repair-AutomationTasks.ps1; apply from an administrator PowerShell.` });
    }
    if (state.name === 'HybridTurtle Watchdog') {
      const nowMs = options.nowMs ?? Date.now();
      const daily = state.triggers.filter((trigger) => trigger.enabled && trigger.type === 'CalendarTrigger'
        && trigger.daysInterval === '1' && !trigger.endBoundary && ['', 'PT0S'].includes(trigger.randomDelay)
        && Number.isFinite(Date.parse(trigger.startBoundary)) && Date.parse(trigger.startBoundary) <= nowMs);
      const explicitTimes = new Set(daily.filter((trigger) => !trigger.interval)
        .map((trigger) => trigger.startBoundary.slice(11, 16)));
      const repeated = daily.some((trigger) => trigger.startBoundary.slice(11, 16) === '10:05'
        && trigger.interval === 'PT3H' && trigger.duration === 'PT12H');
      if (!repeated && !WATCHDOG_TIMES.every((time) => explicitTimes.has(time))) {
        findings.push({ severity: 'ERROR', taskName: state.name, reason: 'WATCHDOG_SCHEDULE_DRIFT',
          detail: 'Expected daily checks at 10:05, 13:05, 16:05, 19:05 and 22:05. Run scripts/Repair-AutomationTasks.ps1 -Apply from an administrator PowerShell.' });
      }
    }
  }
  return findings;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function auditRegisterScripts(options = {}) {
  const repoRoot = options.repoRoot ?? ROOT;
  const expectedTasks = options.expectedTasks ?? EXPECTED_TASKS;
  const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, 'utf8'));
  const exists = options.existsSync ?? existsSync;
  const findings = [];

  for (const task of expectedTasks) {
    if (!task.registerScript) {
      findings.push({ severity: 'WARNING', taskName: task.name, reason: 'MANIFEST_MISSING_REGISTER_SCRIPT', detail: 'No registerScript field on manifest entry' });
      continue;
    }

    const scriptPath = path.join(repoRoot, task.registerScript);
    if (!exists(scriptPath)) {
      findings.push({ severity: 'ERROR', taskName: task.name, reason: 'REGISTER_SCRIPT_MISSING', detail: `Register script not found: ${task.registerScript}` });
      continue;
    }

    let contents = '';
    try {
      contents = readFile(scriptPath);
    } catch (err) {
      findings.push({ severity: 'ERROR', taskName: task.name, reason: 'REGISTER_SCRIPT_UNREADABLE', detail: err.message });
      continue;
    }

    const namePattern = new RegExp(`["']${escapeRegex(task.name)}["']`);
    if (!namePattern.test(contents)) {
      findings.push({ severity: 'ERROR', taskName: task.name, reason: 'REGISTER_SCRIPT_TASK_NAME_NOT_FOUND', detail: `Task name not present in ${task.registerScript}` });
      continue;
    }

    const targetBat = task.requiredPath;
    // Match the basename so registerScripts that reference the target via
    // forward-slash, backslash, or no path separator all satisfy the check.
    const targetBasename = path.basename(targetBat);
    const batPattern = new RegExp(escapeRegex(targetBasename), 'i');
    if (!batPattern.test(contents)) {
      findings.push({ severity: 'WARNING', taskName: task.name, reason: 'REGISTER_SCRIPT_TARGET_NOT_REFERENCED', detail: `Target ${targetBat} not referenced in ${task.registerScript}` });
    }
  }

  return findings;
}

export function auditDatabaseBackup(options = {}) {
  const repoRoot = options.repoRoot ?? ROOT;
  const backupDir = options.backupDir ?? path.join(repoRoot, 'prisma', 'backups');
  const maxAgeHours = options.maxAgeHours ?? 48;
  const nowMs = options.nowMs ?? Date.now();
  const exists = options.existsSync ?? existsSync;
  const readDir = options.readdirSync ?? readdirSync;
  const stat = options.statSync ?? statSync;

  if (!exists(backupDir)) {
    return [{ severity: 'WARNING', taskName: 'db-backup', reason: 'BACKUP_DIR_MISSING', detail: backupDir }];
  }

  const candidates = readDir(backupDir)
    .filter((fileName) => /^dev\.db\.backup-\d{4}-\d{2}-\d{2}-\d{4}$/.test(fileName));

  if (candidates.length === 0) {
    return [{ severity: 'ERROR', taskName: 'db-backup', reason: 'NO_NIGHTLY_BACKUP', detail: 'No dev.db.backup-* files found; nightly backup may not be running.' }];
  }

  let newestMtime = 0;
  let newestName = '';
  for (const fileName of candidates) {
    const stats = stat(path.join(backupDir, fileName));
    if (stats.mtimeMs > newestMtime) {
      newestMtime = stats.mtimeMs;
      newestName = fileName;
    }
  }

  const ageHours = (nowMs - newestMtime) / (1000 * 60 * 60);
  if (ageHours > maxAgeHours) {
    return [{ severity: 'ERROR', taskName: 'db-backup', reason: 'BACKUP_STALE', detail: `Newest backup ${newestName} is ${ageHours.toFixed(1)}h old (>${maxAgeHours}h). Pre-execution gate will HARD_BLOCK trading.` }];
  }

  return [];
}

function logFindings(findings) {
  if (findings.length === 0) {
    if (!QUIET) console.log('[scheduler-audit] OK: all expected HybridTurtle scheduled tasks are registered with valid targets.');
    return;
  }

  for (const finding of findings) {
    console.log(`[scheduler-audit] ${finding.severity}: ${finding.taskName} ${finding.reason} - ${finding.detail}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const findings = [
    ...runSchedulerAudit(),
    ...auditTimeLimits(),
    ...auditAutomationRuntime(),
    ...auditRegisterScripts(),
    ...auditDatabaseBackup(),
  ];
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings));
  else logFindings(findings);
  process.exit(findings.some((finding) => finding.severity === 'ERROR') ? 1 : 0);
}