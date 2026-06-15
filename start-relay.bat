@echo off
cd /d "%~dp0"
title Lower Thirds Engine
echo(
echo   ============================================
echo      LOWER THIRDS ENGINE
echo   ============================================
echo(
echo   Starting the local server...
echo   Your browser will open automatically at:
echo        http://localhost:7777
echo(
echo   ^>^>  KEEP THIS WINDOW OPEN while you use the app.
echo   ^>^>  Close it (or press Ctrl+C) to stop everything.
echo(
REM Open the default browser after a 2s head-start, in parallel (no extra window):
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:7777'" 2>nul
REM If PowerShell is unavailable, fall back to a direct open (may need one refresh):
if errorlevel 1 start "" http://localhost:7777
REM Run the server in the foreground (this keeps the window alive):
node relay.js
echo(
echo   Server stopped. You can close this window.
pause
