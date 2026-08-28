@echo off
setlocal

rem ==== EFT Spy release build script ====

rem -- MSVC env for cargo linker --
if exist "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" (
    call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
)

rem -- proxy for crates.io / npm --
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897

rem -- ensure cargo is reachable --
where cargo >nul 2>nul || set "PATH=C:\Users\lsscf\.cargo\bin;%PATH%"

cd /d "%~dp0"

echo [EFT Spy] building release bundle ...
call npm run tauri build %*
set EXITCODE=%ERRORLEVEL%

if "%EXITCODE%"=="0" (
    echo.
    echo [EFT Spy] build OK. Outputs:
    echo   app exe : src-tauri\target\release\EFT Spy.exe
    echo   nsis    : src-tauri\target\release\bundle\nsis\
    echo   msi     : src-tauri\target\release\bundle\msi\
) else (
    echo [EFT Spy] build FAILED with exit code %EXITCODE%
)

exit /b %EXITCODE%
