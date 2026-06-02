# Recall Trust Suite — brainstorm variants (audit trail)

**Consultant:** Claude Code (`claude -p`), 2026-06-02. Raw output: `cli-output/claude.md`.
Prompt: `cli-output/prompt.md`. Fallback consultant (Codex) was not needed —
the primary returned 3 parseable variants.

## Variant 1: Independent feature modules

- **Approach**: Implement each of the five features as a self-contained module gated by its own config flag, wired into the orchestrator at its natural seam (A/B into `ranker.ts`, C/E into `evidence-pack.ts`, D into candidate filtering + CLI/MCP schema). No shared abstraction is introduced; each feature owns its own helpers, including separate "significant term" and coverage logic for C and E.
- **Trade-offs**:
  - Pro: Each commit maps cleanly to one kanban task; trivial to TDD and revert in isolation.
  - Pro: Lowest blast radius — a flag-off feature touches nothing else; default behavior trivially stable.
  - Pro: No early refactor of shared internals, so review stays localized.
  - Con: C (rare-term gate / IDF coverage) and E (top-N term coverage) independently reimplement term-significance and coverage matrices, risking divergent verdicts on the same query.
  - Con: B's learned-weight path and A's relation layer both mutate the weight profile without a shared contract, inviting subtle ordering bugs.
  - Con: Duplication accrues as future trust features land.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Shared trust substrate first

- **Approach**: Land foundational primitives in the early commits — a term-signal engine (significant-term extraction, per-token record union, IDF statistics, coverage matrix) plus a relation-signal resolver — then implement all five features as thin consumers of that substrate. C, E, and the rare-term gate all read one coverage matrix; A and B feed one scoring-context object.
- **Trade-offs**:
  - Pro: Single source of truth for "significant/rare term" and coverage; C and E verdicts are guaranteed consistent.
  - Pro: Cleanest long-term architecture; future trust features extend the substrate cheaply.
  - Pro: Centralized determinism/auditing surface aligns with the `why_retrieved` philosophy.
  - Con: The first commits are foundation, not kanban tasks — breaks the clean one-commit-per-feature mapping and the TDD-per-task framing.
  - Con: Largest upfront refactor of `ranker.ts`/`evidence-pack.ts` internals; higher chance of perturbing stable default behavior or the config-fingerprint cache key.
  - Con: Bigger, harder-to-review diff before any user-visible feature lands.
- **Complexity**: large
- **Risk**: medium

## Variant 3: Two-phase layering (pre-rank signals vs post-rank verification overlay)

- **Approach**: Split the suite along the existing pipeline. A pre-rank "signal injection" group — A (relation polarity into the ranker), B (learned weights into weight resolution), D (time constraint into candidate filtering) — shares the weight-profile/candidate path. A post-rank "verification overlay" group — C (per-token union + IDF + rare-term gate) and E (completeness verdict) — shares one coverage engine built over the final candidate set in the evidence-pack stage. Sharing is introduced only where features genuinely overlap (C+E coverage), not globally.
- **Trade-offs**:
  - Pro: Each feature remains its own atomic, TDD'd commit while C and E still share the one place they truly overlap.
  - Pro: Maps onto real pipeline seams (rank vs evidence-pack post-pass), so the scoping is self-documenting and defaults stay isolated per group.
  - Pro: Avoids Variant 2's foundation-first commit and Variant 1's C/E duplication.
  - Con: Two coupling boundaries to keep clean (weight-profile contract; coverage engine), more design thought than Variant 1.
  - Con: The shared coverage engine still lands inside whichever of C/E is built first, so commit ordering carries a small dependency.
- **Complexity**: medium
- **Risk**: low-medium

## Consultant recommendation

**Variant 3.** Rationale (verbatim): It honors the hard constraints — atomic
per-feature commits, opt-in additive features, stable defaults — while
consolidating the one substantive overlap (C's IDF/rare-term coverage and E's
completeness audit both need a per-token coverage matrix) so the two cannot
produce contradictory verdicts. It fits the existing orchestrator seams
(pre-rank scoring vs evidence-pack post-pass) without Variant 2's risky
foundation-first refactor of the cache-fingerprinted ranking core, and avoids
the duplication and drift that Variant 1 would bake into the trust layer.

## Orchestrator decision

**Agree with the consultant: Variant 3.** Project context confirms the
recommendation: prior suites (#46, #47, #54) all landed as per-feature atomic
commits on existing pipeline seams, and `search.ts` already models exactly the
two seams Variant 3 uses (the `assemble()` rank pass and the
`evidencePack === true` post-pass). Variant 2 would refactor the
cache-fingerprinted core that PR #47's query cache depends on — unnecessary
risk for this scope. The C/E coverage engine lands as its own module
(`coverage.ts`) inside the Feature C commit, then E consumes it; commit
ordering in `plan.md` encodes that dependency.
