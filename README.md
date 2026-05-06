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
vault-log           Compatibility wrapper around append-event
```

The local checkout can be used without installing the Python package. Run commands through `scripts/o2b` and `scripts/vault-log`, or set `PYTHONPATH=src` for module execution.

## Safety model

- Your notes stay as plain Markdown.
- Secrets are not meant to be stored in the vault.
- Config export redacts secret-like keys and values.
- Daily logs are append-only below `## Raw events`.
- The current Hermes plugin only registers lightweight health checks; it does not start background jobs.

## Repository

GitHub: https://github.com/itechmeat/open-second-brain

License: MIT.
