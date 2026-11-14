@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "PATH=%PATH%;%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" set "PATH=%PATH%;%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback"
where codex >nul 2>nul
if errorlevel 1 if exist "%LOCALAPPDATA%\OpenAI\Codex\bin" for /f "delims=" %%P in ('dir /b /s "%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe" 2^>nul') do set "CODEX_BINARY=%%P"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js 22 或更新版本。
  echo 官方下载：https://nodejs.org/
  pause
  exit /b 1
)
where codex >nul 2>nul
if errorlevel 1 if not defined CODEX_BINARY (
  echo 需要先安装并登录 Codex CLI，然后重新打开此文件。
  echo 官方说明：https://developers.openai.com/codex/cli/
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo 首次启动，正在安装网页检查工具…
  where npm >nul 2>nul
  if errorlevel 1 (
    where pnpm >nul 2>nul
    if errorlevel 1 (
      echo 没有检测到 npm 或 pnpm，请安装包含 npm 的 Node.js。
      pause
      exit /b 1
    )
    call pnpm install --ignore-scripts
  ) else (
    call npm install --ignore-scripts
  )
  if errorlevel 1 (
    echo 安装没有完成，请检查网络后重试。
    pause
    exit /b 1
  )
)
echo 启动后请在浏览器打开：http://127.0.0.1:4317
echo 保留此窗口；关闭它会停止本地服务。
start "" "http://127.0.0.1:4317"
node server/main.mjs
pause
