@echo off
setlocal
chcp 65001 >nul
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing. Prepare the project dependencies first.
  pause
  exit /b 1
)
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0scripts\start-local-preview.cjs" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
endlocal
