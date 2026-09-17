@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден.
  echo Установите LTS-версию с https://nodejs.org/en/download
  echo Выберите установщик для Windows, затем запустите START.cmd ещё раз.
  echo Подробная инструкция находится в файле ЗАПУСК.md.
  echo.
  pause
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo Нужен Node.js 22.12 или новее.
  echo Установите LTS-версию с https://nodejs.org/en/download и повторите запуск.
  echo.
  pause
  exit /b 1
)
node serve.mjs --open %*
set "gameExit=%errorlevel%"
if not "%gameExit%"=="0" (
  echo.
  echo Игра не запустилась. Прочитайте сообщение выше и файл ЗАПУСК.md.
  pause
)
exit /b %gameExit%
