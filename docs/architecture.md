# Architecture

Open Second Brain is organized around a stable core and multiple runtime adapters.

## Layers

```text
Agent runtime
  -> runtime adapter/plugin
    -> skills and commands
      -> CLI/core library
        -> vault files and local config
```

## Core responsibilities

The core should eventually provide deterministic operations for:

- locating configuration;
- validating configuration;
- initializing a vault profile;
- appending event log entries;
- exporting redacted config snapshots;
- checking vault health;
- running migrations;
- querying known indexes where available.

The core should not depend on Hermes, Claude Code, Codex, or Obsidian internals.

## Runtime adapters

### Hermes adapter

The Hermes adapter can be a real runtime plugin:

```text
plugins/hermes/
  plugin.yaml
  __init__.py
```

Possible responsibilities:

- register available hooks;
- check configuration at gateway startup;
- expose readiness diagnostics;
- connect Hermes session metadata to Open Second Brain profiles;
- optionally add event capture hooks when safe and explicit.

The Hermes adapter must not silently change model routing, write secrets, or mutate unrelated vault areas.

### Claude Code adapter

Claude Code support should be packaged through plugin metadata and bundled skills/commands.

The adapter should focus on:

- installing skills;
- exposing slash-command style workflows where supported;
- optionally configuring hooks;
- optionally declaring MCP configuration in later versions.

### Codex adapter

Codex supports plugins as installable distribution units for reusable skills and apps. The Codex adapter should include:

```text
.codex-plugin/plugin.json
skills/
.mcp.json        # later, optional
hooks/           # later, optional
assets/          # later, optional
```

v0 should keep Codex support simple: plugin manifest plus shared skills and scripts.

## Configuration model

Open Second Brain separates immutable package code from mutable user configuration and data.

### Machine-local config

Machine-local config points a runtime to a vault and environment profile.

Suggested path:

```text
$OPEN_SECOND_BRAIN_CONFIG
~/.config/open-second-brain/config.yaml
```

Example:

```yaml
version: 1
instance_name: Hermes Second Brain
runtime: hermes
environment_name: vps-techmeat
vault:
  path: /root/vault
  agent_dir: AI Wiki
identity:
  agent_name: hermes-vps-agent
  user_language: ru
policy:
  write_mode: agent-owned-dir
```

Machine-local config may contain absolute paths. It must not contain secrets.

### Vault-portable config

Vault-portable config lives inside the vault and travels with backup/sync.

Suggested paths:

```text
<vault>/<agent_dir>/_open-second-brain.yaml
<vault>/<agent_dir>/_OPEN_SECOND_BRAIN.md
```

It describes:

- owner identity;
- language/timezone preferences;
- vault schema;
- write boundaries;
- known agents;
- event log backend;
- durable operating rules.

It must not contain secrets.

## Backup model

Open Second Brain should assume the vault is the primary portable backup unit.

Recommended behavior:

- vault-portable config is backed up with the vault;
- machine-local config can be regenerated with `asb init --adopt-vault`;
- `asb export-config` writes a redacted machine snapshot into the vault;
- secrets are excluded and represented as `[REDACTED]` only when needed.

## Vault layout

A default vault layout may look like:

```text
AI Wiki/
  _OPEN_SECOND_BRAIN.md
  _open-second-brain.yaml
  index.md
  hot.md
  log.md
  identity/
    user.md
    agents.md
  system/
    config-snapshots/
  events/
```

This layout is intentionally agent-owned. The project should not mix agent-generated wiki pages into a user's personal notes without clear boundaries.

## Event log

The event log is append-only. It records operational events, not polished knowledge.

Default backend:

```yaml
event_log:
  backend: daily-markdown
  daily_dir: Daily
  section: Agent Events
```

Later backends may include JSONL, SQLite, or both.

## Security rules

Open Second Brain must not store:

- API keys;
- tokens;
- passwords;
- private SSH keys;
- credentials;
- connection strings containing secrets.

If secret-like content appears in input, tools should redact it as `[REDACTED]` before writing.
