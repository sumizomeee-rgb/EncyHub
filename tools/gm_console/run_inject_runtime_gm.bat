@echo off
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%..\.."
set "VENV_PY=%REPO_ROOT%\.venv\Scripts\python.exe"
set "EXIT_CODE=0"

pushd "%SCRIPT_DIR%" || goto :fail

if exist "%VENV_PY%" (
    echo [RuntimeGM] Using venv Python:
    echo %VENV_PY%
    "%VENV_PY%" "%SCRIPT_DIR%inject_runtime_gm.py"
    set "EXIT_CODE=%ERRORLEVEL%"
) else (
    where py >nul 2>nul
    if not errorlevel 1 (
        echo [RuntimeGM] Using Python launcher: py -3
        py -3 "%SCRIPT_DIR%inject_runtime_gm.py"
        set "EXIT_CODE=%ERRORLEVEL%"
    ) else (
        where python >nul 2>nul
        if not errorlevel 1 (
            echo [RuntimeGM] Using system Python
            python "%SCRIPT_DIR%inject_runtime_gm.py"
            set "EXIT_CODE=%ERRORLEVEL%"
        ) else (
            echo [RuntimeGM] Python not found. Please install Python or create .venv.
            set "EXIT_CODE=9009"
        )
    )
)

popd
echo.
if "%EXIT_CODE%"=="0" (
    echo [RuntimeGM] Inject finished.
) else (
    echo [RuntimeGM] Inject failed, exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

:fail
echo [RuntimeGM] Failed to enter script directory.
pause
exit /b 1
