# Brain Integrity Suite - design

**Status:** draft
**Author:** orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's preference write path has three structural gaps. First, confirmed preferences can be silently mutated outside the dream-pass promotion/retirement flow (hand edits, write races, errant agents) with no observable trace. Second, the existing `writePreference` atomic write prevents torn writes but does not prevent stale-update, unsafe-shrink, source-lock, or duplicate-write collisions - the last writer wins silently. Third, the dream pass runs as a single synchronous pipeline with no on-disk progress trace, and there is no read-only way for an operator (or another agent) to inspect what `brain_dream` would do before invoking it.

This release bundles five features that close all three gaps inside one cohesive PR.

## Scope

- **F1: Content-hash drift detection on confirmed preferences.** On promotion, write `_content_hash: sha256(principle + scope)` into frontmatter. Reads recompute and compare; mismatch logs a `drift_detected` event and surfaces in `brain_doctor`.
- **F2: Structured write-collision detection.** Four typed collision modes (`StaleUpdate`, `UnsafeShrink`, `SourceLock`, `DuplicateWrite`) wrapping the write path via a new `writePreferenceTxn` chokepoint that builds on the `proper-lockfile` pattern already proven in `src/core/pay-memory/approval.ts:361`.
- **F3: Destructive-proof gate on confirmed preferences.** Two sub-gates inside the dream pass: shrink-gate (new principle < threshold% of existing length quarantines the candidate); retire-from-confirmed gate (single-signal retirement of a multi-evidence confirmed preference is rejected without operator action or evidence above a higher threshold).
- **F4: Durable workrun checkpoints for dream pass.** Per-invocation JSONL workrun at `Brain/log/dream-runs/<YYYY-MM-DD>-<run-id>.jsonl` with one line per phase transition. Recovery scan on startup; `brain_doctor` check for dangling files.
- **F5: `brain_review_candidates` MCP tool.** Read-only projection over `dream(vault, { dryRun: true })`, exposed as a new MCP tool returning `{ would_promote, would_retire, would_supersede, clusters_below_threshold }`.

## Out of scope

- Per-preference edit-history audit trail (`t_9f452292`) - separate sibling task, not in this PR.
- Cross-vault locking or multi-vault coordination - Pay Memory's lockfile is single-vault.
- Schema migration for existing v0.11.0 preferences - additive fields with absent-as-default reader semantics. No `o2b brain migrate-*` verb.
- Changes to `dedup-hash.ts` (signal/import dedup) - different concern, untouched.

## Chosen approach

**Variant 2: Single transactional write-path chokepoint.**

Refactor `writePreference` into a thin façade over a new `writePreferenceTxn(vault, input, expectations, options)` that wraps `proper-lockfile`: acquire lock on the preference file path, re-read current frontmatter inside the lock, run an ordered chain of `expectations` checks (revision, content-hash drift observer, shrink, duplicate-window, source-lock), mutate via `writeFrontmatterAtomic`, release. Dream's promotion and retirement paths call into the same txn with feature-specific expectations (shrink-gate and retire-from-confirmed gate are two predicates plugged into the same expectations chain).

`brain_review_candidates` is a thin MCP wrapper over the already-existing `dream(vault, { dryRun: true })` path. Workrun checkpoints live in a separate small context object threaded through dream phases - they observe transitions but do not own the write semantics.

Variant 1 (bottom-up primitives) was rejected because integrity logic would drift across `writePreference` and dream's promote/retire call sites - two parallel implementations of the same idea. Variant 3 (validator-chain pipeline) was rejected because it invents a framework the codebase explicitly avoids (v0.11.0 removed pre-1.0 shims; the project is the opposite of framework-heavy).

## Design decisions

