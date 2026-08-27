@echo off
setlocal
title Agent Harness
cd /d "%~dp0.."

if not exist "node_modules\.bin\agent-harness.cmd" (
  echo Agent Harness is not installed. Run npm install and npm run build first.
  pause
  exit /b 1
)

call npx.cmd --no-install agent-harness serve --open
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo Launch failed with exit code %ERR%.
  pause
)
exit /b %ERR%
