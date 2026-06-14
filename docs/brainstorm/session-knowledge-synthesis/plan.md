# Session Knowledge Synthesis - implementation plan

Three atomic features on one branch (`feat/session-knowledge-synthesis`), each
built TDD-first, each its own conventional commit. Order is chosen so the
shared continuity-store touch (Task A) lands before the read-side consumers.

## Task A: Structured session summary (`t_325a7e4a`)

- **Files**:
  - `src/core/brain/session-summary.ts` (new) - `SessionSummaryDigest` type
    (request: string; decisions/learnings/next_steps: string[]),
    `appendSessionSummary(vault, input)` (agent-supplied categories ->
    validated, content-hash deduped, appended as `session_summary_digest`),
    `getSessionSummary(vault, sessionId)` (latest digest for a session).
  - `src/core/brain/continuity/types.ts` (mod) - add `session_summary_digest`
    to `ContinuityRecordKind`.
  - `src/core/brain/continuity/read-model.ts` (mod) - normalize the new kind
    (lift `session_id`).
  - `src/mcp/brain/...` (new tool) - `brain_session_summary` with two modes or
    two tools: write (agent supplies categories) and read (fetch a session's
    digest). Register in the per-domain tool array; update
    `FROZEN_BRAIN_TOOL_NAMES` + tool-count assertions.
  - `src/cli/brain/verbs/session-summary.ts` (new) + `verbs/index.ts` (mod).
- **Acceptance**:
  - Append rejects a payload missing all four categories (no empty digest).
  - Re-appending identical categories for a session dedupes (content hash).
  - `getSessionSummary` returns the latest digest; absent -> null, not a fake.
  - Byte-identical continuity reads when the tool is never called.
- **Depends on**: none.

## Task B: Idea lineage (`t_635a3ea5`)

- **Files**:
  - `src/core/brain/idea-lineage.ts` (new) - `traceIdeaLineage(vault, {id})`
    walks `sourceRefs` backward from a derived artifact, merges belief-evolution
    transitions and dream-summary provenance, returns an ordered
    observation -> synthesis -> conclusion chain with a seen-set cycle guard and
    a bounded depth.
  - `src/mcp/brain/...` (new tool) - `brain_idea_lineage`; register + update
    frozen names / counts.
  - `src/cli/brain/verbs/idea-lineage.ts` (new) + `verbs/index.ts` (mod).
- **Acceptance**:
  - A digest (Task A) whose `sourceRefs` point at session turns traces back to
    those turns.
  - A preference traces through its belief-evolution creation/promotion.
  - Cyclic sourceRefs terminate (seen-set); depth is bounded and reported.
  - Unknown id -> typed error, not a silent empty chain.
- **Depends on**: Task A (provides a concrete derived artifact to trace).

## Task C: Episodic note history (`t_6a201155`)

- **Files**:
  - `src/core/brain/note-history.ts` (new) - `decomposeNoteHistory(vault,
    notePath, opts)`: read the note's commit chain via `git/reader.ts`
    (`readCommits` with a path filter), split into phases on a configurable
    commit-time-gap threshold (deterministic, structural), emit
    `NoteHistoryPhase[]` (commit range, first/last date, author set, touched
    paths, optional agent-supplied `summary` with `enriched` flag).
  - `src/mcp/brain/...` (new tool) - `brain_note_history`; register + update
    frozen names / counts.
  - `src/cli/brain/verbs/note-history.ts` (new) + `verbs/index.ts` (mod).
- **Acceptance**:
  - Missing repo / non-repo dir -> "no history available" (reader null), not an
    empty phase list pretending success.
  - Empty repo (zero commits) is distinguished from breakage (reader []).
  - A commit chain with a gap above threshold splits into >1 phase; below, 1.
  - Phase summary defaults to a deterministic skeleton with `enriched: false`;
    an agent-supplied summary sets `enriched: true`.
  - Phase splitting is independent of commit-message language (no NL rule).
- **Depends on**: none (parallel to A/B, but committed last to keep the diff
  reviewable).

## Cross-cutting (Phase 4-5, once A/B/C are in)

- Full suite green (`bun test`), typecheck (`bun run typecheck`), lint
  (`bun run lint`), version-sync check (`bun run scripts/sync-version.ts
  --check`).
- `tests/mcp/removed-tools.test.ts` tool-count (78 -> 78 + new top-level tools)
  and `FROZEN_BRAIN_TOOL_NAMES` updated.
- Docs: README, CHANGELOG (`## [X.Y.Z]` + compare link), docs/mcp.md,
  docs/cli-reference.md.
- Version bump in `package.json` + `bun run scripts/sync-version.ts`.
