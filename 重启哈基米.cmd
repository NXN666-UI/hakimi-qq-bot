@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\control.ps1" -Action Restart
set "HAKIMI_EXIT=%errorlevel%"
echo.
pause
exit /b %HAKIMI_EXIT%
