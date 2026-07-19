### Variant 1: Kernel-first (four seams extracted up front)

- **Approach**: Land four pure-refactor commits first, before any feature: (1) a retrieval rank-adjustment pipeline (ordered list of deterministic scorers/sinks between ranker and pack builder), (2) an atomic multi-operation write core generalized from `runPinnedContextBatch`, (3) a unified injection surface abstracting SessionStart and UserPromptSubmit context assembly, (4) a pack-shape module owning budget clipping and protected fields. The ten tasks then plug into these seams as thin consumers, sequenced freely since dependencies are already satisfied.
- **Trade-offs**:
  - Pro: each concern gets exactly one home from day one; no file is rewritten twice inside the PR.
  - Pro: the byte-identical-opt-out gate is easiest to prove - each refactor commit can be verified behavior-neutral in isolation before features stack on it.
  - Pro: parallelizable - once the four kernels exist, the ten tasks have almost no cross-dependencies.
  - Con: seams 3 and 4 are designed before their consumers exist; the injection abstraction especially risks being wrong (SessionStart digest, prompt-time recall, and gap agenda have different lifecycles, budgets, and fail-open/fail-closed rules).
  - Con: four refactor commits inflate the PR and delay the first visible feature; a review objection to one kernel blocks everything behind it.
  - Con: highest chance of speculative generality, which conflicts with the "no stubs, no do-nothing fallbacks" convention.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Feature-first with second-consumer extraction

- **Approach**: Sequence the ten tasks by theme and extract a shared kernel only at the moment a second consumer arrives. Concretely: supersede fade lands inline in `ranker.ts`/`result-filters.ts`; when the trust gate arrives next it extracts the rank-adjustment layer and migrates the fade into it. Likewise `brain_update_note`/`brain_append_note` land on `writeFrontmatterAtomic` first, and the batch tool later generalizes `runPinnedContextBatch` and rebases the note tools onto the shared core.
- **Trade-offs**:
  - Pro: every seam is shaped by two real consumers, so the abstractions are guaranteed to fit; zero speculative design.
  - Pro: each commit ships user-visible value; review can proceed task by task without first approving abstract infrastructure.
  - Con: files are rewritten mid-PR (ranker touched by commit N, restructured by commit N+2), which muddies "one atomic commit per task" and doubles test churn on the hottest files.
  - Con: extraction happens under feature pressure inside the same PR, the classic condition for an asymmetric seam biased toward whichever consumer landed second.
  - Con: sequencing becomes strictly serial along each extraction chain, lengthening the critical path of a ten-task wave.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Two-kernel pragmatic (extract only the seams with two proven consumers; keep injection and budget as conventions)

- **Approach**: Extract exactly two kernels, each of which has two concrete consumers inside this wave: (1) a retrieval-stage rank-adjustment sink between `ranker.ts` and the pack builder, with the trust gate contributing zero-rank verdicts plus receipts and the supersede fade contributing a multiplier - both covering the pure-lexical path; (2) an atomic batch write core generalized from `runPinnedContextBatch` (validate-and-project in memory, commit-or-rollback), on which `brain_update_note`/`brain_append_note` are single-op batches and t_7718ab22 is the multi-op surface that also fixes the operation vocabulary. Seams 3 and 4 are deliberately NOT abstracted: the recall hook, timeline, and gap agenda each stay at their own existing hook/brief anchor sharing only a rendering helper, and clip-protected identity is a small protected-field contract in `token-impact.ts` that `include_raw` simply respects. Sequence: rider test fix; then D (t_cc234ff5, independent); then kernel 1 + t_5f61130a + t_c4a9cef8; then kernel 2 + t_3ff3fe77 + t_7718ab22; then t_5be0654d + t_ac1d36ea; then A-theme t_4adb0b8b, t_2ce46130, t_67d38036 last (the gap loop depends on recall telemetry paths the hook exercises).
- **Trade-offs**:
  - Pro: both extracted kernels are justified by two in-wave consumers, so no speculative abstraction, and both are deterministic pure functions - a natural fit for the no-LLM kernel and the language-agnostic trust-gate constraint.
  - Pro: respects the real asymmetry in theme A - SessionStart is fail-open, the prompt-time recall hook is fail-closed with audit; a shared injection surface would have to encode both policies and would blur exactly the guarantee t_2ce46130 must keep crisp.
  - Pro: shortest critical path - three independent tracks (rank track, write track, injection track) can proceed in parallel after the two small kernel commits.
  - Con: if a future wave adds a third injection consumer, the A-theme code pays a later extraction cost.
  - Con: the protected-fields "convention" in `token-impact.ts` relies on the regression test (tiny-budget clip retains identity) rather than a structural home; a future clipper could bypass it.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3

**Rationale**: The two kernels it extracts are the only candidate seams with two concrete consumers shipping in this very wave, so they cannot be speculatively wrong, while Variant 1 forces an injection abstraction across surfaces with contradictory failure policies (fail-open session hooks vs the fail-closed audited recall hook) and Variant 2 rewrites the ranker and write path twice inside a ten-commit PR, breaking the one-atomic-commit-per-task convention. Variant 3 also yields three parallel tracks with the rider fix and doctor probes landing first, which de-flakes CI before the heavier commits and keeps every commit byte-identical when its flag is omitted.
