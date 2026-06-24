# Session Lifecycle Capture Durability — variant audit trail

Primary consultant: Claude Code (`claude -p --model claude-opus-4-8`), output
captured verbatim in `cli-output/claude.md`. Fallback not invoked — the primary
returned three parseable variants and a recommendation (exit code 0).

Below: the consultant's variants verbatim, then the orchestrator's final
decision and rationale.

---

## Consultant variants (verbatim)

### Variant 1: TS-core authority, dumb provider
- **Approach:** Keep `provider.py` a pure pass-through: surface the `interrupted` kwarg as an explicit field on the bridge payload and forward both the `messages` list and the `session-transcript.jsonl` path, but make no capture decisions in Python. All new behaviour — interrupted-end reconciliation, resume de-dup, and the post-compaction survival audit — lands as new/extended modules under `src/core/brain` (a new `post-compact-audit.ts` mirroring `pre-compact-extract.ts`, plus `interrupted` handling inside `session-lifecycle.ts`). One CLI verb gains the flag; the deterministic core owns all logic and all dedupe.
- **Trade-offs:**
  - Pro: Single deterministic, unit-testable locus; honours "core is LLM-free" and keeps the Python shim trivial and fail-soft by construction.
  - Pro: Survival audit sits naturally beside the symmetric `extractPreCompactRecords`, sharing the continuity store and `[KIND, sessionId, contentHash]` key.
  - Con: Widens the bridge payload contract and pushes interrupted-transcript bytes across the boundary even when the flag is absent (mitigated by an off-by-default field).
  - Con: Larger TS surface to land in one PR; three concerns touch the same lifecycle file.
- **Complexity:** medium
- **Risk:** low

### Variant 2: Minimal seam-reuse, three independent diffs
- **Approach:** Treat the three tasks as three small additive diffs against existing seams, introducing no new abstraction. `interrupted` becomes an optional `NormalizedPayload` field consumed by the existing SessionEnd branch, reusing `resolveSessionLineage` for resume detection and the existing dedupe key to suppress re-capture; the `/exit` task is a verification-plus-deletion of the local poll workaround in `provider.py`; the survival audit is a new post-compaction CLI verb that reuses `pre-compress-pack.ts` read primitives and `readPinnedContext` plus the bounded drift log. Each ships behind its own absent-by-default field/flag.
- **Trade-offs:**
  - Pro: Smallest possible diff per task; byte-identical when flags/fields absent, matching repo conventions exactly.
  - Pro: Maximally reuses named existing substrates (dedupe key, lineage, symmetric pre-compact pass) the grounding calls out, lowering double-count and regression risk.
  - Pro: Each task is independently reviewable and revertible within the shared branch.
  - Con: No unifying model means interrupted-end, clean-end, and audit paths stay three parallel code paths — some duplicated idempotency reasoning.
  - Con: The honest-surfacing of an un-honourable `interrupted` flag is handled ad hoc per path rather than centrally.
- **Complexity:** small
- **Risk:** low

### Variant 3: Unified continuity-event pipeline with idempotency ledger
- **Approach:** Introduce a single `SessionContinuityEvent` abstraction that normalizes interrupted-end, clean-end, and post-compaction-survival into one typed event flowing through one capture pipeline backed by an explicit append-only idempotency ledger (superseding the per-call dedupe key). Both `provider.py` hooks and a new post-compact verb emit into this pipeline; the ledger guarantees no double-count across interrupt→resume and no duplicate continuity records, and records un-honoured `interrupted` flags as honest ledger entries.
- **Trade-offs:**
  - Pro: One place to reason about idempotency, honesty surfacing, and fail-soft behaviour across all three tasks; strongest future extensibility.
  - Pro: Cleanest conceptual model — interrupted capture and audit re-assertion become uniform events.
  - Con: Largest blast radius; replacing the proven `[KIND, sessionId, contentHash]` dedupe with a new ledger risks regressions in already-shipped capture paths and breaks "additive where possible."
  - Con: Hard to keep byte-identical for unchanged installs when a core store is replaced; heavier review and migration burden in a single release.
- **Complexity:** large
- **Risk:** high

### Consultant's recommendation: Variant 2

---

## Final decision: Variant 2 (agree with the recommendation)

**Variant 2 — Minimal seam-reuse, three independent additive diffs.**

Rationale: the release scope itself catalogues the exact substrates each task
needs — the `[KIND, sessionId, contentHash]` continuity dedupe key, the
resume-aware `resolveSessionLineage`, and the symmetric `extractPreCompactRecords`
pass — so the lowest-risk path is three tight additive diffs that reuse them.
This directly honours the repo's explicit conventions: new behaviour must be
off-by-default or byte-identical when unused, hooks must be fail-soft, and
additive-where-possible. Variant 3's core-store replacement (a new idempotency
ledger superseding the proven dedupe key) risks regressions in already-shipped
capture paths and breaks byte-identity for unchanged installs — too high a price
for a single release. Variant 1's TS consolidation is sound but prematurely
pushes transcript bytes across the bridge boundary even when the `interrupted`
flag is absent; Variant 2 keeps the field absent-by-default and the Python shim
truly dumb. The one acknowledged cost of Variant 2 (three parallel code paths
with some duplicated idempotency reasoning) is acceptable because each path is
small and independently revertible, and unification remains available as a later
refactor if the parallel paths prove worth merging.
