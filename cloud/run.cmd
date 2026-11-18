@echo off
rem Start OpenFuture Cloud on http://127.0.0.1:8090 (admin UI at /admin.html).
setlocal
set "JAVA_HOME=F:\PROGRAM_files\ideaIU-2023.3.2.win\jbr"
if not exist "%~dp0target\openfuture-cloud.jar" (
  echo target\openfuture-cloud.jar not found. Run: build.cmd -DskipTests package
  exit /b 1
)
"%JAVA_HOME%\bin\java" -jar "%~dp0target\openfuture-cloud.jar"
