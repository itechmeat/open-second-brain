# Memory Observability Suite - versioned continuity contract, lazy telemetry, trajectory export, recall benchmark

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The continuity store is the de-facto observability surface of the Brain - recall telemetry, gate decisions, context receipts, session turns all land in `Brain/log/continuity/<month>.jsonl` - but the contract is implicit. Records carry no schema version, the "no consumer means no payload work" property is enforced by convention only, no document says which events exist or which are opt-in, traces are locked in a proprietary shape, and there is no way to measure whether a recall change improved or regressed memory quality.

## Scope

- **Versioned continuity schema** (t_26040ee8): every new record stamped `schema: "o2b.continuity.v1"`; legacy records read as v1; evolution rule documented.
- **Lazy gated emit kernel** (t_5d7aa7c5): one `emitGatedTelemetry` helper with payload-as-thunk, fail-open semantics, no-consumer regression tests across all gated surfaces.
- **Continuity read-model**: one normalization layer (schema-version dispatch, legacy defaults, private/redacted masking policy) consumed by export and bench - never the raw store.
- **ATOF/ATIF trajectory export** (t_51959aeb): mapping write-up first; `o2b brain continuity export --format atof|atif` read-only over the JSONL store; private/redacted honored; golden-file tests.
- **Memory quality benchmark harness** (t_882c396a): `o2b brain bench memory` - ingest fixture vault, index, retrieve, evaluate, report; checkpoint/resume by run ID; quality/latency/context-cost reported separately; deterministic no-network mode for CI; optional external judge command.
- **Observability contract doc** (t_66545537): `docs/observability.md` - event families, correlation IDs, payload safety, fail-open rules, opt-in matrix, schema version + evolution rule.

## Out of scope

- Migration or rewriting of existing JSONL continuity files.
- New telemetry emission paths (export and bench are read-only over the store; bench writes only to its own run directory and disposable fixture vaults).
- Hosted telemetry, dashboards, or public benchmark score claims.
- A judge LLM inside the Brain core - judge evaluation is an external optional command.
- Per-origin score normalization, MCP export tools (export produces files; CLI is the right surface).

## Chosen approach

Consultant Variant 3: split write-emit kernel + read-model layer.

Two narrow layers along the project's fail-fast-write / fail-soft-read seam. The write-side emit kernel lives inside `src/core/brain/continuity/` and owns the schema-version constant (stamped in `buildRecord`) and the lazy gate helper (`emit.ts`): payload thunks run only after the gate passes, and a throwing thunk or write never fails the primary operation. The read-side read-model (`read-model.ts`) normalizes raw JSONL records into one canonical shape - schema-version dispatch with `undefined` read as v1, plus a masking policy for `private`/`redacted` records - and both the ATOF/ATIF exporter and the bench harness consume only that read-model, so they cannot disagree on legacy-record handling or redaction. The bench harness is a separate `src/core/bench/` module driving the public `search`/`packContext` APIs against disposable fixture vaults.

Refinements over the consultant's sketch:

- The read-model is not speculative: the bench harness needs normalized continuity records for its session-handoff fixtures regardless of the ATOF/ATIF go/no-go, so the layer pays off even in the no-go branch.
- The export verb lives in the `o2b brain` namespace (`o2b brain continuity export`) like every other Brain verb, not as a new top-level command.
- The ATOF/ATIF fit assessment ran during phase 0 against the published specs: the mapping is viable (see `docs/brainstorm/memory-observability-suite/atof-atif-mapping.md` summary below) - go.

## ATOF/ATIF fit assessment (go)

Verified against the published specs (NVIDIA NeMo ATOF event format; harbor ATIF RFC 0001 v1.7):

