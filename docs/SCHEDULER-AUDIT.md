---
title: HybridTurtle Scheduler Audit
description: How to run the scheduler audit and repair common Windows Task Scheduler findings
author: HybridTurtle
ms.date: 2026-09-13
ms.topic: troubleshooting
keywords:
  - scheduler
  - task scheduler
  - automation
  - audit
estimated_reading_time: 4
---

## Purpose

HybridTurtle relies on Windows Task Scheduler for live operational jobs such as
nightly processing, watchdog checks, midday broker sync, auto-trade sessions,
briefings, ticker audits, and the daily research-refresh enrichment. The
scheduler audit checks that those tasks still point at this repository, that
each expected task has a register script, that the most recent nightly database
backup is fresher than the 48 h pre-execution gate, and that retired legacy
tasks are not active. Runtime inspection additionally requires PowerShell 7
(`pwsh`) and checks unattended logon, wake/catch-up settings and watchdog timing.

Run the audit after installer changes, machine moves, task repairs, or any
unexpected missed automation window.

```powershell
npm run tasks:audit
```

The smoke command also runs the scheduler audit:

```powershell
npm run smoke
```

Retired-task cleanup can be run from an elevated administrator shell:

```powershell
npm run tasks:cleanup-retired
```

To register every HybridTurtle scheduled task in one go (self-elevates via UAC):

```powershell
npm run tasks:register-all
```

## Finding Severity

Errors include missing or misdirected tasks, failed runtime inspection and
watchdog timing that leaves afternoon checks unreachable. Fix errors before
trusting scheduled automation.

Warnings require investigation; they do not prove unattended operation works.
Common warning examples include disabled retired tasks, old non-zero task
results, interactive-only logon and disabled wake settings.

## Unattended Operation Repair

Preview the existing 17 task definitions without making changes:

```powershell
pwsh -NoProfile -File scripts/Repair-AutomationTasks.ps1
```

Then open an administrator PowerShell at the repository root and apply:

```powershell
pwsh -NoProfile -File scripts/Repair-AutomationTasks.ps1 -Apply
npm run tasks:audit
```

The helper never elevates itself or manually starts jobs. It preserves task
owners, actions, trading schedules and execution limits; enables S4U logon,
wake and catch-up; and sets the watchdog to daily 10:05, 13:05, 16:05, 19:05
and 22:05. Restoring normal scheduling can allow jobs, including trades, to run.
Apply requires every task to be Ready and rejects changed definitions.

All original XML is saved under a unique, Git-ignored
`prisma/backups/automation-tasks-*` directory before any registration. An apply
failure attempts reverse-order restoration. Read rollback errors carefully;
the backup XML remains available for manual restoration. Successful application
writes a receipt and verifies the resulting definitions, not actual execution.

S4U requires local access to the repository, credentials and database. The helper
rejects mapped/network drives and EFS-encrypted `.env` or database files.
Authenticated network shares and EFS need a separately configured account.
Wake also depends on firmware and Windows power policy; it cannot start a
powered-off machine. Confirm subsequent scheduled runs while signed out and
after sleep, and confirm the next nightly summary arrives in Telegram.

The register-all workflow applies the same repair at its end. After running an
individual legacy registration helper, rerun the preview and audit because that
helper may restore older settings.

For structured consumers, `node scripts/audit-scheduled-tasks.mjs --json` emits
an array of findings. The watchdog treats invalid output or an inspection
failure as unknown task health, not a clean audit. A nightly heartbeat with
`details.telegramSent: false` produces a separate notification warning even
when core processing succeeded. Notification failure marks the delivery step
failed without changing the core trading-health gate.

## Accepted Task Results

The audit accepts these Windows Task Scheduler result codes as healthy or
informational states:

| Code | Meaning | Audit treatment |
|------|---------|-----------------|
| `0` | Last run completed successfully | Accepted |
| `267009` | Task is currently running | Accepted |
| `267011` | Task has not run yet | Accepted |

Other non-zero result codes are warnings unless the task also has a broken
target path or missing expected action.

## Common Repairs

### Retired Intraday Alert Task

