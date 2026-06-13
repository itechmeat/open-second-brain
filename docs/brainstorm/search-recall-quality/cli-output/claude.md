### Variant 1: Concern-located two-layer split
- **Approach**: Land each unit where its concern already lives rather than introducing shared scaffolding. Read-time projections that need only data already on `SearchOutcome` (score_breakdown serialization, hybrid-degrade warning surfacing) are shaped at the `src/mcp/search-tools.ts` surface; ranking-behavior changes (threshold+rerank, reinforce re-rank) extend the pure ranker behind `ResolvedRecallConfig` kill switches; trust metadata reuses `recall-hint.ts` as a sibling read-time deriver in core; eval/benchmark units extend `benchmark.ts` and add a standalone MCP `run_eval` tool.
- **Trade-offs**:
  - Pro: smallest conceptual footprint; no new abstraction to learn or maintain; each commit is a tight, reviewable diff against the file that owns the concern.
  - Pro: strongest match to "pure core stays side-effect free; surfaces opt into telemetry" — the reinforce ledger and eval recording naturally sit at the MCP edge.
  - Con: score_breakdown projection at the MCP layer can only see fields `BrainSearchResult` already carries; `entityBoost`/`activationBoost`/`coAccessBoost`/`sessionFocus` are computed inside the ranker and would need to be threaded out anyway, so the "thin surface" promise partially leaks back into core.
  - Con: read-time enrichment logic ends up split across two layers (some in core `recall-hint`-style, some in MCP), making the read-time contract harder to reason about as a whole.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Unified read-time enrichment module in core
- **Approach**: Add one pure core module (`src/core/search/enrich.ts`) as an explicit sibling to `recall-hint.ts` that owns every read-time projection — `score_breakdown`, inline trust fields, and hybrid-degrade detection — as pure functions over a ranker output that carries all numeric components. `SearchOptions` gains a single additive `enrich`/`explain`/`threshold`/`reinforce` opt-in bag; threshold+rerank and reinforce re-rank extend the ranker/MMR path behind `ResolvedRecallConfig` switches; the MCP surface only serializes and owns the side-effecting reinforce ledger and the `run_eval` exposure; benchmark gains answer-containment@k in place.
- **Trade-offs**:
  - Pro: all read-time, never-stored projections live in one cohesive, unit-tested core module mirroring the proven `recall-hint` pattern, so the "computed-at-read-time, never stored" invariant is enforced in one place.
  - Pro: ranker carries every score component once, so score_breakdown is a trivial structural projection with no leak back-and-forth; byte-identical legacy output is easy to assert because every field is gated by an explicit flag default.
  - Pro: keeps the side-effect boundary clean — pure enrichment in core, ledger/eval recording at the surface.
  - Con: requires widening the ranker's output type to surface all components, a slightly larger up-front type change touching `types.ts`.
  - Con: one module owning three distinct projections risks becoming a mild grab-bag if not internally sectioned.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Composable gated enrichment pipeline with registry
- **Approach**: Introduce a generalized read-time enrichment pipeline where each of the seven units registers as a gated transform stage over the ranked outcome, dispatched by a flag/kill-switch map, plus a parallel pluggable structure for eval dimensions (source-utilization, citation-depth, answer-containment) as registered metrics. The MCP surface and benchmark both consume the same registry so new signals/metrics drop in uniformly.
- **Trade-offs**:
  - Pro: maximally uniform and future-proof — an eighth signal or metric is a one-stage registration, and ordering/composition with the MMR pass is explicit and centrally controlled.
  - Pro: forces a single declarative answer to "which flag gates which behavior," reducing the chance any unit silently mutates default output.
  - Con: heaviest abstraction for a fixed set of seven units shipping at once; the registry indirection obscures otherwise-trivial projections and works against the repo's concrete, per-signal, one-file conventions.
  - Con: a shared pipeline core makes the seven "atomic, independently TDD'd commits" harder to land cleanly — early commits must build scaffolding the later ones use, coupling the commit sequence.
  - Con: higher risk of perturbing byte-identical legacy output, since all results now flow through a new common path even when no flag is set.
- **Complexity**: large
- **Risk**: medium-high

### Recommended: Variant 2
**Rationale**: It directly follows the established `recall-hint.ts` precedent the task itself names as the model pattern, keeping all read-time/never-stored projections cohesive and pure while leaving ledger writes and eval exposure at the MCP edge where side effects belong. It avoids Variant 1's score-component leak between layers and sidesteps Variant 3's registry over-engineering, which would couple the seven supposedly-atomic commits and threaten the byte-identical-when-flags-off guarantee that is a hard constraint here.
