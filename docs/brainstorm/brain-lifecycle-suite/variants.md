# Brain lifecycle suite - brainstorm audit trail

Consultant: Claude Code (`claude -p`), primary. Exit 0, three parseable
variants returned; the Codex fallback was therefore not run. Raw output is
preserved at `cli-output/claude.md`; the filled prompt at `cli-output/prompt.md`.

## Variants (verbatim)

### Variant 1: Orchestration wrapper with chokepoint audit
- **Approach**: Leave the proven `dream()` plan/execute internals untouched but wrap them in a thin phase orchestrator that names the existing seams (`close` -> `reconcile` -> `synthesize` -> `heal` -> `log`) and emits one checkpoint per phase into the existing `dream-workrun` JSONL. The domain classifier, temporal extractor, and heal enrichment slot in as pure functions called inside the relevant phase; the per-preference audit is captured at the mutation chokepoints (`writePreferenceTxn`, `moveToRetired`, `mergePreferences`) so it records authoritative before/after content hashes and also catches manual edits. Morning brief and reconcile open-questions become read-only projections plus one small open-questions artifact.
- **Trade-offs**: Pro - phases genuinely explicit and ordered without moving proven logic; every invariant preserved by construction. Pro - audit at the write primitive is the most faithful trail (single source of truth, catches non-dream edits) and reuses existing `_revision`/`_content_hash`. Pro - ordering guarantee enforced by the orchestrator, not by reasoning about a 1974-line function. Con - audit writes are new on-disk state, must be gated so a no-mutation run stays byte-identical. Con - the orchestrator straddles existing seams and must thread the same in-memory plan objects carefully.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Pure phase-module pipeline + dedicated per-pref ledger
- **Approach**: Refactor `dream()` into an explicit pipeline where each phase is its own pure module (`close.ts`, `reconcile.ts`, `synthesize.ts`, `heal.ts`) consuming a shared immutable `DreamContext` and returning a phase result + checkpoint; the proven `planTopics`/`planRefresh`/retire logic is relocated behind unchanged signatures into those modules. The audit gets a first-class append-only ledger (`Brain/log/pref-audit/<pref-id>.jsonl`) written transactionally with each preference mutation, and reconcile/temporal/heal are standalone deterministic modules with their own test suites.
- **Trade-offs**: Pro - cleanest separation of concerns, maximally testable phase-by-phase; per-pref ledger is directly greppable with no projection step. Pro - best long-term foundation for more phases. Con - relocating proven logic (even behind identical signatures) is exactly the "rewrite the core" risk the constraints warn against; high chance of perturbing a subtle invariant. Con - largest diff by far, straining one-PR-per-version; many new files and a new layout to keep no-op-safe.
- **Complexity**: large
- **Risk**: high

### Variant 3: Checkpoint-extension decorator with projected audit
- **Approach**: Don't change dream's control flow at all - extend the `dream-workrun` checkpoint enum with the new phase names and emit richer phase summaries at the existing checkpoint seams (`cluster_complete` ~ reconcile, `promote_complete` ~ synthesize), so phases are virtual labels over the current pipeline. New behaviours ship as flag-gated decorators, and the per-pref audit is a read-time projection over existing log events keyed by pref id (like `timeline.ts`), with the morning brief composed from existing digest output.
- **Trade-offs**: Pro - lowest churn; control flow provably untouched; audit projection adds zero new on-disk state (byte-identical by default for free). Pro - naturally incremental. Con - phases mapped onto existing checkpoints rather than truly explicit ordered phases, only partially honouring feature 2. Con - a projected audit can only report what was already logged; cannot reconstruct before/after hashes that were not emitted, and misses manual edits made outside the log path, weakening the lifecycle-trace goal.
- **Complexity**: small
- **Risk**: medium

### Consultant recommendation: Variant 1
Only variant that makes the dream phases genuinely explicit and ordered while
preserving the proven internals verbatim, honouring "wrap/extend, don't
rewrite". Chokepoint audit (vs Variant 3's projection) yields an authoritative
before/after trail that also catches manual edits; the new audit state is easy
to gate so a no-mutation run stays byte-identical.

## Orchestrator decision: Variant 1 (agree with consultant)

Adopted without override. Variant 1 is the only option that satisfies the hard
"do not rewrite the proven `dream()` core" constraint while still delivering
genuinely explicit ordered phases. Variant 2's relocation of battle-tested
planning logic (pinned-rebut retain, signal suppression, gated retires,
guardrail quarantine) is the precise risk the constraints forbid, and its diff
size strains the one-PR-per-version rule. Variant 3's projected audit cannot
reconstruct authoritative before/after content hashes and misses manual edits,
failing feature 1's "trace the full lifecycle" goal. Variant 1's only cost -
new audit on-disk state - is neutralised by gating the append on an actual
content-hash change, preserving the byte-identical default-install contract.
