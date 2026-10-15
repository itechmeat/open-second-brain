You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Storage lifecycle wave for Open Second Brain: turn monotonic vault growth from a silent hard failure into a visible, plannable, reversible set of maintenance events. Four cards, one subsystem:

1. Storage capacity forecasting with graduated warnings, background write backpressure and on-demand receipt compaction (priority 4). A brain that hits its cumulative storage cap refuses every new write with no warning beforehand. Wanted: charge persisted records for what they actually keep, forecast days to exhaustion from a rolling usage aggregate, warn at 80 percent or 30 days and fail at 95 percent or 7 days, pause background producers before the wall so interactive writes keep working, and an explicit preview-bound compaction command plus doctor checks for compaction and counter drift.
2. Review-gated cleanup that retires older duplicate documents with their source links (priority 3). Detect near-identical stored documents, retire the stale copies plus their link records behind the existing review/apply gate, keeping the newest copy. Open decision: canonical selection must be merge-stable.
3. Incremental extraction of text appended since the last extraction run for large sources (priority 1 residue). Today a 1 MiB pre-extract read cap and a content manifest holding only {sha256, fingerprint} mean appended conversation yields nothing new; a per-source byte watermark in the manifest plus a capped tail read recovers it.
4. Per-file batch-failure decomposition in bulk removal runs so one bad file does not abort the run (priority 1 residue). The page-dedup apply loop and the deleteBySource per-entry loop today abort or rethrow mid-run.

# Project context

Open Second Brain: a local-first memory kernel for coding agents. TypeScript on Bun 1.4.0, no runtime dependencies; runs no model (the calling agent extracts and writes prose; the kernel stores, gates and audits). All durable state lives inside the operator's vault (`Brain/` markdown + `.open-second-brain/brain.sqlite` derived store). Kernel invariants: named typed errors with closed code unions registered through an exhaustive-members compile check; plan/apply gates on anything destructive (dry-run default, explicit ids/confirm, count guard, snapshot-before-destructive-write, recoverability verdict); measured-or-refused honesty (never a silent zero); server-side measurement, never caller claims; state-surface, write-site and destructive-site censuses that fail the build when a new durable file, write or deletion is unregistered; MCP tool and CLI verb parity tests.

Recent commits:
ef974e0d fix: comma-separated and legacy scopes no longer abort the dream pass, plus three test-isolation fixes (v1.84.1) (#254)
14a99584 feat: recall lane concurrency, overlapped_ms accounting, a caller-selectable packing policy and standing-instruction facets (v1.84.0) (#252)
e239d323 feat: shipped-seam wiring - a per-session recall pool cap, usage-ordered skill offers, seeded bench sampling and OpenCode V2 configs (v1.83.0) (#251)

Related files:
- src/core/state/surfaces.ts (STATE_SURFACES catalogue of every durable file)
- src/core/brain/token-footprint.ts (existing token-capacity report with warn threshold - the closest precedent)
- src/core/brain/maintenance/lane.ts (background lane: window/busy/host-pressure/lease gates, LANE_TASK vocabulary, verdicts journalled)
- src/core/brain/maintenance/journal.ts (MAINTENANCE_VERDICT closed vocabulary)
- src/core/brain/safeguard.ts (cooperative checkpoint deadlines per OPERATION)
- src/core/brain/maintenance/host-pressure.ts (measured | unmeasurable honesty pattern)
- src/core/search/embedding-spend.ts (planEmbeddingSpend gate verdict: blocked + reason)
- src/core/brain/metrics.ts (appendMetric JSONL sink, surface o2b.metrics.v1)
- src/core/brain/exact-state.ts (overwrite-only Brain/state/<aspect>.md lane)
- src/core/brain/policy/ (blocks/ resolvers over Brain/_brain.yaml; defaults.ts; additive template ratchet in src/core/brain/upgrade.ts mergeBrainYaml)
- src/core/brain/doctor.ts + src/core/brain/doctor/ (DoctorCheck registry; issue codes registered in diagnostics.ts DIAGNOSTIC_SIGNALS or excused in doctor-exits.ts)
- src/core/brain/continuity/ (append-only per-device JSONL ledger, 28 closed record kinds, clip-protected correlation keys, schema o2b.continuity.v1)
- src/core/brain/decisions/receipts.ts (decision_change.v1 append-only accountability - must never be folded)
- src/core/brain/provenance/source-archive.ts (content-addressed evidence archive, no-TTL by contract)
- src/core/brain/hygiene/ (detector registry in scan.ts, plan.ts review gate, apply.ts per-finding fail-soft, applier-capability.ts table)
- src/core/brain/page-dedup.ts (exact-duplicate merge: keep-oldest canonical, merged_into pointers, cycle-refusing setMergedInto, wikilink rewrite)
- src/core/brain/source-cleanup.ts (deleteBySource: dry-run default, confirm ladder, per-source manifest-entry drop, source_invalidation audit, withDestructiveSnapshot)
- src/core/brain/ingest/ingest.ts (ingestSource; PRE_EXTRACT_MAX_SOURCE_BYTES = 1_048_576; readSourceBounded)
- src/core/brain/ingest/content-manifest.ts (per-source {sha256, fingerprint}; parseEntryValue drops unknown field shapes toward reprocessing)
- src/core/brain/ingest/contract.ts (EXTRACT_CONTRACT_VERSION = 2; bump forces one reprocess of every recorded source)
- src/cli/aider.ts readTail (the existing appended-bytes read precedent)
- src/core/search/vector-backfill.ts (dry-run default backfill with spend gate - the pause/gate verdict shape)

Conventions:
- Closed vocabularies as frozen const objects with membership guards; errors carry closed code unions; the MCP boundary maps them by name via exhaustiveMembers (a core code missing from the registry fails tsc).
- New doctor issue codes must be registered in DIAGNOSTIC_SIGNALS or excused with a written reason in DOCTOR_EXIT_EXCLUSIONS (a census test enforces this).
- New durable files need a STATE_SURFACES row; new in-vault write sites need a shared writer or written exclusion; new deletion sites need withDestructiveSnapshot or a DESTRUCTIVE_SITES entry (census tests enforce all three).
- Policy keys live in per-block resolvers under src/core/brain/policy/blocks/ with bounded field checks that hard-error out-of-range values; new template keys ride the additive mergeBrainYaml ratchet on upgrade.
- English only in artifacts; no hardcoded natural-language phrases where a closed vocabulary belongs; repeated literals hoisted into named constants.

Constraints:
- Interactive operator writes must keep working under backpressure; only background producers pause.
- Compaction and duplicate retirement stay behind explicit preview-bound apply gates; dry-run default; count guards; snapshot before destructive writes; audit record per confirmed run.
- The rolling usage aggregate is advisory and forecast-only; enforcement decisions re-measure on disk at the moment of the decision.
- Receipt compaction must preserve: clip-protected continuity keys, source_invalidation records, decision_change.v1 append-only receipts, the source-archive no-TTL contract.
- No new runtime dependencies. No daemon process. Bun runs SQLite synchronously - no fake async cancellation; cooperative checkpoints only.
- Naming must not collide with Hermes context compaction vocabulary (pre_compact_extract, post_compact_audit).

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
