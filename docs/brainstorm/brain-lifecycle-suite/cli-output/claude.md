### Variant 1: Orchestration wrapper with chokepoint audit
- **Approach**: Leave the proven `dream()` plan/execute internals untouched but wrap them in a thin phase orchestrator that names the existing seams (`close` → `reconcile` → `synthesize` → `heal` → `log`) and emits one checkpoint per phase into the existing `dream-workrun` JSONL. The domain classifier, temporal extractor, and heal enrichment slot in as pure functions called *inside* the relevant phase; the per-preference audit is captured at the mutation chokepoints (`writePreferenceTxn`, `moveToRetired`, `mergePreferences`) so it records authoritative before/after content hashes and also catches manual edits. Morning brief and reconcile open-questions become read-only projections plus one small open-questions artifact.
- **Trade-offs**:
  - Pro: phases are genuinely explicit and ordered (satisfies feature 2's intent) without moving any proven logic — every dream invariant is preserved by construction.
  - Pro: audit instrumented at the write primitive is the most faithful trail (single source of truth, captures non-dream edits too) and reuses the existing `_revision`/`_content_hash` stamping.
  - Pro: ordering guarantee (reconcile-before-synthesize, heal-after-mutations) is enforced by the orchestrator, not by reasoning about a 1974-line function.
  - Con: audit writes are new on-disk state — must be gated so a no-mutation run stays a true no-op and byte-identical.
  - Con: the orchestrator straddles the existing `scanBrain`/`planTopics`/execute boundaries, so it must thread the same in-memory plan objects carefully to avoid double-execution.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Pure phase-module pipeline + dedicated per-pref ledger
- **Approach**: Refactor `dream()` into an explicit pipeline where each phase is its own pure module (`close.ts`, `reconcile.ts`, `synthesize.ts`, `heal.ts`) consuming a shared immutable `DreamContext` and returning a phase result + checkpoint; the proven `planTopics`/`planRefresh`/retire logic is *relocated behind unchanged signatures* into those modules. The audit gets a first-class append-only ledger (`Brain/log/pref-audit/<pref-id>.jsonl`) written transactionally with each preference mutation, and reconcile/temporal/heal are each standalone deterministic modules with their own test suites.
- **Trade-offs**:
  - Pro: cleanest separation of concerns, maximally testable phase-by-phase, and the per-pref ledger gives the operator a directly greppable lifecycle file with no projection step.
  - Pro: best long-term foundation if more phases are added later.
  - Con: relocating proven logic — even behind identical signatures — is exactly the "rewrite the core" risk the constraints warn against; high chance of perturbing a subtle invariant (pinned-rebut retain, signal suppression, gated retires).
  - Con: largest diff by far, straining the one-PR-per-version rule; many new files and a new directory layout to keep no-op-safe.
- **Complexity**: large
- **Risk**: high

### Variant 3: Checkpoint-extension decorator with projected audit
- **Approach**: Don't change dream's control flow at all — extend the `dream-workrun` checkpoint enum with the new phase names and emit richer phase summaries at the *existing* checkpoint seams (`cluster_complete` ≈ reconcile, `promote_complete` ≈ synthesize), so phases are virtual labels over the current pipeline. New behaviors (classifier, temporal, heal enrichment) ship as flag-gated decorators, and the per-pref audit is a read-time projection over existing log events keyed by pref id (à la `timeline.ts`), with the morning brief composed from existing `brain_digest`/`brain_daily_brief` output.
- **Trade-offs**:
  - Pro: lowest possible churn to the dream core; control flow is provably untouched, and the audit projection adds zero new on-disk state (byte-identical by default for free).
  - Pro: naturally incremental — pieces could even be staged.
  - Con: phases are mapped onto existing checkpoints rather than truly explicit ordered phases, which only partially honors feature 2's "explicit ordered phases each emitting a checkpoint."
  - Con: a projected audit can only report what was already logged — it cannot reconstruct before/after hashes that weren't emitted, and it misses manual edits made outside the log path, weakening the "trace the full lifecycle" goal.
- **Complexity**: small
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: It is the only variant that makes the dream phases genuinely explicit and ordered (feature 2's core intent) while preserving the proven `dream()` internals verbatim, directly honoring the "wrap/extend, don't rewrite" and invariant-preservation constraints that make Variant 2 too risky. Capturing the audit at the mutation chokepoints — rather than Variant 3's projection — yields an authoritative before/after trail that also catches manual edits, satisfying feature 1's "trace the full lifecycle" requirement, and the new audit state is easy to gate so a no-mutation dream run stays a true byte-identical no-op.
