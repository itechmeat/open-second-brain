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

- **`agent_name`** — prefix attached to every `Brain/log/` event the
  MCP server records against this vault. Pick a deliberate value
  (`<runtime>-<host>` is a good default).
- **`timezone`** — IANA name (`Europe/Belgrade`, `America/New_York`,
  `UTC`). Used to stamp event timestamps regardless of the host's
  local clock.

If the vault was initialized previously, check the registry first:

- `~/.config/open-second-brain/config.yaml` `agent_name` (authoritative)
- `<vault>/Brain/_brain.yaml` `primary_agent` (when set)
- `<vault>/Brain/log/*.{md,jsonl}` (recurring `agent` field)

A repeat `o2b init --agent-name X` is safe — it updates the
machine-local config in place.

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

Then call `brain_note` once (via MCP or `o2b brain note "..."` on the
CLI) and confirm that the new line in `Brain/log/<today>.md` carries
the chosen `agent` value, not the literal `agent` placeholder.

## Plays well with codegraph

If your vault sits next to code repositories, OSB cooperates with
[codegraph](https://github.com/colbymchenry/codegraph) as a partner
tool: codegraph owns the symbol graph and call relationships in a
codebase, OSB owns the prose / Brain / preferences in the vault. When
`o2b doctor` runs from inside or beside a code project, it adds a
`code_graph` line that summarises whether codegraph is installed and
indexed there. Installation is performed by codegraph's own installer,
not by OSB. See `skills/codegraph-partner/SKILL.md` for the agent-side
playbook.
