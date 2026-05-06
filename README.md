# OpenSecondBrain

OpenSecondBrain gives Hermes Agent a small, filesystem-first second brain for Obsidian-compatible Markdown vaults.

It is built for Hermes first: install it as a Hermes plugin, point it at a vault, and let Hermes use deterministic commands for the parts that should not depend on model reasoning — setup checks, vault bootstrap, daily event logging, safe config export, and wiki indexing.

Claude Code and OpenAI Codex are supported through lightweight adapter manifests, but Hermes is the primary runtime.

## What it does today

- Bootstraps an agent-owned area inside your vault: `AI Wiki/` plus `_OPEN_SECOND_BRAIN.md`.
- Appends agent events to daily Markdown notes without editing your manual notes above `## Raw events`.
- Regenerates a simple Markdown page index from frontmatter and wikilinks.
- Exports config snapshots with secret-like values redacted.
- Runs health checks for the vault, config file, Hermes plugin, and Claude/Codex manifests.
- Ships with dependency-free CLI wrappers: `scripts/o2b` and `scripts/vault-log`.

OpenSecondBrain does not run a daemon, replace your vault, or write hidden background state outside the configured vault/config paths.

## Install in Hermes

In the Hermes Dashboard:

1. Open Plugins.
2. Choose Install from GitHub / Git URL.
3. Paste this repository URL:

```text
https://github.com/itechmeat/open-second-brain
```

4. Install and enable the plugin.
5. Restart Hermes or start a fresh session if the plugin list was already loaded.

Hermes also supports the same flow from the CLI:

```bash
hermes plugins install itechmeat/open-second-brain --enable
```

Hermes documentation describes plugin install identifiers as a Git URL or `owner/repo` shorthand; the dashboard field accepts the same formats.

## First run

Create or update the OpenSecondBrain profile inside a vault:

```bash
scripts/o2b init --vault /path/to/vault --name "My Second Brain"
```

Check that the vault and runtime adapters are healthy:

```bash
scripts/o2b doctor --vault /path/to/vault --repo .
```

Append an agent event:

```bash
scripts/o2b append-event --vault /path/to/vault --as hermes "initialized OpenSecondBrain"
```

Refresh the Markdown page index:

```bash
scripts/o2b index --vault /path/to/vault
```

## CLI commands

```text
o2b status          Show config/vault status
o2b init            Bootstrap the vault profile
o2b doctor          Run vault and adapter checks
o2b append-event    Append one daily event-log entry
o2b index           Rebuild the Markdown page index
o2b export-config   Write a redacted config snapshot
o2b mcp             Run the optional MCP tool server (stdio)
o2b uninstall       Print an uninstall plan; --apply-local removes only local config
vault-log           Compatibility wrapper around append-event
```

The local checkout can be used without installing the Python package. Run commands through `scripts/o2b` and `scripts/vault-log`, or set `PYTHONPATH=src` for module execution.

## Optional MCP tool server

OpenSecondBrain ships an optional Model Context Protocol server that exposes the same deterministic operations as MCP tools. Register it through Hermes from the CLI:

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
```

Or edit `~/.hermes/config.yaml` directly:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: ["mcp", "--vault", "/path/to/vault"]
```

Tools: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`. See `docs/mcp.md` for full setup, tool schemas, and Claude Code/Codex notes. The CLI remains the supported baseline; the MCP server is opt-in.

## Updating

OpenSecondBrain follows the standard Hermes plugin update flow.

```bash
hermes plugins update open-second-brain
hermes gateway restart
```

`hermes plugins update` runs `git pull` inside the installed plugin directory; it does not rewrite your `~/.hermes/config.yaml` MCP registration. After an update:

- The `o2b` CLI is upgraded automatically.
- The MCP entrypoint stays registered, so no `hermes mcp add` is needed for an in-place upgrade.
- Restart the gateway (or open a fresh Hermes session) so cached plugin metadata and the MCP subprocess are reloaded.
- Run `o2b doctor --vault /path/to/vault --repo .` to confirm the new manifest still validates.

The `version` field in `plugin.yaml` is informational — Hermes installs whatever the current `main` branch contains. Pin to a specific release by checking out a tag inside the plugin directory if you want stricter control.

## Uninstalling

OpenSecondBrain treats your vault as the source of truth and never removes Markdown notes, `Daily/`, or `AI Wiki/`. Uninstalling has three independent layers; do them in this order.

1. Print a plan and review the leftovers (read-only):

   ```bash
   o2b uninstall
   ```

   The plan tells you which Hermes commands to run yourself, where the machine-local config directory lives, and reminds you that the vault is untouched. The dry-run never modifies the filesystem.

2. Deregister the MCP server and remove the Hermes plugin (Hermes-owned state):

   ```bash
   hermes mcp remove open-second-brain
   hermes plugins remove open-second-brain
   hermes gateway restart
   ```

   `hermes mcp remove` deletes the MCP registration and any OAuth tokens. `hermes plugins remove` deletes only the installed plugin directory. OpenSecondBrain itself never edits `~/.hermes/config.yaml` — these commands are run by you against Hermes.

3. Optionally remove the machine-local config directory (typically `~/.config/open-second-brain` or `$OPEN_SECOND_BRAIN_CONFIG`'s parent):

   ```bash
   o2b uninstall --apply-local
   ```

   `--apply-local` only removes that one config directory. It refuses to act if the directory name is not a recognized Open Second Brain config dir, if it lives inside a Hermes-owned path, or if it looks like a git repository. It never touches the vault, Hermes config, or anything else.

To delete the vault you must do that yourself with normal filesystem tools — OpenSecondBrain will not do it for you, even with `--apply-local`.

## Safety model

- Your notes stay as plain Markdown.
- Secrets are not meant to be stored in the vault.
- Config export redacts secret-like keys and values.
- Daily logs are append-only below `## Raw events`.
- The current Hermes plugin only registers lightweight health checks; it does not start background jobs.

## Repository

GitHub: https://github.com/itechmeat/open-second-brain

License: MIT.
