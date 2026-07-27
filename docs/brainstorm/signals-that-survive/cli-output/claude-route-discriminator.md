### Variant 1: In-router discriminator ladder on a candidate-score table

- **Approach**: Keep `routeExtractedFacts` as the single write router, but split its decision into two explicit pure functions: `scoreRouteCandidates(fact, ctx)` returning a frozen, deterministically-ordered `{ route, score }[]` built from the structural features already available (family-pattern match length, span coverage of the line, overlap with a URL range, entity-anchor count, durability signal set, dedup history for the hash), and `discriminate(candidates)` which fires only when `top.score - second.score <= MARGIN`. The discriminator is a fixed, ordered ladder of registered rules, each a pure structural predicate with a stable id (`overlap-containment`, `anchor-majority`, `span-coverage`, `family-table-order` as the terminal always-decides rule); the first rule that separates the tied candidates wins and its id is recorded. Every discrimination emits one `route_discrimination` continuity record through `emitGatedTelemetry` behind a new config key, carrying the candidate set, scores, margin, winning route, and the rule id — never the fact text.
- **Trade-offs**:
  - Pro: touches one call site; the existing dedup → durability → staging → write chain is unchanged, and with the gate key absent behaviour is byte-identical because the terminal rule reproduces today's family-table order.
  - Pro: fully deterministic and word-list-free — every feature is a count, an offset, or a set membership, so it behaves identically across scripts.
  - Pro: rule ids make tie-breaks auditable and tunable; `MARGIN` is one named constant, and misroute rates become measurable per rule.
  - Pro: no new public CLI/MCP surface required to ship the mechanism; the reader can follow later.
  - Con: the score table is bespoke to the extracted-facts router; a second write path (preference vs note vs pinned) would need its own copy unless it is generalised later.
  - Con: score weights are a tuning surface with no ground truth on day one — early records will mostly confirm the terminal rule fires, which looks like low value until data accumulates.
  - Con: adds a second decision point to a hot capture path, so the ladder must stay allocation-cheap.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Extracted two-stage routing kernel shared by all write surfaces

- **Approach**: Introduce `src/core/brain/routing/` holding a route-agnostic kernel — a `RouteCandidate` type, a `CandidateScorer` interface, a `Discriminator` registry keyed by stable id, and a `resolveRoute()` driver that runs primary scoring, detects near-equality, applies the registry in registration order, and emits the gated `route_discrimination` record once for every write surface. `routeExtractedFacts` becomes the first consumer by supplying a fact-specific scorer; the signal/preference/note/pinned writer entry points become subsequent consumers with their own scorers over the same kernel, so the tie-break record shape is identical regardless of which write path produced it.
- **Trade-offs**:
  - Pro: DRY across the whole write surface — the misfiled-write problem the task names is not confined to extracted facts, and this is the only variant that addresses signal-vs-obligation and note-vs-decision ambiguity in the same mechanism.
  - Pro: one telemetry schema, one config gate, one advisory-rail code family for every routed write; `dream` gets a uniform reconciliation input.
  - Pro: the registry makes the discriminator set inspectable and testable independently of any router.
  - Con: largest blast radius — it re-plumbs write paths that currently have no ambiguity problem proven against them, and the writer MCP tools are an existing public surface that must stay compatible.
  - Con: the abstraction is being designed from exactly one concrete consumer, so the scorer interface risks being shaped wrong and rewritten at the second adopter.
  - Con: significant test surface across many existing writer tests before any behaviour improves.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Ambiguity as its own route — quarantine plus a registered advisory exit

- **Approach**: Compute the same candidate score table, but when the top candidates are within the margin, do not pick a winner: route the fact to an explicit ambiguous lane (reusing the existing `Brain/pending/` staging machinery already wired through `writeApprovalEnabled` and `brainDirsForWrite`), record the full candidate set on the staged item, and surface a registered advisory-rail code so the operator or `dream` resolves it. The tie-break rules exist only as ranking hints presented alongside the candidates, never as an autonomous decision, and the gated `route_discrimination` record captures both the candidate set and the eventual resolution when it lands.
- **Trade-offs**:
  - Pro: strictly honest — an ambiguous write is never silently guessed, and it fits the v1.40.0 "every diagnosis names its exit" precedent directly, since ambiguity is exactly a state that needs a named exit.
  - Pro: reuses `Brain/pending/` rather than inventing a lane; the resolution events become ground-truth training data for the score table a later variant would need.
  - Pro: zero risk of a wrong automated tie-break, since there is no automated tie-break.
  - Con: does not actually cut the misfiled-write rate — it converts misfiles into operator queue depth, moving the cost rather than removing it, and the task's stated value is reducing what `dream` must reconcile.
  - Con: a low margin threshold floods the pending lane; a high one makes the whole stage inert, and there is no data yet to pick between them.
  - Con: requires a resolution surface (CLI or MCP) to drain the lane, or the quarantine is a leak.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: It delivers the actual deliverable — a deterministic, auditable tie-break with its own gated emission — against the one router the corrected hints anchor to, without re-plumbing write paths whose ambiguity is still hypothetical, and the terminal `family-table-order` rule guarantees byte-identical behaviour when the gate key is absent as the conventions require. Variant 2 designs a cross-surface abstraction from a single consumer and would very likely be rewritten at the second one; the kernel is the right eventual shape, but only after Variant 1's records show what the scorer interface actually needs. Variant 3 answers a different question (who resolves ambiguity) rather than the one asked (how routing disambiguates), and its quarantine lane is best added later as a bounded escalation when Variant 1's telemetry shows a margin band the ladder genuinely cannot separate.
