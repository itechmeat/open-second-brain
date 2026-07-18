# Belief lifecycle and decision memory - implementation plan

Ordering follows consultant Variant 3: each track's anchor lands first and
owns the track's shared abstraction; later units in the track consume it.
Tracks are mutually independent; standalone units are order-free. Each unit
lands as one atomic conventional commit with its tests, formatted (oxfmt) and
lint-clean (oxlint).

Sequence: A1 -> A2 -> A3 -> A4 -> B1 -> B2 -> B3 -> B4 -> B5 -> S1 -> S2 -> L
(Track B may run in parallel with Track A on the same branch; S1/S2 anytime.)

## Tasks

### Task A1 - cross-type tombstone + supersede lifecycle (`t_7d5a3589`, p2, Track A anchor)
- **Files**: new `src/core/brain/lifecycle/tombstone.ts` (state machine,
  idempotent tombstone, supersede-with-replacement, `resolveChainTip`),
  exclusion wiring in recall/inject/active/dream paths, curator read slices
  over observed-use verdicts surfaced through the existing read surface
  (brain_brief/schema_inspect style), CLI verb + MCP addition, event kinds in
  `src/core/brain/types.ts`, tests.
- **Acceptance**: tombstoning any memory type (preference, signal, learning)
  sets `_status`/`tombstoned_at`/`tombstone_reason` frontmatter without
  deleting the file; re-issuing is a byte-identical no-op; supersede records
  the replacement link; tombstoned and superseded-non-tip entries stop
  appearing in recall, inject, and `Brain/active.md` but remain readable for
  audit; curator slices list injected-never-used, contradicted, and high-used
  memories from observed-use verdicts; every lifecycle mutation logs a typed
  event.
- **Depends on**: none.

### Task A2 - atomic temporal fact-replacement (`t_3ba9c404`, p3)
- **Files**: new `src/core/brain/lifecycle/temporal-replace.ts`, tests.
- **Acceptance**: one operation closes the predecessor (`valid_to = T`) and
  opens the successor (`valid_from = T`) at one shared instant with half-open
  `[valid_from, valid_to)` semantics; date-only facts keep whole-day
  semantics; the pair is written atomically (both or neither); the successor
  link reuses `superseded_by`; point-in-time evaluation of the pair yields no
  gap and no overlap for any probe instant (property test); the existing
  conflict-resolution supersede path is untouched (its tests stay green).
- **Depends on**: A1 (same module family, chain link conventions).

### Task A3 - persisted claim-graph query surface (`t_6916369f`, p3)
- **Files**: new `src/core/brain/claim-graph.ts` (bounded persisted
  projection + rebuild), CLI verb `o2b brain claims`, MCP tool in the
  knowledge slice, tests.
- **Acceptance**: the projection composes existing `superseded_by`/
  `contradicts` relations and `valid_from`/`valid_until` fields plus
  provenance per claim; one query answers "true at instant T", "current
  truth", "what replaced X", "what contests X"; current-truth is the default
  and history/retracted content is opt-in; the projection is bounded (cap
  constant) and deterministically rebuildable; no extractor is modified.
- **Depends on**: A1, A2 (reads chain and interval conventions).

### Task A4 - supersedes-chain consumer policy (`t_d9365884`, p2)
- **Files**: new `src/core/brain/inject-governor.ts` (tip-preference
  bookkeeping), inject path (context-pack), `src/core/search/enrich.ts`
  (replacement-pointer annotation on superseded hits), dream decay
  acceleration, tests.
- **Acceptance**: a chain of 3 superseding memories injects only the tip
  under budget by default; an explicit historical flag keeps the chain; recall
  results for superseded items carry a pointer to their replacement; the dream
  pass retires low-recall superseded ancestors faster than live memories
  (deterministic threshold constants); non-chain memories behave
  byte-identically to today.
- **Depends on**: A1 (`resolveChainTip`).

### Task B1 - decision-record artifact (`t_ac03214d`, p3, Track B anchor)
- **Files**: new `src/core/brain/decisions/record.ts` (note family under
  `Brain/decisions/`, frontmatter schema, outcome backfill, similar-decision
  lookup), obligation wiring for `review_date`, CLI verb + MCP addition, event
  kinds, tests.
- **Acceptance**: capturing a decision writes a `type: decision` note with
  `chosen`, `assumption`, `review_date`, empty `outcome`, optional
  `premortem`; `review_date` opens exactly one obligation, idempotently;
  outcome backfill mutates the note and logs the mutation; capturing a new
  decision surfaces historically similar decisions with their recorded
  outcomes via existing search; malformed input rejects with a typed error.
- **Depends on**: none.

