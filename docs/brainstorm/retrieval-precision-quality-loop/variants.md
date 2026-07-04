# Architecture variants - retrieval-precision-quality-loop

Branch: `feat/retrieval-precision-quality-loop`. Consultant output is preserved verbatim in
`cli-output/claude.md`; this file restates the three variants verbatim and records the final
decision and rationale.

## Variant 1
Approach: Introduce one shared per-item annotation envelope early on the branch - a
`RetrievalAnnotations` extension threaded through `context-pack.ts`/`context-receipts.ts` and
the reader tail - and have every card attach its field to that single struct (A: rerank score,
C: epistemic status + `evidence_refs`, D: adequacy verdict, E: satisfaction signal). Cards land
in sequence, each extending the same envelope rather than opening a new output seam. B folds its
outcome tag onto the same annotation vocabulary.
Trade-offs:
- Cleanest composition: C->D and A->enrich share one growth point, so the C/D output-shape
  collision and the A/rerank-tail collision collapse into "extend the struct."
- Broad blast radius on the shared type; a defect in the envelope touches all five read paths
  at once.
- Per-card bit-identity is harder to verify: each card mutates a struct other cards also read,
  so the off-branch proof is no longer a single guarded call site but "this field defaults
  absent and nothing consumes it."
- Front-loads an abstraction before the second consumer exists, risking speculative shape.
Complexity: large
Risk: medium

## Variant 2
Approach: Keep each card a self-contained stage with its own module, its own default-off config
key, and one guarded call site, minimizing shared types. Resolve the real collisions purely by
ordering so the later card extends an already-merged seam: A -> C -> D -> E -> B. A appends
after the existing heuristic reranks in the reader tail; C adds the epistemic field to context
items; D extends C's now-merged item shape with the verdict and reads gate-telemetry/coverage; E
instruments the recall path D already touched; B lands last as the capstone assembly over a
fully-merged branch.
Trade-offs:
- Maximal per-card bit-identity: every off-branch is a single guarded call site whose unchanged
  output is trivially verifiable.
- Smallest blast radius per card; a regression is isolated to one stage.
- Directly mirrors invariant #6 and the demonstrated one-PR-many-cards cadence - no up-front
  shared abstraction to design or defend.
- Mild duplication: C's status and D's verdict are emitted as adjacent-but-separate fields; B
  and E each own their persistence (`Brain/lessons/*` vs `Brain/demand-log/*`) with no shared
  writer.
Complexity: medium
Risk: low

## Variant 3
Approach: Land the two persistence substrates and a shared recall-event record first - B's
outcome-tagged lessons corpus and E's demand log both emitted as continuity/`gate_telemetry`-
style records - then rebuild the read-side cards (A, C, D) as consumers of that common event
stream. D and E share one recall-event emission; B and E share the record substrate; the dream
pass folds everything.
Trade-offs:
- Resolves the B/E persistence collision and the D/E recall-instrumentation collision via one
  shared emission point.
- Inverts the natural read->write flow, forcing the persistence/event layer to be designed
  before its consumers exist.
- Centralized emission on the hot path stresses the fail-open telemetry contract and Syncthing
  determinism, and makes the off-branch bit-identity proof depend on the whole bus being inert,
  not a local call site.
- Largest blast radius and the weakest fit with driving cards one at a time - the first card
  carries most of the risk for cards that land later.
Complexity: large
Risk: high

## Recommended: Variant 2
Variant 2 is the only option whose off-branch state is provable the way invariant #2 asks for
it - a single guarded call site per card, each off-branch byte-identical to today - because it
refuses a shared mutable struct or a shared emission bus that would make bit-identity a
whole-subsystem property. The ordering A -> C -> D -> E -> B is exactly invariant #6 in
practice: A is pure search-side with no vault writes and lowest blast radius, so it seeds the
cross-encoder-provider pattern first (mirroring `embeddings/registry.ts`) without touching any
other card; C then establishes the epistemic field on context items so D extends an
already-merged shape rather than colliding on `context-pack.ts`/`context-receipts.ts`; D reuses
C's status plus the existing `gate-telemetry`/`coverage` scores as a thin verdict+action layer
(honoring its "do not build a separate attention organ" guardrail); E appends its demand log at
the recall seam D has already opened, reusing `coverage.ts`'s IDF score as the satisfaction
axis; and B lands last as the heaviest assembly, unifying `dead-ends.ts`/`preference.ts` under
the `usage-signal.ts` decay scorer and the dream pass over a fully-merged branch. This maximizes
reuse of existing scoring/telemetry/coverage primitives, keeps every decision in-kernel
deterministic (the cross-encoder stays an opt-in external call, graceful no-op when unset), and
matches the repository's proven multi-card-suite cadence. Variant 1's shared envelope and
Variant 3's event bus both trade that per-card verifiability and small blast radius for a
composition elegance the suite does not need - and both raise, rather than lower, the risk to
the load-bearing bit-identity and fail-open invariants.

## Final decision: Variant 2 (accepted)

Agreed with the consultant's recommendation. Variant 2 is the only variant whose off-branch
state is provable per-card as a single guarded call site - the precondition the repo demands for
any ranking/score/output change (invariant #2) and the easiest property to verify. It preserves
the load-bearing conventions: an LLM-free kernel (the cross-encoder is an opt-in external call,
graceful no-op when unconfigured), fail-open telemetry, language-agnostic logic, Syncthing-peer
determinism, and the demonstrated one-PR-themed-suite release cadence. The drive order
A -> C -> D -> E -> B resolves every real cross-card collision by the cheapest sufficient
mechanism (ordering) rather than a speculative up-front abstraction: A seeds the provider-registry
pattern at the reader tail with no vault writes; C establishes the item-shape seam so D extends
a merged shape rather than colliding on `context-pack.ts`/`context-receipts.ts`; D reuses
existing gate-telemetry + coverage scores as a thin verdict+action layer (honoring the card's
"no separate attention organ" guardrail); E appends at the recall seam D opened, reusing the
coverage score as the satisfaction axis; B lands last as the capstone assembly over a
fully-merged branch, extending the dream pass rather than running a parallel loop.

Variant 1's shared annotation envelope turns bit-identity into a whole-subsystem property and
front-loads an abstraction before its consumers exist. Variant 3's shared emission bus
inverts the read->write flow and stresses the fail-open + Syncthing-determinism invariants on
the hot path. Neither is warranted for this suite.

Drive order: **A -> C -> D -> E -> B**.
