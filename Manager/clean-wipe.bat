@echo off
setlocal

REM clean-wipe.bat — full reset of Hive injection state.
REM
REM Use when the game has started rejecting connections (errorId=15, infinite
REM loading, "oops" screen) or when switching between prod and dev DLL builds.
REM
REM Does NOT delete the game itself or any character data — only our injected
REM files, cached pipe-target files, and proxy/DLL trace logs.

echo [clean-wipe] Closing Hive / RotMG / UnityCrashHandler...
taskkill /F /IM "Hive 1.0.0.exe" >nul 2>&1
taskkill /F /IM "RotMG Exalt.exe"        >nul 2>&1
taskkill /F /IM "UnityCrashHandler64.exe" >nul 2>&1

REM Short pause so file handles actually release.
timeout /t 1 /nobreak >nul

set "GAMEDIR=%LOCALAPPDATA%\RealmOfTheMadGod\Production"

echo [clean-wipe] Removing injected DLLs from %GAMEDIR%...
if exist "%GAMEDIR%\winhttp.dll"       del /F /Q "%GAMEDIR%\winhttp.dll"
if exist "%GAMEDIR%\version.dll"       del /F /Q "%GAMEDIR%\version.dll"
if exist "%GAMEDIR%\version.pdb"       del /F /Q "%GAMEDIR%\version.pdb"
if exist "%GAMEDIR%\winhttp.dll.bak"   del /F /Q "%GAMEDIR%\winhttp.dll.bak"
if exist "%GAMEDIR%\version.dll.bak"   del /F /Q "%GAMEDIR%\version.dll.bak"

echo [clean-wipe] Clearing proxy logs / target files...
if exist "%TEMP%\rotmg_proxy_target.txt"      del /F /Q "%TEMP%\rotmg_proxy_target.txt"
if exist "%TEMP%\realm-engine-proxy.log"      del /F /Q "%TEMP%\realm-engine-proxy.log"
if exist "%LOCALAPPDATA%\RotMG Exalt DLL Trace.log" del /F /Q "%LOCALAPPDATA%\RotMG Exalt DLL Trace.log"

echo [clean-wipe] Verifying...
set "LEFTOVER="
if exist "%GAMEDIR%\winhttp.dll"  set "LEFTOVER=%LEFTOVER% winhttp.dll"
if exist "%GAMEDIR%\version.dll"  set "LEFTOVER=%LEFTOVER% version.dll"
if exist "%GAMEDIR%\version.pdb"  set "LEFTOVER=%LEFTOVER% version.pdb"

if defined LEFTOVER (
    echo [clean-wipe] WARNING: these files could not be deleted (still held open?):%LEFTOVER%
    echo [clean-wipe] Close everything, reboot if needed, and run again.
    pause
    exit /b 1
)

echo.
echo [clean-wipe] Done. Game folder is clean.
echo [clean-wipe] Next step: launch RotMG normally to verify it works, then re-launch
echo             Hive portable — it'll redeploy both DLLs on startup.
echo.
pause
endlocal
