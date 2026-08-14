@echo off
setlocal
title Agent Harness Setup
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-agent-harness.ps1" %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo Install failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
echo Setup finished. Use Launch-AgentHarness.cmd next time.
pause
endlocal
