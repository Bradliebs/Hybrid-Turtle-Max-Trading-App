# Register HybridTurtle weekly digest + Monday briefing in Windows Task Scheduler
# Run as Administrator

# When invoked from register-all-tasks.ps1 (which sets $ErrorActionPreference = 'Stop'),
# inherited preferences make schtasks.exe's expected first-run /Delete (exit code 1 —
# "task not found") get promoted to a terminating exception caught by the orchestrator's
# try/catch as "ERROR: The system cannot find the file specified." Force local
# preferences so this script behaves identically standalone vs. orchestrated.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# Resolve repo root from this script's location (this file lives in <root>\scripts\).
# Previously hardcoded to "C:\Turtle-Hybrid\Hybrid-Trurtle-Max" (note the typo) which
# meant schtasks /Create /TR "<missing>\weekly-digest-task.bat" failed with
# "The system cannot find the file specified." on every machine.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Set-TaskResilient($name, $timeLimit = 'PT10M') {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { return }

  # schtasks /Create defaults monthly tasks to Vista compatibility, which
  # rejects Win7+ settings like StartWhenAvailable. Bump compatibility first.
  if ($task.Settings.Compatibility -eq 'Vista' -or $task.Settings.Compatibility -eq 'V1') {
    try {
      $task.Settings.Compatibility = 'Win7'
      Set-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null
      $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    } catch {
      Write-Host "  Could not bump compatibility for ${name}: $_" -ForegroundColor Yellow
    }
  }

  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false
  $task.Settings.IdleSettings.StopOnIdleEnd = $false
  $task.Settings.StartWhenAvailable = $true
  $task.Settings.ExecutionTimeLimit = $timeLimit
  try {
    Set-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "  Could not apply resilience settings to ${name}: $_" -ForegroundColor Yellow
  }
}

# Weekly Digest — Sunday 18:00
schtasks /Delete /TN "HybridTurtle-WeeklyDigest" /F 2>$null
schtasks /Create /TN "HybridTurtle-WeeklyDigest" /SC WEEKLY /D SUN /ST 18:00 /TR "`"$root\weekly-digest-task.bat`"" /RL HIGHEST /F
Set-TaskResilient "HybridTurtle-WeeklyDigest"
Write-Host "Weekly Digest: $LASTEXITCODE"

# Monday Briefing — Monday 07:30
schtasks /Delete /TN "HybridTurtle-MondayBriefing" /F 2>$null
schtasks /Create /TN "HybridTurtle-MondayBriefing" /SC WEEKLY /D MON /ST 07:30 /TR "`"$root\monday-briefing-task.bat`"" /RL HIGHEST /F
Set-TaskResilient "HybridTurtle-MondayBriefing"
Write-Host "Monday Briefing: $LASTEXITCODE"

# UK Pre-Session Briefing — Mon-Fri 08:00
schtasks /Delete /TN "HybridTurtle-UKBriefing" /F 2>$null
schtasks /Create /TN "HybridTurtle-UKBriefing" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:00 /TR "`"$root\uk-briefing-task.bat`"" /RL HIGHEST /F
Set-TaskResilient "HybridTurtle-UKBriefing"
Write-Host "UK Briefing: $LASTEXITCODE"

# US Pre-Session Briefing — Tue-Fri 14:30
schtasks /Delete /TN "HybridTurtle-USBriefing" /F 2>$null
schtasks /Create /TN "HybridTurtle-USBriefing" /SC WEEKLY /D TUE,WED,THU,FRI /ST 14:30 /TR "`"$root\us-briefing-task.bat`"" /RL HIGHEST /F
Set-TaskResilient "HybridTurtle-USBriefing"
Write-Host "US Briefing: $LASTEXITCODE"

# Ticker Audit — 1st of each month at 06:00 (before market open)
# schtasks /SC MONTHLY produces Vista-compat XML which rejects later
# Set-ScheduledTask updates. Round-trip the XML to bump compatibility to V2 (Win7+)
# so Set-TaskResilient can apply battery + StartWhenAvailable settings.
schtasks /Delete /TN "HybridTurtle-TickerAudit" /F 2>$null
schtasks /Create /TN "HybridTurtle-TickerAudit" /SC MONTHLY /D 1 /ST 06:00 /TR "`"$root\ticker-audit-task.bat`" --scheduled" /RL HIGHEST /F | Out-Null
$tickerXml = schtasks /Query /TN "HybridTurtle-TickerAudit" /XML | Out-String
if ($tickerXml -match '<Compatibility>V1</Compatibility>') {
  $tickerXml = $tickerXml -replace '<Compatibility>V1</Compatibility>', '<Compatibility>V2</Compatibility>'
}
$tickerXml = $tickerXml -replace '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
$tickerXml = $tickerXml -replace '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
$tickerXml = $tickerXml -replace '<StopOnIdleEnd>true</StopOnIdleEnd>', '<StopOnIdleEnd>false</StopOnIdleEnd>'
if ($tickerXml -notmatch '<StartWhenAvailable>') {
  $tickerXml = $tickerXml -replace '<Settings>', '<Settings><StartWhenAvailable>true</StartWhenAvailable>'
}
if ($tickerXml -notmatch '<ExecutionTimeLimit>') {
  $tickerXml = $tickerXml -replace '</Settings>', '<ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>'
}
schtasks /Delete /TN "HybridTurtle-TickerAudit" /F | Out-Null
$tickerXmlPath = Join-Path $env:TEMP 'hybridturtle-ticker-audit.xml'
$tickerXml | Out-File -FilePath $tickerXmlPath -Encoding Unicode
schtasks /Create /TN "HybridTurtle-TickerAudit" /XML "`"$tickerXmlPath`"" /F | Out-Null
Remove-Item $tickerXmlPath -ErrorAction SilentlyContinue
Set-TaskResilient "HybridTurtle-TickerAudit"
Write-Host "Ticker Audit: $LASTEXITCODE"

# Research Refresh — daily 23:00 (after nightly + T212 sync, idempotent enrichment)
schtasks /Delete /TN "HybridTurtle-ResearchRefresh" /F 2>$null
schtasks /Create /TN "HybridTurtle-ResearchRefresh" /SC DAILY /ST 23:00 /TR "`"$root\research-refresh-task.bat`" --scheduled" /RL HIGHEST /F
# ResearchRefresh needs 20 minutes: outcome enrichment fetches ~400 tickers a night
# (see ENRICHMENT_BATCH_SIZE in src/cron/research-refresh.ts). Matches the audit manifest.
Set-TaskResilient "HybridTurtle-ResearchRefresh" 'PT20M'
Write-Host "Research Refresh: $LASTEXITCODE"

Write-Host ""
Write-Host "Done. Verify with: schtasks /Query /TN HybridTurtle-WeeklyDigest"
Write-Host "                    schtasks /Query /TN HybridTurtle-MondayBriefing"
Write-Host "                    schtasks /Query /TN HybridTurtle-USBriefing"
Write-Host "                    schtasks /Query /TN HybridTurtle-TickerAudit"
Write-Host "                    schtasks /Query /TN HybridTurtle-ResearchRefresh"
