You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic: Memory Observability Suite for Open Second Brain (target v0.39.0). Five kanban tasks ship in one PR:

## Task 1 (t_26040ee8, p2): Versioned telemetry schema for continuity records

The continuity store (`src/core/brain/continuity/store.ts`) writes JSONL records to `Brain/log/continuity/<month>.jsonl` with `id`, `kind`, `createdAt`, `sourceRefs`, `payload`, `private`, `redacted` - but no schema version. Consumers cannot detect when a record kind's payload shape evolves.

- Add a `schema` field to `ContinuityRecord` (`src/core/brain/continuity/types.ts`), stamped at `buildRecord()` - e.g. `o2b.continuity.v1`.
- Old records without the field are implicitly v1; readers treat `undefined` as v1 (no migration of existing JSONL).
- Decide versioning granularity: one version for the whole store vs per-kind versions. Upstream (hermes-agent PR #38232) uses one contract-wide version - simplest, recommended.
- Document the evolution rule: additive fields do not bump the version; renames/removals/semantic changes do.
- Tests: new records carry the version; readers accept legacy records without it; `recordId()` hash either includes or deliberately excludes the version (pick one, test it - including it would change dedup IDs for otherwise-identical records).

## Task 2 (t_5d7aa7c5, p1): Lazy gated telemetry emit helper with no-consumer regression tests

Telemetry opt-in gates live at each call site (`if (resolveRecallGateTelemetry(...))` in `src/mcp/search-tools.ts`, `telemetry` options in `src/core/brain/context-pack.ts` / `pre-compress-pack.ts`, lifecycle capture in `src/core/brain/session-lifecycle.ts`). The property "no consumer => no payload work" is enforced by convention, not by structure or tests.

1. Audit every `appendContinuityRecord` / `captureSessionLifecycleEvent` / telemetry-emit call site for eager payload construction ahead of the gate. Fix any found.
2. Centralize the gate: a small `emitTelemetry(kind, gate, lazyPayload)` helper (payload as a thunk) so the lazy-after-gate shape is the default.
3. No-consumer regression tests: for each gated surface, a test asserting that with telemetry off, the payload thunk is never invoked and no continuity write happens.
4. Keep fail-open semantics: a throwing payload thunk or write must never fail the primary operation - assert that too.

Known call sites of appendContinuityRecord: context-receipts.ts, pre-compact-extract.ts, session-recall.ts (2 sites), recall-telemetry.ts (emitRecallTelemetry), gate-telemetry.ts (emitGateTelemetry).

## Task 3 (t_66545537, p2): Observability contract doc

Write `docs/observability.md`: event families (Brain/log/<date>.md log events via appendLogEvent in src/core/brain/log.ts; continuity record kinds; session lifecycle capture), correlation IDs (session_id, turn_id, createdAt, record id sha-256 dedup, sourceRefs), payload safety (private-region stripping, secret redaction in continuity/redaction.ts, deep-freeze, private/redacted flags), fail-open rules, always-on vs opt-in status per event kind verified against source. Doc only - no behavior changes, but it documents the schema version + evolution rule from Task 1.

## Task 4 (t_51959aeb, p1): ATOF/ATIF trajectory export for continuity session records (exploration first)

1. Assess fit: map continuity record kinds (session_turn, recall_telemetry, gate_telemetry, context_receipt) onto ATOF event kinds (scope/mark) and ATIF steps/observations. O2B is a memory layer, not the agent loop - the interesting trajectory is "turn -> recall gate decision -> context pack served -> receipts". Write up the mapping before any code.
2. If the fit is real: `o2b continuity export --format atof|atif [--session <id>] [--month <m>]` CLI producing spec-conformant files. Read-only over the JSONL store; no new emission paths.
3. Honor private/redacted record flags in the export (drop or mask, never leak).
4. Validate output against the published format specs (golden-file tests with sanitized fixtures).
If the mapping write-up shows the formats are a bad fit, close with the write-up as the artifact.

## Task 5 (t_882c396a, p2): Memory quality benchmark harness with MemScore-style reporting

Add an OSB-local benchmark harness for memory quality regression testing (inspired by supermemory MemoryBench):

- `o2b brain bench memory` with phases: ingest fixture, build index/dream, run retrieval/context-pack, answer with configured judge/model or deterministic expected-context mode, evaluate, report.
- Store runs under a local ignored directory such as `.open-second-brain/bench-runs/` with `checkpoint.json`, per-question results, and `report.json`.
- Track quality/pass rate, recall latency, average context tokens/chars, missing-ground-truth cases, stale-fact regressions. Keep quality / latency / context-cost as separate numbers (MemScore triple), never one opaque score.
- Fixture categories: single-hop preference recall, temporal updates, contradiction/supersession, multi-record evidence, session handoff, context budget truncation.
- Reports diffable so PRs can show whether recall quality improved or regressed.
- A benchmark run can resume from a checkpointed run ID without repeating completed phases.
- The harness can run in a deterministic no-network mode for CI smoke coverage.
- Optional judge-model evaluation clearly gated by config and skipped when unavailable.

# Project context

Open Second Brain - TypeScript on Bun, plus a Python provider layer. Markdown/Obsidian vault as storage, SQLite FTS5 index for search, MCP server (65 advertised tools) + `o2b` CLI.

Recent commits:
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)

Related files:
- src/core/brain/continuity/{store,types,redaction}.ts - JSONL continuity store, buildRecord, safeContinuityPayload
- src/core/brain/recall-telemetry.ts, gate-telemetry.ts - emit/list/summarize over continuity records
- src/core/brain/session-lifecycle.ts - per-tool-use lifecycle capture (hot path)
- src/core/brain/context-receipts.ts, pre-compact-extract.ts, session-recall.ts - other continuity writers
- src/core/brain/context-pack.ts (packContext), src/core/search/search.ts (search) - recall surfaces the bench would drive
- src/core/brain/log.ts (appendLogEvent) - daily Markdown log + JSONL sidecar
- src/cli/brain/verbs/ - one file per CLI verb, registration in verbs/index.ts + help-text.ts + command-manifest.ts
- src/mcp/{tools,brain-tools,search-tools}.ts - MCP tool table; registry-guard test caps description length at 160 chars; advertised-tool-count contract test

Conventions:
- Deterministic core: no LLM calls inside Brain core; judge-model steps must be external/optional
- Everything additive: existing CLI verbs, MCP tool shapes, search result fields never change shape; new behavior off by default or per-call explicit
- Fail-soft on read paths, fail-fast on mutations; external/secondary writes never break the primary operation
- TDD with bun test (3576 tests), oxlint baseline 111 warnings, oxfmt formatter, tsc strict, no `as` casts to silence types
- Kernel-first: shared kernels per suite so features cannot drift (see recent suites)
- snake_case keys in on-disk JSON/frontmatter and MCP payloads; camelCase in TS

Constraints:
- No new external dependencies unless unavoidable
- No migration of existing JSONL continuity files
- recordId() dedup-hash compatibility must be considered explicitly (Task 1)
- Telemetry stays default-off; raw prompts never persisted
- Benchmark must not write into a user vault; it runs against disposable fixture vaults
- MCP contract: new tools must keep description properties under 160 chars; advertised count test updated deliberately

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
