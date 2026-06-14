### Variant 1: Federated patches with a shared config block
- **Approach**: Each unit ships as its own small, self-contained module. The only shared structure is a single nested optional block added to `ResolvedSearchConfig` (one sub-object per unit, all absent-by-default) plus one `resolveRecallProfile(name)` helper that expands `fast|balanced|thorough` into the exact knob tuple already enumerated by `tuning.ts`. Read-side weighting for decay and file-context biasing is written inline at the existing score-combination site in `search.ts`, guarded by per-unit flag checks.
- **Trade-offs**:
  - Pro: smallest possible diff and review surface; each unit independently testable and revertable.
  - Pro: byte-identical OFF is trivial to assert because each guard is a single early branch returning the prior code path.
  - Pro: no new abstraction to get wrong; no risk of drifting toward the deferred external-source registry.
  - Con: read-side weighting logic for Unit 3 and Unit 4 is scattered and order-sensitive, with no single seam; a fifth future unit repeats the same inline boilerplate.
  - Con: persistence conventions (version + hash + fail-soft) get re-implemented per unit (co-occurrence cache, decay-signal cache) instead of shared.
  - Con: "four units, one release" reads as four patches that merely landed together, not a composed suite.
- **Complexity**: small
- **Risk**: low

### Variant 2: Two shared primitives - a profile/knob resolver and a composable read-side adjuster fed by signal readers
- **Approach**: Introduce exactly two seams. First, a `resolveRecallProfile` that maps a profile name to the existing knob tuple (candidate-pool multiplier, depth, expansion, fusion mode), reusing `tuning.ts` axes so profiles and self-tuning stay coherent. Second, a read-side `ScoreAdjuster` composition point in `search.ts`: an ordered list of pure `(candidate, signals) -> weight` functions that Unit 3 (usage/recency decay) and Unit 4 (file-path bias, extending `session-focus.ts`) plug into, sourced by small `UsageSignalReader`s over `recall_telemetry` continuity records. Unit 2 (co-occurrence) is a dream-side producer that only shares the persistence convention (versioned, hashed, re-validated, fail-soft suggestion artifact, like `tuning.json`) and never touches the read path.
- **Trade-offs**:
  - Pro: genuine composition on the one axis that actually overlaps (read-side weighting), with decay and file-context funneling through a single, testable seam.
  - Pro: signal readers and the persistence convention are shared by three units (decay cache, co-occurrence suggestions, and the existing tuning artifact) without forcing co-occurrence into the read path it does not belong in.
  - Pro: identity-transform when every flag is off (empty adjuster list, default profile equals current knobs) gives a clean byte-identical assertion.
  - Con: requires up-front design of the adjuster contract and ordering semantics; more test cases than Variant 1.
  - Con: two seams to learn, a middle ground that neither minimizes diff nor maximizes future extensibility.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Unified RecallContext orchestrator with an internal signal/pass registry
- **Approach**: A single `buildRecallContext(config, selection)` owns everything: profile expansion, registration of all signal sources, composition of every read-side adjuster, and the file-context query path all resolve through it; co-occurrence is registered as one entry in a shared maintenance-pass registry alongside other dream passes. One seam gates all four units and anticipates the deferred external recall-source registry.
- **Trade-offs**:
  - Pro: maximal uniformity and a single place for gating, config, and persistence wiring; most natural growth path toward future recall sources.
  - Pro: the suite genuinely reads as one architecture rather than additive units.
  - Con: heavy abstraction for four small additive units; the orchestrator sits directly on the hot `search()` public path, enlarging blast radius and making byte-identical OFF harder to prove.
  - Con: a registry of recall sources/passes drifts toward the "pluggable external recall-source registry" that is explicitly out of scope.
  - Con: highest review cost and the greatest chance of touching default behaviour by accident.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It matches the stated goal of one or two shared primitives precisely - a profile/knob resolver plus a composable read-side adjuster fed by signal readers - so the units compose on the single axis they truly share (read-side weighting) while co-occurrence stays a dream-side producer behind only the shared persistence convention. It reuses the `tuning.ts` knob axes and `session-focus.ts` biasing rather than inventing parallel machinery, keeps the byte-identical-OFF guarantee cheap via an empty adjuster list and default profile, and deliberately stops short of the orchestrator/registry that would drift into the explicitly deferred external-source scope.
