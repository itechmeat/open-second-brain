# Consultant output - agent-presence-self-improvement

The consultant role was performed in-session against the prompt at `cli-output/prompt.md`; the output below is preserved verbatim.

### Variant 1: one installer feature, lessons and rewrites folded into it

- **Approach**: Treat all four cards as one install-surface feature: the instruction block, the lessons block, the ChatGPT naming and even the rewrite lane hang off `o2b install` as steps of one orchestrator, with one manifest recording everything the tool wrote.
- **Trade-offs**:
  - Pros: one verb to learn; one consent pass; the lock/manifest story is single.
  - Cons: the rewrite lane has no install step at all - it is a brain verb family with its own gates, so folding it in is a category error; the lessons approval lifecycle is independent of host detection (a vault with zero installed hosts still promotes lessons); a mega-orchestrator turns every later feature into an `o2b install` regression surface; the card asks for install presence, not install monopoly.
- **Complexity**: large
- **Risk**: high

### Variant 2: one shared writer, two producers, separate kernels

- **Approach**: Build one block-id-parametrised rules-block writer over the existing managed-block editor; the installer lane and the lessons lane are its two producers with separate lifecycles and consent surfaces; the rewrite loop is a self-contained kernel lane beside them (task sets, preregistered spec, envelope rollouts, selection and held-out gates, apply through the existing proposal pipeline); ChatGPT desktop is detection-plus-docs on the codex adapter. Lanes own disjoint files; shared registries are append-only.
- **Trade-offs**:
  - Pros: exactly one write class for harness-owned files, so one census story and one audit trail; no producer forks the editor; each kernel is testable in isolation; the lanes parallelize behind two early pure commits.
  - Cons: two consent surfaces for rules files (install's and the lessons verbs'), which the docs must keep distinct; the writer contract must be frozen before the lessons lane starts, adding an ordering constraint the mega-orchestrator would not have.
- **Complexity**: medium
- **Risk**: low

### Variant 3: per-feature writers

- **Approach**: Let each lane write its own block logic directly against `insertManagedBlock`: the installer keeps its own compute/apply, the lessons verbs their own.
- **Trade-offs**:
  - Pros: no cross-lane contract; each lane ships independently with zero waiting.
  - Cons: two implementations of the drift refusal, the backup ladder, the idempotence byte-compare and the marker discipline, guaranteed to diverge; two census stories for one write class; the wave's stated spine (one apply-gated rules-file write path) is not built.
- **Complexity**: small per lane, large in total
- **Risk**: medium

### Recommended: Variant 2

**Rationale**: The board's scope option names the spine as one apply-gated rules-file write path plus the closed skill loop, and the tree already contains every primitive both halves need - the managed-block editor, the conformance checker, the consent ladder, the proposal pipeline with its journalled accept, the decision-model preregistration discipline. Variant 3 dissolves the spine into two guaranteed-to-diverge writers; Variant 1 miscategories a verb-family feature as an install step and concentrates regression risk in one orchestrator. Variant 2 adds exactly what is missing - one shared writer, one kernel lane - and keeps the lanes disjoint behind two early pure commits.
