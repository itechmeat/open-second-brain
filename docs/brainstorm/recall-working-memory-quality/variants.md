# Recall & Working-Memory Quality Suite - brainstorm audit trail

Primary consultant: Claude Code (`claude -p`), exit 0, three parseable variants
plus a recommendation. Fallback consultant (Codex) NOT invoked - primary
succeeded with >= 2 variants. Full verbatim output: `cli-output/claude.md`.

## Variant 1: Federated patches with a shared config block (small / low)

Each unit a self-contained module; only shared structure is one optional nested
block on `ResolvedSearchConfig` plus `resolveRecallProfile`. Read-side weighting for
decay and file-context written inline at the score-combination site in `search.ts`.

- Pro: smallest diff; independently testable/revertable; trivial byte-identical OFF;
  no new abstraction to get wrong.
- Con: read-side logic for Units 3 and 4 scattered and order-sensitive, no single
  seam; persistence conventions re-implemented per unit; reads as four patches that
  merely landed together.

## Variant 2: Two shared primitives - profile/knob resolver + composable read-side adjuster fed by signal readers (medium / medium) - RECOMMENDED

A `resolveRecallProfile` reusing `tuning.ts` axes, plus a read-side `ScoreAdjuster`
composition point fed by small `UsageSignalReader`s over `recall_telemetry`.
Co-occurrence stays a dream-side producer sharing only the persistence convention.

- Pro: genuine composition on the one axis that overlaps (read-side weighting);
  shared signal readers + persistence convention; clean identity-transform OFF.
- Con: needs up-front adjuster-contract/ordering design; two seams; a middle ground.

## Variant 3: Unified RecallContext orchestrator with internal signal/pass registry (large / high)

A single `buildRecallContext` owns profile expansion, signal registration, adjuster
composition, file-context path, and a maintenance-pass registry for co-occurrence.

- Pro: maximal uniformity; most natural growth toward future recall sources.
- Con: heavy abstraction for four small units; sits on the hot `search()` public
  path (enlarges blast radius, harder byte-identical proof); drifts toward the
  explicitly-deferred external recall-source registry; highest review cost.

## Consultant recommendation: Variant 2

> It matches the stated goal of one or two shared primitives precisely ... the units
> compose on the single axis they truly share (read-side weighting) while
> co-occurrence stays a dream-side producer behind only the shared persistence
> convention ... deliberately stops short of the orchestrator/registry that would
> drift into the explicitly deferred external-source scope.

## Orchestrator decision: ADOPT Variant 2, with one scoping refinement

Accepted. Variant 2 fits the project's established conventions (flag-gated,
deterministic, versioned+hashed persistence, byte-identical OFF) and the "one or two
shared primitives" goal better than the minimal Variant 1 (which re-implements
persistence per unit and scatters read-side logic) or the heavy Variant 3 (which
puts an orchestrator on the hot search path and drifts toward the deferred
external-source registry).

Refinement (documented in `design.md`): the consultant placed the read-side adjuster
for BOTH decay and file-context on the `search()` public path. We keep the
two-primitive philosophy but scope the read-side weight to where candidates actually
flow - decay weighting in the continuity read-model, file-context as a standalone
surface reusing `session-focus.ts`. This leaves the `search()` default path
untouched, making the byte-identical guarantee cheaper and the blast radius smaller -
which addresses the consultant's own stated risk about widening the search hot path.
This is a scoping choice within Variant 2, not a different variant.
