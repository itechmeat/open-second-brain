# Storage lifecycle - capacity forecast, background backpressure, gated reclamation and residue recovery

**Status:** draft
**Author:** orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain vaults grow monotonically with agent sessions and captures, and nothing today tells the operator how much runway is left or degrades gracefully when the store fills. The only quota handling is the embedding provider's, the only reclamation primitive is artifact-run TTL pruning, and the nearest capacity report counts tokens, not bytes. This wave turns that silent hard failure into a visible, plannable, reversible set of maintenance events: measure what the store keeps, forecast the runway, warn in graduated steps, pause background producers before the wall while interactive writes keep working, reclaim bytes behind explicit apply gates (receipt compaction, near-duplicate retirement), and recover more value from already-stored bytes (incremental appended-text extraction, per-file batch-failure decomposition so removal runs always complete).

## Scope

- A storage usage meter that charges every durable state surface for the bytes it actually keeps on disk, measured server-side, per-surface measured-or-refused.
- A rolling usage aggregate (one `storage_usage` metrics sample per run) and a linear forecast of days to an operator-configured cap, with graduated tiers `ok / warn / critical / unbounded / unmeasurable` (defaults: warn at 80 percent or 30 days, critical at 95 percent or 7 days).
- A `storage:` policy block in `Brain/_brain.yaml` (cap and threshold keys), riding the additive template ratchet; no cap configured means unbounded and nothing changes for existing vaults.
- Background write backpressure: a capacity gate on the maintenance lane (new `skipped:capacity` verdict, journalled with its reading) and a named `capacity_exhausted` refusal at the `brain_ingest_source` entry at the critical tier, zero writes. Interactive note writes, recall and search are never refused by the capacity layer.
- An explicit preview-bound receipt compaction command (`o2b brain receipts` scan/compact, MCP `brain_receipts`) that folds old records in continuity and metrics JSONL shards into per-month aggregates behind a dry-run default, explicit ids, count guard, snapshot gate and per-run audit record, preserving the protected record classes verbatim.
- A content-level near-duplicate document detector in the hygiene registry whose `retire` action, behind the existing review/apply gate, retires stale copies keep-newest, retargets inbound wikilinks to the canonical copy, drops the retired copies' content-manifest entries, and writes a `source_invalidation` audit record per retired copy.
- Incremental appended-text extraction: an additive per-source `extracted_bytes` watermark in the content manifest, a UTF-8-safe capped tail read, and appended-delta reporting through the existing ingest result and `o2b brain extract` preview.
- Per-file batch-failure decomposition in the bulk removal runs (`deleteBySource`, the page-dedup CLI apply loop, the maintenance collect loops) so one bad file is collected as a named failure and the run completes.
- Doctor checks: `storage-capacity` (tier warning and critical issues, unmeasurable reported as uncertain) and `receipt-ledger-growth` (advisory compaction backlog).

## Out of scope

