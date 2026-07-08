You are a senior backend architect advising the maintainers of **Open Second Brain (OSB)**, a TypeScript/Bun Obsidian-native memory-layer plugin for Hermes Agent (a Python LLM gateway). OSB ships a native Python `MemoryProvider` that bridges the deterministic TS core to Hermes' memory contract.

Two upstream Hermes PRs just landed and OSB must verify its surface against them. This is a **verify + regression-guard** task — not a feature build. The kernel calls no LLM; all changes are on the thin Python provider adapter + tests.

# Project / runtime facts

- Language: TypeScript core (Bun) + a thin Python `MemoryProvider` adapter (`plugins/hermes/`).
- Key files:
  - `plugins/hermes/_schemas.py` — vendored static tool schemas, each a flat `{name, description, inputSchema}` tuple. `static_tool_schemas()` returns deep copies with `inputSchema` renamed to `parameters`.
  - `plugins/hermes/provider.py` — `OpenSecondBrainMemoryProvider`: owns `get_tool_schemas()`, `handle_tool_call()`, and lifecycle hooks `on_pre_compress`, `on_session_end`, `sync_turn`, `prefetch`, `on_memory_write`, `shutdown`. `_flush_buffer()` calls `brain_pre_compact_extract` with `session_id = self._session_id or "hermes"`.
  - `src/core/brain/session-summary.ts` — TS session digests keyed/deduped by `session_id`.
  - `tests/python/test_static_schemas.py` + `tests/python/test_memory_provider.py` — Python unit tests (always run); plus a live `o2b mcp` anti-drift comparison that skips when Bun is absent.
- Conventions: SOLID/KISS/DRY; no misleading fallbacks; no hardcoding; English-only strings, abstract multi-language; every new surface additive and byte-identical when off; fail-soft hooks (never break a gateway turn).
- Tests: Python `unittest` for the provider; TS core has its own suite. CI has Bun (anti-drift enforced locally too).

# Recent git log (for direction / prior art)

```
61a9ad66 fix(brain): CodeRabbit review hardening for the unreleased v1.26.0 (#128)
962c3e0a feat(brain): memory-signal provenance and lifecycle integrity layer (v1.26.0) (#127)
fe2c0be2 feat(brain): context-pack economics and observability (1.25.0) (#126)
1cde572f fix(brain): harden reindex swap, self-heal, hot paths, and continuity contracts (1.24.0) (#125)
998e437f fix(windows): resolve 3 compatibility issues on Windows (#123)
```

# In-scope task bodies (verbatim)

## TASK t_2c8448bb — Verify OSB tool schemas against new core normalize/validate-before-wrap (PR #52140)

Upstream Hermes PR #52140 — fix(agent): validate context/memory tool schemas before wrapping. Core now runs a shared `normalize_tool_schema()` (agent/memory_manager.py) that unwraps already-wrapped `{type:function,function:{...}}` entries and validates a top-level `name` before agent_init.py wraps them. Previously one malformed schema from a memory provider disabled the ENTIRE toolset with HTTP 400 on strict providers (DeepSeek). Topic 41/157/160/161 run deepseek-v4-pro, so OSB tool exposure on those topics is exactly the at-risk path.

Verify:
- Confirm OSB's exported brain_* tool schemas are NOT pre-wrapped (no nested {type:function}) and every entry has a top-level name.
- Confirm none of OSB's tools get silently dropped/renamed by the new normalization.
- Add a regression check that the OSB toolset survives a strict-provider turn.

Pre-check note: OSB brain_* schemas in `plugins/hermes/_schemas.py` are flat (name, description, inputSchema) — no `{type:function}` wrapper anywhere, every entry has a top-level name — so they appear to already satisfy the constraint. But `get_tool_schemas()` mutates live entries: renames `inputSchema`→`parameters` in-place (`t = dict(t); t["parameters"] = t.pop("inputSchema")`). Need to confirm this remap still passes `normalize_tool_schema()` and that the curated set is unchanged after normalization.

## TASK t_3190e771 — Re-verify OSB compression hooks under in_place=True default flip (PR #52658)

Upstream Hermes PR #52658 — feat(compression): flip `compression.in_place` default False→True. Compaction now keeps ONE durable session id instead of rotating it. OSB hooks `on_pre_compress` (via `_flush_buffer`) and `on_session_end`, and writes continuity/summary records keyed by session id. A stable session id across compaction changes the lifecycle around those hooks (see upstream tests `test_compression_boundary_hook.py`).

Verify:
- OSB `on_pre_compress` / `on_session_end` still fire correctly and exactly once per boundary with a non-rotating session id.
- No duplicate/clobbered Brain session writes when a session is compacted in place repeatedly.
- Decide whether OSB should rely on session-id stability or remain id-agnostic. Opt-out fallback is `compression.in_place: false`.

Current behavior: `on_pre_compress` and `on_session_end` both call `_drain_captures()` + `_flush_buffer()`, which clears the in-memory buffer after one `brain_pre_compact_extract` call. Existing test `test_sync_turn_buffers_and_pre_compress_flushes_through_extract` checks a single flush + buffer-clear (second flush is a no-op), but does NOT cover repeated in-place compaction under a STABLE session id. Session summaries in `session-summary.ts` dedupe by content hash + scope by `session_id`.

# What I need from you

Produce EXACTLY 3 distinct architectural variants for how to structure this verify + regression-guard work across both tasks. For each variant give:
- **Approach** (2-3 sentences: what gets verified, where the regression guard lives, how the two tasks relate).
- **Trade-offs** (bullets).
- **Complexity**: small | medium | large.
- **Risk**: low | medium | high.

Then EXACTLY ONE line: `Recommended: Variant N` with a 2-3 sentence rationale.

Constraints to respect in every variant:
- The Python provider adapter is the only place allowed to change (plus tests). Do NOT touch the TS core or vendored schema bodies unless a real defect is found.
- Regression tests must be deterministic and runnable in CI without a live strict-provider — i.e. they must simulate the normalize path / repeated-compaction locally, not depend on DeepSeek.
- Both tasks ship together in ONE release on a shared feature branch; variants may sequence them or treat them jointly, but must keep the combined change minimal and coherent.
- No code in your answer — variants + recommendation only. Nothing outside those sections.
