You are helping select and then brainstorm the scope of the NEXT release for the Open Second Brain project. Do not write code. Do not write a final design. Your job has two parts: (1) recommend the single most useful RELATED cluster of low-priority triage tasks to ship as one release, and (2) for that recommended cluster, produce architectural variants.

# Selection objective

From the triage column below, pick a COHERENT cluster of tasks that:

- Share a subsystem or a single architectural theme (a "related cluster", not a grab-bag).
- Are LOW / minor priority on this board. Priority scale here is: 4 = highest, 0 = unprocessed/lowest. Prefer p0-p1 clusters; p2 only if tightly related to the chosen theme.
- Maximize USEFULNESS to the project. Usefulness is the most important criterion by far. The number of files touched and exact feature count are the WEAKEST signals - do not optimize for them.
- Are buildable additively, without architectural unknowns that need a separate ADR, and without depending on reverse-engineering an external/unstable data format (treat "needs reverse-engineering of an external transcript/session format" as a blocking risk).

Explicitly AVOID recommending:

- Large architectural subsystems the board's validator flagged as "needs ADR / design discussion" (PDF export, voice/STT-TTS, whiteboard, 15-adapter architecture, universal agent runtime contract, LLM tracing, inbox-pill UI, subagent orchestration).
- Thin passthroughs to an external binary that would silently no-op when that binary is absent (e.g. a `reindex --force` verb that just shells out to an absent `graphify`) - the project forbids misleading fallbacks.
- Anything gated on an unmerged upstream PR.

# Project context

- Name: Open Second Brain. Language/runtime: TypeScript on Bun. Storage: SQLite (bun:sqlite, FTS5 + sqlite-vec). Surfaces: an MCP stdio server, an `o2b` CLI, and an Obsidian/Markdown vault.
- The kernel is provider-agnostic: it NEVER calls an LLM itself. Any AI extraction must be agent-driven (via an MCP tool or a lifecycle hook); the kernel only stores already-extracted structured data.
- Hard guarantees the project holds itself to: byte-identical reads when a new feature flag/surface is unused; language-agnostic behavior (NO hardcoded natural-language word lists in any language - use structural signals, frontmatter fields, document-frequency, or agent/LLM extraction); no misleading fallbacks; no hardcoding; no `as` TypeScript cast crutches.
- Two relevant registry-driven subsystems already exist and are explicitly designed for easy extension:
  1. `src/core/install/adapters/` - writes the Open Second Brain MCP servers (and optional lifecycle hooks) into a third-party coding agent's own config. Present targets: aider, copilot-cli, cursor, gemini-cli, generic, grok, kiro, opencode, pi. A thin adapter is ~25 lines via the shared `_json-mcp.ts` base; bespoke hook+MCP adapters (grok) are larger. NOTE: the adapter-registration import list is currently duplicated verbatim across 4 CLI entry files (install.ts, init-interactive.ts, uninstall-target.ts, update.ts) - a latent DRY problem.
  2. `src/core/brain/sessions/` - session-import adapters that read an agent's transcript files and ingest them. Present: claude, codex, grok, hermes, opencode. Registry self-documents the 3-step add procedure. Adding a runtime here requires KNOWING that runtime's on-disk transcript format.

Recent shipped releases (most recent first):
- v1.10.0 Recall & Working-Memory Quality - selectable recall profiles, usage decay, co-occurrence auto-relate, file-context recall
- v1.9.0 Brain Portability & Interop - bank export/import, page contract, brain_create_note, in-process SDK
- v1.8.0 Indexer Durability & Resilience - cooperative abort, graceful watch shutdown, resumable reindex
- v1.7.0 Knowledge Provenance - ingest, research, NER, derived facts, owner-scope, standing-query
- v1.6.0 Vault Integrity & Trust; v1.5.0 Search & Recall Quality; v1.4.0 native Grok integration; v1.3.0 opencode integration + Continuity/Hygiene/Freshness

Constraints for the chosen cluster:
- Do not change existing public APIs in a breaking way.
- No new external runtime dependencies unless unavoidable.
- Every new surface must be byte-identical-when-unused and language-agnostic.

# Triage column (every task with body and comments)

<<<TRIAGE
[The full triage column - 42 tasks with bodies and comments - was fed in verbatim at runtime via `kanban.ts triage`. Omitted from the committed audit trail to avoid persisting a board snapshot in the repo; the live board is the source of truth.]
TRIAGE

# Required output format

## Part 1 - Scope recommendation

### Candidate clusters
List 2-4 candidate clusters you considered. For each: the cluster name, the task IDs in it, the shared theme, and a one-line usefulness/risk note.

### Recommended cluster
- **Name**:
- **Task IDs**:
- **Why this cluster** (3-5 sentences, usefulness-first):
- **Why not the others** (1-2 sentences each):
- **Key risks and how to neutralize them**:

## Part 2 - Architectural variants for the recommended cluster

Produce exactly 3 distinct architectural variants for IMPLEMENTING the recommended cluster. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants:

### Recommended: Variant N
**Rationale**: 2-3 sentences, considering the project context and constraints above.

Output nothing outside of these sections.