- **ATOF** is JSONL with `scope` (paired start/end, shared `uuid`) and `mark` (point-in-time) events; required fields `kind`, `atof_version`, `uuid`, `timestamp`, `name`; scope events add `category` (closed vocabulary including `retriever`, `custom`) and `attributes`. Mapping: `recall_telemetry` becomes a `retriever` scope pair (start synthesized as `createdAt - duration_ms`, end at `createdAt`); `gate_telemetry`, `context_receipt`, `pre_compact_extract`, and `source_invalidation` become `mark` events with `category_profile.subtype` carrying the O2B kind; `session_turn` becomes a `custom` mark. `parent_uuid` left null - O2B records are flat; correlation rides `session_id` in attributes.
- **ATIF v1.7** is a JSON document with `schema_version`, `agent`, `steps[]`; steps have `step_id`, `source` (`system`/`user`/`agent`), `message`, optional `observation`/`extra`. Mapping: one trajectory per `session_id`; `session_turn` records become steps with `source` mapped from `role` (`user` to `user`, everything else to `agent`); memory-layer events (gate decision, recall, receipt) become `system` steps with `llm_call_count: 0` - the spec's explicit marker for deterministic dispatch - and payload in `extra`. Subagent embedding unused (flat sessions).
- Both formats honor redaction by construction: the exporter consumes the read-model with masking applied, and records flagged `private` are dropped while `redacted` payload text passes through already masked.

## Design decisions

- **One contract-wide version, not per-kind** - `o2b.continuity.v1`, matching the upstream pattern; simplest rule for consumers; per-kind granularity can be added later inside the payload if ever needed.
- **`recordId()` deliberately EXCLUDES the schema field** - identical records must dedupe identically across the version-stamp transition; including it would silently change every dedup ID with no migration. Locked by test.
- **Constant lives in `continuity/types.ts`** (`CONTINUITY_SCHEMA_VERSION`) so both the write kernel and the read-model import one symbol.
- **Evolution rule** (documented in `docs/observability.md`): additive optional fields do not bump the version; renames, removals, or semantic changes bump to `o2b.continuity.v2`; readers must accept unknown newer minor shapes fail-soft.
- **Lazy emit helper shape**: `emitGatedTelemetry(gate, build)` where `gate` is a boolean (already-resolved config) and `build` is a thunk performing the emission and returning the record. Gate off: thunk never invoked, returns `null`. Thunk throws: error swallowed, returns `null` (fail-open). Call sites that need the record id (`packContext` telemetryId enrichment) handle `null` by omitting the field.
- **Fail-open is a deliberate semantic change**: today a throwing `appendContinuityRecord` inside `packContext` would fail the pack; after this suite telemetry can never fail the primary operation. This is exactly what t_5d7aa7c5 demands; asserted by tests on every surface.
- **No-consumer regression tests spy on the thunk and on the continuity directory** - with the gate off, the thunk must never run and `Brain/log/continuity/` must stay absent/untouched. Covered gated surfaces: recall telemetry (context-pack, pre-compress), gate telemetry (MCP recall gate), context receipts (both pack paths).
- **Audit verdict on the non-gated writers**: `session-recall.ts` and `pre-compact-extract.ts` write continuity records as their PRIMARY operation (explicit import/extract commands) - they are always-on by design, keep fail-fast semantics, and do not route through the gated kernel. Session lifecycle capture writes audit rows and Brain log events, not continuity records; a regression test pins that boundary (lifecycle capture with defaults produces zero continuity writes).
- **Read-model masking policy is caller-explicit**: `normalizeContinuityRecords(records, { dropPrivate: true })` - export always drops `private` records; bench keeps them (fixture vaults contain no real private data) but the default is the safe drop.
- **Export is CLI-only, no MCP tool** - it produces files on disk; MCP surface gains nothing and the 65-tool contract stays untouched this release.
- **Bench fixtures are repo-local JSON** under `tests/fixtures/bench/` (checked in, sanitized); each fixture declares notes to materialize into a disposable vault plus questions with expected artifact paths. Categories shipped: single-hop preference recall, temporal update/stale-fact supersession, contradiction, multi-record evidence, session handoff, context budget truncation.
- **Deterministic evaluation is the default**: expected-context mode checks retrieval hits (hit@k, reciprocal rank) and context-pack evidence inclusion within budget - no network, CI-safe. Judge mode is an optional external command (config key `bench_judge_cmd`) receiving JSON on stdin and returning a verdict JSON on stdout; absent config means judge phase is skipped and marked `skipped` in the report.
- **Run store** under `.open-second-brain/bench-runs/<run-id>/` (gitignored): `checkpoint.json` (completed phases + fixture hash), per-question results, `report.json`. Resume validates the fixture hash before skipping phases - a changed fixture invalidates the checkpoint rather than silently mixing runs.
- **MemScore-style triple stays a triple**: `quality` (pass rate + per-category breakdown), `latency_ms` (avg + max), `context_cost` (avg chars + estimated tokens) - never collapsed into one number. `report.json` keys are stable and sorted for diffability.
- **Bench never touches a user vault**: the harness materializes its fixture vault under the run directory and resolves config strictly inside it; a guard refuses to run phases against any path outside the run directory.

