# Consultant output - trust-and-responsiveness-hardening

The consultant role was performed in-session against the prompt at `cli-output/prompt.md`; the output below is preserved verbatim.

### Variant 1: Per-feature parallel lanes with an append-only shared protocol

- **Approach**: Four lanes with strictly disjoint file ownership implement the four cards independently and simultaneously; the only shared surfaces are the doctor registry, the two code-classification tables, the shared doctor test files, docs and CHANGELOG, all governed by an append-only protocol - each lane appends its entries in its own final commit via `git commit --only`, and one integrator reconciles ordering and prose and runs the full gates. Each lane leans on the substrate that already exists in the tree: the frozen `DOCTOR_CHECKS` registry, the managed-block merger, `RequestDrain`'s N-in-flight register, and the `SEARCH_TRUST_GATE_MODE` gate shape.
- **Trade-offs**:
  - Pros: four agents work truly in parallel (the wave's main cost is wall time); every card ships as an atomic conventional commit; no infrastructure is built that the tree does not already need; the append-only protocol makes the four shared files textual merges rather than design coordination.
  - Cons: the shared files are a serialization point at lane end (registry order and census must be reconciled); lane discipline can slip without the `--only` commit rule being enforced; cross-lane interactions (e.g. two new doctor rows landing in one release) are only seen at integration.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Shared-substrate-first

- **Approach**: Build a common foundation first - a doctor-row framework (registration helper, counting-check template, classification wiring, census scaffolding), a shared gate-mode/config resolver extracted from `retrieval-gate.ts`, and a transport concurrency primitive - then implement the four cards as thin consumers of that substrate.
- **Trade-offs**:
  - Pros: the doctor rows for the gitignore and marker cards and the gate modes land on one tested abstraction; classification wiring cannot diverge between the two new codes; the extracted resolver removes one duplicated pattern.
  - Cons: serializes the start of all four lanes behind a fifth work package; most of the "substrate" already exists in this tree, so the phase mostly renames and moves working code (a refactor PR riding a hardening wave); the abstraction risks being shaped by imagined needs - three of the four cards need exactly one registry entry each, which is not a framework.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Integration-heavy single spine

- **Approach**: One integrator owns the branch throughout; the four features are implemented serially against a continuously integrated spine, with an integration pass (registry order, census, docs, full suite) after every feature rather than once at the end. Parallel agents, if any, work strictly inside one feature at a time under the integrator's sequencing.
- **Trade-offs**:
  - Pros: shared files never merge concurrently, so no protocol is needed; every integration hazard surfaces immediately after the feature that caused it; the branch is always releasable.
  - Cons: gives up the wave's parallelism entirely (four features times an integration pass each); the integrator becomes a bottleneck and context swamps; the per-feature integration passes mostly re-run the same registry/census/docs checks that a single end pass covers.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 1

**Rationale**: The substrate Variant 2 would build already exists - the doctor registry, the managed-block merger, the drain register and the gate-mode pattern are shipped, tested code - so substrate-first buys a refactor, not a foundation, and three of the four cards need exactly one append entry each. Variant 1 is the only shape that lets four agents work simultaneously, and its one real hazard, concurrent edits to four small shared files, is bounded by an append-only protocol whose merges are textual. Variant 3's continuous integration is the safest but converts the wave's defining constraint - four independent P4 cards - into a serial queue for no correctness gain the end-pass integrator does not already provide.
