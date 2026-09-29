@echo off
:: ============================================================
:: HybridTurtle — Register Auto-Trade Scheduled Tasks
:: ============================================================
:: Creates Windows Scheduled Tasks for automated trading:
::
::   1. Evening Scan   — 20:00 Mon-Fri (scan only, no trades)
::   2. UK Entries      — 08:15 Mon-Fri
::   3. US Entries      — 14:45 Mon-Fri
::   4. US Close        — 20:30 Mon-Fri
::
:: Requires Administrator privileges (self-elevates).
:: ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c \"%~f0\"'"
    exit /b
)

setlocal
cd /d "%~dp0"

:: --yes (or -y / /Y) skips the interactive Y/N prompt and final pause so the
:: orchestrator (npm run tasks:register-all) can run this non-interactively.
set "AUTO_YES="
if /i "%~1"=="--yes" set "AUTO_YES=1"
if /i "%~1"=="-y" set "AUTO_YES=1"
if /i "%~1"=="/Y" set "AUTO_YES=1"

echo.
echo  ==========================================================
echo   HybridTurtle — Register Auto-Trade Tasks
echo  ==========================================================
echo.
echo   This will create 7 Windows Scheduled Tasks:
echo.
echo     1. HybridTurtle-Scan         20:00 Mon-Fri  (evening scan)
echo     2. HybridTurtle-Trade-UK     08:20 Mon-Fri  (UK/EU open)
echo     3. HybridTurtle-Trade-UKM    10:30 Mon-Fri  (UK/EU mid-morning)
echo     4. HybridTurtle-Trade-US     14:45 Mon-Fri  (US open)
echo     5. HybridTurtle-Trade-USM    17:00 Mon-Fri  (US midday)
echo     6. HybridTurtle-Trade-USC    20:30 Mon-Fri  (US near-close)
echo     7. HybridTurtle-HourlyStatus hourly Mon-Fri (Telegram updates)
echo.
echo   Requirements:
echo     - Auto-trading switched on in Settings ^> Safety Controls
echo       ^(or ENABLE_AUTO_TRADING=true in .env on first run^)
echo     - Trading 212 account connected in Settings
echo     - PC must be on at scheduled times
echo.
if defined AUTO_YES (
    echo   --yes flag set — proceeding without prompt.
) else (
    set /p CONFIRM="  Create these scheduled tasks? (Y/N): "
    if /i not "%CONFIRM%"=="Y" (
        echo  Cancelled.
        pause
        exit /b 0
    )
)

set "SCRIPT_DIR=%~dp0"
set "BAT=%SCRIPT_DIR%auto-trade-task.bat"

echo.

:: ── Evening Scan (20:00) ──
echo  [1/4] Registering evening scan (20:00)...
schtasks /Delete /TN "HybridTurtle-Scan" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Scan" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 20:00 /TR "\"%BAT%\" scan --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Scan at 20:00
) else (
    echo         FAILED — could not create scan task
)

:: ── UK Entries (08:20 — 5 min after open to avoid Yahoo rate limits at 08:15) ──
echo  [2/7] Registering UK entries (08:20)...
schtasks /Delete /TN "HybridTurtle-Trade-UK" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Trade-UK" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:20 /TR "\"%BAT%\" uk --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Trade-UK at 08:20
) else (
    echo         FAILED — could not create UK trade task
)

:: ── UK Mid-Morning (10:30) ──
echo  [3/7] Registering UK mid-morning (10:30)...
schtasks /Delete /TN "HybridTurtle-Trade-UKM" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Trade-UKM" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 10:30 /TR "\"%BAT%\" uk-mid --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Trade-UKM at 10:30
) else (
    echo         FAILED — could not create UK mid-morning task
)

:: ── US Entries (14:45) ──
echo  [4/7] Registering US entries (14:45)...
schtasks /Delete /TN "HybridTurtle-Trade-US" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Trade-US" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 14:45 /TR "\"%BAT%\" us --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Trade-US at 14:45
) else (
    echo         FAILED — could not create US trade task
)

:: ── US Midday (17:00) ──
echo  [5/7] Registering US midday (17:00)...
schtasks /Delete /TN "HybridTurtle-Trade-USM" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Trade-USM" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 17:00 /TR "\"%BAT%\" us-mid --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Trade-USM at 17:00
) else (
    echo         FAILED — could not create US midday task
)

:: ── US Near-Close (20:30) ──
echo  [6/7] Registering US near-close (20:30)...
schtasks /Delete /TN "HybridTurtle-Trade-USC" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-Trade-USC" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 20:30 /TR "\"%BAT%\" us-close --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-Trade-USC at 20:30
) else (
    echo         FAILED — could not create US close task
)

:: ── Hourly Status (every hour during market hours) ──
echo  [7/7] Registering hourly Telegram status...
set "HS_BAT=%SCRIPT_DIR%hourly-status-task.bat"
:: Audit 2026-06-16 (MEDIUM-2): /ST 08:02 keeps iterations on the :02 grid so
:: the final hourly tick lands at 21:02, two minutes after the 21:00 nightly
:: start — avoids SQLite WAL contention with nightly's first writes.
schtasks /Delete /TN "HybridTurtle-HourlyStatus" /F >nul 2>&1
schtasks /Create /TN "HybridTurtle-HourlyStatus" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:02 /RI 60 /DU 13:00 /TR "\"%HS_BAT%\" --scheduled" /RL HIGHEST /F >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK — HybridTurtle-HourlyStatus every hour 08:02-21:02
) else (
    echo         FAILED — could not create hourly status task
)

echo.
echo  ==========================================================
echo   Done! View/edit tasks in Windows Task Scheduler.
echo.
echo   To disable: set ENABLE_AUTO_TRADING=false in .env
echo   To pause:   enable kill switch in Settings
echo  ==========================================================
echo.

if not defined AUTO_YES pause
