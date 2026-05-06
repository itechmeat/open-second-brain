# Roadmap

## v0: portable package skeleton

Goal: create an understandable open-source package that can be installed or inspected by Hermes, Claude Code, Codex, and humans.

Scope:

- README and design documentation;
- architecture notes;
- tested CLI foundation;
- event log concept;
- skills for Open Second Brain and event logging;
- Hermes plugin skeleton;
- Claude Code plugin manifest;
- Codex plugin manifest;
- no daemon;
- no required MCP server;
- no automatic background writes.

## v0.1: deterministic CLI ✅

Implemented:

```text
o2b status
o2b init
o2b doctor
o2b export-config
o2b append-event
vault-log
```

- `o2b status` — locate config and list known keys.
- `o2b init` — bootstrap a vault profile with AI Wiki structure.
- `o2b doctor` — run health checks on vault, config, and plugin manifests.
- `o2b export-config` — write a redacted config snapshot.
- `o2b append-event` — append an event to the daily Markdown backend.
- `vault-log` — compatibility wrapper for existing vault-log users.

All commands are dependency-free and tested with Python `unittest` (34 tests).

## v0.2: vault profile bootstrap ✅

`o2b init` creates:

```text
AI Wiki/_OPEN_SECOND_BRAIN.md
AI Wiki/_open-second-brain.yaml
AI Wiki/index.md
AI Wiki/hot.md
AI Wiki/log.md
AI Wiki/identity/user.md
AI Wiki/identity/agents.md
```

Implemented:
- vault-local operating manual (`_OPEN_SECOND_BRAIN.md`) to drive agent behavior;
- query helpers for the wiki layer (`parse_frontmatter`, `extract_wikilinks`, `list_vault_pages`);
- `o2b index` to regenerate `AI Wiki/index.md` from discovered vault pages.

## v0.3: runtime polish ✅

Implemented:

- Hermes plugin health checks with safe best-effort registration;
- Claude Code plugin command metadata for `status`, `doctor`, `init`, `index`, `append-event`, `export-config`, and `vault-log`;
- Codex, Claude, and Hermes plugin manifest validation in `o2b doctor --repo`;
- better install and runtime notes in README;
- test fixtures for sandbox vaults and plugin manifest repos.

## v1: MCP tool server ✅

Implemented in v0.4.0 (`docs/mcp.md`):

- stdio JSON-RPC 2.0 server on protocol version `2025-06-18`;
- five tools: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`;
- `o2b mcp` subcommand and `o2b-mcp` console script;
- Hermes/Claude/Codex manifest metadata referencing the MCP entrypoint;
- documentation for `~/.hermes/config.yaml mcp_servers` registration.

The MCP server is optional. The CLI remains the supported baseline.

## v2: richer automation

Possible future work:

- opt-in event capture hooks;
- local indexing;
- semantic retrieval;
- background compaction;
- automatic knowledge synthesis;
- documentation site;
- package registries and marketplaces.

Automation must remain explicit and reversible.
