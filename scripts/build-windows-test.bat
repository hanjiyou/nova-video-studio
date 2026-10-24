@echo off
setlocal
echo Output root: release-multi-reference
echo Build version: automatic; see the selected Installer path below.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows-test.ps1" -OpenOutput %*
set "buildExitCode=%ERRORLEVEL%"
echo.
if "%buildExitCode%"=="0" (
    echo [SUCCESS] Build script completed successfully.
    echo A real build opens its output directory. CheckOnly opens nothing.
) else (
    echo [FAILED] Build script failed. Exit code: %buildExitCode%
    echo See the error and Build log path above.
)
echo.
pause
exit /b %buildExitCode%
