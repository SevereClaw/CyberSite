@echo off
chcp 65001 >nul
title SevereClaw presence bot
cd /d "%~dp0"
where node >nul 2>nul || (echo Нужен Node.js: https://nodejs.org & pause & exit /b 1)
if not exist config.json (
  copy config.example.json config.json >nul
  echo Создал config.json. Заполни его и запусти start.bat ещё раз.
  notepad config.json
  exit /b 0
)
if not exist node_modules (
  echo Ставлю зависимости...
  call npm install --omit=dev || (pause & exit /b 1)
)
:loop
node index.js
echo Бот остановился, перезапуск через 10 секунд. Закрой окно, чтобы выключить.
timeout /t 10 >nul
goto loop
