@echo off
setlocal
cd /d "%~dp0" || exit /b 1
set "TYPESAFE_NODE=%~1"
if not defined TYPESAFE_NODE set "TYPESAFE_NODE=node"
"%TYPESAFE_NODE%" --import tsx src\cron\typesafe-review.ts >> "%~dp0typesafe-review.log" 2>&1
set "WORKER_EXIT=%ERRORLEVEL%"
exit /b %WORKER_EXIT%