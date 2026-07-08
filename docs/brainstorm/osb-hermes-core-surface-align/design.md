# Design — OSB Hermes-core surface align

- **Slug:** `osb-hermes-core-surface-align`
- **Branch:** `feat/osb-hermes-core-surface-align` (off `61a9ad66`, == `origin/main`)
- **Scope:** single coherent line — verify OSB's Hermes-facing surface (memory-provider tool schemas + compression/session lifecycle hooks) against two freshly-landed upstream Hermes PRs, and add deterministic regression guards. No TS-core changes.

## Problem

Two upstream Hermes PRs landed on `main` (2026-06-24 / 2026-06-25) and OSB must confirm its `MemoryProvider` surface still conforms:

1. **PR #52140** — `fix(agent): validate context/memory tool schemas before wrapping` (closes #47707). Core now runs a shared `normalize_tool_schema()` in `agent/memory_manager.py` that (a) unwraps any already-wrapped `{type:function, function:{...}}` entry and (b) validates a top-level `name` before `agent_init.py` wraps each schema. A malformed schema previously disabled the **entire** toolset with HTTP 400 on strict providers (DeepSeek). OSB exposes its `brain_*` tools through exactly this memory-provider surface, and topics 41/157/160/161 run `deepseek-v4-pro` — so OSB tool exposure is precisely the at-risk path.

2. **PR #52658** — `feat(compression): flip compression.in_place default False→True`. Compaction now keeps **one durable session id** instead of rotating it (root cause of a P1 cluster: lost pending response, search black-hole, stale sid). OSB hooks `on_pre_compress` (via `_flush_buffer` → `brain_pre_compact_extract`) and `on_session_end`, and writes continuity/summary records **keyed by `session_id`**. A stable session id across compaction changes the lifecycle around those hooks.

## Scope

- `plugins/hermes/provider.py` — read/verify; change only if a real defect surfaces (none found in pre-check).
- `plugins/hermes/_schemas.py` — read/verify (already flat; no change expected).
- `tests/python/test_static_schemas.py` — **extend** with a structural-invariant regression for the normalize path (t_2c8448bb).
- `tests/python/test_memory_provider.py` — **extend** with a repeated in-place-compaction regression under a stable session id (t_3190e771).
- `docs/brainstorm/osb-hermes-core-surface-align/` — this design + plan + variants + cli-output.

## Out of scope

- The deterministic TypeScript core (`src/core/brain/*`) — session-summary dedup already keys by `session_id` + content hash; no change needed.
- Re-porting upstream `normalize_tool_schema()` or `test_compression_boundary_hook.py` into OSB (deliberately rejected — see Design decisions).
- Vendored schema bodies — they are a verbatim projection of the live `o2b mcp` `tools/list` and are protected by the existing anti-drift test; do not hand-edit.
- Any change to OSB's `compression.in_place` config handling — OSB does not own that flag; it is a Hermes core knob.
- The umbrella meta-card `t_9935bd26` (intentionally omitted; pure coordinator, closed manually after children ship).

## Chosen approach — Variant 1: two disjoint, thin regression guards (task-local)

The two tasks are **behaviorally disjoint** (schema shape vs. compaction lifecycle), so each gets its own focused, deterministic test. No shared harness, no ported normalizer, no golden snapshots.

- **t_2c8448bb — assert structural invariants the new normalize path depends on**, against the exact output of `get_tool_schemas()` (both the static-fallback and the live-bridge code paths), rather than re-implementing `normalize_tool_schema()`. Invariants: no `{type:function}` wrapper nested anywhere; every entry has a non-empty top-level `name`; the `inputSchema`→`parameters` in-place remap is idempotent and preserves the curated name set, count, and order.
- **t_3190e771 — drive `sync_turn` → repeated `on_pre_compress` → `on_session_end` with a fixed session id**, and assert exactly-once flush semantics: `brain_pre_compact_extract` fires once per boundary, the in-memory buffer is cleared between flushes (no double-flush), and no duplicate/clobbered Brain session writes accumulate across repeated in-place compaction. Decide OSB stays **session-id-agnostic** (it already keys writes by `session_id` but makes no assumption the id rotates; stability only helps, never hurts).

## Design decisions

1. **Assert invariants, do not port the normalizer.** Hermes is fast-forwarded to `main` on every `hermes update`; a locally-ported `normalize_tool_schema()` would silently drift and give false confidence (a green test guarding the wrong contract). Asserting the *preconditions* the normalizer relies on (flat shape, top-level `name`) is upstream-drift-proof and deterministic in CI without DeepSeek.
2. **No DeepSeek dependency.** The "strict-provider turn survives" guarantee is asserted **by proxy** — the structural invariants that caused the HTTP 400 are proven absent. This keeps the test hermetic and CI-cheap, and matches the repo's existing anti-drift style (which skips, not fails, when a live dependency is missing).
3. **Stable-id is a non-event for OSB.** OSB never assumed the session id rotates: `_flush_buffer` clears its buffer after each flush, and TS-side summaries dedupe by content hash. Repeated in-place compaction under one stable id therefore cannot produce duplicate writes *unless* the buffer is flushed twice per boundary — which is exactly the regression the new test pins. No opt-out toggle is added; `compression.in_place: false` remains Hermes' own fallback, not OSB's concern.
4. **Test-only where possible.** Both changes are additive regression tests. `provider.py`/`_schemas.py` change only if a real defect is found during implementation — the pre-check found none.
5. **Ship as one release on one branch.** Both guards land on `feat/osb-hermes-core-surface-align` as one coherent upstream-alignment release, cards driven one at a time, each worker building on the prior card's commits.

## File changes

| File | Change | Task |
|---|---|---|
| `tests/python/test_static_schemas.py` | Add `NormalizeContractTests`: assert flat shape (no `{type:function}`), top-level `name` present on every entry, and that `get_tool_schemas()` output (static + live-remap paths) survives a faithful *invariant* check + preserves the curated name set/count/order under the `inputSchema`→`parameters` remap. | t_2c8448bb |
| `tests/python/test_memory_provider.py` | Add `test_repeated_in_place_compaction_flushes_each_boundary_once_with_stable_session_id`: buffer turns, fire `on_pre_compress` N times with the same `session_id`, assert exactly one `brain_pre_compact_extract` per boundary, buffer cleared between, no duplicate/clobbered writes. | t_3190e771 |
| `docs/brainstorm/osb-hermes-core-surface-align/{design,plan,variants}.md` + `cli-output/*` | Phase-0 artifacts. | — |

## Risks

- **Proxy vs. end-to-end (low).** Asserting invariants proves the HTTP-400 preconditions are absent but does not exercise a real strict-provider wrap. Mitigation: the invariants are the *exact* conditions the upstream issue #47707 names; satisfying them is the precise fix the PR enforces. A live DeepSeek e2e is out of scope (no credentials in CI; non-hermetic).
- **Upstream test-shape drift (low).** If a future Hermes release changes the normalize contract, the invariant test still holds (it asserts OSB's own shape, not upstream's internals) — and the live `o2b mcp` anti-drift test already catches schema-body drift.
- **Compaction-simulator fidelity (low).** The repeated-compaction test simulates the boundary by calling the hook directly, which is how the existing lifecycle tests already exercise it; no new simulator abstraction is introduced.
