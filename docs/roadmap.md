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

## v0.2: vault profile bootstrap ✅ (in-progress)

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

Remaining v0.2 work:
- vault-local operating manual (`_OPEN_SECOND_BRAIN.md`) to drive agent behavior;
- query helpers for the wiki layer.

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
