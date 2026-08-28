@echo off

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d F:\CODE\eft-spy
echo [EFT Spy] Starting dev mode...
call npm run tauri dev
pause
