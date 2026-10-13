# Variants - wiring shipped seams

Audit trail for the brainstorm phase of the feature-release-playbook run on branch feat/wiring-shipped-seams, 2026-10-13. The consultant prompt is in `cli-output/prompt.md`. In this run the consultant role was performed by the same design agent that orchestrates the wave (no external consultant CLI was available); its reply is recorded verbatim in `cli-output/consultant.md` and repeated below as consultant work. The orchestrator decision follows the variants.

## Consultant variants (verbatim)

### Variant 1: Four parallel disjoint lanes with one bench contract commit first
- **Approach**: Run the four residues as four file-disjoint lanes. The bench sampler lane lands a contract commit first - CLI flags with paired-flag refusal, the widened loader signature with an options parameter, and the sampling capability declaration - because the pool-cap lane holds the wave's only append-only right on a bench file: one knob name in the bench pin's recall key list, exercisable only after that commit. The cap, skill-ordering and OpenCode lanes start immediately over files nothing else touches; each lane's pure module (cap grouper, usage map builder, stratified sampler, JSONC editor) is written and tested in isolation from its first commit. One integrator pass closes docs, census reconciliation, the CHANGELOG entry and the version bump.
- **Trade-offs**:
  - Maximal wall-clock parallelism: three of four lanes share no file with anything and never wait.
  - Exactly one declared cross-lane dependency (the pin key append waits on the bench contract commit), so coordination cost is one paragraph of contract.
  - The bench gains its measurement instrument early: the seeded sampler is the tool the cap's measured flip-rule decision needs, inside the same pull request.
  - Cost: the contract must pin file ownership precisely and the bench lane must commit its contract before the cap lane finishes.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Serial stack in risk order
- **Approach**: Land the four residues one at a time on the shared branch, ordered so each is fully green before the next starts: skill usage ordering (smallest, single ranking point), per-session pool cap, seeded sampler, OpenCode adapter (largest, least mechanical). No lane structure, no cross-lane contract; every change is built against a fully settled tree.
- **Trade-offs**:
  - Zero coordination cost and the simplest possible audit trail: one clean commit series per feature.
  - Every feature is verified against the previous feature's final state, so no append-only splits or dependency waits are needed.
  - Four sequential build-and-stabilize cycles stretch the release badly; the cap, skill and OpenCode lanes share no files yet serialize unnecessarily.
  - The measurement instrument arrives third, so the cap lands unmeasured and its flip-rule decision waits or ships on assertion.
- **Complexity**: small
- **Risk**: medium

### Variant 3: Two stacked half-waves - retrieval and its measurement, then the host adapter
- **Approach**: Split the wave into two halves inside one pull request. Half one lands the three retrieval-side residues in parallel (pool cap, skill usage ordering, seeded sampler) with the bench contract commit inside it. Half two lands the OpenCode V2 adapter after the tree settles, keeping the least mechanical, most environment-dependent work isolated from the retrieval changes.
- **Trade-offs**:
  - The adapter's review surface is fully separated from the ranking changes, which are the drift-sensitive ones.
  - Each half is independently verifiable and revertible.
  - The OpenCode lane shares no files with the retrieval lanes, so isolating it buys review clarity at the price of an artificial serialization point.
  - The integrator faces two merge windows instead of one, doubling census and docs reconciliation work.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: The four residues are file-disjoint except one genuine seam - the cap's bench pin entry needs the bench verb file the sampler lane owns - so parallel lanes with a single pinned dependency capture almost all of the serial variant's safety at a fraction of its wall clock, and the sampler lands early enough to measure the cap inside the same pull request. This is the same substrate-then-lanes shape the previous recall-quality wave executed successfully on this repository, so the ownership mechanics, dependency-wait rule and census arbitration are proven here.

## Orchestrator decision

**Chosen: Variant 1 - four parallel disjoint lanes with one bench contract commit first.** The consultant's recommendation is accepted without override. The recon touch-surface analysis confirms the four residues are file-disjoint with exactly one real dependency (the cap lane's one-line append to `BENCH_PIN_NESTED_KEYS.recall` in the bench verb, exercisable only after lane 3's contract commit lands), so serializing or half-waving the wave would only add wall clock without removing any risk Variant 1 does not already pin. One amendment to the consultant's sketch, recorded in the design doc and the plan contract: lane 3 also owns the bench verb's USAGE and report-print strings and the two append-only CLI string files, keeping every commit single-owner at the file level, and the cap lane's append is its final task so the dependency wait costs it nothing.
