@echo off
setlocal

rem -- MSVC env for cargo linker (搜索常见安装位置) --
for %%D in (
  "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
  "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
) do (
  if exist %%D (
    call %%D >nul
    goto have_vs
  )
)
:have_vs

cd /d "%~dp0\src-tauri"

where cargo >nul 2>nul || (
  echo [IC Tarkov] ERROR: 未找到 cargo，请先安装 Rust 并加入 PATH。
  exit /b 1
)

cargo build
