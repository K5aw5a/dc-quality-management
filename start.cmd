@echo off
rem Double-click to start the Quality Dashboard and open it in your browser.
rem Settings (project name, logo...) go in local.env next to this file.
rem Keep this window open while you use the app; close it to stop the app.
title Quality Dashboard
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again. & pause & exit /b 1)
if not exist local.env if exist local.env.example copy local.env.example local.env >nul
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:3000"
node --disable-warning=ExperimentalWarning src\server.js
echo.
echo The app has stopped.
pause
