# Memory Observability Suite - implementation plan

## Tasks

### Task 1: Versioned continuity schema (t_26040ee8)
- **Files**: `src/core/brain/continuity/types.ts` (`schema` field on `ContinuityRecord`, `CONTINUITY_SCHEMA_VERSION` constant), `src/core/brain/continuity/store.ts` (stamp in `buildRecord`), `tests/core/brain/continuity-schema-version.test.ts`
- **Acceptance**: new records carry `schema: "o2b.continuity.v1"`; readers accept legacy records without the field; `recordId()` provably excludes the schema field (same id for stamped and unstamped identical input)
- **Depends on**: none

### Task 2: Lazy gated emit kernel + call-site audit (t_5d7aa7c5)
- **Files**: `src/core/brain/continuity/emit.ts` (new), call-site reroutes in `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, `src/mcp/search-tools.ts` (gate telemetry); `tests/core/brain/continuity-emit.test.ts` (helper semantics), no-consumer regression tests per gated surface (extend `tests/core/brain/{context-pack,context-receipts}.test.ts`, `tests/mcp/recall-gate-telemetry.test.ts`), plus a lifecycle boundary test (capture with defaults produces zero continuity writes)
- **Acceptance**: with gate off, payload thunk never invoked and no continuity write happens (asserted per gated surface); a throwing thunk or write never fails the primary operation; gate on keeps existing record shapes byte-identical; `session-recall.ts` / `pre-compact-extract.ts` documented as always-on primary writes and left fail-fast
- **Depends on**: Task 1

### Task 3: Continuity read-model
- **Files**: `src/core/brain/continuity/read-model.ts` (new), `tests/core/brain/continuity-read-model.test.ts`
- **Acceptance**: raw JSONL lines (stamped, legacy, malformed) normalize into one canonical shape; legacy records report schema v1; masking policy drops `private` records by default and masks per option; unknown kinds pass through fail-soft
- **Depends on**: Task 1

### Task 4: ATOF/ATIF mapping write-up + export verb (t_51959aeb)
- **Files**: `docs/brainstorm/memory-observability-suite/atof-atif-mapping.md` (mapping, spec revisions, go decision), `src/core/brain/continuity/export-atof.ts`, `src/core/brain/continuity/export-atif.ts`, `src/cli/brain/verbs/continuity.ts`, verb registration (`verbs/index.ts`, `brain.ts`, `command-manifest.ts`, `help-text.ts`), `tests/core/brain/continuity-export-atof.test.ts`, `continuity-export-atif.test.ts`, `tests/cli/continuity-export.test.ts` (golden files with sanitized fixtures)
- **Acceptance**: `o2b brain continuity export --format atof|atif [--session <id>] [--month <m>] --out <dir>` produces spec-conformant files; `private` records dropped, `redacted` text stays masked; golden-file tests pass; read-only over the store
- **Depends on**: Task 3

### Task 5: Bench harness core (t_882c396a, part 1)
- **Files**: `src/core/bench/types.ts`, `src/core/bench/fixture.ts`, `src/core/bench/run-store.ts`, `src/core/bench/phases.ts`, `src/core/bench/report.ts`, `src/core/bench/judge.ts`, `tests/core/bench/{fixture,run-store,phases,report}.test.ts`
- **Acceptance**: fixture JSON validates and materializes a disposable vault inside the run directory; phases ingest/index/retrieve/evaluate/report run end-to-end deterministically with no network; checkpoint/resume by run ID skips completed phases and invalidates on fixture-hash change; report keeps quality/latency/context-cost separate with stable sorted keys; guard refuses paths outside the run dir
- **Depends on**: Task 3 (session-handoff fixture reads normalized continuity records)

### Task 6: Bench CLI verb + fixture suite (t_882c396a, part 2)
- **Files**: `src/cli/brain/verbs/bench.ts`, verb registration, `tests/fixtures/bench/*.json` (6 categories), `src/core/config.ts` (`resolveBenchJudgeCmd` + env override), `tests/helpers/run-cli.ts` (env scrub), `.gitignore`, `tests/cli/bench.test.ts`
- **Acceptance**: `o2b brain bench memory --fixture <name> [--resume <run-id>] [--json]` runs the full pipeline on every shipped fixture; at least one fixture catches stale/superseded recall regressions; at least one measures expected evidence within context budget; judge phase skipped cleanly when `bench_judge_cmd` unset
- **Depends on**: Task 5

### Task 7: e2e integration test
- **Files**: `tests/e2e/memory-observability.integration.test.ts`
- **Acceptance**: one flow exercises schema-stamped emission with gates on, export of the produced records to both formats, and a bench run over a small fixture - all green in one test file
- **Depends on**: Tasks 2, 4, 6

### Task 8: Observability contract doc (t_66545537)
- **Files**: `docs/observability.md`, cross-links from `docs/how-it-works.md` and `docs/mcp.md`
- **Acceptance**: every emitted event kind enumerated and verified against source (log events, continuity kinds, session lifecycle); opt-in vs always-on correct per kind; correlation IDs, payload safety, fail-open rules, schema version + evolution rule documented; repo writing prefs honored
- **Depends on**: Tasks 1, 2 (documents their behavior)
