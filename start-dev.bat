@echo off
rem ==== IC Tarkov MSVC 环境配置 ====
rem 仅用于配置 Rust/Cargo 所需的 MSVC 链接器环境，
rem 配置完成后保持命令行打开，手动运行：
rem   npm run tauri:dev     启动开发模式
rem   npm run tauri:build   构建桌面应用

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

where cargo >nul 2>nul || (
  echo [IC Tarkov] WARNING: 未找到 cargo，请先安装 Rust 并加入 PATH。
)

echo [IC Tarkov] MSVC 环境已配置，可直接运行 npm run tauri:dev / tauri:build
cmd /k
