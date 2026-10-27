@echo off
setlocal
chcp 65001 >nul
title AI Media Flow
pushd "%~dp0"
if errorlevel 1 goto directory_error

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 22 or newer.
  pause
  popd
  exit /b 1
)

if exist "package-lock.json" if not exist "node_modules\cos-nodejs-sdk-v5\package.json" (
  echo Installing required dependencies...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo Dependency installation failed. Please check npm and network access.
    pause
    popd
    exit /b 1
  )
)

echo Starting AI Media Flow...
echo The browser will open when the server is ready.
echo Keep this window open. Press Ctrl+C to stop the server.
echo.
if exist ".env" (
  node --env-file=.env server.js --open
) else (
  node server.js --open
)
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed or the server exited. See the error above.
  pause
)
popd
exit /b %EXIT_CODE%

:directory_error
echo Cannot access the application directory.
pause
exit /b 1
