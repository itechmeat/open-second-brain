# Entity Truth & Self-Improving Dream Suite - variants audit trail

Consultant: Claude Code (`claude -p`), 2026-06-04. Raw output: `cli-output/claude.md`.

## Variant 1: Ten Independent Feature Modules

- **Approach**: Treat each kanban task as a self-contained module with its own versioned store/envelope and its own CLI verb + MCP tool, sharing only the existing substrate (buildEntityIndex, dream.ts, weekly-brief.ts) read-only. Parent/child pairs (1-2, 3-4) sit in sibling files with a thin internal import rather than a shared abstraction. No new cross-cutting layer is introduced.
- **Trade-offs**:
  - Pro: maximum parallelizability - ten features can be built/tested/reviewed nearly independently; smallest blast radius per feature; bit-identical defaults are trivial to guarantee since each module is inert with no new data.
  - Pro: failure of one feature can't corrupt another; fail-closed parsing is per-store and simple.
  - Con: real duplication - entity-anchor resolution, claim addressing, and ranked-reason emission get reimplemented across conflicts/claim-slots/atomic-facts/contamination.
  - Con: weak synergy - claim slots (2), conflict records (1), and quantitative facts (4) clearly want one addressable per-entity representation; keeping them separate pushes integration cost downstream.
  - Con: ten new persisted formats to version and migrate.
- **Complexity**: large
- **Risk**: low

## Variant 2: Two Shared Backbones (Entity-Truth Ledger + Dream Signal Bus)

- **Approach**: Build one Entity-Truth Ledger that all of Half A reads/writes through - atomic-fact decomposition (3) and the quantitative family (4) feed addressable per-entity aspect slots (2), conflicts (1) and contamination checks are queries over that ledger, and cross-agent collision (5) diffs two agents' ledger writes. Half B introduces a Dream Signal Bus: surprisal (9), dead-ends (8), outcome-tied evidence (7), top-source (6), and foresight (10) all emit ranked, reasoned signals folded into the existing dream/weekly envelopes. Two cohesive cores instead of ten silos.
- **Trade-offs**:
  - Pro: strong cohesion where the domain genuinely shares structure - entity anchors and claim addressing live in exactly one place; conflict/slot/quantitative logic compose instead of duplicating.
  - Pro: cross-agent collision (5) and contamination (1) become near-free queries once the ledger exists; dream features share one ranking/reason convention.
  - Con: largest blast radius - the ledger sits on the hot fact-extraction path, so guaranteeing bit-identical neutral defaults requires careful gating.
  - Con: backbone must be designed before features land, reducing early parallelism; a ledger schema bug touches five features at once.
  - Con: temptation to over-generalize the bus for features (6, 10) that aren't really signals.
- **Complexity**: large
- **Risk**: medium

## Variant 3: Pure Fold-Over-Append-Only-Events

- **Approach**: Add no mutable state; every feature is a deterministic, replayable fold over existing append-only logs (sig-*.md, log JSONL, recurrence/events.jsonl) producing frozen envelopes, with new persisted artifacts limited to append-only event streams (conflict events, claim-supersede events, dead-end entries, foresight notes) each carrying a schema-version and fail-closed parser. Claim "current value" and conflict status are derived projections recomputed from the event stream, never stored mutably.
- **Trade-offs**:
  - Pro: most faithful to the stated convention (folds over mutable state, frozen replayable envelopes); bit-identical defaults fall out naturally since an empty event stream folds to the existing output.
  - Pro: provenance lineage (2) and superseded history are first-class because nothing is overwritten; auditing and rollback are uniform.
  - Pro: low risk to existing code - reads compose, writes only append.
  - Con: some features (claim slots with fast "what is true now", quantitative aggregation) need projection caches anyway, so a pure-fold stance leaks into derived stores regardless.
  - Con: recomputing folds for collision detection (5, push-mode within a recent window) and surprisal (9) on every event can be costly without indexing.
  - Con: more conceptual overhead per feature; contributors must think in folds even for simple checks.
- **Complexity**: medium
- **Risk**: low

## Consultant recommendation

### Recommended: Variant 2

**Rationale**: Half A's five features are not independent - atomic facts, the quantitative family, claim slots, conflicts, and contamination all revolve around one addressable per-entity claim representation, so a shared Entity-Truth Ledger eliminates the duplication of Variant 1 and the projection-cache awkwardness Variant 3 admits it would hit anyway. The medium risk it adds is concentrated on one well-understood path (fact extraction) and is manageable with the project's existing gating + fail-closed + bit-identical-default discipline, while the Dream Signal Bus for Half B reuses the established ranked-reason envelope-fold convention rather than inventing per-feature stores. Variant 1 ships faster but pushes integration debt downstream; Variant 3 is the cleanest philosophically but forces genuinely stateful artifacts (slots, lineage, registries) into a fold-only mold that doesn't fit them.

## Orchestrator decision

Variant 2 accepted with three containment refinements that import Variant 3's storage discipline and neutralize Variant 2's two stated cons:

1. **Ledger storage is fold-over-append-only.** The Entity-Truth Ledger persists as device-sharded append-only JSONL (`Brain/truth/claims.<deviceId>.jsonl`, the `log-jsonl.ts` pattern) plus a derived, recomputable fold state - exactly the activation-store shape shipped in v0.42.0. A ledger schema bug is recoverable by refolding; nothing mutable is the source of truth.
2. **No Dream Signal Bus abstraction.** Half B ships as additive optional envelope fields plus small standalone modules that share the existing ranked-`reasons` convention. The consultant itself flagged the over-generalization temptation for features 6 and 10; a shared convention costs nothing, a shared bus is machinery nobody asked for.
3. **Hot path stays untouched.** Fact extraction and pre-compact extraction behave bit-identically by default; ledger ingest is an explicit step (CLI verb / dream-step) so neutral defaults need no gating analysis on the capture path.
