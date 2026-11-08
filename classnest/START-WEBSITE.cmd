@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://localhost:3000 in your browser after the server starts.
echo Keep this window open while using the website. Press Ctrl+C to stop it.
node server.js
pause
