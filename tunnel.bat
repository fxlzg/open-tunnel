@echo off
title open-tunnel
cd /d %~dp0
if "%1"=="" (node index.js --open) else (node index.js --port %1 --open)
