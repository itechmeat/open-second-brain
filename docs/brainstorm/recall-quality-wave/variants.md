# Variants - recall-quality wave

Audit trail for the brainstorm phase of the feature-release-playbook run on branch feat/recall-quality-wave, 2026-10-12. The consultant prompt is in `cli-output/prompt.md`. In this run the consultant role was performed by the same design agent that orchestrates the wave (no external consultant CLI was available); its reply is recorded verbatim in `cli-output/consultant.md` and repeated below as consultant work. The orchestrator decision follows the variants.

## Consultant variants (verbatim)

### Variant 1: Bench-first contract substrate with four parallel disjoint lanes
- **Approach**: Land the bench framework contracts first as two behavior-preserving commits owned by one bench lane: the per-suite capability declaration (a suite registry in the bench verb mapping suite to loader and capabilities) and run-identity knob pinning folded into the checkpoint hash. Then run four lanes in parallel over disjoint file sets - iterative recall loop, coverage-first session recall, graded surfacing key plus replay harness, and the rest of the LongMemEval suite - with the replay lane pinned as the one declared dependent on the two bench contract commits. A single integrator pass closes census reconciliation, docs, version bump and the full gate run.
- **Trade-offs**:
  - Maximal wall-clock parallelism: the two recall behavior lanes share no files with anything and start immediately.
  - Exactly one declared cross-lane dependency (replay harness waits on the bench contracts), so coordination cost is one paragraph of contract, not a meeting schedule.
  - The wave gains its measuring stick early: the replay suite and the LongMemEval lane can later produce before/after receipts for the behavior lanes inside the same pull request.
  - Cost: the contract must be written down precisely (who owns which file, append-only rights on the bench registration points), and the bench lane must commit its two contract commits before the replay lane starts.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Serial quality stack in measurement-first order
- **Approach**: Build the four residues one at a time, each fully complete and green on the branch before the next starts, ordered so measurement always precedes behavior: LongMemEval bench suite, graded surfacing key and replay harness, coverage-first session recall, iterative recall loop. No lane structure, no cross-lane contracts; every change lands against a fully settled tree.
- **Trade-offs**:
  - Zero coordination cost and the simplest possible audit trail: each residue is a clean sequential commit series.
  - Every change is built against the previous change's final state, so no waiting rules or append-only ownership splits are needed.
  - Four sequential build-and-stabilize cycles stretch the release badly; the two recall behavior lanes are completely file-disjoint yet serialize unnecessarily.
  - Late lanes inherit churn from earlier lanes' unrelated refactors, widening the review surface per step.
- **Complexity**: small
- **Risk**: medium

### Variant 3: Two stacked half-waves - measurement, then behavior
- **Approach**: Split the wave into two stacked halves inside one pull request: half-wave one lands the two measurement residues (LongMemEval suite and the graded gate with its replay harness), half-wave two lands the two recall behavior residues (iterative loop and coverage-first session recall) and records their before/after numbers with the new harness. The halves share the branch sequentially; within each half the lanes run in parallel.
- **Trade-offs**:
  - Each half is independently verifiable, and the final pull request carries measured evidence for the behavior changes, which is the strongest possible receipt.
  - The behavior lanes are forced to wait for the full measurement half even though the iterative loop and coverage recall share nothing with the bench files.
  - Stacked half-wave history entangles reverts: rolling back one behavior lane drags the measurement lane it is stacked on.
  - The integrator faces two merge windows instead of one, doubling the census-reconciliation work.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: The four residues are file-disjoint except one genuine seam - the replay harness needs the suite registry and knob pinning the bench lane owns - so parallel lanes with a single pinned dependency capture almost all of the serial variant's safety at a fraction of its wall clock. Landing the two behavior-preserving bench contracts first costs nothing and hands the wave its measuring stick before any behavior changes land, which is exactly the discipline the repo's byte-identical-off invariant wants. This is also the shape the previous recall-quality wave on this branch already executed successfully, so the tooling and audit conventions exist.

## Orchestrator decision

**Chosen: Variant 1 - bench-first contract substrate with four parallel disjoint lanes.** The consultant's recommendation is accepted without override. The recon touch-surface analysis confirms the four residues are file-disjoint with exactly one real dependency (Lane C's replay harness consumes Lane D's suite registry and run-identity knob pinning), so serializing or half-waving the wave would only add wall clock without removing any risk Variant 1 does not already pin. The branch itself just ran the prior recall-quality wave with this same substrate-then-lanes shape, so the append-only ownership mechanics, dependency-wait rule and census arbitration are proven here. One amendment to the consultant's sketch, recorded in the design doc and the plan contract: the bench framework files stay exclusively Lane D's except for Lane C's append-only suite-registration entries, exercisable only after the two contract commits land, keeping every commit single-owner at the file level.
