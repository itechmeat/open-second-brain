@echo off
rem Open Second Brain hook launcher: o2b-hook.cmd <hook-name> [args...]
rem Windows twin of scripts/o2b-hook. Fail-soft like it: a missing hook, a
rem missing Bun or a hook that exits non-zero never blocks the agent - the
rem launcher always exits 0 and says why on stderr.
rem DisableDelayedExpansion: a ! in the checkout path must stay a character
rem even where delayed expansion is switched on in the registry.
setlocal DisableDelayedExpansion
rem cmd.exe looks in the current directory before PATH, so a bun.cmd or
rem bun.exe in the project an agent host opened would run instead of Bun.
set "NoDefaultCurrentDirectoryInExePath=1"
set "O2B_HOOK=%~1"
if "%O2B_HOOK%"=="" (
  >&2 echo o2b-hook: missing hook name; skipping
  exit /b 0
)
set "O2B_ROOT=%~dp0.."
if defined CLAUDE_PLUGIN_ROOT if exist "%CLAUDE_PLUGIN_ROOT%\hooks\%O2B_HOOK%.ts" set "O2B_ROOT=%CLAUDE_PLUGIN_ROOT%"
if not exist "%O2B_ROOT%\hooks\%O2B_HOOK%.ts" if defined OSB_PLUGIN_ROOT set "O2B_ROOT=%OSB_PLUGIN_ROOT%"
if not exist "%O2B_ROOT%\hooks\%O2B_HOOK%.ts" (
  >&2 echo o2b-hook: could not locate hooks\%O2B_HOOK%.ts ^(plugin root unresolved^); skipping
  exit /b 0
)
set "O2B_BUN=bun"
where bun >nul 2>&1
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "O2B_BUN=%USERPROFILE%\.bun\bin\bun.exe"
  ) else (
    >&2 echo o2b-hook: bun not on PATH; skipping %O2B_HOOK%
    exit /b 0
  )
)
shift
set "O2B_ARGS="
:collect
rem Test the raw argument, quotes included: an empty "" argument is still an
rem argument, and the loop must not stop at it and drop the ones after it.
if [%1]==[] goto run
set O2B_ARGS=%O2B_ARGS% %1
shift
goto collect
:run
"%O2B_BUN%" run "%O2B_ROOT%\hooks\%O2B_HOOK%.ts"%O2B_ARGS%
rem Not "if errorlevel 1": that is false for a negative code such as a crash.
if not "%ERRORLEVEL%"=="0" >&2 echo o2b-hook: hook %O2B_HOOK% exited %ERRORLEVEL%; suppressed to keep the runtime unblocked
exit /b 0
