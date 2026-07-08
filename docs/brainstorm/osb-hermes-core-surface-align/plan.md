# Plan — OSB Hermes-core surface align

Branch: `feat/osb-hermes-core-surface-align`. Drive cards **one at a time**; each worker builds on the commits the previously-driven card landed. Follow TDD: write the failing test first, then the minimal change that makes it pass. Reference: `docs/brainstorm/osb-hermes-core-surface-align/design.md`.

Run tests from the repo root:
- Python provider tests: `python -m pytest tests/python/test_static_schemas.py tests/python/test_memory_provider.py -q` (or `python -m unittest` if pytest is absent).
- The live anti-drift test in `test_static_schemas.py` skips automatically when Bun/`o2b` is missing — that is expected and must stay a skip, not a failure.

---

## Task t_2c8448bb — Verify OSB tool schemas against new core normalize/validate-before-wrap (PR #52140)

**Files**
- `tests/python/test_static_schemas.py` — add a new `NormalizeContractTests(unittest.TestCase)` class.
- `plugins/hermes/_schemas.py` — read-only verify (no change expected; pre-check confirmed flat schemas).
- `plugins/hermes/provider.py` — read-only verify of `get_tool_schemas()` (the `inputSchema`→`parameters` in-place remap is the focus).

**Acceptance (a passing test)**
- A test that imports `STATIC_TOOL_SCHEMAS`, `static_tool_schemas()`, and `MEMORY_TOOLS`, and asserts, for both the raw static tuple and the remapped accessor output:
  1. No entry contains a nested `{type:function, function:{...}}` wrapper (i.e. no key `type == "function"` with a `function` sub-dict at top level).
  2. Every entry has a non-empty top-level `name` (str).
  3. After the `inputSchema`→`parameters` remap, the set of `name`s, the count, and the declaration order are unchanged vs. the curated `MEMORY_TOOLS` set / static tuple order.
  4. The remap is idempotent: calling the accessor twice yields identical deep-copied output (guards the existing `test_accessor_returns_deep_copies` contract too).
- Additionally, a test that drives `OpenSecondBrainMemoryProvider.get_tool_schemas()` through a `FakeBrainBridge` returning a live-shaped tool list (one with `inputSchema`, one accidentally pre-wrapped `{type:function,...}`) and asserts the provider **filters out only non-curated names** and never emits a nameless/ double-wrapped entry — proving the OSB toolset survives the normalize path a strict provider would apply.
- `python -m pytest tests/python/test_static_schemas.py -q` is green; existing `StaticSchemaIntegrityTests` still pass.

**Depends on**
- Nothing (leaf). Ship first on the shared branch.

---

## Task t_3190e771 — Re-verify OSB compression hooks under in_place=True default flip (PR #52658)

**Files**
- `tests/python/test_memory_provider.py` — add a new test (and, only if the FakeBridge lacks it, a tiny helper to record ordered call args; reuse the existing `FakeBrainBridge.calls` list).
- `plugins/hermes/provider.py` — read-only verify of `on_pre_compress` / `on_session_end` / `_flush_buffer` (no change expected; confirm buffer-clear semantics).

**Acceptance (a passing test)**
- A test `test_repeated_in_place_compaction_flushes_each_boundary_once_with_stable_session_id` that:
  1. Initializes a provider with a `FakeBrainBridge` whose `brain_pre_compact_extract` returns an empty structured result.
  2. `sync_turn("u1","a1", session_id="sess-stable")`, then `_drain_captures()`.
  3. Fires `on_pre_compress([])` (boundary #1), then `on_pre_compress([])` again (boundary #2, same `session_id="sess-stable"` — simulating repeated in-place compaction with a non-rotating id), then `on_session_end([])`.
  4. Asserts `brain_pre_compact_extract` was called **exactly once per boundary that had buffered turns** — i.e. boundary #1 flushes the buffered turn; boundaries #2 and the final `on_session_end` make **zero** additional extract calls (buffer was cleared), because no new turn was buffered between them.
  5. Additionally: buffer some turns between boundary #1 and #2 and assert boundary #2 flushes exactly once with the newly-buffered turns only (no re-flush of #1's content) — proving no duplicate/clobbered writes accumulate under a stable id.
- A second test `test_stable_session_id_does_not_assume_rotation` documenting the decision: the provider makes no assumption that `session_id` changes across compaction; passing the same id to repeated `sync_turn` + `on_pre_compress` produces independent, dedup-safe flushes (the TS core dedupes by content hash anyway).
- `python -m pytest tests/python/test_memory_provider.py -q` is green; all existing `ProviderLifecycleTests` still pass.

**Depends on**
- t_2c8448bb having landed its test additions on the shared branch (so this worker builds on a green, schema-verified base). Both ship in the same release commit set; drive t_2c8448bb first, then this one.

---

## Release notes (both tasks)

- No `CHANGELOG.md` entry is required for a verify+regression-guard release with no behavior change, UNLESS a defect is found and fixed during implementation — in which case add a `### Fixed` line under the next unreleased version describing the corrected surface.
- Combined design: `docs/brainstorm/osb-hermes-core-surface-align/design.md`.
- Commit each card's work as its own focused commit on `feat/osb-hermes-core-surface-align`; the phase-0 brainstorm commit (`chore(brainstorm): osb-hermes-core-surface-align`) is already the branch base.
