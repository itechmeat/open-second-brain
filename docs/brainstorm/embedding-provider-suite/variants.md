# Embedding Provider Suite - brainstorm variants (audit trail)

Primary consultant: `claude -p` (Claude Code). Exit 0, three parseable variants, no fallback needed. Full transcript: `cli-output/claude.md`. Prompt: `cli-output/prompt.md`.

## Variant 1: Inline per-subsystem extension

- **Approach**: Each unit lands in the module that already owns its concern, following existing closed-union/factory conventions verbatim. RRF becomes a `fusionMode` branch inside `ranker.ts`; the `local` provider extends the `makeProvider` switch + a new `local-provider.ts`; the registry is a read/merge helper in `config.ts` wired into `resolveSearchConfig` and new CLI verbs; cost/signature logic extends `indexer.ts` and `store.ts`. A single tiny `signature()` helper is the only shared new primitive.
- **Trade-offs**: Smallest diff, lowest risk to the bit-identical/closed-union rules, fastest independent shipping; BUT cost/signature/pricing knowledge sprinkled across indexer + store + config (DRY pressure), and registry-to-factory precedence coupling is implicit across two call sites.
- **Complexity**: small
- **Risk**: low

## Variant 2: Shared signature/provenance kernel + registry module

- **Approach**: Two focused new domain modules - `embeddings/signature.ts` (canonicalise `{provider, model, dimension}` -> signature, hold pricing table, compute staleness + spend estimates) and `embeddings/registry.ts` (load/persist provider definitions, merge after built-ins) - that Units 2/3/4 all depend on. RRF lands as a small `fusion` strategy split out of `ranker.ts`. Factory, CLI, indexer, store all consume the kernel rather than re-deriving provider identity.
- **Trade-offs**: Directly satisfies the "one shared canonicalization/signature kernel" constraint; cost/signature/stale independently unit-testable; `corpusGeneration()` and per-chunk stamping converge on one signature, reducing drift. BUT more upfront structure, and a medium blast radius (indexer/store/config gain a dependency edge whose fail-soft behaviour must be re-verified at each seam).
- **Complexity**: medium
- **Risk**: medium

## Variant 3: Descriptor/strategy plugin refactor

- **Approach**: Generalise the subsystem around uniform abstractions - providers become capability-carrying "descriptors" (built-in or registered), fusion becomes a pluggable `FusionStrategy` interface. The closed string union is replaced by a descriptor registry; all four units become "register a descriptor / register a strategy."
- **Trade-offs**: Most extensible and cleanest conceptual model. BUT replaces the closed union that `resolveSearchConfig`/`parseProvider` depend on, broadens the bit-identical-when-off surface, has the largest diff and most tests to re-baseline, and the highest chance of public-API churn triggering the migration constraint - over-built relative to four concrete units.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation: Variant 2

> The kernel approach is the only one that directly honours the explicit "one shared canonicalization/signature kernel" constraint while keeping the closed union, fail-soft, and bit-identical-when-off rules intact - Units 2, 3, and 4 genuinely share provider-identity and signature logic, so centralizing it prevents the drift that Variant 1 invites and avoids the over-reach of Variant 3's full plugin rewrite. It scales to four units with isolated, testable seams without forcing public-API breakage or re-baselining the ranker's explainability contract.

## Orchestrator decision: accept Variant 2

Accepted without override. The decisive factor is the project's own DRY constraint: Unit 4's per-chunk signature and the existing `corpusGeneration()` fingerprint must agree on what "the same embedding configuration" means, and Unit 3's registry resolves provider identity that Unit 4 then signs - centralising this in `signature.ts` is the design that prevents three call sites from drifting. Variant 1 would ship slightly faster but re-introduces exactly that drift risk across indexer/store/config; Variant 3's descriptor rewrite would break the closed-union convention and the explainable-`reasons` test contract for no benefit at four-unit scale. Variant 2 keeps the closed union closed (registry entries resolve to `openai-compat`; only `local` is a new member), keeps RRF and the cost gate off by default for bit-identical behaviour, and isolates each unit behind a testable seam.
