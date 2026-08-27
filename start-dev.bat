@echo off

set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cd /d F:\CODE\eft-spy
echo [EFT Spy] 正在启动开发模式...
call npm run tauri dev
pause
