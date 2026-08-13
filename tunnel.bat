@echo off
chcp 65001 >nul
cd /d "%~dp0"
title open-tunnel
echo.
echo   open-tunnel // starting...
echo.
if "%1"=="" (node index.js --open) else (node index.js --port %1 --open)
pause
