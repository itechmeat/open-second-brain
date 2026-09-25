@echo off
rem Open Second Brain CLI.
rem Windows twin of the bash launcher beside it (scripts/o2b); cmd.exe
rem cannot run that one. Resolves Bun the way _bun-precheck.sh does: PATH
rem first, then the default %USERPROFILE%\.bun\bin install location.
rem DisableDelayedExpansion: a ! in the checkout path must stay a character
rem even where delayed expansion is switched on in the registry.
setlocal DisableDelayedExpansion
rem cmd.exe looks in the current directory before PATH, so a bun.cmd or
rem bun.exe in the project an agent host opened would run instead of Bun.
set "NoDefaultCurrentDirectoryInExePath=1"
set "O2B_ROOT=%~dp0.."
set "O2B_BUN=bun"
where bun >nul 2>&1
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "O2B_BUN=%USERPROFILE%\.bun\bin\bun.exe"
  ) else (
    >&2 echo error: 'bun' is not on PATH. Open Second Brain runs on Bun ^(^>=1.1.0^). Install it with:
    >&2 echo   powershell -c "irm bun.sh/install.ps1 ^| iex"
    exit /b 127
  )
)
"%O2B_BUN%" run "%O2B_ROOT%\src\cli\main.ts" %*
exit /b %ERRORLEVEL%
