# Agent Write Contract Suite - provider-agnostic write sessions, backend boundary, shared namespace, decision panel

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

External agents need to propose structured Brain artifacts, but OSB has no agent-facing write lifecycle: validation can reject malformed output, yet there is no session that tells the caller what to generate, returns machine-readable correction errors without losing state, caps retries, guards path collisions, and only commits when the artifact satisfies schema and safety rules. Three adjacent gaps share the same theme: memory rendering is hardcoded to the Claude format with no backend seam, writes by one agent are invisible to sibling agents even when the operator wants a shared substrate, and there is no structured multi-persona deliberation surface. All four must land without putting an LLM inside the deterministic core.

## Scope

- One file-backed write-session kernel (`src/core/brain/write-session/`): session store with TTL and retry cap, JSON envelopes (`needs-llm-step`, `needs-correction`, `needs-review`, `done`, `failed`), artifact validation with machine-readable errors and a compact correction prompt, path-collision guard requiring explicit overwrite/merge intent, operator approval step, audit trail through the existing log chokepoint. (t_bc36a8a2)
- Decision panel as a session kind riding the same kernel: persona definitions in `Brain/personas/` with a built-in default lens set, per-persona prompt steps, a synthesis step, and a committed structured decision note. The calling agent supplies every generated text; OSB sequences, validates, and commits. (t_0cc6fdff)
- Memory-source backend boundary (`src/core/brain/agent-backend/`): a `MemorySourceBackend` protocol plus registry, with the existing `claude-memory-*` flow wrapped as the first backend and config-driven selection. Behavior with the default backend is byte-identical to today. (t_53f9f67f)
- Cross-agent shared namespace (`src/core/brain/shared-namespace.ts`): an opt-in config key that mirrors explicit remember-writes (signals and notes) into a second vault namespace with per-agent attribution and origin metadata; mirror failures never break the primary write. (t_936a1a61)
- CLI verbs `o2b brain session ...` and `o2b brain panel ...`; one new MCP tool `brain_write_session` (kind discriminator covers artifact and panel sessions).

## Out of scope

- Any LLM call inside OSB - generation always belongs to the calling agent.
- Bidirectional sync or conflict resolution for the shared namespace (mirror is one-way, append-style).
- Non-Claude memory backends beyond the protocol + registry + Claude adapter (a second adapter ships when a real format is in hand).
- Merge semantics that rewrite existing artifact content (merge intent appends a clearly delimited section; full three-way merge is deferred).
- Schema-pack mutations or new validation grammar - sessions validate against the existing schema-pack vocabulary and frontmatter contracts.

## Chosen approach

Consultant Variant 1 (unified session kernel), accepted with containment refinements. One generic write-session state machine is the literal deliverable of t_bc36a8a2; the decision panel is a session kind on that kernel (persona loading plus a synthesis schema), not a second lifecycle. The backend boundary stays a deliberately narrow seam around the memory-import flow - the session kernel does NOT consult backends (refinement against speculative coupling). The shared namespace is an independent fail-soft hook at the existing `writeSignal`/`appendLogEvent` chokepoints, invoked by the surface handlers after the primary write succeeds.

## Design decisions

