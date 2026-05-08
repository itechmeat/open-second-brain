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

OpenClaw recognizes two plugin formats: **Native** (JS runtime module with `package.json` + `openclaw.plugin.json`) and **Bundle** (adapter directories like `.codex-plugin/`, `.claude-plugin/` mapped to OpenClaw features).

Open Second Brain uses the **Native format** with a pure JavaScript entry that operates directly on the vault filesystem — no Python subprocess, no `child_process`:

```text
package.json             # openclaw.extensions → ./openclaw/index.js
openclaw/
  index.js               # JS entry: definePluginEntry + api.registerTool (two-arg)
  vault.js               # Pure JS: frontmatter parse/write, slugify, wikilinks, page listing
  event-log.js           # Pure JS: daily note creation, chronological event insertion
openclaw.plugin.json     # Static discovery metadata (id, configSchema, contracts.tools)
src/open_second_brain/
  cli.py                 # Python CLI (for Hermes/standalone usage)
  mcp.py                 # MCP server (optional, for runtimes that prefer MCP)
.claude-plugin/          # Auto-detected by OpenClaw Bundle format
.codex-plugin/           # Auto-detected by OpenClaw Bundle format
```

The integration flow:

1. **Discovery**: OpenClaw reads `package.json`, finds `openclaw.extensions`, and loads `openclaw/index.js`.
2. **Tool registration**: The JS entry calls `api.registerTool(tool, { name })` for each of the five tools (`second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`).
3. **Pure JS execution**: Each tool's `execute()` runs entirely in the Node.js process using `node:fs/promises` and `node:path` to read/write the vault directory. No subprocess is spawned — this passes the OpenClaw security scanner which blocks `child_process` imports.
4. **Config**: `api.pluginConfig` provides the vault path and instance name from OpenClaw's plugin config.

The Python CLI (`o2b`) and MCP server (`o2b mcp`) remain available for Hermes and standalone usage, but the OpenClaw runtime is self-contained JavaScript.

Installation (always installs the latest from `main`; do not append `@v...`):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain
```

The OpenClaw adapter must remain compatible with the Hermes, Claude Code, and Codex adapters. The `o2b mcp` MCP server is still available for runtimes that prefer the MCP protocol.

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
instance_name: My Second Brain
runtime: hermes
environment_name: <hostname>
vault:
  path: <absolute-path-to-Obsidian-vault>
  agent_dir: AI Wiki
identity:
  agent_name: <chosen-agent-name>
  user_language: <BCP-47 tag, e.g. en or ru>
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
