# Storage lifecycle - implementation plan

Six features across five parallel lanes. Each lane owns a disjoint file set; the only shared files are the pinned contracts listed below, and every contract names its owner and landing order. Tasks are TDD-ready: the acceptance test is written first and must fail with the expected error before implementation.

## Pinned cross-lane contracts

| # | File(s) | Exported symbols | Owner | Landing |
|---|---------|------------------|-------|---------|
| C1 | `src/core/brain/storage/usage.ts`, `forecast.ts`, `gate.ts`, `capacity-error.ts` | `measureStorageUsage`, `sampleStorageUsage`, `forecastStorageUsage`, `STORAGE_CAPACITY_TIER`, `StorageForecast`, `StorageUsage`, `evaluateCapacityGate`, `CapacityGateDecision`, `StorageCapacityError`, `STORAGE_ERROR_CODES` | Lane 1 | Lands first; Lane 2 and Lane 3 consume read-only |
| C2 | `src/core/brain/types.ts`, `src/core/brain/policy/blocks/storage.ts`, `policy/load.ts`, `policy/defaults.ts`, `policy/validate.ts`, `src/core/brain/config-template.ts` | `BrainStorageConfig`, `ResolvedBrainStorageConfig`, `BRAIN_STORAGE_DEFAULTS`, `resolveStorage` | Lane 1 | Lands first; no other lane edits any config file |
| C3 | `src/mcp/tool-error-codes.ts` | `STORAGE_ERROR_CODES` registered via `exhaustiveMembers` | Lane 1 | Lands first |
| C4 | `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts` | `DOCTOR_CHECKS` row for `storageCapacityCheck` then `receiptLedgerCheck`; `DIAGNOSTIC_SIGNALS` codes | Lane 1 first, Lane 3 appends | Lane 3 depends on Lane 1 for these two files |
| C5 | `src/mcp/brain-tools.ts` | `STORAGE_TOOLS` aggregation then `RECEIPT_TOOLS` | Lane 1 first, Lane 3 appends | Lane 3 depends on Lane 1 for this file |
| C6 | `src/core/brain/source-cleanup.ts` | widened export `removeFile` (plus Lane 5's own loop decomposition) | Lane 5 | Lands before Lane 4 consumes `removeFile`; Lane 4 imports it, never edits the file |
| C7 | `src/core/brain/ingest/*`, `src/cli/brain/verbs/extract.ts` | watermark internals | Lane 5 | Lane 2 must not touch `ingest.ts`; the admission refusal lives in `src/mcp/brain/ingest-tools.ts` (Lane 2's file), so the two never meet |
| C8 | `src/core/brain/hygiene/types.ts`, `scan.ts`, `apply.ts`, `src/core/brain/applier-capability.ts` | `document-dedup` detector id, `retire` action, applier routing | Lane 4 | Exclusive to Lane 4 |
| C9 | `src/core/brain/maintenance/lane.ts`, `journal.ts`, `src/cli/brain/verbs/maintenance.ts`, `src/mcp/brain/admin-tools.ts` | capacity gate wiring, `MAINTENANCE_VERDICT.skippedCapacity` | Lane 2 | Exclusive to Lane 2 |
| C10 | `src/core/brain/continuity/types.ts` | additive `receipt_compaction` record kind | Lane 3 | Exclusive to Lane 3 |

No lane edits `src/core/brain/continuity/store.ts` (Lane 3 keeps the append path generic; Lane 4 imports the existing exported `appendContinuitySourceInvalidation`). No new `STATE_SURFACES` rows are expected: samples ride the metrics sink, the audit rides continuity, and ledger rewrites touch existing rows; the state-surface census run in CI verifies this per lane.

---

## Lane 1 - storage substrate (lands first)

Pure modules first, then registration, then surfaces.

### Task 1.1: usage meter
- **Files**: new `src/core/brain/storage/usage.ts`; new `tests/core/brain/storage-usage.test.ts`
- **Acceptance**: `measureStorageUsage(vault, opts)` on a sandbox vault returns per-tier byte totals (vault-content, derived) that match a hand-computed fixture (page files, `brain.sqlite` plus WAL/SHM sidecars, artifacts, snapshots, ledgers); a surface made unreadable (chmod fixture gated on `CHMOD_CANNOT_DENY`) appears in `unmeasured` with its named reason and never as zero bytes; the walker's per-dot-dir policy (artifacts, archives, snapshots all counted) is asserted; deterministic via injected `now` only.
- **Depends on**: none.

### Task 1.2: forecast and tiers
- **Files**: new `src/core/brain/storage/forecast.ts`; new `tests/core/brain/storage-forecast.test.ts`
- **Acceptance**: `forecastStorageUsage` over seeded `storage_usage` metric samples returns the linear slope, `days_to_cap` and tier; tier boundaries hit exactly at the default constants (warn 80 percent / 30 days, critical 95 percent / 7 days, module-level named constants); absent `cap_bytes` yields `unbounded`; an unreadable store yields `unmeasurable`; fewer than two samples yields the named no-forecast state; `sampleStorageUsage` appends one `storage_usage` metrics record per call, fail-soft, and is asserted idempotent per run id.
- **Depends on**: Task 1.1.

### Task 1.3: capacity error leaf and code registration
- **Files**: new `src/core/brain/storage/capacity-error.ts`; modified `src/mcp/tool-error-codes.ts` (C3); new `tests/mcp/storage-capacity-errors.test.ts`
- **Acceptance**: `StorageCapacityError` carries the closed `STORAGE_ERROR_CODES` union (`capacity_unmeasurable`, `capacity_exhausted`); registration compiles through `exhaustiveMembers`; the MCP envelope test asserts the codes map by name and never leak vault paths at remote reach.
- **Depends on**: none (parallel with 1.1/1.2 within the lane).

### Task 1.4: storage policy block
- **Files**: C2 set - new `src/core/brain/policy/blocks/storage.ts`, modified `src/core/brain/types.ts`, `policy/load.ts`, `policy/defaults.ts`, `policy/validate.ts`, `src/core/brain/config-template.ts`; new `tests/core/brain/storage-policy.test.ts`
- **Acceptance**: `resolveStorage` parses `cap_bytes`, `warn_percent`, `critical_percent`, `warn_days`, `critical_days` with bounded field checks that hard-error out-of-range values and a `critical_percent` that must exceed `warn_percent`; absent block resolves to the documented defaults with `cap_bytes` absent (unbounded); the template ratchet appends the new block to an existing `_brain.yaml` without rewriting existing values (mergeBrainYaml fixture).
- **Depends on**: none within the lane.

### Task 1.5: capacity gate decision
- **Files**: new `src/core/brain/storage/gate.ts`; extend `tests/core/brain/storage-forecast.test.ts` or a sibling `tests/core/brain/storage-gate.test.ts`
- **Acceptance**: `evaluateCapacityGate` returns `run` / `skip` with the tier and reading attached; unbounded and `unmeasurable` stores never skip; the decision is computed from a fresh `measureStorageUsage` call at decision time, never from the stored aggregate (asserted by mutating the aggregate between sample and decision).
- **Depends on**: Tasks 1.2 and 1.4.

### Task 1.6: storage-capacity doctor check
- **Files**: new `src/core/brain/doctor/storage-capacity.ts`; modified `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts` (C4, first landing); new `tests/core/brain/doctor-storage-capacity.test.ts`
- **Acceptance**: `runDoctor` on a hand-built skeleton vault (doctor-drift pattern) emits a warning issue at the warn tier, an error issue at critical, and an `uncertain` entry for an unmeasurable store, reading `ctx.dbPath` fail-soft; both issue codes are registered in `DIAGNOSTIC_SIGNALS` and `tests/core/brain/doctor-exit-census.test.ts` passes unchanged in mechanism; reach filtering follows the doctor-counts-reach pattern.
- **Depends on**: Tasks 1.2 and 1.3.

### Task 1.7: report surfaces (CLI verb and MCP tool)
- **Files**: new `src/cli/brain/verbs/storage.ts`, `src/mcp/brain/storage-tools.ts`; modified `src/mcp/brain-tools.ts` (C5, first landing); new `tests/cli/brain/verbs/storage.test.ts`, `tests/mcp/brain-storage.test.ts`, `tests/mcp/storage-reach.test.ts`
- **Acceptance**: `o2b brain storage` and `brain_storage` return the measurement, forecast, tier and per-surface `unmeasured` reasons; below local reach the report answers `measured: false` with the named reason (link-integrity model); each invocation appends one usage sample; the brain-tools parity test derives both surfaces without a CLI_ONLY/MCP_ONLY entry.
- **Depends on**: Tasks 1.5 and 1.6.

---

## Lane 2 - background write backpressure

### Task 2.1: maintenance lane capacity gate
- **Files**: modified `src/core/brain/maintenance/lane.ts` (C9), `src/core/brain/maintenance/journal.ts` (C9); new `tests/core/brain/maintenance-capacity-gate.test.ts`
- **Acceptance**: `evaluateGates` gains the capacity check ordered after host pressure, active only when the vault's storage block configures `cap_bytes`; a critical tier returns the new `MAINTENANCE_VERDICT.skippedCapacity` with the reading carried alongside (the pressure-reading model); `skipped:capacity` journal rows parse and render; `--force` bypasses it, the lease is never bypassed; the usage sample is taken before the skip returns (asserted: a skipped run still appends a sample); unmeasurable leaves the gate open with the reason journalled.
- **Depends on**: Lane 1 Tasks 1.2, 1.4, 1.5 (C1, C2).

### Task 2.2: lane surfaces carry the verdict
- **Files**: modified `src/cli/brain/verbs/maintenance.ts` (C9), `src/mcp/brain/admin-tools.ts` (C9); extend `tests/core/brain/maintenance-capacity-gate.test.ts`; update `tests/mcp/maintenance-parity-census.test.ts` expectations
- **Acceptance**: CLI flags and MCP properties derive the new verdict and reading identically from source; the parity census passes in both directions with no new exclusion; a skipped-capacity run reports the tier and the remedy path in both surfaces.
- **Depends on**: Task 2.1.

### Task 2.3: ingest admission refusal
- **Files**: modified `src/mcp/brain/ingest-tools.ts` (C7 boundary - this file only); new `tests/mcp/ingest-capacity-refusal.test.ts`
- **Acceptance**: at the critical tier `brain_ingest_source` refuses before any write with the `capacity_exhausted` envelope naming the remedy (compaction, retirement, cap raise); zero bytes written to the vault (asserted with `brainPageTexts`); an unbounded or sub-critical vault ingests unchanged; the check is skipped entirely when no cap is configured (no measurement cost).
- **Depends on**: Lane 1 Tasks 1.3, 1.5 (C1, C3).

---

## Lane 3 - receipt compaction

### Task 3.1: ledger scan
- **Files**: new `src/core/brain/receipts/types.ts`, `src/core/brain/receipts/scan.ts`; new `tests/core/brain/receipts-scan.test.ts`
- **Acceptance**: `scanReceiptLedgers` inventories continuity and metrics shards with record counts, byte sizes, foldable counts above the age threshold and protected-record counts; the protected vocabulary (source_invalidation, pre/post-compact kinds, clip-protected-key carriers, unknown kinds) is asserted never counted foldable; the scan is read-only (byte-identical vault after run).
- **Depends on**: none.

### Task 3.2: fold engine
- **Files**: new `src/core/brain/receipts/compact.ts`; new `tests/core/brain/receipts-compact.test.ts`
- **Acceptance**: `compactReceiptLedgers` with explicit shard ids folds records older than `older_than_days` into one aggregate line per (kind, month) preserving count, first/last timestamps and byte totals; protected records survive verbatim in order; unknown kinds fail closed to keep; shrink is verified (output strictly smaller, protected content byte-present); the rewrite is atomic per shard inside `withDestructiveSnapshot` and per-shard fail-soft (a poisoned shard is collected, the run completes); re-run is idempotent (nothing left foldable, no write); the continuity record kind `receipt_compaction` (C10, additive to `src/core/brain/continuity/types.ts`) is appended exactly once per confirmed run and never on a dry run; `expect`/count-guard mismatch aborts before any write.
- **Depends on**: Task 3.1.

### Task 3.3: receipt-ledger-growth doctor check
- **Files**: new `src/core/brain/doctor/receipt-ledger.ts`; modified `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts` (C4, appended after Lane 1); new `tests/core/brain/doctor-receipt-ledger.test.ts`
- **Acceptance**: a ledger above the growth threshold yields a warning issue naming the receipts command; a compacted ledger yields no issue; codes registered in `DIAGNOSTIC_SIGNALS`; doctor-exit census passes.
- **Depends on**: Task 3.1; Lane 1 Task 1.6 (C4 order).

### Task 3.4: receipt surfaces (CLI verb and MCP tool)
- **Files**: new `src/cli/brain/verbs/receipts.ts`, `src/mcp/brain/receipt-tools.ts`; modified `src/mcp/brain-tools.ts` (C5, appended after Lane 1); new `tests/cli/brain/verbs/receipts.test.ts`, `tests/mcp/brain-receipts.test.ts`
- **Acceptance**: `o2b brain receipts scan` is the default and writes nothing; `compact` requires explicit shard ids from a scan and enforces the count guard before mutating; the deny refusal (`refuseDocumentDeny`) fires on the mutation lane; the tool and verb derive from one source (parity test); output names the operation receipt compaction, disjoint from the context-compaction vocabulary.
- **Depends on**: Task 3.2, Task 3.3; Lane 1 Task 1.7 (C5 order).

---

## Lane 4 - near-duplicate document retirement

### Task 4.1: document-dedup detector
- **Files**: new `src/core/brain/hygiene/detectors/document-dedup.ts`; new `tests/core/brain/document-dedup-detector.test.ts`
- **Acceptance**: the detector groups ingest summary pages (kind `brain-source`) by content similarity at the lexical threshold (0.8) and, when a provider is configured, the embedding threshold (0.97), excluding merge-resolved pairs and keeping scope keys folded; canonical is the newest `created_at`; a group containing any member without `created_at` is emitted ineligible with the reason in evidence (mtime instability); finding ids are deterministic via `hygieneFindingId`.
- **Depends on**: none.

### Task 4.2: retire action vocabulary and routing
- **Files**: modified `src/core/brain/hygiene/types.ts`, `src/core/brain/hygiene/apply.ts`, `src/core/brain/applier-capability.ts` (C8); new `tests/core/brain/hygiene-retire-routing.test.ts`
- **Acceptance**: `retire` joins the closed action vocabulary and the applier-capability table; `buildHygienePlan` routes retire findings through the review path (excluded from unattended apply); `executeFinding` dispatches retire to the retirement core with the count guard semantics hygiene apply already enforces.
- **Depends on**: Task 4.1.

### Task 4.3: retirement applier core
- **Files**: new `src/core/brain/document-retire.ts`; new `tests/core/brain/document-retire.test.ts`
- **Acceptance**: per stale copy, the applier retargets inbound wikilinks to the canonical (retargetWikilinks report asserted), removes the page, drops the content-manifest entry round-tripping the read contract, and appends one `appendContinuitySourceInvalidation` record naming canonical id, retired id, dropped manifest key and the retained source-archive hash; a re-ingest of the retired copy's source does not resurrect a page (manifest-drop assertion); per-copy failure is collected (`{path, message}`), the failed copy stays on disk, and the run completes; the whole span sits inside `withDestructiveSnapshot` with a recoverability verdict; the source archive file is asserted still present.
- **Depends on**: Task 4.2; Lane 5 Task 5.1 (C6 - consumes the exported `removeFile`).

---

## Lane 5 - residues: decomposition and incremental extraction

### Task 5.1: deleteBySource per-file decomposition
- **Files**: modified `src/core/brain/source-cleanup.ts` (C6, lands first - widens the `removeFile` export for Lane 4); extend `tests/core/brain/source-cleanup.test.ts`
- **Acceptance**: a per-entry removal failure is collected as `{path, message}`, the remaining entries are still removed, the partial-progress audit and the final audit carry honest removed/failed counts, and the result shape gains the `failed` array; a run with zero failures is byte-identical in behavior to today; regression test asserts the pre-fix code fails this test (one injected failing file aborts the run today).
- **Depends on**: none.

### Task 5.2: page-dedup and collect loop decomposition
- **Files**: modified `src/cli/brain/verbs/page-dedup.ts`, `src/core/brain/maintenance/collect.ts`; new `tests/cli/brain/verbs/page-dedup-apply-fail-soft.test.ts`, extend the maintenance collect tests
- **Acceptance**: a MergeChainError on one cluster is collected (`{key, message}`), later clusters still apply, the report lists failures, and the CLI exits 1 when failures are non-empty; collect loops collect per-item errors in the module's existing report shape; write-batch all-or-nothing behavior is asserted unchanged.
- **Depends on**: none (parallel with 5.1 inside the lane).

### Task 5.3: tail read primitive
- **Files**: new `src/core/brain/ingest/tail-read.ts`; new `tests/core/brain/ingest/tail-read.test.ts`
- **Acceptance**: reading from a byte offset returns only appended text snapped forward to the first UTF-8-safe newline boundary; a file that shrank below the offset falls back to the full content with the shrink named; the bounded-read ceiling is enforced with the existing refusal vocabulary; multi-byte characters split across the boundary decode cleanly.
- **Depends on**: none.

### Task 5.4: manifest watermark
- **Files**: modified `src/core/brain/ingest/content-manifest.ts`; extend `tests/core/brain/ingest/content-manifest.test.ts`
- **Acceptance**: `parseEntryValue` accepts entries carrying additive `extracted_bytes` / `extracted_at` and preserves them through `updateManifest` round-trips; an entry without them degrades to byte 0; schema_version stays 3 (additive fields never bump); unknown field shapes still drop toward reprocessing exactly as today.
- **Depends on**: none.

### Task 5.5: incremental extraction plumbing
- **Files**: modified `src/core/brain/ingest/ingest.ts`, `src/cli/brain/verbs/extract.ts` (C7); new `tests/core/brain/ingest/incremental-extract.test.ts`
- **Acceptance**: an ingest of a source whose manifest record carries `extracted_bytes` reports the appended delta `{from_byte, to_byte}` on `IngestSourceResult` and stamps the new watermark only when the run covered those bytes; the CLI extract preview reports the appended slice metadata for a previously-extracted source; appending bytes to a fixture source twice yields two correct deltas with no overlap; a rewritten (not appended) source classifies modified and reprocesses fully, resetting the watermark; `EXTRACT_CONTRACT_VERSION` is asserted unchanged at 2 and no mass reprocess is triggered.
- **Depends on**: Tasks 5.3 and 5.4.

---

## Landing order and integration

1. Lane 1 lands whole (substrate first: Tasks 1.1-1.4 may interleave, 1.5-1.7 in order).
2. Lane 2 and Lane 3 start once Lane 1's dependency tasks land; Lane 5 starts immediately (independent); Lane 4 starts once Task 5.1 lands.
3. Integration order at the end of the wave: Lane 3's C4/C5 appends rebase onto Lane 1's landed registry rows; the full suite, both censuses (`doctor-exit-census`, `maintenance-parity-census`, `brain-tools-parity`, write-site and destructive-site) and the formatter run before each lane's commits per the playbook's commit discipline.
