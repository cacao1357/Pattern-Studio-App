@echo off
setlocal
cd /d "%~dp0"
if not exist "python\python.exe" (
    echo Download and extract the Windows portable ZIP from GitHub Releases.
    echo For a source checkout, follow README.md.
    pause
    exit /b 1
)
"python\python.exe" -I -B "scripts\serve_api.py" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
