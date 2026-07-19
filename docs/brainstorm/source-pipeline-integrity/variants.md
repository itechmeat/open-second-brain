# Source pipeline integrity and operator tooling - variant audit trail

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw
output in `cli-output/claude.md`. Three variants were requested for the wave
architecture as a whole (where shared abstractions live), not for the worth
of individual units. The fallback consultant (Codex) was not invoked because
the primary run succeeded with three parseable variants.

## Variant 1: Two shared kernels, cluster-local units

- **Approach**: extract exactly two new shared abstractions, each riding in
  with the first unit that needs it - a gitignore-style path-scope engine
  (`src/core/fs/ignore.ts`) introduced by the hygiene-scan unit and consumed
  by ingest scoping, and a diagnostics-signal model (issue class + detector +
  optional fixer + next-command hint) introduced by `doctor --repair` and
  consumed by the status snapshot. Everything else lands as local changes to
  its existing module, in four clusters with a short dependency spine.
- **Trade-offs**:
  - Pro: shared logic gets exactly one home without any infrastructure-only
    commit; each abstraction ships inside a feature commit with tests.
  - Pro: maximal prefix-shippability; a stalled wave leaves `main`
    releasable after any unit.
  - Pro: byte-identical opt-out is easy; nothing changes uninvoked.
  - Con: the ingest path stays four separate touch points rather than one
    explicit pipeline; a future wave may want that consolidation.
  - Con: the diagnostics model shape is set by the repair unit and may need
    a small extension when the snapshot unit arrives.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Source-pipeline spine

- **Approach**: treat the five intake units as stages of one explicit
  discovery pipeline abstraction (`SourcePipeline` context with typed hooks:
  scope, gate, pre-extract, dispatch, reconcile); operator tooling reads a
  shared health-signal registry; remaining units stay peripheral.
- **Trade-offs**:
  - Pro: strongest conceptual match to the wave theme; one choke point for
    what enters the vault.
  - Pro: reconciliation and gating become trivially testable pipeline
    stages.
  - Con: the pipeline scaffold is an infrastructure commit the repo's
    conventions discourage, and it forces refactoring `ingest.ts` /
    `batch-plan.ts` before any user-visible unit ships; a stalled wave
    leaves a half-migrated pipeline.
  - Con: highest risk to byte-identical opt-out, since existing ingest is
    rerouted through new machinery even when no new flag is set.
  - Con: hygiene importing from `brain/ingest` inverts layering; the ignore
    engine must live below both anyway.
- **Complexity**: large
- **Risk**: high

## Variant 3: Eleven islands, convention-only sharing

- **Approach**: every unit lands independently in its own existing module
  with no new shared homes; ignore parsing lives inside `hygiene/` and
  ingest imports it across layers; the snapshot re-formats six verbs'
  outputs itself; fixers pair with doctor checks ad hoc.
- **Trade-offs**:
  - Pro: cheapest to execute, easiest to parallelize, every commit small
    and independently revertable.
  - Pro: near-perfect prefix-shippability with zero scaffolding.
  - Con: the ignore engine under `hygiene/` with `ingest/` importing it
    violates one-directional layering, or gets duplicated.
  - Con: the snapshot re-deriving signals from six verbs duplicates
    presentation logic and drifts; hints get hardcoded per call site.
  - Con: defers exactly the consolidation debt the post-v1.30.1 refactor
    paid down.
- **Complexity**: small
- **Risk**: medium

## Consultant recommendation

Variant 1. "Variant 1 delivers the two abstractions this wave genuinely
reuses (ignore composition, diagnostics signals with hints) in their correct
one-home locations, while avoiding Variant 2's infrastructure-first commit
and its threat to the byte-identical opt-out and atomic-feature-commit
conventions. Unlike Variant 3, it keeps layering one-directional - the
ignore engine sits below both hygiene and ingest, and hints travel with
issue definitions instead of being duplicated in the snapshot. Its short
dependency spine (1->2, 9->10) preserves the constraint that a partially
completed wave still ships as a coherent prefix of v1.34.0." (quoted
verbatim from the consultant output, arrows ASCII-normalized)

## Orchestrator decision

Variant 1 is adopted without override. It is the same anchor-owned shared
abstraction pattern that succeeded in the v1.32.0 and v1.33.0 waves, applied
to this wave's shape: here the two shared pieces (path-scope engine,
diagnostics-signal model) each ship inside the first consuming feature
commit, keeping every commit release-visible and the layering
one-directional. The accepted ordering constraints (P1 before P2, O2 before
O3) are recorded in `plan.md`.
