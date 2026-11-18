@echo off
rem Build with IDEA bundled Maven 3.9.5 + JDK 17 (system Maven 3.6.1 is too old).
setlocal
set "JAVA_HOME=F:\PROGRAM_files\ideaIU-2023.3.2.win\jbr"
set "MVN=F:\PROGRAM_files\ideaIU-2023.3.2.win\plugins\maven\lib\maven3\bin\mvn.cmd"
call "%MVN%" -s "%~dp0maven-settings.xml" %*
