@echo off
title GORILAS GYM - Sistema + lector de acceso
cd /d "%~dp0"
echo.
echo   GORILAS GYM - iniciando sistema CON el lector de acceso...
echo.
echo   Esta ventana tiene que quedarse abierta mientras el gimnasio
echo   este trabajando: es la que escucha al lector de rostro.
echo.
start "" http://localhost:5173
node puente\puente.js
pause
