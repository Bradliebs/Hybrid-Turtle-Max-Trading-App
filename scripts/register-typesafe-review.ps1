#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
Registers only the optional Typesafe advisory worker.
.DESCRIPTION
Creates an unattended task without starting it or altering other tasks.
.PARAMETER RepoRoot
The installed repository directory, on a local disk accessible to this user.
.EXAMPLE
./scripts/register-typesafe-review.ps1 -WhatIf
.NOTES
Requires ScheduledTasks and a local Node installation. Does not self-elevate.
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$RepoRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'

function Register-TypesafeReviewTask {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RepoRoot)
    $Root = (Resolve-Path -LiteralPath $RepoRoot).Path
    $Batch = Join-Path $Root 'typesafe-review-task.bat'
    if (-not (Test-Path -LiteralPath $Batch)) { throw 'Typesafe batch launcher is missing.' }
    $Node = (Get-Command node.exe -CommandType Application).Source
    $TaskName = 'HybridTurtle-TypesafeReview'
    if (Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue) {
        throw 'Pilot task already exists. Audit it; do not replace it implicitly.'
    }
    $Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" `
        -Argument "/d /s /c `"`"$Batch`" `"$Node`"`"" -WorkingDirectory $Root
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 15)
    $Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType S4U -RunLevel Limited
    if ($PSCmdlet.ShouldProcess($TaskName, 'Register optional advisory task')) {
        Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $Action -Trigger $Trigger `
            -Settings $Settings -Principal $Principal -Description 'Optional Typesafe evidence review; weekday eligibility and quota enforced by worker.'
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Register-TypesafeReviewTask -RepoRoot $RepoRoot -WhatIf:$WhatIfPreference
    } catch {
        Write-Error -ErrorAction Continue "Pilot registration failed: $($_.Exception.Message)"
        exit 1
    }
}