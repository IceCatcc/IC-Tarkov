@echo off

cd /d "%~dp0"

where cargo >nul 2>nul || set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
echo [IC Tarkov] Starting dev mode...
call npm run tauri dev
pause
