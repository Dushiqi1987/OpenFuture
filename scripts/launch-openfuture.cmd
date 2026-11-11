@echo off
setlocal
cd /d "D:\OpenFuture"
set "ELECTRON_RUN_AS_NODE="
set "PWD="
set "OPENFUTURE_USER_DATA="
set > ".scratch\launcher-env.txt"
"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "node_modules\electron-vite\bin\electron-vite.js" build > ".scratch\launcher-build.log" 2>&1
if errorlevel 1 (
  echo OpenFuture build failed. See .scratch\launcher-build.log
  pause
  exit /b 1
)
start "" "D:\OpenFuture\node_modules\electron\dist\electron.exe" "D:\OpenFuture" --remote-debugging-port=9257
exit /b 0
