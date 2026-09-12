@echo off
title GORILAS GYM - Sistema de gestion
cd /d "%~dp0"
echo.
echo   GORILAS GYM - iniciando sistema...
echo.
start "" http://localhost:5173
node server.js
pause