`HybridTurtle Intraday Alert` is a retired legacy task. It points at the old
`C:\HybridTurtle-v6.0\intraday-alert-task.bat` path and is replaced by current
nightly near-stop checks plus hourly status monitoring.

If the audit reports it as disabled, automation can still run. Delete it from an
elevated PowerShell or Command Prompt to remove the warning:

```powershell
schtasks /Delete /TN "HybridTurtle Intraday Alert" /F
```

If deletion returns `Access is denied`, open the shell as administrator and run
the command again.

You can also run the retired-task cleanup helper from an elevated shell:

```powershell
npm run tasks:cleanup-retired
```

### Midday Sync Drift

The canonical midday task is `HybridTurtle Midday Sync`. It should run
`midday-sync-task.bat --scheduled` from this repository at 10:00, 13:00, 16:00,
and 19:00 on weekdays.

Repair it from an elevated PowerShell session:

```powershell
.\register-midday-sync.ps1
```

The older `HybridTurtle-MiddaySync` task is not canonical. Delete it if it
appears:

```powershell
schtasks /Delete /TN "HybridTurtle-MiddaySync" /F
```

### Auto-Trade Task Drift

Auto-trade tasks must call `auto-trade-task.bat` with the expected scheduled
session argument:

* `HybridTurtle-Scan`: `scan --scheduled`
* `HybridTurtle-Trade-UK`: `uk --scheduled`
* `HybridTurtle-Trade-UKM`: `uk-mid --scheduled`
* `HybridTurtle-Trade-US`: `us --scheduled`
* `HybridTurtle-Trade-USM`: `us-mid --scheduled`
* `HybridTurtle-Trade-USC`: `us-close --scheduled` *(scheduled task stays registered, but `auto-trade-task.bat` skips `us-close` by default unless `PAUSE_US_CLOSE=0` is set in `.env`)*

Repair them from an elevated shell with:

```powershell
.\register-auto-trade.bat
```

> [!WARNING]
> Do not manually run the `uk`, `us`, or `us-close` auto-trade sessions unless
> you intend to allow the live order path. The scheduled task registration is
> safe; the trading sessions themselves can place orders when enabled.

### Research Refresh Missing

`HybridTurtle-ResearchRefresh` runs `research-refresh-task.bat --scheduled`
daily at 23:00. The job is idempotent and runs after nightly + the final T212
sync to enrich candidate outcomes (5d/10d/20d returns). Repair from an elevated
PowerShell session:

```powershell
.\scripts\register-weekly-tasks.ps1
```

### Stale Database Backup

The audit also checks the newest `dev.db.backup-*` file in `prisma/backups/`
against a 48 h threshold matching the pre-execution `BACKUP` HARD_BLOCK gate.
A `BACKUP_STALE` or `NO_NIGHTLY_BACKUP` finding means the nightly backup step
has not produced a fresh file. Run the nightly process to create one:

```powershell
.\nightly-task.bat
```

### Register Script Drift

Each expected task is mapped to a register script in
`scripts/audit-scheduled-tasks.mjs`. The audit verifies the script still
exists and references both the task name and target `.bat` file. Findings such
as `REGISTER_SCRIPT_MISSING`, `REGISTER_SCRIPT_TASK_NAME_NOT_FOUND`, or
`REGISTER_SCRIPT_TARGET_NOT_REFERENCED` indicate one of the install scripts has
drifted from the manifest.

### Battery Resilience Drift

`schtasks /SC MONTHLY` produces tasks with Vista-era compatibility, which then
reject `Set-ScheduledTask` updates for `StartWhenAvailable` and battery
behaviour. The audit flags `BATTERY_RESILIENCE_DRIFT` when a task's
`Power Management` field still reports `Stop On Battery Mode`. Repair by
re-running the orchestrator from an elevated shell so the XML round-trip in
`scripts/register-weekly-tasks.ps1` bumps the task to Win7 compat:

```powershell
npm run tasks:register-all
```

## Verification

After any repair, run:

```powershell
npm run tasks:audit
npm run smoke
```

The audit is clean when it prints no errors. Retired-task warnings are acceptable
only when the task is disabled and cannot be removed without administrator
permissions.