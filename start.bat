@echo off
:: ============================================================
:: HybridTurtle Trading Dashboard — Launcher
:: ============================================================
:: Double-click this to start the dashboard.
:: It will open your browser automatically.
:: ============================================================

title HybridTurtle Dashboard
color 0B
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  ===========================================================
echo   HybridTurtle Trading Dashboard v6.0
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

:: Check node_modules
if not exist "node_modules" (
    echo  Dependencies not found — installing now...
    call npm install
    if %errorlevel% neq 0 (
        echo  !! npm install failed.
        pause
        exit /b 1
    )
)

:: Desktop installs need DISABLE_API_AUTH=true and real secrets. A .env copied
:: from .env.example causes "Unauthorised"/"Too many requests", weakly encrypted
:: Trading 212 keys and a locked Telegram panel. The check uses the same loader
:: as the dashboard, so duplicate lines and .env.local/.env.production count.
:: Warn only: LAN setups deliberately keep auth on.
node scripts\check-env.mjs

:: Ensure Prisma client is generated
if not exist "node_modules\.prisma" (
    echo  Generating Prisma client...
    call npx prisma generate
    if %errorlevel% neq 0 (
        echo  !! Prisma generate failed.
        pause
        exit /b 1
    )
)

:: Ensure database exists and schema is up to date
set FIRST_RUN=0
if not exist "prisma\dev.db" set FIRST_RUN=1

if %FIRST_RUN%==1 (
    echo  Setting up database for the first time...
) else (
    echo  Checking database migrations...
)

call node scripts/auto-migrate.mjs
if %errorlevel% neq 0 (
    echo  !! Database migration failed.
    pause
    exit /b 1
)

if %FIRST_RUN%==1 (
    call npx prisma db seed 2>nul
)

:: Pre-flight: verify critical source files exist
if not exist "src\components\shared\Navbar.tsx" (
    echo.
    echo  !! Critical file missing: src\components\shared\Navbar.tsx
    echo  !! The installation appears incomplete.
    echo  !! Please re-extract the HybridTurtle zip and run install.bat again.
    pause
    exit /b 1
)
if not exist "src\app\layout.tsx" (
    echo.
    echo  !! Critical file missing: src\app\layout.tsx
    echo  !! The installation appears incomplete.
    echo  !! Please re-extract the HybridTurtle zip and run install.bat again.
    pause
    exit /b 1
)
if not exist "tsconfig.json" (
    echo.
    echo  !! Critical file missing: tsconfig.json
    echo  !! The installation appears incomplete.
    echo  !! Please re-extract the HybridTurtle zip and run install.bat again.
    pause
    exit /b 1
)

:: Kill any stale HybridTurtle processes on port 3000 (only targets port 3000, not all Node)
echo  Checking for stale processes on port 3000...
netstat -aon 2>nul | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo          Stopping previous dashboard instance...
    for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
)

:: Wait a moment for the port to free up
timeout /t 1 /nobreak >nul

:: Surface scheduler ERRORs visibly so silent failures (Windows Task Scheduler
:: killed an auto-trade run, time-limit drift after a registration script
:: change, etc.) cannot go unnoticed for days. This is read-only and never
:: blocks the dashboard from starting.
echo.
echo  Checking scheduled tasks...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\check-scheduler-on-start.ps1"
echo.

:: Ensure production build exists AND is fresh.
:: - Missing BUILD_ID → first run / corrupted build → must build.
:: - BUILD_ID older than any source file under src/ or prisma/schema.prisma →
::   stale build → must rebuild, otherwise next start serves yesterday's code
::   and source edits silently fail to surface (this is the exact foot-gun that
::   caused the 2026-05-02 "portfolio shows 3 of 6" confusion).
:: Staleness detection lives in scripts/check-build-staleness.ps1 so the logic
:: stays debuggable outside of cmd-escape hell.
set NEED_BUILD=0
if not exist ".next\BUILD_ID" (
    set NEED_BUILD=1
) else (
    for /f %%n in ('powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\check-build-staleness.ps1"') do set NEWER_FILES=%%n
    if not "!NEWER_FILES!"=="0" (
        if not "!NEWER_FILES!"=="" (
            echo  Source changed since last build ^(!NEWER_FILES! file^(s^) newer than .next\BUILD_ID^) — rebuilding...
            set NEED_BUILD=1
        )
    )
)

if !NEED_BUILD!==1 (
    echo  Type-checking before build...
    call npm run typecheck
    if !errorlevel! neq 0 (
        echo  !! Type errors found. Fix the errors above before the dashboard can start.
        pause
        exit /b 1
    )
    echo  Building dashboard ^(this may take a few minutes^)...
    call npx next build
    if !errorlevel! neq 0 (
        echo  !! Build failed. Try running install.bat again.
        pause
        exit /b 1
    )
)

echo  Starting dashboard server...
echo.
echo  ───────────────────────────────────────────────────────────
echo   Dashboard will open at: http://localhost:3000
echo.
echo   Keep this window open while using the dashboard.
echo   Press Ctrl+C or close this window to stop.
echo  ───────────────────────────────────────────────────────────
echo.

:: Open browser once server is ready (polls every 2s, max 60s)
:: Also prints a readiness confirmation so users know the dashboard is up
:: After readiness, runs the backend smoke test (non-blocking) to flag regressions
start /min powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 30; $i++) { Start-Sleep 2; try { $r = Invoke-WebRequest -Uri http://localhost:3000/api/system-status -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { Write-Host '  Dashboard READY at http://localhost:3000'; Start-Process http://localhost:3000/dashboard; Start-Process -FilePath 'cmd' -ArgumentList '/c','npm run smoke ^> smoke.log 2^>^&1' -WindowStyle Hidden -WorkingDirectory '%CD%'; exit } } catch {} }; Write-Host '  WARNING: Server did not respond in 60s. Open http://localhost:3000 manually.'"

:: Start the production server (blocks until user closes)
call npm start

pause
