# Prerequisites

The `o2b` CLI runs on [Bun](https://bun.sh/). Every install path
expects `bun >= 1.1.0` on `PATH`.

```bash
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

If you cannot install Bun (locked-down environment, unsupported
architecture), the plugin will not function on that host. No Python
fallback exists.

## Get the `o2b` CLI

Install the package from the registry. It provides `o2b`, `o2b-mcp` and
`o2b-hook`, with Bun `>= 1.1.0` on `PATH` as the only prerequisite:

```bash
bun add -g open-second-brain
o2b version
```

Then run `o2b setup --target <host> ... --apply --yes` as
[`install.md`](../install.md#install-from-the-registry) shows. The package
does not ship `vault-log`; use `o2b brain note` instead.

Plugin hosts (Claude Code, Codex, Hermes, OpenClaw) also ship the launcher
with the plugin; their install page shows how to publish it. As an
alternative to the registry install, use a clone. Do not install both:
doctor reports several different `o2b` on `PATH`.

```bash
git clone https://github.com/itechmeat/open-second-brain ~/open-second-brain
~/open-second-brain/scripts/o2b install-cli
export PATH="$HOME/.local/bin:$PATH"
o2b version
```

`install-cli` links `o2b`, `vault-log` and `o2b-hook` into `~/.local/bin`.
Add that directory to `PATH` in your shell profile. A client that starts
MCP servers with a bare `o2b` command needs it on the `PATH` it runs with;
if it does not have it, use the absolute path `~/.local/bin/o2b` (expanded)
as the command. `o2b setup` from a registry install avoids this: it
registers absolute paths.
On native Windows, follow [`windows.md`](windows.md) instead.

## Supported platforms

Linux, macOS and the other POSIX hosts Bun runs on, plus native
Windows 10/11 (x64). WSL is a Linux host and follows the Linux
instructions.

| Platform | Default config path |
|---|---|
| Linux, macOS, BSD | `$HOME/.config/open-second-brain/config.yaml` |
| Windows | `%LOCALAPPDATA%\open-second-brain\config.yaml` |

`OPEN_SECOND_BRAIN_CONFIG` (an explicit file) and `XDG_CONFIG_HOME`
(a configuration root) override the default on every platform.

On Windows, install Bun with
`powershell -c "irm bun.sh/install.ps1 | iex"` and follow
[`windows.md`](windows.md): the CLI is published as `.cmd` launchers,
MCP hosts start it through `cmd /d /c`, and Claude Code's hooks need
Git for Windows.

## Identity (agent name + timezone)

`o2b setup` (or `o2b init`) persists two values into the machine config
(`~/.config/open-second-brain/config.yaml` on Linux and macOS):

- **`agent_name`** — the name attached to every event the MCP server
  records for this machine. The installation that creates the brain
  becomes its dream owner under this name. Pick a deliberate value
  (`<runtime>-<host>` is a good default). Grok, opencode and OpenClaw
  write under a name derived from it: the vendor token is swapped for the
  runtime (`claude-vps-agent` becomes `grok-vps-agent`; a name outside the
  `<vendor>-<host>-agent` shape gets the runtime as a prefix).
- **`timezone`** — IANA name (`Europe/Belgrade`, `America/New_York`,
  `UTC`). Used to stamp event timestamps regardless of the host's
  local clock.

If the machine was set up before, check what it already uses:

- the config file above (`agent_name`, authoritative), shown by `o2b status`;
- the dream owner's agent, shown by `o2b dream owner`;
- on a vault from 1.x, `<vault>/Brain/_brain.yaml` `primary_agent` (when set).

A repeat `o2b init --agent-name X` is safe — it updates the
machine-local config in place. It does not move the dream owner; use
`o2b dream owner --here --agent X` for that.

## Vault path discovery

Vault locations vary per user. Discover candidates in this order:

1. Directories containing a `.obsidian/` subdirectory under `~/`,
   `~/Documents/`, `~/Sync/`, `~/Dropbox/`, or a Syncthing-shared
   `vault/` folder.
2. The user's choice when multiple candidates exist.
3. A new directory at `~/vault/` if none are found and the user
   agrees.

## Consent before apply

The apply lanes that rewrite client configuration —
`o2b install --target <runtime> --apply` and
`o2b brain protect --target <runtime> --apply` — ask once before
writing. On an interactive terminal they print the plan with a unified
diff of the target file and prompt (`Proceed? [y/N]`); answering
anything but `y`/`yes` writes nothing. In a non-interactive run
(`--json`, CI, no TTY) there is no one to ask, so the command refuses
fail-closed and writes nothing; pass `--yes` to authorise the write
explicitly. A consent refusal exits with code 6 (`o2b install`) and
names the missing flag on stderr. `--check`, `--plan` and dry runs
never prompt and never gate.

## Verification

After any install path completes, run:

```bash
o2b doctor --vault /path/to/vault --repo .
o2b install --check
```

`o2b install --check` is the runtime-install health check
(per-target managed-block / MCP-ping verification). `o2b doctor`
covers the machine, the brain store and the vault — they are
complementary, not substitutes. On a `--no-vault` machine, run
`o2b doctor` without `--vault`.

Then record one test signal through the host (the `brain_feedback`
tool, or `o2b brain feedback` on the CLI) and confirm that it carries
the chosen agent name, not the literal `agent` placeholder. On Grok,
opencode and OpenClaw it carries the runtime-derived name described under
Identity above (`grok-vps-agent` for a chosen `claude-vps-agent`).

## Plays well with codegraph

If your vault sits next to code repositories, Open Second Brain cooperates with
[codegraph](https://github.com/colbymchenry/codegraph) as a partner
tool: codegraph owns the symbol graph and call relationships in a
codebase, Open Second Brain owns the prose / Brain / preferences in the vault. When
`o2b doctor` runs from inside or beside a code project, it adds a
`code_graph` line that summarises whether codegraph is installed and
indexed there. Installation is performed by codegraph's own installer,
not by Open Second Brain. See `skills/codegraph-partner/SKILL.md` for the agent-side
playbook.
