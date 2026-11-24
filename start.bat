@echo off
setlocal
cd /d "%~dp0"
title Xbox Play
echo Iniciando Xbox Play...
echo.
node --env-file-if-exists=.env src/server.js
echo.
echo O servidor parou. Pressione qualquer tecla para fechar.
pause >nul
