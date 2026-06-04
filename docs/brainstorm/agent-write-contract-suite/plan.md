# Agent Write Contract Suite - implementation plan

## Tasks

### Task 1: write-session store and types
- **Files**: `src/core/brain/write-session/types.ts`, `src/core/brain/write-session/store.ts`, `tests/core/brain/write-session/store.test.ts`
- **Acceptance**: session records round-trip through `Brain/.sessions/write/<id>.json` (snake_case on disk, camelCase in TS); id allocation is collision-safe; lazy TTL turns an expired record into terminal `failed` with reason `expired` on read; `sweepSessions` removes terminal and expired files; corrupted session files read as a probe error, never throw.
- **Depends on**: none

### Task 2: artifact validation and target policy
- **Files**: `src/core/brain/write-session/validate.ts`, `tests/core/brain/write-session/validate.test.ts`
- **Acceptance**: target paths must resolve inside `Brain/` (traversal and absolute escapes rejected); reserved namespaces (`Brain/preferences/`, `Brain/log/`, `Brain/.sessions/`, `Brain/.payloads/`, `Brain/_brain.yaml`) are denied with coded errors; artifacts validate frontmatter shape, declared schema-pack type/tag vocabulary, and size caps; every failure is `{code, path, message}`; a compact correction prompt is built from the error list.
- **Depends on**: Task 1

### Task 3: session engine - lifecycle, correction loop, collision guard, audit
- **Files**: `src/core/brain/write-session/engine.ts`, `tests/core/brain/write-session/engine.test.ts`
- **Acceptance**: `openArtifactSession` returns a `needs-llm-step` envelope with prompt and schema hints, and `existing` metadata (length, content hash, first heading) when the target exists; `submitArtifact` returns `needs-correction` with errors and decremented `attempts_left` on validation failure, terminal `failed` at the retry cap, `needs-review` when review is required, and `done` with an atomic commit otherwise; commits against an existing path require the session's explicit `overwrite` or `merge` intent (merge appends a delimited section); `approveSession` commits a reviewed artifact; `abandonSession` is terminal; every terminal transition appends one `write_session` event via `appendLogEvent`.
- **Depends on**: Tasks 1, 2

### Task 4: decision panel kind - personas, steps, synthesis, committed note
- **Files**: `src/core/brain/write-session/personas.ts`, `src/core/brain/write-session/panel.ts`, `tests/core/brain/write-session/panel.test.ts`
- **Acceptance**: personas load from `Brain/personas/*.md` (frontmatter `kind: persona`, `lens`) with the built-in default set (technical, strategic, risk, user-experience) when the directory is absent; `openPanelSession` walks deterministic steps `persona:<slug>` in order then `synthesis`, each envelope carrying that step's prompt; per-step submits validate non-empty bounded text and reuse the kernel correction loop; the final commit renders `Brain/decisions/panels/panel-<date>-<topic-slug>.md` with frontmatter, per-persona sections, and the synthesis; the panel adds no new envelope fields.
- **Depends on**: Task 3

### Task 5: memory-source backend boundary
- **Files**: `src/core/brain/agent-backend/types.ts`, `src/core/brain/agent-backend/registry.ts`, `src/core/brain/agent-backend/claude.ts`, `tests/core/brain/agent-backend.test.ts`
- **Acceptance**: `MemorySourceBackend` protocol (`id`, `discoverMemoryPaths`, `parseMemories`, `renderPreference`); frozen registry with `claude` registered; `resolveMemoryBackend` reads the `memory_backend` config key, defaults to `claude`, and fails on unknown ids with the registered list in the message; the Claude adapter delegates to existing `claude-memory-*` modules and its rendered output is byte-identical to calling them directly; the import flow resolves through the registry with unchanged default behavior.
- **Depends on**: none

### Task 6: cross-agent shared namespace mirror
- **Files**: `src/core/brain/shared-namespace.ts`, `tests/core/brain/shared-namespace.test.ts`, mirror hooks in `src/mcp/brain-tools.ts` (`brain_feedback`, `brain_note`) and `src/cli/brain/verbs/` feedback/note paths
- **Acceptance**: `resolveSharedNamespace` reads the `shared_namespace` config key (missing/empty = off); `mirrorSignal`/`mirrorNote` write the same record into the shared vault with `origin_vault` attribution alongside the agent identity; any mirror failure is swallowed and reported as `mirror: "failed"` while the primary write result is untouched; default-off means byte-identical behavior for existing setups; tool and CLI results carry `mirror: "ok" | "failed" | "off"` only when the feature is configured; unconfigured setups stay silent.
- **Depends on**: none

### Task 7: CLI verbs - session and panel
- **Files**: `src/cli/brain/verbs/session.ts`, `src/cli/brain/verbs/panel.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-session.test.ts`, `tests/cli/brain-panel.test.ts`
- **Acceptance**: `o2b brain session open|submit|approve|abandon|status|list|sweep` and `o2b brain panel open|submit|status` drive the kernel end-to-end with `--json` envelopes; artifact bodies come from `--file` or stdin; errors exit 1 with the envelope on stdout; help text and command manifest list both verbs.
- **Depends on**: Tasks 3, 4

### Task 8: MCP tool brain_write_session
- **Files**: `src/mcp/brain-tools.ts`, `src/mcp/tools.ts`, contract tests asserting the advertised tool count, `tests/mcp/brain-write-session.test.ts`
- **Acceptance**: one tool with `op` (`open|submit|approve|abandon|status|list`) and `kind` (`artifact|panel`) discriminators returning the same envelopes as the CLI; advertised count moves 65 -> 66 in full scope and contract tests are updated deliberately; writer scope is unchanged.
- **Depends on**: Tasks 3, 4

### Task 9: end-to-end integration test
- **Files**: `tests/e2e/agent-write-contract.integration.test.ts`
- **Acceptance**: one flow per feature against a real tmp vault: artifact session open -> invalid submit -> correction envelope -> valid submit -> committed file plus audit event; panel open -> four persona submits -> synthesis -> committed decision note; backend registry resolves claude and renders a preference; shared namespace mirrors a signal and a note with attribution while a broken shared path degrades to `mirror: "failed"` without harming the primary write.
- **Depends on**: Tasks 3, 4, 5, 6

### Task 10: docs
- **Files**: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md`
- **Acceptance**: CHANGELOG `[0.41.0]` entry; README capability sentence; CLI reference section for `brain session` and `brain panel`; how-it-works section describing the write-session contract and the no-LLM-in-core rule it preserves.
- **Depends on**: Tasks 1-9
