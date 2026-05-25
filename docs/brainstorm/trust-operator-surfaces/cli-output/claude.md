### Variant 1: Flat layered expansion, no new MCP tool
- **Approach**: Drop each feature as a peer module in its matching layer (atoms next to existing atoms, helpers next to existing helpers), and extend `brain_doctor` / `brain_dream` / `brain_digest` / `brain_feedback` in-place with new fields. The operator dashboard becomes an extension of `DigestJson` (new `trust_verdict`, `uncertain_count`, `quarantined_count`, `verification_delta_summary` fields), not a new tool. No new directory; eight features land as ~8 small peer modules across existing folders.
- **Trade-offs**:
  - Pro: smallest surface-area delta, mirrors v0.10.14 / v0.10.10 style (extend, don't add tools).
  - Pro: each feature stays independently testable; bundle = sum of parts.
  - Pro: lowest risk of cross-feature coupling regressions.
  - Con: the "trust the brain's self-reporting" theme is invisible at the file-tree level — eight tiny additions sprinkled across `src/core/brain/`.
  - Con: dashboard via field-expansion of `DigestJson` makes that type wider and less focused; operators must still mentally compose multiple sections.
  - Con: no single import path that a future contributor can point at as "the trust layer".
- **Complexity**: medium
- **Risk**: low

### Variant 2: New `trust/` subsystem with one new consumer tool
- **Approach**: Introduce `src/core/brain/trust/` housing the new helpers (`compute-verification-delta.ts`, `compute-trust-verdict.ts`, `assess-rule-quality.ts`, `check-role-permission.ts`, `instruction-file-ceiling.ts`, `self-approval-guardrail.ts`), each a pure function over atoms. Atoms (uncertainty arrays, verdict field, promotion config) still land on the existing summary types, but everything that *computes* them lives in `trust/`. Add one new MCP tool `brain_operator_summary` as the aggregating consumer; existing tools import the helpers but keep their current shape and contracts.
- **Trade-offs**:
  - Pro: follows v0.10.15 precedent (`page-meta/`, `maintenance/` subdirs) — gives the release a coherent identity and a single grep target.
  - Pro: helpers are pure, so cross-feature interaction is forced through typed function boundaries instead of ad-hoc field reads.
  - Pro: dashboard tool can iterate independently without re-shaping `DigestJson`; `brain_digest` stays small and digestible.
  - Pro: tests mirror cleanly under `tests/core/brain/trust/`.
  - Con: requires choosing a subsystem name now; "trust" may age poorly if scope drifts.
  - Con: one extra MCP tool to document, version, and keep aligned with `brain_digest` (overlap risk).
  - Con: slightly more upfront design than Variant 1 — need to define the trust-layer's read-only contract against atoms.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Capability-kernel refactor around writes
- **Approach**: Make role-separated permissions (#8) the keystone — introduce a `BrainCapability` kernel that intercepts every brain write (`brain_feedback`, `brain_dream`, `brain_apply_evidence`), and rebuild the other seven features as policies hanging off that kernel (quality gate as a pre-write policy, self-approval guardrail as a promotion policy, verification delta as a post-write policy, etc.). Existing handlers in `src/mcp/brain-tools.ts` get rewritten to flow through the kernel.
- **Trade-offs**:
  - Pro: structurally enforces #8 — role boundaries can't be bypassed because the kernel mediates every write.
  - Pro: future brain tools inherit role separation, quality gates, and verification for free.
  - Pro: the cleanest long-term mental model — one seam, many policies.
  - Con: violates the project's "extend without rewriting" rule and "no backwards-compat shims" posture — `brain-tools.ts` handlers get re-shaped.
  - Con: largest blast radius across 1865+ tests; bundling a refactor with eight features in one release inflates review surface and CHANGELOG scope.
  - Con: kernel design is the kind of premature abstraction the layered-DAG convention exists to prevent; v0.10.15 explicitly chose peer modules over a kernel.
  - Con: high risk that one of the eight features stalls and blocks the other seven because they share a critical-path module.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: Variant 2 fits the established v0.10.15 precedent (a named subdirectory of pure helpers per release) and gives the eight-feature bundle the coherent identity its theme demands, without the rewriting risk of Variant 3 or the file-tree invisibility of Variant 1. Atoms remain field-additions on existing summaries (satisfying "extend without rewriting"), helpers are pure and independently testable, and one new consumer tool (`brain_operator_summary`) cleanly absorbs the dashboard role so `brain_digest` stays focused. It preserves the layered DAG rule while making the release legible as a single architectural move.
