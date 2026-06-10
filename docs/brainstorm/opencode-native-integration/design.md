# opencode native integration - bundled plugin, spool capture, config-correct install

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** t_d505b2b9

## Problem statement

Open Second Brain integrates deeply with Claude Code and Codex (hooks, session import, MCP registration) but its opencode support is a single install adapter that writes `~/.config/opencode/mcp.json` with an `mcpServers` key - a file current opencode does not read at all. opencode's real extensibility surface (a documented plugin system with lifecycle hooks plus an SDK client, and `opencode.json` with an `mcp` key) is unused. Operators running opencode get no MCP registration that works, no active-context injection, no session capture, and no session import.

## Scope

- Fix the install adapter to write the config opencode actually reads: `~/.config/opencode/opencode.json`, `mcp` key, entries shaped `{type: "local", command: [...], environment, enabled: true}`. Migrate away the stale `mcp.json` written by previous Open Second Brain versions.
- Extend the shared JSON-merge layer (`json-merge.ts`, `_json-mcp.ts`, drift detection) with a pluggable entry shape so the opencode adapter, and any future runtime with a non-`mcpServers` schema, reuses the same lifecycle.
- Ship a single-file, zero-dependency opencode plugin (TypeScript, public hook API only) installed by the adapter into `~/.config/opencode/plugins/`. The plugin: injects active Brain context per session, snapshots session turns into a spool JSONL on lifecycle events, and emits a post-write logging reminder after file-mutating tools. Fail-soft everywhere.
- Add a fourth session adapter `opencode` to `SESSION_ADAPTERS` that detects and imports the spool JSONL (a format this repo owns), wired through the existing `importSessionPath` flow.
- Docs: rewrite `install/opencode.md`, update `install.md` quick table and `README.md` runtime list, CHANGELOG entry.

## Out of scope

- Stop-log guardrail parity. opencode has no blocking stop hook; `session.idle` cannot veto a turn. Documented as a known gap.
- Parsing opencode's on-disk storage (`~/.local/share/opencode/storage/`). Undocumented, unstable; the spool file is the contract instead.
- npm distribution of the plugin (`plugin` key). Revisit if the bundled-file copy proves brittle in the field.
- Wiring the `instructions` config key. AGENTS.md support is native in opencode and per-session inject covers freshness.
- Hermes/Claude hook-layer changes (`hooks/hooks.json`, `hooks/lib/detect.ts` runtime detection). The plugin does not route through `o2b-hook`.

## Chosen approach

Variant 2 from `variants.md` (consultant-recommended, accepted without override).

The install adapter becomes the single entry point: `o2b install --target opencode --apply` (a) merges the two canonical MCP servers into `opencode.json` under `mcp` using opencode's entry schema, (b) copies the bundled plugin file into the global plugins directory with a version-stamped header, (c) removes Open Second Brain keys from the legacy `mcp.json` if present, and records everything in the install manifest so `verify` reports drift and `uninstall` reverses all three.

The plugin is one self-contained TypeScript file exporting the standard opencode plugin function. It receives the SDK `client` and uses three hooks:

- `experimental.chat.system.transform` - appends the rendered active-context block to the system prompt array. The block comes from spawning the bundled `o2b-hook active-inject` PATH shim (the same binary the Claude Code and Codex hook layers call) with a synthetic `{"hook_event_name":"SessionStart"}` payload on stdin and parsing `hookSpecificOutput.additionalContext` from stdout - vault resolution, budgeting, and quiet-failure semantics are inherited rather than reimplemented. Cached per session with a short TTL. Experimental API: the entire body is wrapped so a signature change degrades to no-op.
- `event` - on `session.idle`, `session.compacted`, `session.deleted`: fetch the full message list through `client.session.messages()` and atomically rewrite `${XDG_DATA_HOME:-~/.local/share}/open-second-brain/opencode/<sessionID>.jsonl` as a snapshot (meta line + one normalized turn line per message). Snapshot-rewrite, not append: idempotent, self-healing after crashes, and dedup downstream is by content hash already.
- `tool.execute.after` - for file-mutating tools (`write`, `edit`, `patch`, `bash` heuristics mirroring `NATIVE_ARTIFACT_NAMES` semantics): appends the standard logging reminder to the tool output so the model sees it, matching the Claude Code post-write-reminder contract.

