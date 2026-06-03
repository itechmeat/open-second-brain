### Variant 1: Single observability kernel
- **Approach**: Introduce one shared `src/core/brain/observability/` kernel that owns the schema-version constant (`o2b.continuity.v1`), the `emitTelemetry(kind, gate, lazyPayload)` gate helper, and a record-normalization function. Tasks 1+2 land entirely inside it; every existing writer (`context-receipts`, `session-recall`, `recall-telemetry`, `gate-telemetry`, lifecycle) is refactored to route through the helper. Tasks 4 (export) and 5 (bench) become read-only consumers that import the kernel's normalize/version logic so all three surfaces agree on record shape.
- **Trade-offs**:
  - Pro: Matches the established kernel-first convention (suites #64–#69); the lazy-after-gate shape becomes structurally enforced, not conventional.
  - Pro: Single source of truth for schema version + evolution rule, which Task 3's doc and Task 4's export both depend on.
  - Pro: Easiest place to hang the no-consumer regression tests and fail-open guarantees.
  - Con: Refactoring six call sites in one PR widens the blast radius and risks touching the lifecycle hot path.
  - Con: Up-front abstraction cost before Task 4's fit assessment is even known to pay off.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Thin additive per-task patches
- **Approach**: Keep each task local with no new shared module. Add the `schema` field directly in `buildRecord()`, add `emitTelemetry` as a small helper beside the continuity store, write the doc, and add `export` and `bench` as independent CLI verbs that each read the JSONL store directly. Call sites are audited and fixed in place but not rerouted through a unifying layer.
- **Trade-offs**:
  - Pro: Smallest diff, lowest chance of regressing the lifecycle hot path or dedup hashing.
  - Pro: Task 4 can be cheaply abandoned (write-up only) without unwinding shared infrastructure.
  - Pro: Fast to land; each task is independently reviewable.
  - Con: The "no consumer => no payload work" property stays convention-enforced at most sites; drift is likely to recur in future suites.
  - Con: Export and bench each reimplement JSONL reading and version handling, duplicating normalization logic.
  - Con: Cuts against the project's kernel-first direction.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Split write-emit kernel + read-model layer
- **Approach**: Build two narrow layers instead of one. A write-side emit kernel covers Tasks 1+2 (schema stamping at `buildRecord`, `emitTelemetry` thunk gate, fail-open). A separate read-side "trajectory read-model" normalizes JSONL records into a canonical in-memory shape with schema-version dispatch, and both Task 4 (ATOF/ATIF export) and Task 5 (bench retrieval scoring) consume only that read-model — never the raw store.
- **Trade-offs**:
  - Pro: Clean separation of fail-fast write concerns from fail-soft read concerns, matching the project's read/write posture.
  - Pro: The read-model absorbs schema-version branching once, so export and bench can't disagree on legacy-record handling or private/redacted masking.
  - Pro: Gated emit kernel is small and low-risk; the larger read-model is purely additive and read-only.
  - Con: Two kernels to design and document instead of one; some conceptual overlap (version constant referenced on both sides).
  - Con: The read-model is partly speculative until Task 4's fit assessment confirms ATOF/ATIF is worth building.
  - Con: More moving parts than a single kernel for reviewers to hold.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: The five tasks split cleanly along the project's own fail-fast-write / fail-soft-read seam, and a shared read-model is the one place that guarantees export and bench handle legacy unversioned records and private/redacted masking identically — the highest-leverage correctness invariant in the epic. The write-emit kernel stays small enough to keep the lifecycle hot path safe, while the read layer remains purely additive and can be scoped down to a write-up artifact if Task 4's ATOF/ATIF fit assessment comes back negative, without stranding the rest of the suite.
