# Grok Build native integration - implementation plan

One feature branch `feat/grok-native-integration`, atomic conventional commits, TDD per unit
(failing test first). Implementation order is risk-first: build the plugin and prove the
enable-semantics against live grok 0.2.45 before the rest depends on it.

## Tasks

### Task 1: Bundled grok plugin tree + asset module (kanban t_b69deebd)
- **Files**: `plugins/grok/open-second-brain/plugin.json`, `.mcp.json`, `hooks/hooks.json`,
  `hooks/bin/*`; `src/core/install/grok-plugin-asset.ts`; `tests/plugins/grok-plugin.test.ts`.
- **Acceptance**: `grok plugin validate plugins/grok/open-second-brain` passes; `.mcp.json`
  carries the two canonical entries built from the shared `McpServerEntry` payload (no
  duplication); `grok-plugin-asset.ts` returns the tree + version stamp; hooks are fail-soft and
  unit-tested offline with stub stdin + stub `o2b-hook`.
- **Depends on**: none.

### Task 2: Grok install adapter + minimal TOML enable helper (kanban t_8fdd6077)
- **Files**: `src/core/install/grok-config.ts`; `src/core/install/adapters/grok.ts`; registry
  registration; target-id union if present; `tests/core/install/grok-config.test.ts`,
  `tests/core/install/adapters/grok.test.ts`, `tests/fixtures/install/grok/`.
- **Acceptance**: `o2b install --target grok --apply` copies the plugin tree into
  `~/.grok/plugins/open-second-brain/` (honoring `GROK_HOME`), ensures `[plugins] enabled`
  idempotently, records `owned_paths`; `verify` flags a missing/edited file or missing enable
  entry as drift; `uninstall` removes exactly what was installed and drops the enable entry;
  dry-run plan matches apply. `grok-config.ts` ensures/removes the table + array membership
  without a TOML lib and without disturbing other sections.
- **VERIFY FIRST against live grok**: after a real `apply`, `grok inspect --json` must show the
  plugin's MCP servers and hooks active. If grok needs an ID form (`<scope>/<hash>/<name>`)
  rather than the bare name in `enabled`, adjust `grok-config.ts` accordingly.
- **Depends on**: Task 1.

### Task 3: Grok hook-payload compatibility (kanban t_23cd40bc)
- **Files**: `hooks/lib/stdin.ts`, `hooks/lib/detect.ts`; `tests/hooks/grok-stdin.test.ts`.
- **Acceptance**: grok's camelCase payload (`hookEventName`/`sessionId`/`cwd`/`workspaceRoot`/
  `toolName`/`toolInput`) normalizes to the internal shape via one declarative mapping; existing
  Claude/Codex payloads still parse unchanged; runtime detection recognizes grok via `GROK_*`
  env + payload shape; a missing `transcript_path` is an explicit typed-optional branch, not a
  faked default; unknown payload fails explicitly.
- **Depends on**: none (integrates with Task 1's hooks at QA).

### Task 4: Grok session import adapter (kanban t_fc98eef2)
- **Files**: `src/core/brain/sessions/grok.ts`; `SESSION_ADAPTERS` + `SessionAdapterId`;
  `tests/core/brain.sessions.grok.test.ts`; `tests/fixtures/sessions/grok-minimal.jsonl`.
- **Acceptance**: adapter `detect()` keys on the ACP `updates.jsonl` structure; iterator yields
  `SessionTurn`-shaped turns; lineage from sibling `summary.json` `parent_session_id`;
  cross-table detect test extended (no adapter collision); a newer ACP shape fails with a
  versioned PARSE error. Fixture captured from a real grok session.
- **Depends on**: none.

### Task 5: Docs (kanban t_f7111278)
- **Files**: `install/grok.md` (new); `install.md`, `README.md`, `docs/how-it-works.md`,
  `CHANGELOG.md`.
- **Acceptance**: every shipped capability documented; full product name throughout; no
  abbreviations, exclamation marks, em-dashes, or AI-authorship markers; any mermaid renders on
  GitHub; known gaps documented (no `transcript_path`; plugins disabled by default until enabled;
  Claude-compat overlap explained). One CHANGELOG entry under the next version header.
- **Depends on**: Tasks 1-4 (docs describe what actually shipped).

## QA (Phase 4, after all tasks)

- `bun test`, `bun run typecheck`, `bun run lint`, `bun run scripts/sync-version.ts --check`.
- Live smoke test against grok 0.2.45: install, `grok inspect --json` shows MCP + hooks, trigger
  a file edit (PostToolUse nudge), end a session and import it into the Brain, `grok mcp list`.
