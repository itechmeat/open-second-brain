# Brain Integrity Suite - implementation plan

Seven atomic tasks, all TDD-driven. Each task = failing test first, see fail, minimal code, see green, refactor, atomic conventional commit on `feat/brain-integrity-suite`.

## Tasks

### Task 1: Sync lockfile primitive + `writePreferenceTxn` chokepoint + expectations chain

- **Files**:
  - new `src/core/brain/sync-lockfile.ts` - `acquireLockSync(target): LockHandle`, `LockHandle.release()`, `scanStaleLocks(vault): string[]`, process-exit cleanup hook for held locks. Single-attempt exclusive create via `fs.openSync(target + '.lock', 'wx')`.
  - new `src/core/brain/preference-txn.ts` - `writePreferenceTxn(vault, input, expectations, options): WritePreferenceResult` (sync), `BrainCollisionError extends Error` with `kind` discriminant, `WritePreferenceExpectations` type.
  - modified `src/core/brain/preference.ts` - `writePreference` delegates to `writePreferenceTxn` with an empty expectations array; public signature unchanged.
  - new `tests/core/brain/sync-lockfile.test.ts` - acquire success, EEXIST collision, release, exit-cleanup.
  - new `tests/core/brain/preference-txn.test.ts` - txn flow (lock acquire, re-read, expectations chain, mutate, lock release), expectations chain ordering, error class kind discriminant.
- **Acceptance**: existing `writePreference` tests stay green (no caller signature changes); txn path passes the full lock-acquire / re-read / mutate flow; `BrainCollisionError` exposes `.kind` field with one of four string values; the sync lockfile creates the `.lock` file then removes it on release; `bun test` clean.
- **Depends on**: none (foundation).

### Task 2: `_revision` counter + `_content_hash` frontmatter fields

- **Files**:
  - modified `src/core/brain/types.ts` - add optional `_revision: number`, `_content_hash: string` to `BrainPreference`.
  - modified `src/core/brain/preference.ts` - `WritePreferenceInput` gains optional `revision`, `content_hash`; `preferenceFrontmatter` emits `_revision` (defaults to 0) and `_content_hash` (only when status is `confirmed`).
  - new `src/core/brain/content-hash.ts` - `computeContentHash(principle: string, scope?: string): string`.
  - new `tests/core/brain/content-hash.test.ts` - hash determinism, whitespace handling, scope optional.
  - modified `tests/core/brain/preference.test.ts` or new test file - frontmatter shape with new fields.
- **Acceptance**: `_revision` defaults to 0, increments on each write; `_content_hash` present only on `_status: confirmed`; hash is deterministic for same `(principle, scope)`.
- **Depends on**: Task 1.

### Task 3: Collision-detection expectations (StaleUpdate, UnsafeShrink, SourceLock, DuplicateWrite)

- **Files**:
  - modified `src/core/brain/preference-txn.ts` - four expectations: `expectRevision(n)`, `noUnsafeShrink(minRatio)`, `sourceLockGuard`, `noDuplicateWrite(window)`.
  - modified `src/core/brain/policy.ts` - config fields `confidence.unsafe_shrink_min_ratio` (default 0.5) and `retire.confirmed_evidence_multiplier` (default 3).
  - new `tests/core/brain/preference-collision.test.ts` - one describe-block per collision kind, each with red-then-green case.
- **Acceptance**: each collision mode raises `BrainCollisionError` with correct `kind`; lock acquisition timeout maps to `SourceLock`; config defaults loadable via `loadBrainConfig`.
- **Depends on**: Task 1, Task 2.

### Task 4: Drift detection on confirmed-preference reads

- **Files**:
  - modified `src/core/brain/content-hash.ts` - `verifyContentHash(pref): { ok: boolean; observed?: string; expected?: string }`.
  - modified `src/core/brain/query.ts` (or wherever `brain_query` reads preferences) - on `_status: confirmed` reads, call `verifyContentHash`, emit `drift_detected` event via existing log writer when mismatch.
  - modified `src/core/brain/doctor.ts` - new `BrainDoctorCheck` for drift summary.
  - new event code constant `BRAIN_EVENT.driftDetected` in the same place other event codes live.
  - new `tests/core/brain/content-hash-drift.test.ts` - mutate principle on disk, read, assert event emitted.
- **Acceptance**: hand-editing a confirmed preference's `principle` triggers exactly one `drift_detected` event per read (not per byte); `brain_doctor` surfaces a count of drifted preferences; mismatch does not block the read.
- **Depends on**: Task 2.

### Task 5: Destructive-proof gates in dream pass

- **Files**:
  - modified `src/core/brain/dream.ts` - promotion path passes `noUnsafeShrink` expectation when target is `_status: confirmed`; retirement path passes `requireEvidenceCountAbove(threshold)` when source is `_status: confirmed`.
  - modified `src/core/brain/types.ts` - new `DreamQuarantinedEntry` reason codes `unsafe_shrink`, `retire_evidence_below_threshold`.
  - new `tests/core/brain/dream-destructive-gate.test.ts` - feed dream a single-signal retirement against multi-evidence confirmed pref; assert quarantine entry returned, pref unchanged on disk.
- **Acceptance**: dream's `DreamRunSummary.retired` does not include a confirmed pref when evidence count is below multiplier; `quarantined` array carries the rejected attempt with the relevant `failed_gates` code; existing dream tests stay green.
- **Depends on**: Task 3.

### Task 6: Durable workrun checkpoints for dream pass

- **Files**:
  - new `src/core/brain/dream-workrun.ts` - `openWorkrun(vault, runId): WorkrunHandle`, `WorkrunHandle.checkpoint(phase)`, `WorkrunHandle.finalize()`, `WorkrunHandle.interrupt()`, `scanDanglingWorkruns(vault): string[]`.
  - modified `src/core/brain/dream.ts` - phase markers at the four transition points; skipped when `opts.dryRun === true`.
  - modified `src/core/brain/paths.ts` - `dreamRunsDir(vault)`, `dreamWorkrunPath(vault, runId)` path helpers.
  - modified `src/core/brain/doctor.ts` - check `scanDanglingWorkruns` and surface as warning.
  - new `tests/core/brain/dream-workrun.test.ts` - emission ordering, recovery scan, dry-run skip.
- **Acceptance**: a full dream pass writes exactly one workrun file with five JSONL lines (`started`, `cluster_complete`, `promote_complete`, `retire_complete`, `finalized`); a crashed run (test simulates) leaves a workrun without `finalized` and is picked up by the doctor check.
- **Depends on**: none structurally, but Task 5 should land first so dream's promote/retire phases are stable.

### Task 7: `brain_review_candidates` MCP tool

- **Files**:
  - new `src/core/brain/review-candidates.ts` - `buildReviewCandidates(vault): ReviewCandidatesReport`, internally calls `dream(vault, { dryRun: true })` and projects.
  - modified `src/mcp/brain-tools.ts` - `toolBrainReviewCandidates(ctx, args)` handler matching the existing tool signature.
  - modified `src/mcp/tools.ts` - tool registration entry.
  - modified `src/mcp/instructions.ts` - tool description for the agent-facing surface.
  - new `tests/core/brain/review-candidates.test.ts` - shape and dry-run isolation (no files mutated).
  - new `tests/mcp/brain-review-candidates.test.ts` - MCP tool wiring + arg shape.
- **Acceptance**: the tool returns `{ would_promote, would_retire, would_supersede, clusters_below_threshold }`; invoking it twice in a row produces the same result without writing any new files; the tool is discoverable through the MCP server's tool list.
- **Depends on**: Task 6 (so the workrun does not fire on dry-run is exercised together).
