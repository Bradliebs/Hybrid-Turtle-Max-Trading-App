#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
Read-only audit of the optional Typesafe task.
.DESCRIPTION
Checks only this pilot's schedule, action, principal and execution limits.
.PARAMETER RepoRoot
The installed repository directory.
.EXAMPLE
./scripts/audit-typesafe-review-task.ps1
.NOTES
Never repairs or registers tasks. Missing or mismatched configuration exits nonzero.
#>
[CmdletBinding()]
param([string]$RepoRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'

function Test-TypesafeReviewTask {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RepoRoot)
    $Root = (Resolve-Path -LiteralPath $RepoRoot).Path
    $Task = Get-ScheduledTask -TaskName 'HybridTurtle-TypesafeReview' -TaskPath '\'
    $Info = Get-ScheduledTaskInfo -TaskName 'HybridTurtle-TypesafeReview' -TaskPath '\'
    $Node = (Get-Command node.exe -CommandType Application).Source
    $Batch = Join-Path $Root 'typesafe-review-task.bat'
    $ExpectedArguments = "/d /s /c `"`"$Batch`" `"$Node`"`""
    $Issues = @()
    if ($Task.State -eq 'Disabled') { $Issues += 'TASK_DISABLED' }
    if (@($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -ne "$env:SystemRoot\System32\cmd.exe" -or
        $Task.Actions[0].Arguments -ne $ExpectedArguments -or $Task.Actions[0].WorkingDirectory -ne $Root) { $Issues += 'ACTION_MISMATCH' }
    if (@($Task.Triggers).Count -ne 1 -or $Task.Triggers[0].Repetition.Interval -ne 'PT15M' -or
        $Task.Triggers[0].Repetition.Duration -or -not $Task.Triggers[0].Enabled) { $Issues += 'SCHEDULE_MISMATCH' }
    if ($Task.Settings.MultipleInstances -ne 'IgnoreNew' -or $Task.Settings.ExecutionTimeLimit -ne 'PT5M' -or
        -not $Task.Settings.StartWhenAvailable -or $Task.Settings.DisallowStartIfOnBatteries -or
        $Task.Settings.StopIfGoingOnBatteries) { $Issues += 'SETTINGS_MISMATCH' }
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    # Task Scheduler reports local accounts as a bare name ('bradl'), so compare SIDs.
    $TaskSid = $null
    try {
        $TaskSid = ([Security.Principal.NTAccount]$Task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { $TaskSid = $null }
    if ($Task.Principal.LogonType -ne 'S4U' -or $Task.Principal.RunLevel -ne 'Limited' -or
        ($Task.Principal.UserId -notin @($Identity.Name, $Identity.User.Value) -and $TaskSid -ne $Identity.User.Value)) {
        $Issues += 'PRINCIPAL_MISMATCH'
    }
    [pscustomobject]@{
        Passed = $Issues.Count -eq 0
        Issues = $Issues
        LastRunTime = $Info.LastRunTime
        LastTaskResult = $Info.LastTaskResult
        NextRunTime = $Info.NextRunTime
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $Result = Test-TypesafeReviewTask -RepoRoot $RepoRoot
        $Result | ConvertTo-Json -Depth 4
        if (-not $Result.Passed) { exit 1 }
    } catch {
        Write-Error -ErrorAction Continue "Pilot audit failed: $($_.Exception.Message)"
        exit 1
    }
}