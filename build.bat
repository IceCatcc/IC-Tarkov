@echo off
setlocal enabledelayedexpansion

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

rem -- read version from tauri.conf.json (single source of truth) --
set "APPVER="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw 'src-tauri\tauri.conf.json' | ConvertFrom-Json).version"`) do set "APPVER=%%v"
if "!APPVER!"=="" set "APPVER=unknown"

echo [EFT Spy] building release bundle (v!APPVER!) ...
call npm run tauri build %*
set EXITCODE=%ERRORLEVEL%

if "!EXITCODE!"=="0" (
    rem -- copy exe with version in filename --
    set "SRC_EXE=src-tauri\target\release\EFT Spy.exe"
    set "DST_EXE=src-tauri\target\release\EFT-Spy-!APPVER!.exe"
    if exist "!SRC_EXE!" (
        copy /y "!SRC_EXE!" "!DST_EXE!" >nul
        echo.
        echo [EFT Spy] build OK. Outputs:
        echo   app exe : !SRC_EXE!
        echo   named   : !DST_EXE!
        echo   nsis    : src-tauri\target\release\bundle\nsis\
        echo   msi     : src-tauri\target\release\bundle\msi\
    ) else (
        echo [EFT Spy] build OK but exe not found: !SRC_EXE!
    )
) else (
    echo [EFT Spy] build FAILED with exit code !EXITCODE!
)

exit /b !EXITCODE!