## File changes

New:
- `src/core/brain/continuity/emit.ts` - lazy gated emit kernel.
- `src/core/brain/continuity/read-model.ts` - normalized record shape + masking policy.
- `src/core/brain/continuity/export-atof.ts`, `export-atif.ts` - format renderers over the read-model.
- `src/core/bench/` - `types.ts`, `fixture.ts` (load/validate/materialize), `run-store.ts` (checkpoint/resume), `phases.ts` (ingest/index/retrieve/evaluate/report), `judge.ts` (external command bridge), `report.ts` (diffable report).
- `src/cli/brain/verbs/continuity.ts` - `o2b brain continuity export`.
- `src/cli/brain/verbs/bench.ts` - `o2b brain bench memory`.
- `tests/fixtures/bench/*.json` - fixture suite.
- `docs/observability.md` - the contract doc (t_66545537).
- `docs/brainstorm/memory-observability-suite/atof-atif-mapping.md` - full mapping write-up (audit trail).
- Test suites: continuity-schema-version, continuity-emit, continuity-read-model, continuity-export-atof, continuity-export-atif, bench-fixture, bench-run-store, bench-phases, bench-report, CLI verb tests, e2e.

Modified:
- `src/core/brain/continuity/types.ts` (+`schema` field, +constant), `store.ts` (stamp in `buildRecord`, recordId untouched).
- `src/core/brain/recall-telemetry.ts`, `gate-telemetry.ts`, `context-receipts.ts`, `pre-compact-extract.ts`, `session-recall.ts`, `src/core/brain/context-pack.ts`, `pre-compress-pack.ts`, `src/mcp/search-tools.ts` - route gated emissions through the kernel.
- `src/cli/brain/verbs/index.ts`, `src/cli/brain.ts`, `command-manifest.ts`, `help-text.ts` - verb registration.
- `src/core/config.ts` - `resolveBenchJudgeCmd` (+ env override), test env scrub list.
- `.gitignore` - `.open-second-brain/bench-runs/`.
- `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md` (phase 5).

## Risks and open questions

- **Fail-open conversion changes error propagation** at existing call sites; mitigated by explicit tests asserting both the old happy path and the new swallow path.
- **Synthetic ATOF scope start times** (createdAt minus duration) are an interpretation, not a recorded fact; documented in the mapping write-up and marked via an attribute so consumers can tell.
- **Golden-file tests vs spec drift**: specs are external; goldens pin our output shape, and the mapping doc records which spec revisions we matched.
- **Bench latency numbers are environment-sensitive**; the report separates them from quality precisely so CI can assert quality while treating latency as informative.
- **Session lifecycle hot path**: the audit found gating already happens before payload construction at the MCP gate site; lifecycle's audit row is the primary operation (not telemetry) and stays untouched - the no-consumer tests pin the boundary.
