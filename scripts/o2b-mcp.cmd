@echo off
rem Open Second Brain MCP server (stdio).
rem Windows twin of the bash launcher beside it (scripts/o2b-mcp); cmd.exe
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
rem Dependency bootstrap. A marketplace add/upgrade replaces this checkout
rem wholesale, so node_modules can arrive missing even though package.json and
rem bun.lock ship with the tree, and the CLI then cannot start. One file stat
rem when the tree is present; one frozen install when it is not. Mirrors the
rem block at the bottom of _bun-precheck.sh; O2B_SKIP_DEP_BOOTSTRAP opts out.
rem stdout joins stderr: this launcher serves the MCP stdio transport, and
rem bun's install report must never interleave with the JSON-RPC stream.
if not exist "%O2B_ROOT%\node_modules\proper-lockfile\package.json" (
  if not defined O2B_SKIP_DEP_BOOTSTRAP (
    >&2 echo o2b: dependency tree missing in this checkout; running 'bun install --frozen-lockfile'...
    pushd "%O2B_ROOT%"
    "%O2B_BUN%" install --frozen-lockfile 1>&2
    if errorlevel 1 (
      >&2 echo error: the automatic 'bun install --frozen-lockfile' failed in "%O2B_ROOT%".
      >&2 echo Run that command inside the checkout yourself, then retry. See install/codex.md and docs/updating.md.
      popd
      exit /b 1
    )
    popd
  )
)
"%O2B_BUN%" run "%O2B_ROOT%\src\cli\main.ts" mcp %*
exit /b %ERRORLEVEL%
