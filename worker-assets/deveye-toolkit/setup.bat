@echo off
REM DeVeye Server Setup Script - VulnAgent v1.0
REM Run this on a Windows machine with Chrome

echo === DeVeye Server Setup ===
echo.

REM Check Chrome
set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

if "%CHROME%"=="" (
    echo [!] Chrome not found. Please install Google Chrome first.
    echo     https://www.google.com/chrome/
    pause
    exit /b 1
)
echo [OK] Chrome found: %CHROME%

REM Verify CLI
set "SCRIPT_DIR=%~dp0"
set "CLI_BIN=%SCRIPT_DIR%deveye.exe"

if not exist "%CLI_BIN%" (
    echo [!] deveye.exe not found in %SCRIPT_DIR%
    pause
    exit /b 1
)

"%CLI_BIN%" --version

echo.
echo === Setup Complete ===
echo.
echo Start the server with:
echo.
echo   deveye.exe server start --host 0.0.0.0 --port 9888 --token YOUR_TOKEN --extension-path "%SCRIPT_DIR%extension-dist" --daemon
echo.
echo Then in VulnAgent Settings - POC/EXP:
echo   Server URL: ws://THIS_MACHINE_IP:9888
echo   Token: YOUR_TOKEN
echo.
pause
