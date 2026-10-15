### Variant 1: Dedicated storage subsystem on top of the existing gates
- **Approach**: Add a new `src/core/brain/storage/` module that owns four things. (1) A footprint census keyed by the `STATE_SURFACES` rows, which charges each surface for the bytes it actually keeps on disk. (2) A rolling usage aggregate written to the metrics sink and used only for forecasting. (3) A closed `STORAGE_VERDICT` vocabulary (`ok | warn | fail | unmeasurable`) that applies the 80 percent / 30 day and 95 percent / 7 day thresholds through a new policy block. (4) A `storage_pressure` gate that the maintenance lane and the other background producers check before they run, so interactive writes are never gated. Reclaim (named `storage_reclaim` so it does not clash with the Hermes compaction names) and the near-duplicate retirement detector both reuse the hygiene scan/plan/apply review gate. Both run on one shared per-item fail-soft removal-run primitive, and page-dedup and `deleteBySource` are moved onto that same primitive. The incremental-extraction watermark ships alongside as an additive field in the content manifest.
- **Trade-offs**:
  - Pro: all four cards share one vocabulary, one verdict shape and one removal-run primitive, so card 4 is fixed once for every bulk-removal path, including the new ones.
  - Pro: every decision re-measures on disk through the census, and the aggregate only feeds the forecast, which meets the measured-or-refused constraint and the "advisory aggregate" constraint directly.
  - Pro: it reuses proven seams (the lane gate pattern, the hygiene review gate, `withDestructiveSnapshot`, the `planEmbeddingSpend` blocked/reason shape), so little new mechanism is invented.
  - Pro: the reclaim planner can have an explicit preserve list (clip-protected continuity keys, `source_invalidation`, `decision_change.v1`, the source archive) that is enforced by a type-level exclusion table, not by convention.
  - Con: it is the largest surface area: a new policy block, new doctor checks (counter drift, reclaim backlog), new diagnostic codes, new MCP/CLI verbs with parity tests, and census rows.
  - Con: a full on-disk census on every gate check costs I/O, so it needs a cheap stat-only path plus a cooperative checkpoint deadline.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Extend the existing seams in place
- **Approach**: Grow `token-footprint.ts` into a combined token and byte capacity report with the warn/fail thresholds, and add the forecast as one more field computed from the metrics JSONL. Add a host-pressure-style "storage" input to the existing lane gates so the lane pauses near the wall. Card by card: compaction becomes a new `LANE_TASK` with a CLI preview/apply pair, duplicate retirement becomes one more hygiene detector with an applier-capability row, the watermark goes into the manifest, and the page-dedup and `deleteBySource` loops each get their own try/catch-and-collect fix.
- **Trade-offs**:
  - Pro: smallest diff and fastest to ship, because each card lands in the file that already owns that concern.
  - Pro: no new top-level module, and fewer new census rows and parity tests.
  - Con: backpressure only covers the maintenance lane. Other background producers (vector backfill, dream, ingest batches) would each need their own ad-hoc check, so the "pause all background producers" guarantee is spread across many sites.
  - Con: card 4 is fixed twice in two shapes, and the new reclaim and retirement appliers would need a third copy. The per-file failure semantics drift apart.
  - Con: overloading the token-footprint report mixes two capacity models, and the 95 percent fail state has no single owner that enforcement can call.
  - Con: preservation of the protected receipts lives in the logic of one lane task, so it is easier to break silently later.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Enforcement at write admission with charge-at-write accounting
- **Approach**: Route every in-vault write through the shared writer, which runs an admission check. Each write is tagged with a closed producer class (`interactive | background`) and charges a persisted SQLite usage counter with its kept bytes at write time. Background writes are refused above the warn line, and every write is refused above the fail line unless it is a reclaim. Reclaim seals and rolls receipt ledgers into segments, and segments outside the preserve list become eligible for retirement behind a plan/apply gate. Duplicate retirement and the watermark are handled as in the other variants, and per-file decomposition is built into the writer's batch API.
- **Trade-offs**:
  - Pro: the most precise and immediate backpressure. No producer can bypass it, because the write-site census already forces every write through a shared writer.
  - Pro: the forecast comes cheaply from a counter that is always current.
  - Con: the counter becomes a second source of truth that can drift (crashes, out-of-band edits in Obsidian, git checkouts). The constraint requires on-disk re-measurement at decision time anyway, so the counter's main benefit is undercut and the drift doctor check becomes load-bearing.
  - Con: putting enforcement on the hot write path risks blocking interactive writes through misclassification or a bug in admission. That is exactly the failure the task exists to remove.
  - Con: segment sealing changes the on-disk shape of the append-only continuity and receipt ledgers. That is a migration with readers everywhere, and it puts the `decision_change.v1` "never folded" contract at risk.
  - Con: it touches every write site at once, which makes it the largest blast radius in the codebase.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: Variant 1 is the only one that gives one owner to all four requirements: the measured-at-decision enforcement, the advisory-only forecast, the "pause only background producers" gate and a single per-file fail-soft removal primitive. It does this by extending the lane, hygiene and destructive-gate patterns the kernel already trusts, not by touching the hot write path or migrating the append-only ledgers. Variant 2 is cheaper but leaves backpressure and failure decomposition scattered across sites, where they will drift. Variant 3 adds a drift-prone counter and puts at risk both the interactive-write guarantee and the receipt contracts that the constraints protect.
