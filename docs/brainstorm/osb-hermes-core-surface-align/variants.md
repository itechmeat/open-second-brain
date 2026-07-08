# Variants — OSB Hermes-core surface align

All variants verbatim from the consultant (claude-opus-4-8), plus the final decision rationale.

---

## Variant 1 — Two disjoint, thin regression guards (task-local)

**Approach:** Treat the tasks as behaviorally independent and give each its own focused test module against `provider.py`. For t_2c8448bb, assert the *structural invariants* the new `normalize_tool_schema()` depends on — no `{type:function}` wrapper, a top-level `name` on every entry, and that the in-place `inputSchema`→`parameters` remap is idempotent and preserves the curated set/count/order — rather than re-implementing upstream normalization. For t_3190e771, drive `sync_turn` → repeated `on_pre_compress` → `on_session_end` against a fixed session id and assert exactly-once flush semantics and no duplicate/clobbered Brain writes.

**Trade-offs:**
- No shared infrastructure to build or maintain; smallest possible diff for a verify task.
- Structural-invariant assertions (vs. a ported normalizer) can't drift out of sync with upstream and give no false confidence.
- Honestly models that schema-shape and compaction-lifecycle share nothing — no artificial coupling.
- Weaker at proving the end-to-end "strict-provider turn survives"; the strict path is asserted by proxy (invariants) rather than by exercising a wrap step.
- Two modules means two places to update if the provider surface later grows.

**Complexity:** small
**Risk:** low

---

## Variant 2 — Shared upstream-contract harness (joint)

**Approach:** Frame both tasks as one theme — "OSB conforms to changed upstream contracts" — and build a single test-support module with two reusable fixtures: a local port of `normalize_tool_schema()` semantics and a session-lifecycle/compaction-boundary simulator mirroring `test_compression_boundary_hook.py`. Both regression suites consume this harness so the whole upstream surface is verified through one coherent seam.

**Trade-offs:**
- DRY, one canonical place expressing "what upstream expects of us"; easy to extend when the next Hermes PR lands.
- Coherent story for the shared branch/release: one harness, one intent.
- A locally-ported `normalize_tool_schema` is a maintenance liability — if upstream changes its normalization, the port silently drifts and the guard passes while reality breaks (false confidence).
- More upfront surface than a verify task warrants; couples two behaviorally unrelated concerns for organizational neatness only.
- Simulator fidelity to real compaction is an assumption that must itself be trusted.

**Complexity:** medium
**Risk:** medium

---

## Variant 3 — Golden-snapshot drift detection

**Approach:** Capture the post-normalization toolset and a session-write "ledger" (the sequence of `brain_pre_compact_extract` calls + summary keys emitted across a repeated in-place compaction run) as golden artifacts, then assert byte-identical-when-off against those snapshots. This leans on the "additive/byte-identical" convention and pairs naturally with the existing `o2b mcp` anti-drift comparison, making both tasks a single drift-guard surface.

**Trade-offs:**
- Excellent at catching *unintended* changes to the exposed schema set and hook call pattern; cheap to read as a diff in review.
- Reuses the anti-drift muscle the repo already has.
- Snapshots prove "nothing changed," not "behavior is correct under the new default" — a careless regenerate can bake in a real regression.
- Snapshotting the write ledger likely requires instrumenting the provider's write path, pushing toward touching more than the adapter.
- Doesn't behaviorally exercise the strict-provider wrap or the exactly-once flush; it observes outputs, not the lifecycle guarantees the tasks actually ask about.

**Complexity:** medium
**Risk:** medium

---

## Consultant recommendation

> Recommended: Variant 1 — The two tasks are behaviorally disjoint (schema shape vs. compaction lifecycle), so forcing a shared harness or snapshot surface adds coupling and maintenance a verify task doesn't warrant. Asserting the structural invariants `normalize_tool_schema()` relies on — rather than re-porting it — keeps the guards deterministic, CI-safe without DeepSeek, and immune to upstream drift, while still shipping both as one minimal, coherent branch.

## Final decision: Variant 1 (agree with recommendation)

Rationale: the two tasks are behaviorally disjoint (schema shape vs. compaction lifecycle). Asserting structural invariants instead of re-porting `normalize_tool_schema()` avoids the false-confidence drift risk that is especially acute here — Hermes is fast-forwarded to `main` on every `hermes update`, so any local port can silently rot while the test stays green. Variant 1 is the only option that is deterministic in CI without DeepSeek credentials, minimal in diff, and upstream-drift-proof, while still shipping both guards as one coherent alignment release. Variants 2 and 3 were rejected for coupling unrelated concerns and for observing outputs rather than the actual lifecycle guarantees the tasks require.
