### Variant 1: Unified Safety Kernel
- **Approach**: Build a single shared `brain/safety` core that all five tasks plug into - one deterministic classifier/sanitizer pipeline, one provenance/trust-label model, one secret-reference resolution boundary, and one audit-receipt emitter. The prompt-injection guard, secret refs, hard-forget closure, knowledge packs, and payload registry all consume the same kernel primitives (scan, label, redact, receipt) so behavior and operator surfaces are uniform across the suite.
- **Trade-offs**:
  - Pro: Maximum consistency - one privacy scanner reused by export/forget/payload paths, one audit format, one trust vocabulary; no drift between features.
  - Pro: Future host hooks and connectors inherit safety for free.
  - Con: Large blast radius into `redactor.ts`, `context-pack.ts`, `pre-compress-pack.ts`, `artifact-store.ts`, and MCP tools simultaneously; high regression surface against existing redaction/visibility behavior.
  - Con: Couples release cadence - the suite ships only when the slowest member (hard-forget closure) is safe; risks the "unsafe platform rewrite" the constraints warn against.
- **Complexity**: large
- **Risk**: high

### Variant 2: Independent Feature Slices on a Thin Contract
- **Approach**: Implement each task as its own self-contained module behind minimal shared interfaces - a `SafetyReason` type, a small audit-receipt helper, and reuse of the existing `redactor.ts` privacy scan - but no central kernel. Each feature owns its classifier, CLI verb, MCP surface, and tests independently, allowing parallel development and incremental merges.
- **Trade-offs**:
  - Pro: Low coupling; each slice ships, reverts, and is reviewed independently with a contained blast radius.
  - Pro: Easy to parallelize; existing public APIs stay untouched per the additive/opt-in convention.
  - Con: Real risk of divergence - five subtly different scan/redaction code paths and inconsistent JSON/reason shapes across CLI and MCP.
  - Con: Cross-cutting guarantees (e.g. "secrets never reach agent-facing output" and "forget invalidates caches") are enforced per-feature, so a gap in one slice can quietly weaken the suite-wide invariant.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Security Spine Deep, Governance Foundation Preview-Only
- **Approach**: Ship the two security-critical tasks - prompt-injection guard and agent-blind secret references - to full depth as the suite's spine, since they harden existing automatic-surfacing and config paths. Ship hard-forget, knowledge packs, and the payload registry as foundation slices: full data model, dry-run/preview, and read/inspection CLI+MCP surfaces, but defer the destructive apply (cascade delete, pack install mutation, payload eviction) to follow-ups. A thin shared contract (reasons + audit receipt) borrowed from Variant 2 keeps surfaces uniform.
- **Trade-offs**:
  - Pro: Directly satisfies the "foundation slice for largest tasks" and "dry-run/preview-first" constraints; the genuinely irreversible paths land last, behind preview.
  - Pro: Cohesive, reviewable PR that delivers real protection now (injection + secrets) without a platform rewrite.
  - Pro: Dry-run/preview outputs become the spec and test fixtures for the later apply phases.
  - Con: Forget/packs/payload are not end-to-end in this release; operators get plans and previews but not full apply, requiring clear "preview-only" signposting.
  - Con: Some rework risk if the apply phase later reveals model gaps the dry-run didn't anticipate.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3
**Rationale**: It maps onto the stated constraints almost exactly - ship a cohesive foundation, keep destructive forget/pack/payload behavior dry-run/preview-first, and avoid the unsafe platform rewrite that the full-depth Variant 1 invites. It delivers the highest-value protection (the injection guard and agent-blind secrets, both anchoring the parent task) at full strength now, while borrowing Variant 2's thin shared reason/audit contract to keep operator-facing JSON uniform without taking on Variant 1's simultaneous blast radius across redaction, context-pack, and MCP surfaces.