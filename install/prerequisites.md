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

## Identity (agent name + timezone)

`o2b init` persists two values into `~/.config/open-second-brain/config.yaml`:

- **`agent_name`** — prefix used in every `Daily/` entry and every
  `Brain/log/` event written by an MCP server pointing at this vault.
  Pick a deliberate value (`<runtime>-<host>` is a good default).
- **`timezone`** — IANA name (`Europe/Belgrade`, `America/New_York`,
  `UTC`). Used to stamp `Daily/` entries regardless of the host's
  local clock.

If the vault was initialized previously, check the registry first:

- `~/.config/open-second-brain/config.yaml` `agent_name` (authoritative)
- `<vault>/AI Wiki/identity/agents.md` (human-readable list)
- `<vault>/Daily/*.md` (recurring `@<name>` lines)

A repeat `o2b init --agent-name X` is safe: it appends `X` to the
registry without removing the previous agents.

## Vault path discovery

Vault locations vary per user. Discover candidates in this order:

1. Directories containing a `.obsidian/` subdirectory under `~/`,
   `~/Documents/`, `~/Sync/`, `~/Dropbox/`, or a Syncthing-shared
   `vault/` folder.
2. The user's choice when multiple candidates exist.
3. A new directory at `~/vault/` if none are found and the user
   agrees.

## Verification

After any install path completes, run:

```bash
o2b doctor --vault /path/to/vault --repo .
o2b install --check
```

`o2b install --check` is the v0.10.11 runtime-install health check
(per-target managed-block / MCP-ping verification). `o2b doctor`
covers vault invariants — they are complementary, not substitutes.

Then send one event without an explicit `agent` argument and confirm
that the new `Daily/YYYY.MM.DD.md` line begins with the chosen
`@<agent_name>` prefix, not the literal `@agent` placeholder.
