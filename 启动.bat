@echo off
cd /d "%~dp0"
title Nijika Diary
echo.
echo   Server starting... Open http://localhost:3000
echo   Press Ctrl+C to stop
echo.
node server.js
pause
