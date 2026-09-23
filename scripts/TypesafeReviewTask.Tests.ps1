#!/usr/bin/env pwsh
#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }

BeforeAll {
    . (Join-Path $PSScriptRoot 'register-typesafe-review.ps1')
    . (Join-Path $PSScriptRoot 'audit-typesafe-review-task.ps1')
    $script:Root = Split-Path $PSScriptRoot -Parent
}

Describe 'Isolated Typesafe scheduled task' -Tag 'Unit' {
    BeforeEach {
        Mock Get-ScheduledTask { $null }
        Mock Register-ScheduledTask {
            [pscustomobject]@{ Actions = @($Action); Triggers = @($Trigger); Settings = $Settings; Principal = $Principal; State = 'Ready' }
        }
        Mock Get-ScheduledTaskInfo { [pscustomobject]@{ LastRunTime = [datetime]::MinValue; LastTaskResult = 267011; NextRunTime = (Get-Date).AddMinutes(15) } }
    }
    It 'registers only the pilot with matching unattended limits' {
        $script:Task = Register-TypesafeReviewTask -RepoRoot $Root
        Should -Invoke Register-ScheduledTask -Times 1 -Exactly -ParameterFilter {
            $TaskName -eq 'HybridTurtle-TypesafeReview' -and $TaskPath -eq '\'
        }
        Mock Get-ScheduledTask { $script:Task }
        (Test-TypesafeReviewTask -RepoRoot $Root).Passed | Should -BeTrue
    }
    It 'does not replace existing tasks or register in WhatIf mode' {
        Register-TypesafeReviewTask -RepoRoot $Root -WhatIf
        Should -Invoke Register-ScheduledTask -Times 0 -Exactly
        Mock Get-ScheduledTask { [pscustomobject]@{ State = 'Ready' } }
        { Register-TypesafeReviewTask -RepoRoot $Root } | Should -Throw '*already exists*'
        Should -Invoke Register-ScheduledTask -Times 0 -Exactly
    }
    It 'detects disabled, wrong schedule, principal and settings without repairing' {
        $script:Task = Register-TypesafeReviewTask -RepoRoot $Root
        $Task.State = 'Disabled'
        $Task.Triggers[0].Repetition.Interval = 'PT30M'
        $Task.Principal.LogonType = 'Interactive'
        $Task.Settings.ExecutionTimeLimit = 'PT10M'
        Mock Get-ScheduledTask { $script:Task }
        $Result = Test-TypesafeReviewTask -RepoRoot $Root
        $Result.Passed | Should -BeFalse
        $Result.Issues | Should -Contain 'TASK_DISABLED'
        $Result.Issues | Should -Contain 'SCHEDULE_MISMATCH'
        $Result.Issues | Should -Contain 'PRINCIPAL_MISMATCH'
        $Result.Issues | Should -Contain 'SETTINGS_MISMATCH'
    }
    It 'accepts the bare local account name Task Scheduler reports for the current user' {
        $script:Task = Register-TypesafeReviewTask -RepoRoot $Root
        $Task.Principal.UserId = $env:USERNAME
        Mock Get-ScheduledTask { $script:Task }
        (Test-TypesafeReviewTask -RepoRoot $Root).Passed | Should -BeTrue
    }
    It 'flags a principal belonging to a different account' {
        $script:Task = Register-TypesafeReviewTask -RepoRoot $Root
        $Task.Principal.UserId = 'NT AUTHORITY\SYSTEM'
        Mock Get-ScheduledTask { $script:Task }
        (Test-TypesafeReviewTask -RepoRoot $Root).Issues | Should -Contain 'PRINCIPAL_MISMATCH'
    }
    It 'preserves child exit status and quotes a Node path with spaces' {
        $Node = Join-Path $TestDrive 'fake node.cmd'
        Set-Content -LiteralPath $Node -Value '@exit /b 23'
        Copy-Item (Join-Path $Root 'typesafe-review-task.bat') $TestDrive
        $Process = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c `"`"$TestDrive\typesafe-review-task.bat`" `"$Node`"`"" -Wait -PassThru -NoNewWindow
        $Process.ExitCode | Should -Be 23
    }
}