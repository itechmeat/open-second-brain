# Workspace Insight Suite - brainstorm audit trail

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw output in `cli-output/claude.md`. Codex fallback not needed (primary returned 3 parseable variants).

## Variant 1: Two cluster-aligned kernels

- **Approach**: Build exactly two shared kernels matching the two clusters. Cluster A gets a **read-side resolution + origin-tagging kernel**: a `SourceResolver` that extends the existing `profiles.ts` resolution chain to cover project pointer files (A2), registered read-only sources (A2), and union/global mode (A3), emitting a single `origin` label that rides the existing `reasons[]` mechanism and feeds `profile.md`/`sgrep` (A4). A1's link builder and B's pipeline are smaller standalone pieces: Cluster B gets a **deterministic candidate→trigger kernel** that normalizes output from existing report generators (health, retention, stale, watchdog, backlinks, pre-compact) into a common `Candidate` record, which the `Brain/triggers/` lifecycle (B2) consumes and which B1/B3 produce; B4 plugs decisions into the existing `recall-telemetry.ts`.
- **Trade-offs**:
  - Pro: kernel boundaries follow the cluster seams, so the PR reads as two coherent stories rather than eight patches.
  - Pro: origin label reuses `reasons[]` and trigger records reuse Markdown+JSONL - no new cross-cutting abstractions.
  - Pro: writes-stay-local and read-only invariants concentrate in one resolver, easy to test once.
  - Con: A1 (link format) and B4 (telemetry) don't fit either kernel cleanly and remain semi-isolated.
  - Con: the candidate kernel must accommodate heterogeneous report shapes, risking a lowest-common-denominator record.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Minimal shared primitives, feature-local modules

- **Approach**: Introduce only the smallest shared types - an `origin` field on search results, a `LinkFormat` config + builder, and a `Candidate` record shape - then implement all eight tasks as independent modules consuming those primitives. No shared resolver or pipeline; each feature owns its own vault discovery, candidate assembly, and surface wiring.
- **Trade-offs**:
  - Pro: lowest coupling; any single feature can be reverted or deferred without disturbing the others.
  - Pro: each module is individually small and easy to TDD in isolation.
  - Pro: least risk of touching the sensitive `profiles.ts` resolution chain in a wide-reaching way.
  - Con: duplicates vault-resolution and origin-labelling logic across A2/A3/A4, and report-scanning logic across B1/B3 - directly against the "small number of shared kernels" constraint.
  - Con: eight loosely-related modules make the PR feel like a grab-bag, weakening reviewability and consistency.
  - Con: invariant enforcement (read-only sources, writes-local) is scattered, raising the chance one path leaks a write.
- **Complexity**: small-to-medium
- **Risk**: medium (incoherence + duplicated invariant checks)

## Variant 3: Unified federation registry + insight bus

- **Approach**: Collapse all read-source concerns (profiles, project pointers, read-only sources, global mode) behind one `SourceRegistry` federation abstraction that becomes the single resolver for every read path, and collapse all proactive output behind one "insight bus" where every report generator emits events into `Brain/triggers/` and the lifecycle is the sole consumer. A1, A4, B3, B1 all become thin producers/consumers on these two backbones.
- **Trade-offs**:
  - Pro: maximal reuse; conceptually the cleanest end state (one read federation, one insight stream).
  - Pro: future vaults/sources/reports plug in with near-zero new surface.
  - Con: rewrites the `profiles.ts` resolution chain and reroutes existing search/context-pack reads through a new layer - high blast radius against "additive only / backward compatible" and "full/writer scopes byte-identical" constraints.
  - Con: forcing health/retention/stale/synthesis/idea generators to emit into one bus is a large refactor of working deterministic code for features that are mostly default-off.
  - Con: hardest to land safely in one PR; a bug in the federation layer breaks every read.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation

### Recommended: Variant 1

**Rationale**: It satisfies the explicit "small number of shared kernels" directive by mapping two kernels to the two clusters, while keeping each kernel additive - the origin label rides the existing `reasons[]` field and the trigger queue consumes existing report output, so no public API or scope changes. Variant 2 duplicates the very vault-resolution and candidate logic the constraint warns against, and Variant 3's rewrite of the `profiles.ts` resolution chain and report generators carries too much blast radius for default-off features shipping in a single PR.

## Orchestrator decision

Variant 1 accepted as recommended, with two refinements documented in `design.md`:

1. The Kernel A "SourceResolver" is decomposed into three small modules (pointer discovery, recall-sources registry, origins enumerator) rather than one class - same kernel boundary, but each piece stays independently testable and `resolveVault` gains only a walk-up hook instead of a new abstraction layer.
2. The accepted con "A1 and B4 remain semi-isolated" is treated as a feature: A1 stays a pure formatting kernel and B4 an emission point on the existing continuity-record kernel; neither is forced into a kernel it does not need.
