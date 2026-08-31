@echo off
setlocal enabledelayedexpansion

rem ==== IC Tarkov release build script (release-only) ====
rem 分发统一走本脚本：tauri build 恒为 release 构建（strip+LTO，见 Cargo.toml），
rem 且禁止透传 --debug，避免误把 debug 构建分发出去（debug 符号会被杀软误报）。

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

rem -- clean previous frontend build (vite emptyOutDir disabled to avoid safe-delete bulk confirm) --
if exist dist rmdir /s /q dist

rem -- parse args: reject --debug (distribution must be release) --
set "ARGS="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--debug" (
    echo [IC Tarkov] ERROR: --debug 不允许用于分发构建，本脚本仅出 release。
    exit /b 1
)
set "ARGS=!ARGS! %~1"
shift
goto parse
:parsed

rem -- read version from tauri.conf.json (single source of truth) --
set "APPVER="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw 'src-tauri\tauri.conf.json' | ConvertFrom-Json).version"`) do set "APPVER=%%v"
if "!APPVER!"=="" set "APPVER=unknown"

echo [IC Tarkov] building release bundle (v!APPVER!) ...
call npm run tauri build !ARGS!
set EXITCODE=%ERRORLEVEL%

if "!EXITCODE!"=="0" (
    rem -- copy exe with version in filename --
    set "SRC_EXE=src-tauri\target\release\IC Tarkov.exe"
    set "DST_EXE=src-tauri\target\release\IC-Tarkov-!APPVER!.exe"
    if exist "!SRC_EXE!" (
        copy /y "!SRC_EXE!" "!DST_EXE!" >nul
        echo.
        echo [IC Tarkov] release build OK. Outputs:
        echo   app exe : !SRC_EXE!
        echo   named   : !DST_EXE!
        echo   nsis    : src-tauri\target\release\bundle\nsis\
        echo   msi     : src-tauri\target\release\bundle\msi\
    ) else (
        echo [IC Tarkov] build OK but exe not found: !SRC_EXE!
    )
) else (
    echo [IC Tarkov] build FAILED with exit code !EXITCODE!
)

exit /b !EXITCODE!