The spool format is owned by this repo: first line `{"type":"session_meta","originator":"open-second-brain-opencode-plugin","format":1,...}`, subsequent lines `{"type":"turn","turnId","timestamp","role","text","toolCalls"}` - deliberately close to `SessionTurn` so the session adapter is a thin validator. The `opencode` session adapter detects on the meta line's `originator` and yields turns; `importSessionPath` pointed at the spool directory does the rest (dedup, markers, lineage).

## Design decisions

- **Pluggable entry shape, not a forked adapter body.** `json-merge.ts` gains `serializeEntry`/`entryEquals` injection points (defaults preserve current behavior byte-for-byte). Cursor, kiro, Gemini CLI continue on defaults; the smoke tests pin that.
- **Spool snapshot over event append.** `session.idle` can fire many times per session; append-only would duplicate turns and require dedup in the adapter. A full-snapshot rewrite on each lifecycle event is idempotent and keeps the adapter dumb.
- **Plugin discovers nothing about the vault.** The spool lands in an XDG data path independent of vault location; the active-context inject shells to `o2b-hook` on PATH (or `OSB_HOOK_BIN` override) which resolves the vault from the persisted Open Second Brain config, and silently skips when absent. No vault path is baked into the plugin file, so one plugin file serves any number of vaults and the file content is deterministic for drift detection.
- **Version-stamped plugin copy.** The installed plugin carries `// open-second-brain plugin v<version>` in its header; the manifest records the content hash. `verify` flags drift when the bundled source and the installed copy diverge (operator edited it, or an upgrade has not been re-applied).
- **Legacy `mcp.json` migration is removal-only.** We delete our two keys (and the file if it becomes empty and we created it per the manifest); we never translate user-authored entries - not ours to interpret.
- **Reminder via tool-output suffix, not TUI toast.** The reminder's audience is the model (same as Claude Code's `systemMessage`), not the human; a toast would nag the operator and be invisible to the agent.

## File changes

New:
- `plugins/opencode/open-second-brain.ts` - the bundled plugin source.
- `src/core/install/opencode-plugin-asset.ts` - resolves the bundled plugin source path + version stamp for the adapter and drift checks.
- `src/core/brain/sessions/opencode.ts` - spool session adapter.
- `tests/core/install/adapters/opencode.test.ts`, `tests/core/brain.sessions.opencode.test.ts`, `tests/plugins/opencode-plugin.test.ts` - per-unit tests.
- `tests/fixtures/sessions/opencode-minimal.jsonl`, install fixtures under `tests/fixtures/install/opencode/`.
- `install/opencode.md` rewrite (file exists; content replaced).

Modified:
- `src/core/install/json-merge.ts`, `src/core/install/adapters/_json-mcp.ts`, `src/core/install/payload-equals.ts` - entry-shape injection.
- `src/core/install/adapters/opencode.ts` - full rewrite onto the new spec.
- `src/core/brain/sessions/types.ts`, `src/core/brain/sessions/registry.ts` - fourth adapter id + registration.
- `install.md`, `README.md`, `CHANGELOG.md`.
- `tests/core/install/adapters/json-mcp-smoke.test.ts` - pins default-shape invariance for existing targets.

## Risks and open questions

- `experimental.chat.system.transform` may change signature in a future opencode release; mitigated by full-body try/catch no-op and by keeping capture (the higher-value half) on the stable `event` bus.
- `client.session.messages()` response shape is typed by the SDK but unverified against a live opencode here (none installed); the plugin tests run against a fake client built from the published SDK types, and the spool meta line carries `format: 1` so a field mismatch surfaces as a versioned import error, not silent corruption.
- The exact tool names opencode uses for file mutation (`write`/`edit`/`patch`) need verification against the docs during implementation; the matcher is a conservative allowlist and misses only the reminder nicety, never capture.
