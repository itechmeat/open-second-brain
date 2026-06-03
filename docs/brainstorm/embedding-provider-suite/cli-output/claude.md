### Variant 1: Inline per-subsystem extension
- **Approach**: Each unit lands in the module that already owns its concern, following the existing closed-union/factory conventions verbatim. RRF becomes a `fusionMode` branch inside `ranker.ts`; the `local` provider extends the `makeProvider` switch + a new `local-provider.ts`; the registry is a read/merge helper in `config.ts` wired into `resolveSearchConfig` and new CLI verbs; cost/signature logic extends `indexer.ts` (gate, estimate) and `store.ts` (signature stamp). A single tiny `signature()` helper is the only shared new primitive.
- **Trade-offs**:
  - Smallest diff; each change reviewable against its sibling code and existing tests.
  - Lowest risk to the bit-identical-when-off and closed-union rules — they're untouched except where extended.
  - Fastest path to shipping the p4/p3/p2 units independently.
  - Cost/signature/pricing knowledge gets sprinkled across indexer + store + config rather than living in one place; mild DRY pressure as Unit 4's signature and Unit 3's registry both touch provider identity.
  - Registry↔factory coupling is implicit (two call sites must agree on precedence ordering).
- **Complexity**: small
- **Risk**: low

### Variant 2: Shared signature/provenance kernel + registry module
- **Approach**: Introduce two focused new domain modules — `embeddings/signature.ts` (canonicalize `{provider, model, dimension}` → stable signature, hold the per-model pricing table, compute stale-detection and spend estimates) and `embeddings/registry.ts` (load/persist provider definitions, merge after built-ins) — that Units 2/3/4 all depend on. RRF lands as a small `fusion` strategy split out of `ranker.ts`. The factory, CLI, indexer, and store all consume the kernel rather than re-deriving provider identity.
- **Trade-offs**:
  - Directly satisfies the stated "one shared canonicalization/signature kernel rather than per-call-site duplication" constraint.
  - Cost model, signature, and stale-detection become independently unit-testable in isolation from the store/indexer.
  - `corpusGeneration()` and per-chunk stamping converge on one signature definition, reducing drift risk in Unit 4.
  - More upfront structure than a pure inline approach; introduces module boundaries that must be designed before any unit ships, slightly coupling the four deliverables.
  - Medium blast radius: indexer/store/config all gain a new dependency edge, so the off-path fail-soft behaviour must be re-verified at each seam.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Descriptor/strategy plugin refactor
- **Approach**: Generalize the whole subsystem around uniform abstractions — providers become "descriptors" (built-in or registered) carrying capabilities (dimension, pricing, local/remote, signature), and fusion becomes a pluggable `FusionStrategy` interface (`linear` | `rrf`). The closed string union is replaced by a descriptor registry; all four units become instances of "register a descriptor / register a strategy."
- **Trade-offs**:
  - Most extensible: future providers and fusion modes drop in without touching core dispatch.
  - Cleanest conceptual model — registry, cost, signature, and fusion all hang off one extensibility spine.
  - Replaces the closed union that `resolveSearchConfig`/`parseProvider` depend on, risking the convention that provider selection is a validated closed set, and broadening the surface that must stay bit-identical-when-off.
  - Largest diff and the most existing tests (explainable `reasons`, parser validation, corpus generation) to re-baseline; over-built relative to four concrete units.
  - Highest chance of public-API churn on `EmbeddingProvider`/`ResolvedEmbeddingConfig` consumers, triggering the migration constraint.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The kernel approach is the only one that directly honours the explicit "one shared canonicalization/signature kernel" constraint while keeping the closed union, fail-soft, and bit-identical-when-off rules intact — Units 2, 3, and 4 genuinely share provider-identity and signature logic, so centralizing it prevents the drift that Variant 1 invites and avoids the over-reach of Variant 3's full plugin rewrite. It scales to four units with isolated, testable seams without forcing public-API breakage or re-baselining the ranker's explainability contract.
