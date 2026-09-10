# Who wrote what, and how to take it back - brainstorm audit trail

Consultant: Claude Code (`claude -p`), prompt at `cli-output/prompt.md`, verbatim output at `cli-output/claude.md`. Fallback consultant not needed (three parseable variants returned).

## Variants as returned

### Variant 1: Seam-first, thin shared primitives

- **Approach**: Add one note-write seam (`src/core/brain/notes/write-seam.ts`) that every note mutation passes through: it checks the freeze marker, hashes the target before and after, runs the atomic write, and emits one `note_write` log event through `appendLogEvent` in `src/core/brain/log.ts` with the pref-audit field shape (`agent`, `hash_before/after`, `origin_channel` stamped server-side at `log.ts:335`). Extract only the shard grammar, listing and merge from `src/core/brain/log-jsonl.ts:52-62` into a small `ledger-shards.ts` and re-point the five unsharded writers at it; put the per-shard `prev` chain inside the log appender only; build revert as plan-seal-apply over `note_write` events with the before-image resolved from a content-addressed image store written by the seam. Landing order: B (shards) → A (seam + event) → C (freeze at the seam) → E (chain in appender + doctor) → D (revert).
- **Trade-offs**:
  - Pro: A and C share one chokepoint, and the write-site census (`tests/core/architecture/write-site-census.test.ts`) can pin "every note writer routes through the seam" the same way it pins direct-fs exclusions. Internal callers (dream apply, dedup merge, write-session commit in `write-session/engine.ts:414`, `write-batch.ts:236`) are covered because the seam sits below the MCP layer.
  - Pro: the shard extraction is mechanical; `continuity/store.ts:98`, `idempotency-ledger.ts:126`, `pref-audit.ts`, `metrics.ts:69` and `lineage/ledger.ts` each swap one path function and one reader loop. The bare file name already means "empty shard id" (`log-jsonl.ts:6`), so no rename migration is needed, only a doctor lint that reports leftover bare files being appended to by a second device.
  - Pro: content-addressed before-images (`Brain/.state/write-images/<sha256>`) dedupe naturally, and the log event only carries the hash. The snapshot gate (`snapshot-gate.ts`) covers `Brain/` top-level entries, so the image store is inside the recovery region.
  - Pro: revert reuses `sealManifest` and the `destination_occupied`-style drift refusal from `src/core/state/migrate.ts:186,724`; the only new semantics are "refuse on drift", the simplest of the three options the task leaves open.
  - Con: the lineage ledger carries its own `seq` and chain plus in-place compaction; sharding it per device means the verifier in `lineage/verify.ts` must iterate shards, which is a real change, not a path swap.
  - Con: the image store grows with every edit until pruned; it needs a retention rule tied to the snapshot policy in `policy.ts` or it becomes a second unbounded ledger.
  - Con: the chain lives in `log.ts`, so other ledgers stay unchained. Acceptable per Task E scope, but a second chain later will want the primitive Variant 2 builds now.
  - Con: new `prev` on every log line changes log bytes for every vault. Mitigation: legacy lines without `prev` are treated as chain genesis, and the verifier names them `unchained-legacy` rather than broken.
- **Complexity**: medium
- **Risk**: low

### Variant 2: One append-only ledger abstraction carrying shards and chain