- **Session storage**: one JSON file per session under `Brain/.sessions/write/<id>.json` (snake_case fields), atomic writes, consistent with `Brain/.payloads/`. Survives restarts; Syncthing-friendly (no symlinks, no in-place rewrites beyond atomic replace).
- **Lazy TTL**: expiry is evaluated on read (an expired session reads as `failed` with reason `expired`); a `sweep` operation deletes terminal and expired files. No daemon.
- **Envelope grammar**: every operation returns `{status, session_id, kind, step, prompt, schema_hints, errors, attempts_left, expires_at, existing}` - stable JSON, documented, no optional surprises. `errors` entries are `{code, path, message}`.
- **Retry cap**: default 3 submits per step; exhaustion is terminal `failed`. Validation failure preserves session state (the correction loop never loses the target or schema).
- **Collision guard**: opening an artifact session against an existing path returns `existing` metadata (byte length, content hash, first heading); submit commits only when the session was opened with explicit `overwrite` or `merge` intent. Merge appends a delimited section, never rewrites existing bytes.
- **Reserved-deny and review policy**: targets must resolve inside `Brain/` with no traversal; `Brain/preferences/`, `Brain/log/`, `Brain/.sessions/`, `Brain/.payloads/`, and `Brain/_brain.yaml` are denied outright. A session opened with `require_review: true` stops at `needs-review` after validation; `approve` is a separate operator-side operation. Review is an explicit per-session flag, not a namespace list - panel sessions commit their own decision notes without review unless opened with the flag.
- **Audit**: terminal sessions (done, failed, abandoned, approved) append one `write_session` event through `appendLogEvent` - the JSONL sidecar and dream visibility come for free.
- **Panel personas**: `Brain/personas/<slug>.md` with frontmatter (`kind: persona`, `lens`); when the directory is absent the built-in default set (technical, strategic, risk, user-experience) is used. Panel steps are deterministic: personas in declared order, then `synthesis`. The committed note lands at `Brain/decisions/panels/panel-<date>-<topic-slug>.md` with per-persona sections and the synthesis.
- **Backend protocol**: `MemorySourceBackend` exposes `id`, `discoverMemoryPaths`, `parseMemories`, `renderPreference`. The registry is a frozen map; selection reads the `memory_backend` config key (default `claude`); an unknown id fails with the registered list. The Claude adapter delegates to the existing `claude-memory-*` modules - no logic moves, no public API changes.
- **Shared namespace key**: `shared_namespace: <absolute path>` in the device config (`config.yaml`), matching how `vault:` itself is device-level. Empty or missing means off - zero behavior change. Mirrored records carry `origin_vault` (basename of the primary vault) next to the existing agent attribution; mirror outcome surfaces as `mirror: "ok" | "failed" | "off"` in tool results but never throws.
- **MCP growth**: exactly one new tool (`brain_write_session`, op + kind discriminators), advertised count 65 -> 66. The panel gets CLI sugar (`o2b brain panel`), not a second tool.

## File changes

New: `src/core/brain/write-session/{types,store,validate,engine,panel,personas}.ts`, `src/core/brain/agent-backend/{types,registry,claude}.ts`, `src/core/brain/shared-namespace.ts`, `src/cli/brain/verbs/{session,panel}.ts`, tests under `tests/core/brain/write-session/`, `tests/core/brain/agent-backend.test.ts`, `tests/core/brain/shared-namespace.test.ts`, `tests/cli/{brain-session,brain-panel}.test.ts`, `tests/mcp/brain-write-session.test.ts`, `tests/e2e/agent-write-contract.integration.test.ts`.

Modified: `src/mcp/brain-tools.ts` (new tool), `src/mcp/tools.ts` (table), MCP contract tests asserting tool count, `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, the import-claude-memory verb (backend selection seam, default unchanged), MCP `brain_feedback`/`brain_note` handlers and CLI feedback/note verbs (mirror hook), `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md`.

## Risks and open questions

- The kernel must serve both artifact and panel flows without leaking panel needs into the envelope - mitigated by a `kind` discriminator and panel-only fields kept inside the session record, not the envelope grammar.
- Import-flow wiring through the backend registry must stay byte-identical for the default backend - covered by regression tests comparing rendered output before and after the seam.
- Mirror writes into a second vault could surprise dream passes there - mirrored records are ordinary signals/notes with attribution, which is exactly the upstream semantic (shared facts become first-class in the shared substrate).
- Session files are vault-synced; concurrent submits from two devices could race - last-write-wins on the session file is acceptable for v1 and recorded in docs; commits themselves stay atomic and validated.
