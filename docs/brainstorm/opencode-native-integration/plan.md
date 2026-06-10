# opencode native integration - implementation plan

Design: `design.md`. Each task is one atomic conventional commit on `feat/opencode-native-integration`, test-first.

## Tasks

### Task 1: Pluggable MCP entry shape in the shared JSON-merge layer
- **Files**: `src/core/install/json-merge.ts`, `src/core/install/adapters/_json-mcp.ts`, `src/core/install/payload-equals.ts`, `tests/core/install/adapters/json-mcp-smoke.test.ts` (+ a focused unit test for the new injection points)
- **Acceptance**: `mergeMcpServers` / `removeMcpServers` / drift comparison accept optional `serializeEntry` and `entryEquals`; with them omitted, output for cursor/kiro/gemini-cli fixtures is byte-identical to today (smoke test pins it); a custom shape round-trips through merge → detect → verify.
- **Depends on**: none

### Task 2: opencode install adapter rewrite (opencode.json `mcp` block + legacy migration)
- **Files**: `src/core/install/adapters/opencode.ts`, `tests/core/install/adapters/opencode.test.ts`, `tests/fixtures/install/opencode/*`
- **Acceptance**: apply on a clean home writes `~/.config/opencode/opencode.json` with `mcp.open-second-brain` and `mcp.open-second-brain-writer` shaped `{type:"local", command:[array], environment, enabled:true}` preserving user keys; apply with a legacy `~/.config/opencode/mcp.json` containing our keys removes them (file deleted only when empty and manifest-owned); detect/plan/verify/uninstall lifecycle green including drift detection on the new shape; XDG_CONFIG_HOME honored.
- **Depends on**: Task 1

### Task 3: Bundled opencode plugin (single file, zero-dep)
- **Files**: `plugins/opencode/open-second-brain.ts`, `src/core/install/opencode-plugin-asset.ts`, `tests/plugins/opencode-plugin.test.ts`
- **Acceptance**: plugin module exports the opencode plugin function; with a fake `client` and temp XDG dirs: (a) `event` session.idle/compacted/deleted produces a spool snapshot `<sessionID>.jsonl` with meta line `format:1` + normalized turn lines, atomic rewrite, idempotent across repeated idles; (b) `experimental.chat.system.transform` appends rendered context when the `o2b-hook active-inject` spawn succeeds (fake via `OSB_HOOK_BIN` pointing at a stub script) and no-ops (no throw) when the binary is missing; (c) `tool.execute.after` appends the reminder only for file-mutating tool ids; (d) every hook body swallows internal errors (fail-soft assertion with a throwing fake client).
- **Depends on**: none

### Task 4: Plugin installation through the adapter (copy + manifest + drift)
- **Files**: `src/core/install/adapters/opencode.ts`, `src/core/install/opencode-plugin-asset.ts`, `tests/core/install/adapters/opencode.test.ts`
- **Acceptance**: apply copies the bundled plugin into `~/.config/opencode/plugins/open-second-brain.ts` with version-stamped header; manifest records the content hash; verify reports drift when the installed copy is edited; uninstall removes the plugin file; re-apply after upgrade refreshes the copy.
- **Depends on**: Task 2, Task 3

### Task 5: opencode session adapter + registry wiring
- **Files**: `src/core/brain/sessions/opencode.ts`, `src/core/brain/sessions/types.ts`, `src/core/brain/sessions/registry.ts`, `tests/core/brain.sessions.opencode.test.ts`, `tests/fixtures/sessions/opencode-minimal.jsonl`, cross-table cases in `tests/core/brain.sessions.registry.test.ts`
- **Acceptance**: `detect` matches only the spool meta line (originator `open-second-brain-opencode-plugin`), rejects claude/codex/hermes first lines and vice versa (cross-table test extended to 4x4); `iterate` yields normalized turns incl. tool calls; `importSession` on the fixture produces the same counter semantics as other adapters; unknown `format` > 1 fails with a versioned error.
- **Depends on**: Task 3 (spool format frozen)

### Task 6: Docs and changelog
- **Files**: `install/opencode.md`, `install.md`, `README.md`, `CHANGELOG.md`
- **Acceptance**: install/opencode.md documents the full flow (install, what gets written where, plugin behavior, spool import command, known gaps: no stop guardrail, experimental inject); install.md table row updated; README runtime list updated; CHANGELOG entry under the next version header; `bun run lint` and docs checks green.
- **Depends on**: Tasks 1-5
