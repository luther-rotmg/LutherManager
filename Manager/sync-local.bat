@echo off
REM Local override — sets correct WSL user + project path before syncing.
set "WSL_DISTRO=Debian"
set "WSL_USER=doolB"
set "WSL_PARENT=home\doolB\hive"
call "%~dp0sync-and-build.bat"
