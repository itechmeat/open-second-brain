### Variant 1: Four Isolated Vertical Slices
- **Approach**: Treat each task as a self-contained module that touches only its own existing boundary — CJK at `search/schema.ts`+`indexer.ts`, schema mutation at `schema-vocab.ts`+a new `schema-mutate.ts`, session hooks as a new `sessions/hooks.ts` adapter feeding `writeSignal`, watchdog as a standalone gateway background task. Each ships behind its own default-off config key with no shared scaffolding between them. The PR is the sum of four independently reviewable diffs.
- **Trade-offs**:
  - Pro: maximum reviewability and rollback granularity; each slice can be reverted without touching the others.
  - Pro: lowest coupling risk — a bug in the watchdog cannot regress search or schema.
  - Pro: cleanly honors "reuse existing boundaries" since each slice extends exactly one.
  - Con: duplicates atomic-write/fsync-rename logic across schema-mutate, watchdog auto-restore, and hook persistence (DRY violation).
  - Con: duplicates audit-log + privacy-redaction logic (schema mutate-audit vs. hook capture vs. recovery events).
  - Con: 4 tasks × multiple sub-surfaces risks brushing the 10-theme ceiling with no consolidation lever.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Shared Atomic/Audit/Probe Spine
- **Approach**: Extract the cross-cutting primitives the three write-heavy tasks share — an atomic `withMutation` (.tmp+fsync+rename), a file-level lock with stale/liveness detection, an ISO-week JSONL audit writer with redaction, and a health-probe/invariant harness — into a small internal substrate, then build schema mutation, session-hook capture, and the watchdog on top of it. CJK remains the deliberate outlier wired only into the search layer. The schema pack-lock and watchdog probe become two consumers of one locking/probe abstraction rather than parallel implementations.
- **Trade-offs**:
  - Pro: strongest DRY/SOLID alignment — one atomic-write boundary, one audit boundary, one probe harness reused 3×.
  - Pro: the watchdog's invariant checks can directly reuse the `brain_doctor` probe surface, and auto-restore reuses snapshot/rollback gates instead of reinventing them.
  - Pro: consolidates theme count — "atomic mutation substrate" + "audit/probe substrate" absorb several sub-items.
  - Con: highest upfront design coupling — the spine must satisfy schema, hooks, and watchdog simultaneously, raising the chance of an over-fitted abstraction.
  - Con: a regression in the shared spine has blast radius across three features, hurting the isolation that Variant 1 buys cheaply.
  - Con: sequencing pressure — the spine must land first, so partial-merge fallback is weaker.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Risk-Tiered (Full Read/Foundation, Opt-In Writes)
- **Approach**: Ship the low-risk and well-bounded paths in full — CJK tokenization (indexing + query, optionalDeps soft-fail) and the complete schema mutation surface (the explicitly-deferred remainder of t_cbf4967f, already ADR-gated) — while deliberately scoping the two architecturally-novel tasks down to their safe core: session "hooks" implemented as an eager capture adapter that reuses the existing import pipeline rather than a new synchronous hook runtime, and the watchdog implemented as detect-and-recommend (plan-only health probe emitting a remediation plan, auto-restore strictly opt-in/off-by-default). Riskier real-time and auto-recovery behavior is deferred to a follow-up.
- **Trade-offs**:
  - Pro: directly satisfies the hard constraints — auto-restore is never default, session import behavior is untouched, theme count stays low.
  - Pro: front-loads the two tasks with the clearest specs (CJK has an upstream reference impl; schema mutation has an accepted ADR) and de-risks the two flagged "needs design" tasks.
  - Pro: keeps each feature default-off/byte-compatible with minimal new always-on machinery.
  - Con: tasks t_9eaebcad and t_8d8ec450 are only partially delivered — the "real-time" and "self-healing" headline value is deferred.
  - Con: still some duplication of atomic-write/audit logic since no shared spine is extracted (mitigated by smaller write surface).
  - Con: requires explicit operator agreement that two of four tasks ship reduced-scope.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3
**Rationale**: The two upstream-derived tasks (session hooks, watchdog) are both flagged "needs design" and carry the project's sharpest constraints — no default auto-restore, no break to session import — so reducing them to their safe, default-off core is the lowest-risk way to keep all four tasks in one PR under the 10-theme ceiling. It still delivers the two best-specified tasks (CJK with an upstream reference, schema mutation with an accepted ADR) at full scope, and the smaller write surface keeps the DRY cost of skipping Variant 2's shared spine modest while avoiding that spine's three-feature blast radius.
