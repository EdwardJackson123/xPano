@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_masks.ps1" -Backend cpu %*
if errorlevel 1 exit /b %errorlevel%
endlocal
