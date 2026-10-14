@echo off
:: ============================================================
:: HybridTurtle — Auto-Trade Task (Scheduled Entry Point)
:: ============================================================
:: Runs the automated trading pipeline for a specific session.
:: No dashboard needed — runs standalone.
::
:: Sessions:
::   scan     — Evening scan only (no trades)
::   uk       — UK/EU entries (08:20)
::   uk-mid   — UK/EU entries (10:30)
::   us       — US entries (14:45)
::   us-mid   — US entries (17:00)
::   us-close — US near-close entries (20:30)
::
:: Usage:
::   auto-trade-task.bat scan
::   auto-trade-task.bat uk
::   auto-trade-task.bat us
::   auto-trade-task.bat us-close
::
:: Safety: Requires ENABLE_AUTO_TRADING=true in .env
:: ============================================================

title HybridTurtle Auto-Trade (%~1)
color 0A
setlocal
cd /d "%~dp0"

set SESSION=%~1
if "%SESSION%"=="" set SESSION=scan

:: Owner decision D4 (2026-10-14): pause the 20:30 UK (us-close) buying session
:: (11 of 12 historical auto-trades at us-close lost money, -0.57R mean, -£27.93).
:: Set PAUSE_US_CLOSE=0 in the environment to re-enable.
if /I "%SESSION%"=="us-close" if not "%PAUSE_US_CLOSE%"=="0" (
    echo [%date% %time%] Skipping us-close session ^(paused per D4^) >> auto-trade.log
    echo  [%date% %time%] Skipping us-close session ^(paused per D4^).
    exit /b 0
)

echo.
echo  ===========================================================
echo   HybridTurtle — Auto-Trade [%SESSION%]
echo  ===========================================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  !! Node.js not found. Please run install.bat first.
    pause
    exit /b 1
)

:: Check .env
if not exist ".env" (
    echo  !! No .env file found. Please run install.bat first.
    pause
    exit /b 1
)

echo  [%date% %time%] Starting auto-trade session: %SESSION%
echo.

:: Apply any pending database migrations before running
call node scripts/auto-migrate.mjs --quiet 2>nul

:: Log start timestamp
echo [%date% %time%] Starting auto-trade session: %SESSION% >> auto-trade.log

:: Run auto-trade — show output in console AND append to log while preserving npx's exit code
powershell -NoProfile -Command "& { & npx.cmd tsx src/cron/auto-trade.ts --session=%SESSION% 2>&1 | Tee-Object -FilePath 'auto-trade.log' -Append; exit $LASTEXITCODE }"

set EXIT_CODE=%ERRORLEVEL%

echo.
echo  [%date% %time%] Auto-trade finished (exit code: %EXIT_CODE%)
echo [%date% %time%] Auto-trade finished (exit code: %EXIT_CODE%) >> auto-trade.log

:: If run interactively (not from Task Scheduler), pause
if "%~2" neq "--scheduled" pause
exit /b %EXIT_CODE%
