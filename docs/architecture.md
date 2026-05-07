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

The core should not depend on Hermes, Claude Code, Codex, OpenClaw, or Obsidian internals.

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

### OpenClaw adapter

OpenClaw recognizes two plugin formats: **Native** (TypeScript/JS runtime module with `openclaw.plugin.json`) and **Bundle** (adapter directories like `.codex-plugin/`, `.claude-plugin/` mapped to OpenClaw features).

Since Open Second Brain is a Python project, it uses the **Bundle format** combined with a static `openclaw.plugin.json` manifest:

```text
openclaw.plugin.json    # static discovery metadata (id, configSchema, contracts.tools)
.claude-plugin/         # auto-detected by OpenClaw Bundle format
.codex-plugin/          # auto-detected by OpenClaw Bundle format
scripts/o2b             # CLI entry point
src/open_second_brain/mcp.py  # MCP server (runtime tool bridge)
```

The OpenClaw integration does **not** add a TypeScript entry point or `package.json`. Instead:

1. **Cold discovery**: `openclaw.plugin.json` declares the plugin ID, version, configuration schema, and the list of tool names the MCP server provides.
2. **Feature mapping**: OpenClaw auto-detects `.claude-plugin/` and `.codex-plugin/` directories and maps their commands and skills to OpenClaw features.
3. **Runtime bridge**: The MCP server (`o2b mcp`) serves as the tool runtime. OpenClaw discovers tool schemas and executes tool calls through the MCP protocol (stdio JSON-RPC 2.0).

Installation:

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain@v0.5.0
```

The OpenClaw adapter must not introduce Node.js/TypeScript dependencies, must not add `package.json`, and must remain compatible with the Hermes, Claude Code, and Codex adapters.

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
- machine-local config can be regenerated with `o2b init --adopt-vault`;
- `o2b export-config` writes a redacted machine snapshot into the vault;
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
