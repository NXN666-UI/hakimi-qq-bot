@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-settings.ps1" -Section memory
if errorlevel 1 pause
