@echo off
setlocal
cd /d "%~dp0"
title Xbox Play - Ponte de controle
echo ==========================================
echo  Xbox Play - ponte de controle (PC host)
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale o Node 22+ em https://nodejs.org
  goto :fim
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Python nao encontrado. Instale o Python 3 em https://www.python.org
  echo        e marque a opcao "Add python.exe to PATH" na instalacao.
  goto :fim
)

python -c "import vgamepad" >nul 2>nul
if errorlevel 1 (
  echo Primeira execucao: instalando a dependencia Python vgamepad...
  echo.
  python -m pip install -r tools\gamepad-bridge\requirements.txt
  if errorlevel 1 (
    echo.
    echo [ERRO] Nao foi possivel instalar as dependencias.
    goto :fim
  )
  echo.
)

node --env-file-if-exists=.env tools\gamepad-bridge\bridge.js %*

:fim
echo.
echo A ponte parou. Pressione qualquer tecla para fechar.
pause >nul
