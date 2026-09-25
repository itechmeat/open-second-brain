# Native Windows

Open Second Brain runs natively on Windows 10 and 11 (x64). WSL is a Linux
host and follows the Linux instructions instead; this page is for agents that
run on Windows itself - Hermes Agent's desktop app or `install.ps1` build,
Claude Code's native `claude.exe`, opencode, Cursor and the other MCP hosts.

## 1. Prerequisites

Bun (>= 1.1.0), per user, no administrator rights needed:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

`tar.exe` ships in `C:\Windows\System32` on Windows 10 1803 and later; brain
snapshots use it. `zstd` is optional: without it snapshots are compressed
with gzip in-process, so no `gzip` binary is needed either.

Git is needed only to clone the repository. Hermes Agent ships its own Git
for Windows; Claude Code's hooks need Git for Windows installed (see below).

## 2. Get the code and publish the CLI

```powershell
git clone https://github.com/itechmeat/open-second-brain $env:USERPROFILE\projects\open-second-brain
cd $env:USERPROFILE\projects\open-second-brain
bun install
bun run src\cli\main.ts install-cli
```

`install-cli` writes `o2b.cmd`, `vault-log.cmd` and `o2b-hook.cmd` into
`%USERPROFILE%\.local\bin` - small launchers, not symlinks (a symlink needs
Developer Mode or an elevated token). If that directory is not on your PATH
the command prints the one PowerShell line that adds it; open a new terminal
afterwards. Claude Code's native installer already puts it on PATH.

## 3. Initialize

```powershell
o2b init --vault C:\Users\you\Vault --agent-name "<runtime>-<host>-agent" --timezone Europe/Belgrade
o2b brain init --vault C:\Users\you\Vault
```

`~\Vault` is accepted as well as `~/Vault`.

## Where things live

| What | Windows | Linux / macOS |
|---|---|---|
| Config | `%LOCALAPPDATA%\open-second-brain\config.yaml` | `~/.config/open-second-brain/config.yaml` |
| opencode session spool | `%LOCALAPPDATA%\open-second-brain\opencode\` | `~/.local/share/open-second-brain/opencode/` |
| CLI launchers | `%USERPROFILE%\.local\bin\*.cmd` | `~/.local/bin/*` (symlinks) |

`OPEN_SECOND_BRAIN_CONFIG` and the `XDG_*_HOME` variables override these on
every platform. `%LOCALAPPDATA%` rather than the roaming `%APPDATA%`, because
what lives there is machine-bound: the vault path and the agent name, which
carries the host.

## Runtimes

- **Hermes Agent** - install the plugin as in [`hermes.md`](hermes.md). On
  Windows the memory provider starts the MCP bridge as
  `bun run <plugin>\src\cli\main.ts mcp`, without a console window, and reads
  the config from `%LOCALAPPDATA%\open-second-brain\config.yaml`.
- **Claude Code** (`claude.exe`) - install the plugin as in
  [`claudecode.md`](claudecode.md). Claude Code starts the `.mcp.json`
  command through `cmd.exe /d /s /c`, which resolves the extensionless
  `scripts/o2b` to its `scripts\o2b.cmd` sibling via PATHEXT - no
  Windows-specific plugin config is needed. The lifecycle hooks are POSIX
  shell commands and run under Git Bash, which Claude Code finds through
  `git.exe` on PATH (or `CLAUDE_CODE_GIT_BASH_PATH`). Without Git for
  Windows Claude Code falls back to PowerShell, the hook commands fail to
  parse there and are skipped (exit 1, non-blocking) - the MCP tools still
  work. Install Git for Windows to get the hooks.
- **opencode, Cursor, Gemini CLI, Copilot CLI, kiro, Codex** -
  `o2b install --target <name> --apply` writes the MCP entry as
  `cmd /d /c o2b mcp ...`, the form every MCP host documents for batch-file
  launchers on Windows (`/d` skips cmd's AutoRun, whose output would corrupt
  the JSON-RPC stream). The install refuses a vault path containing
  `& | < > ^ % "`, which cmd would split or execute.
- **Grok Build** gets absolute `bun.exe run <repo>\src\cli\main.ts` MCP
  entries and hook commands. Unverified on Windows: xAI does not document
  which shell runs hook commands there (reports say PowerShell), and the
  unquoted command breaks if the Bun or repository path contains a space.
  Keep both paths space-free, or report a failure.

## Behaviour that differs on Windows

- Files open in another process cannot be renamed or deleted on Windows.
  Atomic writes and the search-index swap retry for up to two seconds when
  Syncthing, OneDrive, an antivirus scan or another `o2b` holds a file.
- `o2b search reindex` swaps the index by renaming it. If a long-running
  process keeps `brain.sqlite` open past that window (an MCP server in the
  middle of a query), the swap fails with a clear error and the previous
  index stays in place; run it again.
- Cron recipes (`--cron-template`) print POSIX `crontab` lines. On Windows,
  schedule the same `o2b` command with Task Scheduler.
- `o2b mcp`'s SIGTERM drain has no equivalent: Windows terminates a process
  without delivering a signal it can handle.

## Verify

```powershell
o2b doctor --vault C:\Users\you\Vault
o2b install --check
```
