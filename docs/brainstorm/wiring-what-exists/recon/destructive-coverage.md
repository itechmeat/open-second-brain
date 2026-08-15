# Recon: the destructive gate is called by two of about twenty-five destructive operations

Kanban: `t_a930c42d` (priority 4), scoped by its own body to "the data-loss gate and
correction-taxonomy pieces". Only the gate half is taken; the correction taxonomy is
a separate design and is not in this round.

## The gate exists and states its own guarantee

`src/core/brain/snapshot-gate.ts:1-30` opens with the promise: "no destructive brain
mutation runs without a recovery point on disk first." The module is complete and
correct - `createUniqueSnapshot` (`:97`) handles the collision ladder,
`takeSnapshot` (`:138`) is exported for a caller with no operation behind it,
`withDestructiveSnapshot` (`:181`) enforces the ordering, and the failure semantics
are argued at `:11-18`: a failed snapshot means the operation never runs, and an
operation that throws leaves the archive standing as the recovery point.

It has two call sites in the entire codebase:

- `src/core/brain/source-cleanup.ts:591` - `BRAIN_SNAPSHOT_REASON.deleteBySource`
- `src/core/brain/entities/label-hygiene.ts:222` - `BRAIN_SNAPSHOT_REASON.entityPrune`

## The four operations with the largest unprotected blast radius

**The dream pass bypasses the wrapper.** `src/core/brain/dream.ts:204` calls
`createSnapshot` inline. The gate's own header at `:19-27` names this as the
anti-pattern it exists to prevent. The snapshot is genuinely taken, so this is not a
data-loss defect today; it is the second path that must be kept correct by hand, and
it is why the census in R1b is worth more than the wiring in B1.

**`restoreSnapshot` discards the live tree without a recovery point.**
`src/core/brain/snapshot.ts:1222`, deleting every live top-level entry under `Brain/`
at `:1259-1270`. `.snapshots/` and `.artifacts/` are excluded from the deletion
(`:1243-1248`, called "the load-bearing safety guarantee"), so forward archives
survive - but nothing captures the state being discarded. An operator who rolls back
to the wrong run id has no way back. The confirmation ladder here is the strongest in
the codebase (`rollback.ts:112-120`, `:145-160`: manifest drift refusal, `--yes` in
non-interactive mode, `--force-rollback` recorded in the log as `drift_overridden`),
which makes the missing recovery point the one weak link in an otherwise careful
verb.

**`pruneSnapshots` destroys recovery points automatically.**
`src/core/brain/snapshot.ts:1046`, called from `takeSnapshot` (`snapshot-gate.ts:164`)
and from `dream.ts:278`. Its own comment at `:1047-1049` calls it "the most
destructive operation in the module". It runs on every snapshot and every dream, with
no gate, no confirmation, and no report, trimming to `snapshots.retention_count`
(default 10, `policy/defaults.ts:58`). It cannot be gated on taking a snapshot - that
is circular - so it needs a floor and a named refusal instead.

**`deleteBySource --include-originals` reports a coverage it does not have.** The
snapshot archive covers top-level entries under `Brain/` and nothing else
(`path-constants.ts:116-119`). `source-cleanup.ts:462` returns `[]` for anything
inside `Brain/`, which means the originals this flag deletes are outside `Brain/` by
construction and are therefore outside every archive ever taken. The result still
carries `snapshotRunId` and `snapshotPath`. This is the single largest unrecoverable
blast radius reachable from the MCP surface, and it is reachable while the response
says a recovery point was taken.

## The honest state of recoverability

There is exactly one real restore path: the `Brain/.snapshots/*.tar.zst` archive plus
`restoreSnapshot`. It covers only `Brain/`, keeps ten generations by default, prunes
itself automatically, and is reached by two of the destructive operations. Derived
store coverage (the SQLite index) defaults to `not_requested`.

Everything else is audit trail - `Brain/log/<date>.md` event lines, continuity
`source_invalidation` records, per-preference mutation audit, gate telemetry. Each
tells you *that* something was destroyed. None can reconstruct *what*.

Two operations are safe by construction rather than by gate, and the pattern is worth
naming because B2 should copy it: signal retire (`signal-retire.ts:141-152`) and
preference retire (`preference.ts:1187-1197`) write the destination and assert its
existence *before* unlinking the source. Note preference retire re-renders rather than
copying (`preference.ts:1185`), so the file survives and the original prose does not.

## The confirmation ladder already exists, in six tiers

Nothing needs inventing here either. From weakest to strongest, all present in the
codebase: no gate at all; a `dryRun` option that is not the default (`dream()`);
dry-run by default with `--apply` or `confirm: true` (`deleteBySource`,
`doctor --repair --apply`); `--yes` required non-interactively with a y/N prompt
otherwise (`rollback`, `page-dedup`); an override flag for a proved hazard recorded
in the log (`rollback --force-rollback`); and an exact confirmation phrase with a
dedicated typed error (`REPAIR_CONFIRM_PHRASE = "apply repair"`,
`repair-lane.ts:65`, checked at both the CLI boundary and inside the core). Orthogonal
to all of them is the blast-radius count guard, `count-guard.ts`, with `--expect N`
asserting the match count before any write and `--strict` refusing a guardless
mutation.

The rule the codebase follows, stated plainly: plan first with zero writes, surface
the blast radius, require an affirmative whose strength scales with irreversibility,
and record an overridden refusal.

## The verdict idiom to match

`trust/retrieval-gate.ts:50` and `trust/self-approval-guardrail.ts:35` are the model:
a pure function, no I/O, returning a frozen object carrying a discrete decision plus
a sorted array of controlled tokens - never prose, never one reason when several
apply, gates evaluated independently so multiple failures surface together.

`withDestructiveSnapshot` has no verdict type at all. It either produces a
`DestructiveSnapshot` or throws, including a plain `new Error` on id exhaustion at
`:114-117`. There is nowhere in the current shape to say "recoverability could not be
proved", which is exactly what `--include-originals` and `pruneSnapshots` need to say.

## One member is waiting for its first producer

`BRAIN_SNAPSHOT_REASON.manual` (`types.ts:586`) is declared and documented as
"an operator asking for a recovery point with no operation behind it. No producer in
this release - nothing takes a snapshot on demand." `takeSnapshot` is already exported
for that caller shape. A gate that mints a proof-of-recoverability point before an
operation it cannot otherwise cover is that producer.
