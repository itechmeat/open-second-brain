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
identity:
  agent_name: <chosen-agent-name>
  user_language: <BCP-47 tag, e.g. en or ru>
policy:
  write_mode: agent-owned-dir
```

Machine-local config may contain absolute paths. It must not contain secrets.

### Vault-portable config

Vault-portable config lives at `<vault>/Brain/_brain.yaml` and travels
with backup/sync. It describes:

- schema version + dream / retire / confidence / snapshot thresholds;
- optional `notes.read_paths` (user-authored folders the agent may read);
- optional `temporal:`, `link_graph:`, `guardrails:`, `discipline_report:` tuning blocks;
- `vault.ignore_paths` (exclusion policy for every vault walker).

It must not contain secrets.

## Backup model

Open Second Brain should assume the vault is the primary portable backup unit.

Recommended behavior:

- vault-portable config is backed up with the vault;
- machine-local config can be regenerated with `o2b init --adopt-vault`;
- `o2b export-config` writes a redacted machine snapshot into the vault;
- secrets are excluded and represented as `[REDACTED]` only when needed.

## Vault layout

The agent owns one directory in the vault: `Brain/`. Pay Memory nests
under `Brain/payments/` so the write contract stays simple ("agent
writes only under `Brain/`"). User-authored notes (daily journals,
weekly notes) live wherever the operator names them; the agent reads
those paths only when they are listed in `notes.read_paths`.

```text
Brain/
  _brain.yaml              # schema + thresholds + notes.read_paths (validated by o2b brain doctor)
  _BRAIN.md                # operating manual for agents (rendered by o2b brain init)
  active.md                # derived digest, auto-regenerated
  inbox/                   # raw taste signals, sig-<date>-<slug>.md
    processed/             # signals already folded into a preference
  preferences/             # active rules: pref-<slug>.md, status unconfirmed | confirmed
  retired/                 # ret-<slug>.md with retired_reason
  log/                     # YYYY-MM-DD.md, append-only event log (dream / apply-evidence / etc.)
  payments/                # Pay Memory (optional, paid-action audit)
    policies/spending.md   # spending policy + optional spending.json
    <YYYY-MM-DD>/<slug>.md # dated receipts
    assets/                # generated-asset notes
    drafts/                # draft artefacts
    reports/               # daily reports
    _pending/              # approval workflow
  .snapshots/              # <run_id>.tar.zst, pre-run snapshots for o2b brain rollback
```

This layout is intentionally agent-owned: every artefact Open Second
Brain writes lives under `Brain/`. User-authored content elsewhere in
the vault is read-only to the agent and stays under operator control.

## Brain layer

Three architectural invariants:

- **Filesystem-first.** No database, no daemon. Every artifact is plain Markdown with YAML frontmatter; backup is `cp -r` or `tar`.
- **Deterministic core.** The `dream` algorithm is a pure function of inputs (signals, preferences, log, configuration, current time). No LLM calls inside the core. Semantic merging, if needed, is delegated to external agents via the same CLI / MCP surface.
- **Pre-run snapshot + atomic per-file writes.** Each `dream` run takes a `.snapshots/<run_id>.tar.zst` before any state change; per-file writes go through `fs-atomic` (temp + rename). Combined with retention of the most-recent N snapshots, this gives reversible, audit-friendly mutation.

The layered diagram from the top of this document still holds — `Brain/` sits at the same level as the vault files in the bottom layer:

```text
Agent runtime
  -> runtime adapter/plugin
    -> skills and commands (brain-memory skill, open-second-brain skill)
      -> CLI/core library (src/core/brain/*)
        -> vault files: Brain/ (observing memory) + Brain/payments/ (paid-action audit)
```

Full design: [`docs/plans/2026-05-15-brain-observing-memory.md`](plans/2026-05-15-brain-observing-memory.md).

As of v0.10.10 the always-loaded `open-second-brain-writer` MCP
server hosts one read tool (`brain_context`) alongside the three
writers (`brain_feedback`, `brain_apply_evidence`, `brain_note`).
The reader exists for runtimes without a `SessionStart` hook
(Cursor, Aider, raw Claude API) — they call it once at session
start to pull the same `Brain/active.md` content the hook-aware
runtimes get auto-injected. The MCP server name is preserved for
backward compatibility with existing client `.mcp.json` entries;
renaming is deferred until a second reader joins the always-load
scope.

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
