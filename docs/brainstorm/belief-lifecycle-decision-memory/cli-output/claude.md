### Variant 1: Foundation-first shared kernels

- **Approach**: Land two new shared modules before any feature unit: a supersession-lifecycle kernel (`src/core/brain/lifecycle/` - temporal boundary ops with half-open intervals, tombstone/supersede state machine, chain traversal to tip, receipt emission) and a decision-record kernel (decision note type + frontmatter schema, commitment tier, rating store). Units 1, 3, 4, 5, 11 become thin consumers of the first kernel; units 7, 8, 9, 10 of the second; units 2 and 6 stay standalone. The first two commits of the wave are pure infrastructure with tests but no user-visible behavior.
- **Trade-offs**:
  - Pro: chain traversal, interval semantics, and receipt idempotency are written once - four supersession units and five decision units cannot drift on interval math or tip-resolution rules.
  - Pro: matches the repo's stated "shared choke points over scattered per-call-site checks" convention and the v1.30.1 one-directional layering.
  - Pro: unit 11's receipts hook naturally into the kernel's single write path instead of being retrofitted into five call sites.
  - Con: kernel design must be right before any consumer exists; requirements discovered in unit 5 or 9 (injection budgets, spacing) force kernel rework mid-wave.
  - Con: the first commits violate the spirit of "one atomic feature commit per unit" - they are release-invisible scaffolding, and a slipped wave ships dead code in v1.33.0.
  - Con: serializes the wave - little can start until both kernels merge to the branch.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Fully isolated units, existing surfaces only

- **Approach**: No new shared modules. Each unit lands self-contained against existing choke points: units 1/3/4/5 each read/write `superseded_by` through `enrich.ts` and frontmatter directly, units 7-11 each define their own frontmatter fields and query slices, unit 11 writes receipts as its own JSONL alongside the truth ledger. Overlap (chain walking in 3/4/5, injection changes in 5 and 9, contradiction reads in 3 and 6) is duplicated per unit and deferred to a possible post-wave refactor.
- **Trade-offs**:
  - Pro: maximal commit atomicity and parallelism - any unit can be built, reviewed, or dropped from the wave independently; no unit is blocked on an abstraction that doesn't exist yet.
  - Pro: lowest up-front design risk; each unit's blast radius is exactly its own diff.
  - Con: at least three independent implementations of "walk the supersedes chain to its tip" and two of "interval validity at an instant" - divergence here produces user-visible inconsistency (recall says X is current, inject says Y is).
  - Con: units 5 and 9 both patch the injection loop with caps/preference logic; the second one merged must rebase over the first's uncoordinated changes, and their budget/spacing rules can conflict silently.
  - Con: contradicts the repo's post-v1.30.1 direction and guarantees a v1.33.x dedup refactor.
- **Complexity**: medium
- **Risk**: high

### Variant 3: Cluster tracks with anchor-unit-owned abstractions

- **Approach**: Organize the wave into three tracks, where the first unit of each track ("anchor") ships the track's shared abstraction as part of its own feature commit, and later units in the track consume it. Track A (supersession spine, order 4 → 1 → 3 → 5): unit 4's generalized tombstone/supersede lifecycle module is the shared core; unit 1 adds the temporal-boundary op on top; unit 3's claim-graph projection reads through it; unit 5 consumes its chain-tip resolver. Track B (decision memory, order 7 → 8 → 10 → 11 → 9): unit 7's decision-record note type is the anchor; 8/10/11 extend its schema and store; unit 9 lands last. The only cross-track shared piece is a small injection-governor helper (caps, spacing, tip-preference) introduced by whichever of 5/9 lands first and reused by the other; units 2 and 6 are order-free standalones (6 reads the same contradiction relations as 3 but through the existing `contradicts` surface, not a new one).
- **Trade-offs**:
  - Pro: every commit is a real feature (no infrastructure-only commits), yet shared logic still has exactly one home - the anchor unit's module - satisfying both the atomic-commit rule and the choke-point convention.
  - Pro: abstractions are designed against a concrete first consumer, then hardened by the second, avoiding Variant 1's speculative-API risk.
  - Pro: dependency ordering is explicit and shallow (two chains plus two free units), so the wave degrades gracefully - a track can stop early and still ship its landed prefix.
  - Con: intra-track ordering constraints limit parallelism (unit 5 waits on 4; unit 9 waits on 7/8 and the injection governor).
  - Con: anchor commits (4 and 7) are larger than average because they carry the shared module plus their own feature.
  - Con: if a mid-track unit (e.g. 3) exposes a flaw in the anchor's abstraction, fixing it means amending an already-landed commit's module - churn inside the release branch.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3

**Rationale**: The wave's real coupling is exactly two clusters (supersession spine, decision family) plus one injection touchpoint, and anchor-owned abstractions put each shared piece in one place without Variant 1's speculative infrastructure commits or Variant 2's guaranteed chain-walking divergence between recall, inject, and dream. It is the only variant that keeps every commit an atomic user-visible feature (the project's own release convention) while honoring the post-v1.30.1 "shared choke points, one-directional layering" rule, and its shallow ordering means a partially completed wave still ships coherently as v1.33.0.
