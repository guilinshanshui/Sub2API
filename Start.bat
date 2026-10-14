@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%~dp0"
set "PORT=8787"
if not "%SUB2API_PORT%"=="" set "PORT=%SUB2API_PORT%"
set "BASE_URL=http://127.0.0.1:%PORT%"

rem Web bundle: a packaged build ships web\dist, a source checkout uses apps\web\dist.
if exist "%ROOT%web\dist\index.html" (
    set "SUB2API_WEB_DIST=%ROOT%web\dist"
) else if exist "%ROOT%apps\web\dist\index.html" (
    set "SUB2API_WEB_DIST=%ROOT%apps\web\dist"
) else (
    set "SUB2API_WEB_DIST=%ROOT%web\dist"
)

rem Gateway entry: a packaged build ships dist\index.js, a source checkout uses apps\gateway\dist\index.js.
set "GATEWAY_ENTRY=%ROOT%dist\index.js"
if not exist "%GATEWAY_ENTRY%" set "GATEWAY_ENTRY=%ROOT%apps\gateway\dist\index.js"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 22.19+ or 24+ from https://nodejs.org and try again.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj===22&&min>=19)||maj>=24?0:1)"
if errorlevel 1 (
    echo [ERROR] Node.js %NODE_VERSION% is not supported.
    echo Please install Node.js 22.19+ or 24+ from https://nodejs.org and try again.
    pause
    exit /b 1
)

if not exist "%ROOT%node_modules\fastify\package.json" (
    if exist "%ROOT%pnpm-workspace.yaml" (
        echo First run detected. Installing dependencies...
        call corepack pnpm install
        if errorlevel 1 (
            echo [ERROR] Failed to install dependencies.
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] node_modules is missing or incomplete.
        echo Extract the release ZIP completely, then run Start.bat again.
        pause
        exit /b 1
    )
)

if not exist "%GATEWAY_ENTRY%" (
    if exist "%ROOT%pnpm-workspace.yaml" (
        echo Building project...
        call corepack pnpm build
        if errorlevel 1 (
            echo [ERROR] Failed to build.
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] dist\index.js was not found.
        echo Extract the release ZIP completely, then run Start.bat again.
        pause
        exit /b 1
    )
)

if not exist "%SUB2API_WEB_DIST%\index.html" (
    echo [WARN] Web build not found at "%SUB2API_WEB_DIST%".
)

echo Starting Sub2API gateway...
echo Admin panel: %BASE_URL%
echo Close this window to stop the gateway.
echo.

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\open-when-ready.ps1" -Url "%BASE_URL%"

node "%GATEWAY_ENTRY%"
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Sub2API gateway exited with code %EXIT_CODE%.
    echo Review the messages above. The browser opens only after /api/health responds.
    pause
)
exit /b %EXIT_CODE%