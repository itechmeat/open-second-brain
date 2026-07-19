# Trusted recall and memory write surface - implementation plan

Sequence follows consultant Variant 3. Each task is one atomic TDD commit on feat/recall-trust-and-write-surface. Kernels ride inside their anchor feature commits. Hard edges: B1 before B2 (kernel 1), W1 before W2 (kernel 2), C1 before C2 (clip contract), A2 before A3 (gap loop reads recall audit and telemetry paths the hook exercises). R and D are independent and land first to de-flake CI.

## Tasks

### Task R: de-flake temporal-replace log-day test (rider, no kanban id)
- **Files**: tests/core/brain/lifecycle/temporal-replace.test.ts
- **Acceptance**: the logging test derives the expected log day from the operation result (loggedAt) instead of a hardcoded date; full file passes on any wall-clock date; commit `fix(tests): derive temporal-replace log day from result instead of wall clock`.
- **Depends on**: none

### Task D (t_cc234ff5): fail-fast doctor readiness probes
- **Files**: src/core/doctor.ts, new readiness probe module beside it, doctor CLI verb, tests
- **Acceptance**: behind an explicit flag doctor runs three probes (LLM key resolvable, embedding provider loadable with model and dims, runtime-adapter wiring) each with a per-check timeout and outcome pass, fail with reason, or skipped-not-configured; any fail yields a non-zero exit code; without the flag output is byte-identical to today; tests cover timeout, fail, skip, and exit-code paths.
- **Depends on**: none

### Task B1 (t_5f61130a): retrieval trust gate plus per-pack receipts (carries kernel 1)
- **Files**: new src/core/search/rank-adjust.ts (kernel 1: adjuster registry, verdicts exclude-with-reason, multiply, keep, mounted on semantic and lexical paths), new retrieval-gate module under src/core/brain/trust/, receipt builders (memory_trust_assessment, retrieval_decision_trace as compact references), pack builder wiring, tests
- **Acceptance**: quarantined material (from untrusted-source provenance, contamination entity signals, self-approval guardrail state; structural only, no word lists) ranks zero and reaches no pack while excluded items are counted with reasons in retrieval_decision_trace; every pack carries both receipts; with no adjusters registered ranking output is byte-identical; ablation test shows exact result and rank deltas.
- **Depends on**: R (green CI), not functionally

### Task B2 (t_c4a9cef8): relation-only supersede fade
- **Files**: src/core/search/ranker.ts, src/core/search/result-filters.ts, kernel 1 adjuster, tests
- **Acceptance**: an inbound supersedes or superseded_by relation authored on A fades unchanged B by a named-constant multiplier on both the semantic and pure-lexical paths; existing superseded-non-tip tombstone drop untouched; no relation, byte-identical ranking.
- **Depends on**: B1

### Task W1 (t_3ff3fe77): brain_update_note and brain_append_note (carries kernel 2)
- **Files**: new src/core/brain/write-batch.ts (kernel 2: ordered typed operations, validate and project in memory, commit or roll back), src/mcp/brain/notes-tools.ts additions, tests
- **Acceptance**: update modifies body and/or merges frontmatter of an EXISTING note, append appends; missing target is a typed error; same safety envelope as create (path traversal, Brain machinery root, vault-scope exclusions); both tools are single-operation batches over kernel 2; a mid-write failure leaves the note byte-identical; tool descriptions within registry limits.
- **Depends on**: R (green CI), not functionally

### Task W2 (t_7718ab22): general atomic batch write tool
- **Files**: new MCP batch tool registration, kernel 2 operation vocabulary (create note, update body or frontmatter, append note, apply evidence, append log line), tests
- **Acceptance**: a mixed batch commits all-or-nothing; the first invalid operation aborts with a typed error naming the operation index and no disk write happens; single-op parity with the dedicated tools; pinned-context batching behavior unchanged.
- **Depends on**: W1

### Task C1 (t_5be0654d): clip-protected session_id and agent_id
- **Files**: src/core/brain/token-impact.ts, src/core/brain/continuity/types.ts and store.ts, tests
- **Acceptance**: agent_id joins session_id on pack and continuity identity; a tiny-budget clip retains both fields (regression test); no budget pressure, byte-identical output.
- **Depends on**: none

### Task C2 (t_ac1d36ea): include_raw plus extracted discriminator
- **Files**: src/core/brain/session-recall.ts, src/mcp/brain/recall-tools.ts, tests
- **Acceptance**: include_raw carries the original raw capture beside each derived record in one response; every returned item has an extracted boolean discriminator; flag omitted, byte-identical response; raw payloads respect the clip contract from C1.
- **Depends on**: C1

### Task A1 (t_4adb0b8b): typed age-labeled session-start timeline
- **Files**: new shared rendering helper (typed marker plus relative-age label, pure function over eventType and timestamps), src/core/brain/morning-brief.ts, tests
- **Acceptance**: the morning brief renders recalled items as a chronological timeline with a per-item type marker and relative age; marker vocabulary is fixed and structural, no natural-language classification; brain_brief view=morning reflects it; underlying data unchanged.
- **Depends on**: none

### Task A2 (t_2ce46130): bounded recall inject on UserPromptSubmit
- **Files**: hooks/hooks.json, new recall-inject hook following the existing hooks layout, reuse of src/core/search/recall-hint.ts and src/core/brain/portability/recall-sources.ts, tests
- **Acceptance**: opt-in env flag; caps (max notes, max chars) and a fixed time budget as named constants; abstains below the confidence floor; any internal error or timeout injects nothing; every decision (inject, abstain, error) writes one audit log line; flag off, no behavior change; the hook process never blocks the session.
- **Depends on**: A1 (rendering helper available), R

### Task A3 (t_67d38036): knowledge-gap loop
- **Files**: new gap-loop module under src/core/brain/, session-end promotion and session-start agenda wiring, auto-close in the dream pass beside the freshness auto-resolve precedent, tests
- **Acceptance**: recurring low-confidence gaps (aggregated from existing gap_counts telemetry, tunable threshold) promote to durable vault task notes at session end; open gap tasks render as a session-start agenda through the shared helper; a later confident recall on the topic auto-closes the task; opt-in env flags; flags off, no behavior change; gap task notes never touch the Hermes board.
- **Depends on**: A2

### Task L: docs, changelog, version bump
- **Files**: README.md, CHANGELOG.md (new 1.35.0 entry plus link reference), docs/cli-reference.md, docs/mcp.md, package.json plus `bun run scripts/sync-version.ts`
- **Acceptance**: all ten features documented; version 1.35.0 propagated; `bun run scripts/sync-version.ts --check` passes; commit rides in the same PR.
- **Depends on**: all above

## Batching for delegated implementation

- Batch 1 (parallel-safe, independent): R, D, C1, A1
- Batch 2: B1 then B2 (one agent, kernel 1 track)
- Batch 3: W1 then W2 (one agent, kernel 2 track)
- Batch 4: C2 (after C1), then A2, then A3 (injection track)
- Batch 5: L (docs and bump)

Every batch runs `bun run fmt`, `bun run lint` (baseline exactly 134 warnings, 0 errors), `bun run typecheck`, and foreground `bun test` before each commit.
