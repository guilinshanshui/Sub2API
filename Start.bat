@echo off
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%apps\web\dist\index.html" (
    set "SUB2API_WEB_DIST=%ROOT%apps\web\dist"
) else (
    set "SUB2API_WEB_DIST=%ROOT%web\dist"
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 22+ from https://nodejs.org and try again.
    pause
    exit /b 1
)

if not exist "%ROOT%node_modules" (
    echo First run detected. Installing dependencies...
    call corepack pnpm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
)

if not exist "%ROOT%apps\gateway\dist\index.js" (
    echo Building project...
    call corepack pnpm build
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to build.
        pause
        exit /b 1
    )
)

echo Opening admin panel in 3 seconds...
start /min cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:8787"

echo Sub2API gateway starting...
echo Admin panel: http://127.0.0.1:8787
echo Close this window to stop the gateway.
echo.
node "%ROOT%apps\gateway\dist\index.js"
