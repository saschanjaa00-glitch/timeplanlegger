@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ROOT=%cd%"
set "BACKEND_DIR=%ROOT%\backend"
set "FRONTEND_DIR=%ROOT%\frontend"
set "BACKEND_VENV=%BACKEND_DIR%\.venv"
set "BACKEND_PY=%BACKEND_VENV%\Scripts\python.exe"
set "LOG_DIR=%ROOT%\.launcher-logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [1/6] Checking prerequisites...
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not in PATH.
  echo Install Node.js LTS from https://nodejs.org and try again.
  pause
  exit /b 1
)

set "PYTHON_BOOTSTRAP=python"
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH.
    echo Install Python 3.11+ and try again.
    pause
    exit /b 1
  ) else (
    set "PYTHON_BOOTSTRAP=py -3"
  )
)

echo [2/6] Ensuring backend virtual environment...
set "REBUILD_VENV=0"
if not exist "%BACKEND_PY%" set "REBUILD_VENV=1"

if "%REBUILD_VENV%"=="0" (
  "%BACKEND_PY%" -c "import sys" >nul 2>&1
  if errorlevel 1 set "REBUILD_VENV=1"
)

if "%REBUILD_VENV%"=="1" (
  echo Rebuilding backend .venv...
  if exist "%BACKEND_VENV%" rmdir /s /q "%BACKEND_VENV%"
  %PYTHON_BOOTSTRAP% -m venv "%BACKEND_VENV%"
  if errorlevel 1 (
    echo ERROR: Could not create backend virtual environment.
    pause
    exit /b 1
  )
  "%BACKEND_PY%" -m pip install --upgrade pip
  "%BACKEND_PY%" -m pip install -r "%BACKEND_DIR%\requirements.txt"
  if errorlevel 1 (
    echo ERROR: Backend dependency install failed.
    pause
    exit /b 1
  )
)

echo [3/6] Ensuring frontend dependencies...
if not exist "%FRONTEND_DIR%\node_modules" (
  pushd "%FRONTEND_DIR%"
  npm install
  if errorlevel 1 (
    popd
    echo ERROR: Frontend dependency install failed.
    pause
    exit /b 1
  )
  popd
)

echo [4/6] Starting backend in background on http://localhost:8000 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%BACKEND_PY%' -ArgumentList '-m','uvicorn','app.main:app','--reload','--port','8000' -WorkingDirectory '%BACKEND_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_DIR%\\backend.out.log' -RedirectStandardError '%LOG_DIR%\\backend.err.log'"
if errorlevel 1 (
  echo ERROR: Failed to start backend process.
  pause
  exit /b 1
)

echo [5/6] Starting frontend in background on http://localhost:3000 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev -- -p 3000' -WorkingDirectory '%FRONTEND_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_DIR%\\frontend.out.log' -RedirectStandardError '%LOG_DIR%\\frontend.err.log'"
if errorlevel 1 (
  echo ERROR: Failed to start frontend process.
  pause
  exit /b 1
)

echo Waiting for frontend startup...
timeout /t 4 /nobreak >nul

echo [6/6] Done.
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:3000
start "" "http://localhost:3000"
echo.
echo Logs are written to: %LOG_DIR%
echo No extra terminal windows were opened.
pause
