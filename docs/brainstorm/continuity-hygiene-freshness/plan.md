# Continuity, Hygiene & Freshness Suite - implementation plan

TDD per task: failing test first, implement, refactor, formatter + linter green before every commit. One conventional commit per task.

## Tasks

### Task 1: Command bridge extraction
- **Files**: `src/core/reliability/command-bridge.ts` (new), `src/core/bench/judge.ts` (refactor to thin caller), `tests/core/reliability/command-bridge.test.ts` (new)
- **Acceptance**: existing judge tests pass unchanged; bridge unit tests cover ok / non-zero exit / timeout / malformed JSON / signal kill, all fail-open.
- **Depends on**: none

### Task 2: Lineage kernel (types, resolve, ledger, crutch)
- **Files**: `src/core/brain/lineage/types.ts`, `lineage/resolve.ts`, `lineage/ledger.ts`, `lineage/crutch.ts` (all new), `tests/core/brain/lineage.test.ts` (new)
- **Acceptance**: resolve prefers payload fields (source `payload`); falls back to crutch only on compression evidence + same cwd + bounded window (source `crutch`); otherwise flat (source `flat`). Ledger is append-only JSONL under Brain/state, fail-soft on unreadable state. Every crutch site carries `CRUTCH(t_1459706f)`.
- **Depends on**: none

### Task 3: Hook payload lineage plumbing (A1, t_d08ccc5a)
- **Files**: `hooks/lib/stdin.ts`, `src/core/brain/session-lifecycle.ts`, `tests/core/brain/session-lifecycle*.test.ts`
- **Acceptance**: `HookPayloadBase` exposes optional `parent_session_id` / `root_session_id` / `compression_depth`; lifecycle capture normalizes them, feeds the ledger, and stamps lineage into the audit/log rows; a payload without lineage behaves byte-identically to today.
- **Depends on**: Task 2

### Task 4: Compression-aware capture & recall (A2, t_a94623ad)
- **Files**: `src/core/brain/sessions/import.ts`, `src/core/brain/session-recall.ts`, `src/mcp/brain/recall-tools.ts`, session CLI verbs, `tests/core/brain/session-recall*.test.ts`
- **Acceptance**: imported records carry lineage payload fields; expand/grep/describe over any segment id return turns from the whole lineage; flat sessions regress nothing (characterization test pinned before change); adjacent segments expose a continuity edge (segment list with parent/child ids).
- **Depends on**: Task 2, Task 3

### Task 5: Degradation ladder (A3, t_05f5dc12)
- **Files**: `src/core/brain/recall-budget.ts`, `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, `src/core/brain/context-presets.ts`, config plumb, `tests/core/brain/recall-budget*.test.ts`
- **Acceptance**: default = hard cut, byte-identical (characterization test); staged mode degrades sentence-boundary -> line extract -> hard cut, reported per entry; multi-script terminator tests (Latin, CJK) pass; pure and deterministic.
- **Depends on**: none

### Task 6: Anticipatory context cache (A4, t_4cee9df5)
- **Files**: `src/core/brain/anticipatory-cache.ts` (new), hook entry wiring, `src/mcp/brain/pack-tools.ts` (`brain_anticipatory_context` lives in the context-pack domain), CLI verb, `tests/core/brain/anticipatory-cache.test.ts`
- **Acceptance**: refresh debounced by TTL (clock injected), atomic write, keyed by lineage root; read returns warm cache or falls back to live pack with `cache_state` reported; broken cache never propagates an error to the hook.
- **Depends on**: Task 2

### Task 7: Freshness substrate (B4, t_d9624ef6)
- **Files**: `src/core/brain/freshness.ts` (new), `src/core/brain/handoff.ts` + `src/core/brain/sessions/import.ts` (sources stamp), `tests/core/brain/freshness.test.ts`
- **Acceptance**: `sources:` frontmatter contract (path + sha256) documented and stamped by session-derived writers; on-demand check classifies fresh / stale / orphaned; pages without the contract are skipped silently.
- **Depends on**: none

### Task 8: Hygiene kernel + conflicts & usefulness detectors (B1 core + B3 detection, t_698db8f7 / t_db375a60)
- **Files**: `src/core/brain/hygiene/types.ts`, `hygiene/scan.ts`, `hygiene/detectors/conflicts.ts`, `hygiene/detectors/usefulness.ts`, `hygiene/detectors/freshness.ts` (wraps the Task 7 substrate as a detector), `tests/core/brain/hygiene-scan.test.ts`
- **Acceptance**: scan composes detector findings into one frozen digest; conflict detection is deterministic (contradiction classification + `contradicts` relations); usefulness reads recall-telemetry (never-surfaced / always-skipped candidates); freshness findings map stale -> `recompile` and orphaned -> `review` proposed actions; scan is read-only.
- **Depends on**: Task 7

### Task 9: Dedup detector (B2, t_da3f138f)
- **Files**: `src/core/brain/hygiene/detectors/dedup.ts`, `tests/core/brain/hygiene-dedup.test.ts`
- **Acceptance**: embedding-similarity pairs above threshold (default 0.97) reported with evidence; lexical fallback when the provider is null/unavailable, clearly labeled; candidate set bounded before pairwise comparison.
- **Depends on**: Task 8

### Task 10: Conflict resolution via resolver bridge (B3, t_db375a60)
- **Files**: `src/core/brain/hygiene/resolve-conflicts.ts`, config key `hygiene.resolver_cmd`, `tests/core/brain/hygiene-resolve.test.ts`
- **Acceptance**: with resolver configured, verdicts (supersede / merge / flag) validate and attach to findings; without resolver every conflict is `review`; resolver failure is fail-open to `review`.
- **Depends on**: Task 1, Task 8

### Task 11: Hygiene apply + audit (B1 completion, t_698db8f7)
- **Files**: `src/core/brain/hygiene/apply.ts`, `hygiene/plan.ts`, `tests/core/brain/hygiene-apply.test.ts`
- **Acceptance**: apply executes a typed plan selected from scan findings; every action lands an audit record; `--dry-run` previews with zero writes; `forget` archives, never deletes.
- **Depends on**: Task 8, Task 9, Task 10

### Task 12: Targeted recompile (B5, t_fe490119)
- **Files**: `src/core/brain/recompile.ts` (new), `tests/core/brain/recompile.test.ts`
- **Acceptance**: plan lists stale pages with owning-source diffs and orphan cleanups, skipping unrelated pages; dry-run previews with zero writes and zero external calls; execution re-derives via existing import/indexer entry points.
- **Depends on**: Task 7

### Task 13: Surfaces - MCP tools, CLI verbs, parity list
- **Files**: `src/mcp/brain/hygiene-tools.ts` (new), `src/mcp/brain-tools.ts`, MCP parity test (+2: `brain_hygiene`, `brain_anticipatory_context`), CLI verbs `hygiene` / `refresh` / `anticipate`, command manifest, completions, help text
- **Acceptance**: parity test updated deliberately to the new set; CLI verbs route to kernel functions with stable JSON output; `o2b brain refresh --stale --dry-run` works end-to-end on a fixture vault.
- **Depends on**: Tasks 4, 6, 11, 12

### Task 14: Config keys + docs
- **Files**: `src/core/brain/policy.ts`, `README.md`, `CHANGELOG.md`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/architecture.md`
- **Acceptance**: new one-level config blocks parse via the existing YAML subset grammar with defaults documented; docs describe all nine capabilities; CHANGELOG carries one version entry for the whole PR.
- **Depends on**: Task 13
