# Variants considered - write-honesty-egress-consent

Consultant: codex gpt-6.1-sol (high reasoning), prompted with the six verified
feature briefs and the repo conventions; output preserved verbatim in
`cli-output/codex.md`, prompt in `cli-output/prompt.md`.

## Variant 1: Feature lanes with queued integration (consultant)

- Approach: one lane per feature, shared files owned by single lanes, other
  lanes' changes applied through a serialized integration queue; census and
  registry updates integrated with each feature; combined architecture checks
  after every merge.
- Trade-offs: accountable per-feature ownership and immediate progress on leaf
  modules; shared-file owners become bottlenecks and policy assumptions can
  surface late.
- Complexity: medium. Risk: high.

## Variant 2: Contract-first dependency waves (consultant)

- Approach: a short substrate wave establishing leaf-module contracts,
  shared-file ownership and the census registration sequence, then six lanes
  (integration/substrate, F1+F5, F2, F3, F4, F6); the integration owner applies
  prepared changes to shared files in dependency order (predicates and
  resolvers, enforcement and persistence, reporting surfaces); census rows land
  with the implementation that needs them; combined acceptance checks at the
  end.
- Trade-offs: explicit shared-file coordination with parallel implementation;
  privacy and content-class grouped for consistent policy handling; census
  updates sequenced with real implementation; needs an initial coordination
  pass and disciplined handoffs; wrong early contracts ripple across lanes.
- Complexity: medium. Risk: low.

## Variant 3: Enforcement spine first, advisory features second (consultant)

- Approach: F6 first, then F1 and F5 as the gated enforcement stage while other
  coders prepare F2/F3/F4 against agreed interfaces; advisory features
  integrate after enforcement passes its checks; per-stage doctor,
  state-surface and registry changes; final combined verification.
- Trade-offs: early review concentrates on disclosure and outbound calls and
  regressions localize easily; imposes ordering between features with no
  technical dependency and leaves coders idle.
- Complexity: large. Risk: medium.

### Recommended: Variant 2 (consultant)

Rationale (consultant): useful parallel work with disjoint file ownership and an
explicit route for shared-file edits; one integration lane coordinating doctor
codes, state surfaces and the egress registry reduces census conflicts while
preserving fail-closed checks; the substrate stays limited to concrete contracts
and leaf primitives.

## Orchestrator decision

Variant 2 adopted, with two adaptations that keep its risk profile while
removing its serialization cost:

1. The substrate "wave" is folded into the lanes themselves: every lane lands
   its leaf/contract primitive as its first task (A1, B1, C1, D1, E1, F1t are
   all pure leaf modules or resolvers), so no separate coordination pass delays
   the start. The cross-lane contracts that would have been "established" up
   front are pinned in plan.md instead: file ownership per lane, the two
   append-with-poll shared files (diagnostics.ts, docs/cli-reference.md), the
   indexer.ts single-owner rule, and the provider-construction decline contract
   that keeps Lane F out of indexer.ts entirely.
2. The consultant's F1+F5 pairing is split back into two lanes (A and E): their
   file sets are disjoint (graph/visibility roots vs egress seam), and the
   policy consistency the consultant wanted is already guaranteed because both
   lanes enforce at their own single boundary (remote-deny at the read roots,
   content class at the shared guard) with their own census rows.

Lane graph and acceptance criteria per task: plan.md. Six lanes start in
parallel; one integrator runs the combined gates.
