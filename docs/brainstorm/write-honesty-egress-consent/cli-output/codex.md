### Variant 1: Feature lanes with queued integration
- **Approach**: Assign one lane to each feature, combining lanes when only four or five coders are available. Each lane implements its feature against existing seams, with explicit ownership of shared files such as the indexer and doctor registries. Owners apply other lanes’ prepared changes to those files through a serialized integration queue. Integrate each feature’s census and registry updates with its implementation, then run the combined architecture checks after every merge.
- **Trade-offs**:
  - Pro: Closely follows the verified task slices and keeps feature acceptance accountable to one coder.
  - Pro: Independent leaf modules and detectors can progress immediately.
  - Con: Shared-file owners become bottlenecks, especially around indexer changes and doctor registration.
  - Con: Independently developed policy assumptions can surface late during integration.
- **Complexity**: medium
- **Risk**: high

### Variant 2: Contract-first dependency waves
- **Approach**: Begin with a short substrate wave that establishes leaf-module contracts, shared-file ownership, and the census registration sequence without building a general policy framework. Then use six lanes: integration/substrate, F1+F5, F2, F3, F4, and F6; with four coders, combine integration with F1+F5 and combine F3 with F4. Feature lanes own disjoint implementation files, while the integration owner applies their prepared changes to shared files in dependency order: predicates and resolvers, enforcement and persistence, then reporting surfaces. Register doctor codes with their required census entries, egress changes with their registry entries, and durable surfaces only when their actual storage decisions are settled. Finish with combined acceptance checks for read filtering, held-item lifecycle, egress exclusions, and provider construction before network access.
- **Trade-offs**:
  - Pro: Makes shared-file coordination explicit while preserving parallel implementation.
  - Pro: Groups privacy and content-class work for consistent policy handling while keeping their metadata and semantics distinct.
  - Pro: Sequences census updates alongside real implementation rather than reserving speculative rows or counts.
  - Con: Requires an initial coordination pass and disciplined handoffs to the integration owner.
  - Con: Incorrect early contracts can require changes across several lanes.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Enforcement spine first, advisory features second
- **Approach**: Complete F6 first, then implement F1 and F5 as the next gated stage, establishing provider consent, remote-read protection, and content-class egress exclusion before broadening the wave. During those stages, other coders prepare the isolated F2 hold-decision logic, F3 person-variant module, and F4 detector against agreed interfaces. After the enforcement stage passes its acceptance checks and censuses, integrate F2, F3, and F4 in parallel under shared-file ownership. Each stage carries its own doctor, state-surface, and registry changes, with final combined verification across all six features.
- **Trade-offs**:
  - Pro: Concentrates early review on the features governing disclosure and outbound calls.
  - Pro: Smaller integration stages make regressions easier to localize.
  - Con: Imposes ordering between features that are not all technical dependencies.
  - Con: Four to six coders have less useful parallel work while waiting for enforcement integration.
  - Con: Later indexer and reporting changes still require checking earlier guarantees.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 2
**Rationale**: It gives four to six coders useful parallel work with disjoint file ownership and an explicit route for shared-file edits. Coordinating doctor codes, state surfaces, and the egress registry through one integration lane reduces census conflicts while preserving fail-closed checks. The substrate stays limited to concrete contracts and leaf primitives, avoiding premature storage choices for the consent stamp. Compared with feature-first integration or a largely sequential enforcement stage, it offers the strongest balance of throughput and integration control.
