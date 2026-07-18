# Belief lifecycle and decision memory - variant audit trail

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw
output in `cli-output/claude.md`. Three variants were requested for the wave
architecture as a whole (where shared abstractions live), not for the worth
of individual units. The fallback consultant (Codex) was not invoked because
the primary run succeeded with three parseable variants.

## Variant 1: Foundation-first shared kernels

- **Approach**: land two infrastructure modules before any feature unit - a
  supersession-lifecycle kernel and a decision-record kernel - then implement
  all units as thin consumers.
- **Trade-offs**:
  - Pro: interval math, chain traversal, and receipt idempotency written once.
  - Pro: matches the shared-choke-point convention.
  - Con: kernel APIs are designed speculatively before any consumer exists;
    requirements discovered late force mid-wave kernel rework.
  - Con: infrastructure-only commits violate the one-atomic-feature-commit
    convention and could ship dead code if the wave slips.
  - Con: serializes the whole wave behind two kernel commits.
- **Complexity**: large
- **Risk**: medium

## Variant 2: Fully isolated units, existing surfaces only

- **Approach**: no new shared modules; every unit patches existing choke
  points independently, duplicating chain walking, interval validity, and
  injection changes per unit.
- **Trade-offs**:
  - Pro: maximal commit atomicity and parallelism; smallest per-unit risk.
  - Con: at least three divergent implementations of chain-tip resolution and
    two of interval validity - user-visible inconsistency between recall,
    inject, and dream.
  - Con: the two injection units patch the same loop uncoordinated; silent
    conflicts in budget/spacing rules.
  - Con: guarantees a post-wave dedup refactor, against the post-v1.30.1
    direction.
- **Complexity**: medium
- **Risk**: high

## Variant 3: Cluster tracks with anchor-unit-owned abstractions

- **Approach**: two tracks (supersession spine, decision memory) whose first
  unit ships the track's shared module inside its own feature commit; later
  units consume it. One small cross-track injection-governor helper introduced
  by the first injection unit and reused by the second. Two standalone units.
- **Trade-offs**:
  - Pro: every commit is a real feature, yet shared logic has exactly one
    home; abstractions are designed against a concrete first consumer.
  - Pro: shallow explicit ordering; a track can stop early and still ship its
    landed prefix coherently.
  - Con: intra-track ordering limits parallelism.
  - Con: anchor commits are larger than average; a mid-track flaw in the
    anchor abstraction means churn inside the release branch.
- **Complexity**: medium
- **Risk**: low

## Consultant recommendation

Variant 3. "The wave's real coupling is exactly two clusters (supersession
spine, decision family) plus one injection touchpoint, and anchor-owned
abstractions put each shared piece in one place without Variant 1's
speculative infrastructure commits or Variant 2's guaranteed chain-walking
divergence between recall, inject, and dream. It is the only variant that
keeps every commit an atomic user-visible feature (the project's own release
convention) while honoring the post-v1.30.1 'shared choke points,
one-directional layering' rule, and its shallow ordering means a partially
completed wave still ships coherently as v1.33.0." (quoted verbatim from the
consultant output)

## Orchestrator decision

Variant 3 is adopted without override. It repeats the architecture pattern
that succeeded for the v1.32.0 wave (cluster-scoped kernels, per-unit atomic
commits) while adapting it to this wave's shape: here the shared modules ride
inside anchor feature commits instead of standalone kernel commits, which
keeps every commit release-visible. The accepted ordering constraints
(A1 before A2/A3/A4, B1 before B2/B3/B4, A4+B2 before B5) are recorded in
`plan.md`.
