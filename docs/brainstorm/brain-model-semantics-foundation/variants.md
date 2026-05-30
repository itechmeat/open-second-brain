# Brain Model Semantics foundation - variants

## Consultant output

### Variant 1: Frontmatter-native vocabulary extension

- **Approach**: Lay the foundation entirely in the source-of-truth Markdown by extending the existing `relation-vocab.ts` vocabulary with the preference-specific relation types the upstream tasks imply (`depends_on`, `refines`, plus the already-present `contradicts`/`superseded_by`), and adding optional `relation`-shaped frontmatter fields and a single optional `layer` tag to the preference parser. The explorer projects these through `ExplorerEdge.kind` so typed edges and layer become visible without any new storage. Branching is represented only as an optional `branch` string label on a preference (a soft namespace), with no copy-on-write machinery - selective pick remains a future merge-side concern.
- **Trade-offs**:
  - Pro: Maximally aligned with constraints - reuses the single validation boundary, no parallel subsystem, byte-identical default (fields absent unless supplied).
  - Pro: Deterministic and LLM-free; edges/layers live in the plain files the README promises to own.
  - Pro: Smallest test surface - extends `explorer.test.ts` and `backlinks-relation.test.ts` rather than adding suites.
  - Con: Branching is only a label, not isolation - defers the hardest upstream feature almost entirely.
  - Con: Layer is a flat tag with no per-layer lifecycle, so L0-L3 retention policies are not yet expressible.
- **Complexity**: small
- **Risk**: low

### Variant 2: Unified semantics descriptor with deterministic backfill

- **Approach**: Introduce one cohesive optional "semantics" block on the preference model in `types.ts` that carries all three concepts together - typed edges (validated against `relation-vocab`), a `layer` enum (L0-L3), and a `branch` label - parsed and written through `preference.ts`. Pair it with a dry-run-default backfill tool (mirroring ContextLattice's `memory-edge-backfill`) that deterministically derives high-confidence `same-session`/`exact-topic` edges from existing `evidenced_by` and topic slugs. The descriptor is the shared foundation all three future layers build on.
- **Trade-offs**:
  - Pro: Treats the three tasks as one coherent model layer, avoiding three disjoint half-features.
  - Pro: The backfill-with-dry-run pattern is directly reusable by existing merge/scan operations and is fully deterministic.
  - Pro: Single descriptor gives every future layer (branch isolation, per-layer lifecycle) a stable home.
  - Con: Larger schema footprint up front; risk of speculative fields that stay empty if branching/layering never land.
  - Con: A `layer` enum baked into the core preference type nudges toward the L0-L3 restructure the constraints explicitly say not to do in one PR.
  - Con: Backfill tooling adds a CLI surface and its own test suite.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Derived projection and index layer

- **Approach**: Keep preference files essentially untouched and compute typed semantics on the read side - `explorer.ts` and a deterministic derivation step infer edges (`depends_on`/`refines`/`contradicts`) and a layer classification from existing signals (`evidenced_by`, topic slugs, confidence, session adapters) into a derived, regenerable index rather than stored frontmatter. Branching and selective pick are modeled as alternate derivation views over the same vault, not stored state.
- **Trade-offs**:
  - Pro: Zero schema change to the source of truth; default install is trivially byte-identical and nothing is written unless regenerated.
  - Pro: Edges and layers stay always-consistent with their sources because they are recomputed, never hand-maintained.
  - Pro: Naturally fits the existing derived-artifact pattern (active.md is already auto-generated).
  - Con: Operator cannot author an explicit relationship (e.g. "pref-a depends-on pref-b") - only inferred edges exist, contradicting the upstream "first-class typed edge" intent.
  - Con: A derivation/index step risks becoming the parallel graph subsystem the constraints forbid.
  - Con: Heuristic layer classification is fragile and hardest to test deterministically.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 1

**Rationale**: It is the only variant that satisfies every hard constraint at once - additive, deterministic, schema-compatible, byte-identical by default, and built strictly on the existing `relation-vocab`/`backlink`/`explorer` surfaces rather than a new subsystem. The task is explicitly a _foundation_, and the validator comments require an ADR before branching and L0-L3 lifecycle are built, so Variant 1 establishes the typed-edge and layer-tag vocabulary now while deferring copy-on-write branching and per-layer lifecycle exactly as the constraints demand. Variant 2's unified descriptor and Variant 3's derived index both over-commit to mechanisms (a baked-in layer enum, an inference subsystem) that pre-empt decisions the ADRs are meant to make.

## Orchestrator decision

Chosen: Variant 1.

The existing typed graph semantics work already established `src/core/graph/relation-vocab.ts` as the single validation boundary, and the Brain backlink index already consumes known frontmatter relation fields. Reusing that path gives the selected scope a real implementation foundation without introducing speculative branch storage, a second graph, or layer-specific lifecycle policy before the ADR has settled those decisions.

The implementation should therefore ship a narrow additive slice: preference-authored typed edge vocabulary and explorer projection, optional `memory_layer` / `memory_branch` metadata with validation, and a deterministic dry-run planner for supersession-edge backfill. Full copy-on-write branches, selective pick commands, REST service mode, and per-layer retention remain out of scope for this PR.
