@echo off
echo ============================================
echo  AutoNotes AI — Starting Frontend Dev Server
echo ============================================

cd /d "%~dp0frontend"

if not exist node_modules (
    echo Installing npm dependencies...
    npm install
)

echo.
echo Starting Vite dev server on http://localhost:5173
echo.
npm run dev
