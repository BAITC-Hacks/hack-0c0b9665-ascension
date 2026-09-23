@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node scripts/start-local.js %*
if errorlevel 1 (
  echo.
  echo See docs/organizer-hosting.md for help.
  pause
  exit /b 1
)
