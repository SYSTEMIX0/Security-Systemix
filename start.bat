@echo off
chcp 65001 >nul
if not exist .env (copy .env.example .env && echo عبّي ملف .env ثم شغّل الملف مرة ثانية && notepad .env && exit /b)
if not exist node_modules (call npm install)
node src/index.js
pause