- **One chokepoint, multiple expectations.** `writePreferenceTxn` is the single function that writes to a preference file. Direct writes from CLI/MCP and indirect writes from dream both go through it; the expectations parameter carries feature-specific predicates (shrink-gate, retire-gate, revision check). This is the SOLID open/closed principle: new gates plug in as expectations without modifying the txn body.
- **Lockfile recipe verbatim from Pay Memory.** Same `retries: { retries: 30, factor: 1.2, minTimeout: 30, maxTimeout: 500 }, stale: 10_000, realpath: false` parameters as `transitionRequest:361`. Single source of truth for the lock semantics; if Pay Memory ever tunes them, the brain mirrors.
- **Hash is opt-in via status.** `_content_hash` is written only when promoting to `confirmed`. Unconfirmed and quarantine preferences do not get the field - they are mutable by design.
- **Drift detection is observation, not enforcement.** A mismatch logs a `drift_detected` event into `Brain/log/<today>.md` (and the JSONL sidecar) and surfaces in `brain_doctor` as a warning. The read still returns the live content; hand-edits remain legal. The operator chooses how to react.
- **Revision counter is monotonic.** `_revision: <integer>` starts at 0 on creation, increments on every txn write. `StaleUpdate` fires when the writer's `expected_revision` does not match the current. Absent field reads as 0 for backward compatibility.
- **Shrink threshold is config-driven, not hardcoded.** New field under `Brain/_brain.yaml`'s existing `confidence` block: `confidence.unsafe_shrink_min_ratio` (default 0.5). Anything below half of the existing principle length triggers UnsafeShrink.
- **Workrun phases are deterministic.** Five phase markers in fixed order: `started`, `cluster_complete`, `promote_complete`, `retire_complete`, `finalized`. A sixth marker `interrupted` may replace `finalized` on caught crash. Recovery on dream startup is non-resuming: if a workrun is incomplete, log `recovered` (informational), do not auto-resume - the next dream invocation processes the inbox fresh. `brain_doctor` surfaces dangling files as a warning.
- **`brain_review_candidates` is pure projection.** The MCP handler calls `dream(vault, { dryRun: true })` and returns its plan. No new persistent state, no log events, no inbox mutations. Same signature as other read-only tools: `(ctx, args) => Promise<Record<string, unknown>>`.
- **Error class hierarchy.** A new `BrainCollisionError extends Error` with a `kind: 'StaleUpdate' | 'UnsafeShrink' | 'SourceLock' | 'DuplicateWrite'` discriminant. Error names are machine-friendly identifiers; no human-language strings hardcoded.
- **Sync lockfile primitive instead of `proper-lockfile`.** The consultant's Variant 2 recommendation cited the Pay Memory `proper-lockfile` recipe, but Pay Memory is async while the entire brain write path is sync (`writePreference`, `dream`, `moveToRetired`, `writeFrontmatterAtomic`, all callers). `proper-lockfile` v4 has no `lockSync`. Migrating the brain to async would touch 30+ caller files (CLI verbs, MCP handlers, internal call sites) for a feature whose only async-only ingredient is one lock acquire. The right cost is the opposite: write a tiny sync primitive in `src/core/brain/sync-lockfile.ts` that uses `fs.openSync(target + '.lock', 'wx')` for atomic exclusive create. Single-attempt semantics: `EEXIST` raises `BrainCollisionError` with `kind: 'SourceLock'`, no retry loop. Real-world contention in OSB is rare (single operator, single MCP server, dream runs from cron) so the retry/backoff machinery of `proper-lockfile` would be dead code. Pay Memory keeps its async recipe untouched - the two subsystems have different concurrency profiles.

## File changes

**New files:**
- `src/core/brain/preference-txn.ts` - the `writePreferenceTxn` chokepoint, `BrainCollisionError` class, expectations types.
- `src/core/brain/content-hash.ts` - hash computation helper for `principle + scope`.
- `src/core/brain/dream-workrun.ts` - JSONL workrun writer + reader + recovery scan.
- `src/core/brain/review-candidates.ts` - core builder behind `brain_review_candidates` (calls `dream` in dry-run mode and projects the summary).
- `tests/core/brain/preference-txn.test.ts` - txn behaviour, lock semantics.
- `tests/core/brain/content-hash.test.ts` - hash compute + drift detection.
- `tests/core/brain/preference-collision.test.ts` - StaleUpdate, UnsafeShrink, SourceLock, DuplicateWrite.
- `tests/core/brain/dream-destructive-gate.test.ts` - shrink-gate + retire-from-confirmed gate.
- `tests/core/brain/dream-workrun.test.ts` - workrun emission, recovery scan, dangling check.
- `tests/core/brain/review-candidates.test.ts` - projection shape, dry-run isolation.
- `tests/mcp/brain-review-candidates.test.ts` - MCP tool wiring.