- **Approach**: Build `src/core/brain/ledger/` as a typed `AppendOnlyLedger` that owns shard naming, the device id from `resolveDeviceId()`, the sync writer lock, sync-conflict exclusion, deterministic merge, and an optional per-shard hash chain. Move Brain/log, continuity, idempotency, pref-audit, metrics and lineage onto it, so Task B and Task E are one change; Task A's `note_write` event and Task C's freeze refusal event are records on the same log ledger; Task D reads the ledger's typed cursor and stores the before-image inline in the event. Landing order: ledger primitive → migrate six writers → seam + freeze → revert.
- **Trade-offs**:
  - Pro: sharding, locking and chaining are written once and every current and future ledger inherits them; the census for "did we miss one" becomes a type check rather than a grep over `src/core/state/surfaces.ts`.
  - Pro: Task E's "which files are chained" question has one answer: any ledger with `chain: true`, verified by one doctor check with one finding code.
  - Con: Brain/log has a markdown twin, a directory-level lock and a byte-exact idempotent append contract (`log.ts:335-380`); folding it into a generic ledger risks changing bytes for vaults that enable nothing, which the constraints forbid.
  - Con: the lineage ledger's compaction, gap sidecar and `seq` allocation (`lineage/ledger.ts:100-180`) do not fit a generic append-only shape without either a leaky escape hatch or a second abstraction.
  - Con: inline before-images make the log the largest file family in the vault and put note bodies into a file `o2b brain protect` and Obsidian expose; redaction rules from `continuity/redaction.ts` would have to apply to the log too.
  - Con: file count and review surface exceed the 50-70 file budget once six readers, six writers, their tests, and the pinned state-surface count are all touched in one PR.
- **Complexity**: large
- **Risk**: high

### Variant 3: Boundary middleware, core untouched

- **Approach**: Enforce freeze and emit write events at the MCP and CLI boundary: a `withWriteGuard` wrapper over `ToolDefinition` in `src/mcp/` (next to `reach-refusal.ts`) and a matching CLI verb decorator, keyed on a tool allow-list of mutating verbs. Shards are done per ledger by copying the `LOG_FILE_RE` grammar into each writer; the chain goes into `log.ts`; revert resolves before-images from the nearest snapshot manifest (`manifest.ts` `diffManifests`) and refuses when none covers the write. Landing order: C → A → B → E → D.
- **Trade-offs**:
  - Pro: smallest diff, and the refusal shape is already the house style for boundary refusals (`src/mcp/reach-refusal.ts`).
  - Pro: no change to core write functions, so bit-identical behaviour for unchanged vaults is trivially true.
  - Con: the boundary is not the write seam. Dream apply, hygiene, lifecycle, page-dedup merge and the write-session engine mutate `Brain/` from inside core and would bypass both the freeze and the event, which is exactly the `o2b brain protect` failure the task cites. The census cannot pin a wrapper applied by list.
  - Con: `hash_before` must be computed before the core write and `hash_after` after it, but the handler does not know the resolved target path until `resolveNoteTarget` runs inside `createNote`; the wrapper ends up re-implementing target resolution or recording the caller's unresolved path.
  - Con: snapshots are opt-in and pruned, so most revert plans would refuse for lack of a before-image, making Task D mostly a report rather than an apply path.
  - Con: five copies of the shard grammar drift the day one changes; the project's own DRY brief forbids this.
- **Complexity**: small
- **Risk**: high


## Consultant recommendation

Variant 1 (seam-first, thin shared primitives). Rationale as returned: the seam is the only position that covers the internal writers, the censuses can pin it, the shard extraction keeps `log.ts` byte-stable, the content-addressed image store gives revert a real apply path; Variant 2 does not fit one wave under the bit-identical constraint; Variant 3 repeats the bypassed-boundary failure the epic exists to fix.

## Orchestrator decision

Variant 1 accepted, with two overrides grounded in the reconnaissance the consultant did not have:

1. The freeze guard hooks `assertVaultIdentityForWrite`, not the note-write seam. The note seam covers note writers only; the identity guard is called at 98 sites across 60 modules and is the position "check before any byte" already occupies. A `lane` parameter exempts the Brain log appender and the marker writer so the freeze can be recorded while in force.
2. Refusal events are recorded at the MCP tool boundary, not inside the guard, because the guard cannot import the log module without an import cycle (log -> paths -> vault-identity). The boundary is where the agent-facing refusal is produced anyway.

Variant 2 was rejected for the reasons the consultant gave and one more: the lineage ledger's compaction and gap sidecar would need a leaky escape hatch in any generic ledger type. Variant 3 was rejected because `dream`, `hygiene`, `page-dedup` and the write-session engine write from inside core and would bypass both the freeze and the event, which is the `o2b brain protect` failure the epic cites.
