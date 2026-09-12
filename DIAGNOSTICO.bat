@echo off
title GORILAS GYM - Diagnostico del lector
cd /d "%~dp0"
echo.
echo   DIAGNOSTICO - GORILAS GYM
echo   =========================
echo.
echo   Voy a revisar esta computadora, Smart PSS Lite y la red
echo   para ver como conectar el lector de acceso.
echo.
echo   Esto NO saca datos personales de nadie: solo nombres de
echo   tablas, cuantos registros hay y direcciones de red.
echo.
echo   Tarda como un minuto. Espera a que termine.
echo.
node puente\diagnostico.js
echo.
echo   =========================================================
echo   Listo. Se genero el archivo:  diagnostico-gorilas.txt
echo   Esta aqui mismo, en esta carpeta. Mandalo y con eso
echo   se termina de conectar el sistema.
echo   =========================================================
echo.
pause