### Task B2 - rated decision capture (`t_6fe43fcc`, p3)
- **Files**: `src/core/brain/decisions/record.ts` (rating/rationale fields,
  list/compare queries), CLI/MCP surface, tests.
- **Acceptance**: a decision can be captured or updated with `rating` and
  `rationale` kept separate from ordinary signals; rated decisions are
  listable, sortable by rating, and searchable without polluting
  signal/preference recall; rating updates are logged; unrated decisions
  render unchanged.
- **Depends on**: B1.

### Task B3 - commitment-tier vocabulary (`t_e112c63c`, p3)
- **Files**: `src/core/brain/preference.ts` (optional field passthrough),
  thesis + decision frontmatter, `src/core/brain/active.ts` and context-pack
  formatter (tier label render), tests.
- **Acceptance**: optional `commitment: exploring | leaning | decided |
  locked` round-trips through frontmatter on preferences, theses, and decision
  records; when set, injected text renders the tier label in place of the raw
  confidence float; when unset, output is byte-identical to today; invalid
  tier values reject with a typed error.
- **Depends on**: B1 (decision frontmatter exists).

### Task B4 - decision-change receipts (`t_3547314d`, p3)
- **Files**: new `src/core/brain/decisions/receipts.ts` (`decision_change.v1`
  JSONL append + paginated history query), hooks in the lifecycle
  supersede/tombstone path and preference-confidence update path, CLI/MCP
  history surface, tests.
- **Acceptance**: a belief/preference change emits one receipt carrying
  before, after, evidence triggers, confidence delta, alternatives, actor,
  rationale, reason code; the idempotency key makes replays no-ops; the
  history query paginates with an opaque cursor and reports exact counts;
  records with unexpected free-text reasoning fields are rejected; no receipt
  fires for reads.
- **Depends on**: A1 (lifecycle hook points), B1 (decision store).

### Task B5 - rated-decision recall with caps and spacing (`t_5712fa39`, p3)
- **Files**: `src/core/brain/inject-governor.ts` (caps/spacing extension),
  deterministic prompt-match (token/anchor overlap) over rated decisions,
  injection wiring, config keys (`decision_recall.max_per_session`,
  `decision_recall.min_spacing_turns`), tests.
- **Acceptance**: a prompt deterministically matching a rated decision
  resurfaces it verbatim in the session; per-session cap and spacing rules
  prevent repeats (both enforced by the governor and covered by tests); no
  LLM call and no language-specific word lists in matching; with the feature
  unconfigured, injection output is byte-identical to today.
- **Depends on**: A4 (governor exists), B2 (ratings exist).

### Task S1 - conversation chronology (`t_347e8224`, p3, standalone)
- **Files**: `src/core/search/indexer.ts`/`walker.ts` (carry `authored_at`),
  search result shaping, `fusion.ts`/`ranker.ts` (exact-tie recency
  tie-break), `src/mcp/brain/recall-tools.ts` + session-recall core
  (since/before bounds via existing `time-range.ts`), idempotent dry-run-first
  backfill command, tests.
- **Acceptance**: indexed transcript turns expose `authored_at` in search
  results; exact hybrid-score ties order newer-first while any non-tied pair
  keeps today's order (regression test); `session_grep`/session-recall accept
  since/before bounds; backfill is dry-run by default, idempotent on re-run,
  and performs no re-embedding; documents without a turn instant are
  unchanged.
- **Depends on**: none.

### Task S2 - tension objects with lifecycle (`t_0e3f2bee`, p3, standalone)
- **Files**: new `src/core/brain/tensions.ts` (note family under
  `Brain/tensions/`, state machine open -> confirmed/dismissed/resolved,
  dedup key), context-pack injection-time warning, CLI verb + MCP addition,
  tests.
- **Acceptance**: a detected contradiction persists as a tension note whose
  state lives in frontmatter; re-detection of the same subject pair updates
  the existing note instead of duplicating; confirm/dismiss/resolve
  transitions validate against the state machine and log events; building a
  context pack containing a subject note of an unresolved tension emits a
  warning naming the tension; dismissed/resolved tensions emit nothing.
- **Depends on**: none.

### Task L - docs, CHANGELOG, version bump
- **Files**: `README.md`, `CHANGELOG.md` (`## [1.33.0]` + link reference),
  `docs/cli-reference.md`, `docs/mcp.md`, `package.json` 1.33.0 +
  `bun run scripts/sync-version.ts`.
- **Acceptance**: one CHANGELOG entry covers all eleven units;
  `bun run sync-version:check` passes; README gains short sections for the
  lifecycle, claim-graph, decision, and tension surfaces.
- **Depends on**: all previous tasks.