- Raising the 1 MiB pre-extract cap or the 8 MiB source-trust digest ceiling; deferred post-write embedding and any embedding spend-cap change (the card's other halves, already served by `planEmbeddingSpend`).
- The soft-delete / auto-revive / purge lifecycle from t_d7071804; only its independently buildable residue (per-file decomposition) ships.
- Refusing interactive writes at any tier, and any hard failure of the vault itself; the capacity layer pauses producers and refuses only new-source ingest at critical.
- Compacting decision-change receipts (`decision_change.v1` append-only accountability), the source archive (no-TTL contract by design), snapshots, or `source_invalidation` / pre- and post-compact continuity records.
- Any daemon, watcher or cron introduction; background remains the operator's schedule invoking the maintenance lane.
- A shared generic "batch runner" abstraction; decomposition follows the house per-loop shapes with typed per-subject failure records.

## Chosen approach

Variant 1 from the brainstorm (dedicated storage subsystem on top of the existing gates), with one refinement: receipt compaction is its own gated command rather than a hygiene detector, because the hygiene finding schema targets vault pages while ledger folding targets JSONL shards under `Brain/log` and `Brain/metrics` with different reach and preservation rules; it reuses the brain_hygiene tool shape (closed mode enum, scan default, explicit ids, count guard, audit) without joining its detector registry. Everything else follows the consultant's variant: one `src/core/brain/storage/` module owns measurement, sampling, forecast and the gate decision; the maintenance lane gains a fourth soft gate; reclamation and retirement reuse the plan/apply, snapshot, count-guard and audit seams the kernel already trusts; near-duplicate retirement joins the hygiene detector registry; the watermark is additive manifest state; decomposition is applied per loop in place.

Enforcement re-measures on disk at the moment of every decision; the rolling aggregate is advisory and forecast-only. The tier evaluation is measured-or-refused: a surface that cannot be stat'd is reported in `unmeasured` with its named reason (the `HOST_PRESSURE` posture), never as zero bytes, and an unmeasurable store yields tier `unmeasurable` - the gate then stays open and the doctor check reports uncertain.

## Design decisions

- **No cap by default.** `cap_bytes` absent means tier `unbounded`: bytes are reported, no days-to-exhaustion is invented, no gate fires, no refusal happens. A forecast against an invented default cap would be exactly the misleading number this wave removes.
- **The critical tier refuses only new-source ingest.** At `critical`, `brain_ingest_source` refuses before any write with `StorageCapacityError` code `capacity_exhausted`, naming the remedy (run receipt compaction or duplicate retirement, or raise the cap). Operator note writes, recall, search and status keep working so the operator can always run the reclamation verbs; the gate at the ingest entry sits in `src/mcp/brain/ingest-tools.ts`, not in `ingestSource`, so the core ingest path stays capacity-blind and the file stays owned by the extraction lane.
- **Backpressure is a pre-run refusal, never a wait.** The lane's capacity gate decides before the lease-handled run starts, like window/busy/pressure; nothing blocks on a condition, no new lock exists, and there is no lock-order interaction with the writer lock or the lease. `--force` bypasses it like the other soft gates, never the lease. The usage sample is taken before the skip is returned, so the forecast series keeps accumulating exactly while producers are paused.
- **Gate ordering follows cheapest-first, least-surprising-first.** Window, busy, host pressure, then capacity last: the capacity gate is the most expensive (a byte walk) and its reading is journalled the way the pressure reading is - the decision to skip and the fact that the gate did not evaluate are different journal lines.
- **Canonical selection for retirement is keep-newest on `created_at`, and pages without `created_at` are ineligible.** The mtime fallback is unstable under merges (the merge itself moves the survivor's mtime; a second pass can reverse the pair - the documented GitHub #180 hazard), so a finding whose candidates lack `created_at` is emitted with evidence naming the ineligible members instead of a sortable group. Scope keys keep folding the composite scope; identical text in two scopes never collapses.
- **Retirement drops records with provenance, not silently.** Per retired copy: inbound wikilinks retargeted to the canonical (fence-aware, scope-aware `retargetWikilinks`), page removed, content-manifest entry dropped round-tripping the read contract (the t_586d5d8b rule; a dropped entry must not resurrect on re-ingest), and one exported `appendContinuitySourceInvalidation` record naming canonical id, retired id, dropped manifest key and the retained source-archive hash. The source archive itself is never deleted. Per-copy failures are collected; a copy whose retarget fails stays in place.
- **Receipt compaction preserves a closed protected set, and unknown kinds fail closed to keep.** Fold candidates are continuity and metrics JSONL records older than the invocation's `older_than_days`, folded into one aggregate line per (kind, month) carrying count, first/last timestamps and byte totals. Kept verbatim: `source_invalidation`, `pre_compact_extract`, `post_compact_audit`, any record whose payload carries a `CLIP_PROTECTED_PAYLOAD_KEYS` key, and any record whose kind the folder does not know (forward compatibility - an unknown kind is never folded). Decision receipts live in a separate ledger the command never opens. The audit record per confirmed run is a new additive continuity kind `receipt_compaction`; the naming stays disjoint from the Hermes context-compaction vocabulary on every surface.
- **Compaction rewrite is atomic per shard and fail-soft per shard.** New shard content is written to a temp sibling and renamed inside a `withDestructiveSnapshot` span; a shard that fails is collected with its reason and the run continues; the result reports honest matched/folded/kept/failed counts, and the doctor `receipt-ledger-growth` check reads the same scan output.
- **The watermark is additive manifest state with no contract bump.** `extracted_bytes` (and `extracted_at`) join `ManifestEntry`; `parseEntryValue` learns the extended shape. Absence of the field means "consumed from byte 0", so the first incremental pass over an old record reports the whole file as the delta - the manifest's own reads-degrade-toward-reprocessing rule, applied lazily instead of an eager `EXTRACT_CONTRACT_VERSION` bump that would reprocess every recorded source at once. Shrink falls back to a full re-read with the watermark reset; tail reads snap to the next UTF-8-safe boundary (newline-aligned) and ride the existing bounded-read discipline and caps. Source-trust classification is unchanged: the incremental lane changes what is read for extraction, not how a source is trusted.
- **Decomposition keeps the wire shapes the house already ships.** Each decomposed loop collects typed per-subject failure records (`{path, message}` for file removals, `{key, message}` for dedup clusters) and the CLI exit rules follow the import-session precedent (exit 1 when failures are collected, data reports still exit 0). `runDeletion` keeps its persist-partial-audit-then-throw posture for errors outside the per-entry loop; inside the loop a failing file no longer aborts the remaining entries. write-batch's all-or-nothing contract is untouched.
- **The storage report is its own surface, not a `computeBrainStatus` block.** A byte walk stats every file; folding it into the always-loaded status path would break that path's documented cost bound. `o2b brain storage` and `brain_storage` carry the measurement, forecast and tier; both answer `measured: false` with a named reason below local reach (the `link_integrity` model).
- **New named vocabulary everywhere.** `STORAGE_CAPACITY_TIER`, `MAINTENANCE_VERDICT.skippedCapacity`, `STORAGE_ERROR_CODES` (`capacity_unmeasurable`, `capacity_exhausted`) registered through `exhaustiveMembers`, hygiene action `retire`, detector id `document-dedup`, continuity kind `receipt_compaction`, doctor codes registered in `DIAGNOSTIC_SIGNALS` - every census gets its registration in the same task that adds the vocabulary.

## File changes

New files:

- `src/core/brain/storage/usage.ts`, `forecast.ts`, `gate.ts`, `capacity-error.ts` - measurement, sampling and forecast, the lane-gate decision, the leaf error module.
- `src/core/brain/policy/blocks/storage.ts` - the `storage:` block resolver.
- `src/core/brain/doctor/storage-capacity.ts`, `src/core/brain/doctor/receipt-ledger.ts` - the two new checks.
- `src/core/brain/receipts/types.ts`, `scan.ts`, `compact.ts` - the receipt compaction engine.
- `src/cli/brain/verbs/storage.ts`, `src/cli/brain/verbs/receipts.ts` - the two new CLI verbs.
- `src/mcp/brain/storage-tools.ts`, `src/mcp/brain/receipt-tools.ts` - the two new MCP tools.
- `src/core/brain/hygiene/detectors/document-dedup.ts` - the content-level near-duplicate detector.
- `src/core/brain/document-retire.ts` - the retirement applier core.
- `src/core/brain/ingest/tail-read.ts` - the UTF-8-safe capped tail read.
- Tests for every module above, plus census/parity updates where the census binds by list rather than by enumeration.

Modified files (owners are pinned per lane in plan.md):

- `src/core/brain/policy/load.ts`, `defaults.ts`, `validate.ts`, `src/core/brain/types.ts`, `src/core/brain/config-template.ts` - storage block wiring and template ratchet entry.
- `src/mcp/tool-error-codes.ts` - the new codes via `exhaustiveMembers`.
- `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts` - registry rows and issue-code registrations (landed first by the substrate lane, appended by the compaction lane).
- `src/core/brain/maintenance/lane.ts`, `journal.ts`, `src/cli/brain/verbs/maintenance.ts`, `src/mcp/brain/admin-tools.ts` - the capacity gate, verdict and both surfaces' derivation.
- `src/mcp/brain/ingest-tools.ts` - the critical-tier admission refusal.
- `src/mcp/brain-tools.ts` - tool aggregation (substrate lane first, compaction lane appends).
- `src/core/brain/hygiene/types.ts`, `scan.ts`, `apply.ts`, `src/core/brain/applier-capability.ts` - detector registration, `retire` action, applier routing and capability row.
- `src/core/brain/continuity/types.ts` - the additive `receipt_compaction` kind.
- `src/core/brain/source-cleanup.ts`, `src/cli/brain/verbs/page-dedup.ts`, `src/core/brain/maintenance/collect.ts` - per-file decomposition.
- `src/core/brain/ingest/ingest.ts`, `content-manifest.ts`, `src/cli/brain/verbs/extract.ts` - watermark plumbing and appended-delta reporting.

## Risks and open questions

- **Backpressure must not starve the forecast.** The sample is taken before a `skipped:capacity` return; the explicit `brain storage` invocation samples too. Implementation must not place the sampler after the early return.
- **Byte-walk cost.** The walker is bounded by the lane's per-task safeguard deadline and the report command's own budget; the gate reuses the same measurement with a stat-only fast path per surface (directory sizes are not summable without walking, so the cost is honest I/O, bounded by the same deadline).
- **Reach honesty.** Every vault-wide byte figure is a whole-vault measurement; below local reach the report answers `measured: false` plus reason, and the lane gate is inherently local (the maintenance lane already refuses non-local runs).
- **Concurrent ledger appends during compaction.** Shard replacement races an appender; the rewrite takes the same per-file lock ladder the continuity store already uses (`withFileLock`), and the snapshot gate covers the destructive window.
- **Watermark correctness under editors that rewrite in place** (content changed, not appended): the manifest hash classifies the file `modified` and the full reprocess path applies; the watermark is stamped only when extraction covered the bytes it claims.
- **Census discipline.** Every new durable-write route goes through `atomicWriteFileSync` or a written write-site exclusion; every deletion sits inside `withDestructiveSnapshot`; ledger rewrites touch existing `STATE_SURFACES` rows, so no new row is expected - the state-surface census run in CI is the verifier.
- **Open question resolved during implementation:** whether `brain_hygiene`'s apply path needs any MCP-layer change for the `retire` action or whether the existing generic ids/count-guard routing covers it unchanged (expected: unchanged; verify against `hygiene-tools.ts` apply enforcement).
