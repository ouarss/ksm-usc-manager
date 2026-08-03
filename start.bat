@echo off
rem USC Manager - local launcher.
rem Portable release: uses the bundled php\php.exe, nothing to install.
rem Source checkout: falls back to PHP from PATH.
setlocal
set PHP_BIN=%~dp0php\php.exe
set PHP_ARGS=
if exist "%PHP_BIN%" (
    set PHP_ARGS=-c "%~dp0php\php.ini"
) else (
    set PHP_BIN=php
    where php >nul 2>nul
    if errorlevel 1 (
        echo PHP not found in PATH. Install PHP, or download the portable
        echo release from GitHub, which bundles it.
        pause
        exit /b 1
    )
)
start "" http://127.0.0.1:2901
"%PHP_BIN%" %PHP_ARGS% -S 127.0.0.1:2901 -t "%~dp0public"