**Modified files:**
- `src/core/brain/preference.ts` - `writePreference` delegates to `writePreferenceTxn` with empty expectations.
- `src/core/brain/types.ts` - new optional fields on `BrainPreference` (`_revision`, `_content_hash`).
- `src/core/brain/dream.ts` - workrun emission at phase boundaries; promotion/retirement calls go through txn with gate expectations.
- `src/core/brain/policy.ts` - new config fields `confidence.unsafe_shrink_min_ratio` and `retire.confirmed_evidence_multiplier`.
- `src/core/brain/doctor.ts` - new checks for drift, dangling workrun.
- `src/core/brain/query.ts`, `src/core/brain/search.ts` (if separate) - drift verification on read.
- `src/mcp/brain-tools.ts` - new `toolBrainReviewCandidates` handler.
- `src/mcp/tools.ts` - tool registration.
- `src/mcp/instructions.ts` - tool description.
- `CHANGELOG.md` - v0.12.0 entry.
- `README.md` - updated MCP tool table.
- `package.json` - version bump to 0.12.0.
- `scripts/sync-version.ts` and friends pick up the new version automatically.

Estimated diff: ~55-70 files including tests.

## Risks and open questions

- **Lock contention on hot preferences.** Pay Memory's lockfile config (max 30 retries, ~500ms total) is sized for human-operator pace. The dream pass may write many preferences in rapid succession in one run. Verify in implementation that lock acquire latency stays bounded; consider a single in-process mutex sufficient for the same-run case rather than serialising through the filesystem lockfile for each preference.
- **Lock cleanup on crash.** A sync lockfile leaves a `.lock` file on disk if the process aborts between acquire and release. Mitigation: a `process.on('exit', ...)` cleanup hook unlinks every still-held lock during normal exit; for hard crashes (`SIGKILL`, OOM), the next acquire on the same target sees EEXIST and fails with `SourceLock`. The doctor check surfaces stale `.lock` files via `scanStaleLocks(vault)`. Operators can rm them by hand. Pay Memory's `proper-lockfile` has the same class of issue (its `stale: 10_000` timer is for that case); we accept the same hazard with a simpler recovery path.
- **Sync lockfile primitive scope.** New file `src/core/brain/sync-lockfile.ts` (~50 lines). Tests in `tests/core/brain/sync-lockfile.test.ts`. Doctor integration in `src/core/brain/doctor.ts`. Total deltas on the brain write surface: `preference.ts`, `dream.ts`, the new `preference-txn.ts` wrapping both. No caller signatures change.
- **Hash stability across encoding variations.** `sha256(principle + scope)` is sensitive to leading/trailing whitespace and Unicode normalization. Decision: hash the trimmed `principle.trim() + "\n" + (scope ?? "").trim()`, no NFD/NFC normalization (the codebase already does not normalize elsewhere). Document in `content-hash.ts` so a future refactor does not silently invalidate every existing hash.
- **Dream dry-run + workrun interaction.** Dry-run must not write a workrun file - the workrun is part of the durable side-effect surface. Implementation: skip workrun emission when `opts.dryRun === true`.
- **Backward compat for existing v0.11.0 vaults.** All new frontmatter fields are optional; readers fall back to defaults (`_revision` absent reads as 0; missing `_content_hash` on confirmed pref reads as "never hashed yet, hash on next write"). No migration verb.
- **Test data isolation.** Tests need disposable vaults under `os.tmpdir()` per the existing tests/helpers/ pattern; verify `proper-lockfile` cleans up on process exit during a `bun test` interrupt.
