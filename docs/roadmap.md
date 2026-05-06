# Roadmap

## v0: portable package skeleton

Goal: create an understandable open-source package that can be installed or inspected by Hermes, Claude Code, Codex, and humans.

Scope:

- README and design documentation;
- architecture notes;
- CLI placeholders;
- event log concept;
- skills for Open Second Brain and event logging;
- Hermes plugin skeleton;
- Claude Code plugin manifest;
- Codex plugin manifest;
- no daemon;
- no required MCP server;
- no automatic background writes.

## v0.1: deterministic CLI

Planned commands:

```text
asb init
asb status
asb doctor
asb export-config
asb append-event
vault-log
```

Expected behavior:

- locate config;
- initialize machine-local config;
- adopt an existing vault profile;
- append event log entries;
- export redacted snapshots;
- validate schema and paths.

## v0.2: vault profile bootstrap

Planned outputs:

```text
AI Wiki/_OPEN_SECOND_BRAIN.md
AI Wiki/_open-second-brain.yaml
AI Wiki/index.md
AI Wiki/hot.md
AI Wiki/log.md
AI Wiki/identity/user.md
AI Wiki/identity/agents.md
```

## v0.3: runtime polish

- Hermes plugin health checks;
- Claude Code plugin commands;
- Codex plugin manifest validation;
- better install docs;
- test fixtures and sandbox vaults.

## v1: MCP tool server

Optional MCP server over the same core operations:

- `second_brain_status`;
- `second_brain_query`;
- `second_brain_capture`;
- `event_log_append`;
- `vault_health`.

The MCP server should be optional. CLI must remain the baseline.

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
