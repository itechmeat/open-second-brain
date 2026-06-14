# Session Knowledge Synthesis - structured session summaries, idea lineage, and episodic note history

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain stores rich temporal activity - session turns, preference
lifecycle transitions, dream synthesis output, git-backed note history - but
three slices of that activity are not yet queryable as structured, provenance-
traced knowledge:

1. A whole session is recallable only as hierarchical text rollups
   (`session_summary_node`) or scattered labelled lines (`pre_compact_extract`);
   there is no single session-scoped digest answering "what was the request,
   what did we decide, what did we learn, what is next" as one unit.
2. There is no read-side tracer that reconstructs how a derived insight was
   reached (observation -> synthesis -> conclusion) from the source edges the
   continuity store already records.
3. A note's evolution over time is not decomposed into recallable episodic
   phases; the git history exists (read-only reader shipped) but nothing turns
   a note's commit chain into searchable phase records.

## Scope

- **Feature A - structured session summary (`t_325a7e4a`).** A session-scoped
  digest with the four canonical categories request / decisions / learnings /
  next_steps. The agent extracts the categories (kernel never calls an LLM);
  the kernel validates and stores one continuity record per session, and a
  read surface returns it as a unit.
- **Feature B - idea lineage (`t_635a3ea5`).** A pure read-side tracer that,
  given a derived artifact (a preference, a session summary, a derived fact),
  walks the existing `sourceRefs` edges plus belief-evolution transitions and
  dream output to reconstruct the observation -> synthesis -> conclusion chain.
- **Feature C - episodic note history (`t_6a201155`).** Given a note path,
  read its commit chain via the existing sanitized git reader, decompose it
  into episodic phases by a deterministic structural rule (time gaps), and
  emit recallable phase records; per-phase prose summary is agent-supplied or
  a deterministic skeleton when no agent enriches it.

## Out of scope

- Daily / morning brief (`t_e4ddbe7c`): already shipped (`brain_brief`
  view=morning / view=daily); closed as already-present, no code here.
- Any new coding-agent install adapter or session-import adapter (operator
  excluded "adding new agents" this cycle).
- Embedding-backed semantic search over phase records beyond what the existing
  index already provides; phases are recallable through the existing surfaces,
  not a new vector store.
- Mutating notes, sessions, or preferences. Every feature is additive and
  read-or-append only.

## Chosen approach

Variant 1 from the consultant (`cli-output/claude.md`): agent-extracted
structured records plus read-side synthesis tools, with the discipline borrowed
from Variant 2 that every AI-derived field is optional and marked derived, so
absence of a provider degrades to a deterministic structural skeleton and never
a fabricated summary.

Concretely:

- **Storage** reuses the append-only continuity store
  (`Brain/log/continuity/YYYY-MM.jsonl`) and its `sourceRefs` edge field. A new
  record kind is added to the closed `ContinuityRecordKind` union for the
  session digest; note-history phases reuse the same store. No schema migration
  - the store is append-only and every record self-stamps its schema version.
- **Extraction** is agent-driven through MCP tools that accept already-extracted
  structured fields (the proven `brain_pre_compact_extract` pattern). The kernel
  validates shape, dedupes by content hash, and appends. The kernel performs no
  natural-language parsing beyond the existing structural label grammar.
- **Read surfaces** are pure projections (the `buildDailyBrief` pattern):
  deterministic, no disk mutation, byte-identical to absence when unused.

## Design decisions

- **Distinct record kind for the session digest.** The existing
  `session_summary_node` kind is a hierarchical recall rollup; overloading it
  would conflate two shapes. Add a new kind (e.g. `session_summary_digest`) so
  recall, lineage, and the rollup stay structurally separable. Additive to the
  union; `read-model.ts` normalization extends to lift `session_id`.
- **Categories are data, not kernel grammar.** request / decisions / learnings
  / next_steps are stored as agent-supplied arrays. The kernel does not infer
  them from prose with a natural-language word list - that would break the
  language-agnostic guarantee. An agent (any provider, any language) supplies
  them; absent an agent, the digest is simply not written (no fake digest).
- **Idea lineage adds no new storage.** It is a read-side walk over edges that
  already exist (`sourceRefs`, belief-evolution transitions, dream summaries).
  This keeps it byte-identical-when-unused and avoids a second provenance graph.
- **Note-history phase splitting is deterministic and structural.** Phases are
  cut on commit time gaps (a configurable threshold), not on NL topic detection.
  This is language-agnostic and reproducible. Per-phase prose summary is an
  optional agent enrichment, marked derived; the skeleton (commit range, dates,
  author set, touched paths) is always available from the git reader alone.
- **Fail-soft, honest absence.** Missing git repo -> reader returns null ->
  "no history available" (not an empty fabricated phase). Missing agent
  extraction -> skeleton only, with an explicit `enriched: false`. No
  misleading fallback anywhere.

## File changes

New (core):
- `src/core/brain/session-summary.ts` - digest record shape, append (agent-
  supplied categories), and read (`getSessionSummary(vault, sessionId)`).
- `src/core/brain/idea-lineage.ts` - read-side lineage tracer over sourceRefs +
  belief-evolution + dream output.
- `src/core/brain/note-history.ts` - git-reader-backed phase decomposition.

Modified (core):
- `src/core/brain/continuity/types.ts` - add `session_summary_digest` (and, if
  needed, a note-history phase kind) to `ContinuityRecordKind`.
- `src/core/brain/continuity/read-model.ts` - normalize the new kind(s).
- `src/core/brain/session-lifecycle.ts` - optional hook point to fold a stored
  digest into the SessionEnd result (read-back only, no new write path).

New (MCP):
- session-summary write + read tools, idea-lineage tool, note-history tool,
  registered through the existing per-domain tool arrays in `brain-tools.ts`.
  Update `FROZEN_BRAIN_TOOL_NAMES` and the tool-count assertions accordingly.

New (CLI):
- `src/cli/brain/verbs/session-summary.ts`, `idea-lineage.ts`,
  `note-history.ts`, each exported from `verbs/index.ts` and wired into the
  brain dispatcher; usage errors via the `usageError()` helper (exit 2).

Docs:
- `README.md`, `CHANGELOG.md`, `docs/mcp.md`, `docs/cli-reference.md`.

Version: bump `package.json` and run `bun run scripts/sync-version.ts` inside
this PR (per `CLAUDE.md`).

## Risks and open questions

- **Overlap with `pre_compact_extract`.** Mitigation: the session digest is a
  session-scoped envelope with a fixed 4-category schema and its own read
  surface; it complements, not duplicates, the per-line extractor. Decide in
  Task A whether the digest tool reuses the extractor's storage helpers.
- **`git/reader.ts` has no current callers.** It is shipped and tested but
  unwired; note-history is its first consumer. Confirm its API
  (`readCommits`, path filter) covers per-note history before building Task C.
- **Tool-count test churn.** Adding top-level MCP tools changes
  `FROZEN_BRAIN_TOOL_NAMES` and the `tools/list` count assertion in
  `removed-tools.test.ts` (currently 78). Update both deliberately.
- **Lineage cycles.** The tracer must guard against cyclic sourceRefs (seen-set)
  and bound traversal depth, mirroring the existing lineage-ledger root walk.
