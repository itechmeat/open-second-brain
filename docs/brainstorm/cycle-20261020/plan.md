# Cycle 20261020 - implementation plan (substrate + five parallel lanes + integrator)

Implementation follows consultant Variant 1: Task 0 (substrate) lands first, serial, on one lane; then five lanes run in parallel on provably disjoint file sets; a final integrator task consolidates docs, dedups the manifest and runs the full QA gates. Every feature below carries its kanban card id.

## Lane structure

| Lane | Card(s) | One-line scope |
|------|---------|----------------|
| Substrate (Task 0) | parts of `t_642bc2b8`, `t_a567cc12`, `t_50c81d5c` | Config quartet, env helper, ledger path constants and state-surface row, descriptor with byte-identical `SEARCH_INPUT_SCHEMA` |
| A - cross-topic | `t_642bc2b8` | Cross-topic rule promotion in the dream pass |
| B - context-window | `t_a567cc12` | Model-window resolver and its consumers |
| C - judge-eval | `t_4e1681b3` | Preregistered eval, grade cache and tuning mark |
| D - freshness + wikilink | `t_e4438152`, `t_fd842db0` | Measured index-behind count and scope-honest wikilink disambiguation |
| E - bench + schema artifact | `t_d7ce8baf`, `t_50c81d5c` | Bench-run integrity guards; descriptor consumption, committed artifact, export/check verbs |
| I - integrator | all | Consolidated docs, manifest dedup, CHANGELOG, full QA gates |

Lanes start only after Task 0 lands. Inside a lane, tasks are serial.

## Cross-lane contract

- **Commits**: every lane commits with explicit paths only, `git commit --only <paths>` (stage nothing else). Never `git add -A` and never a bare `git commit -am`.
- **Waiting on the substrate**: a lane that needs a substrate file (any Task 0 file) polls `git log --oneline -1 -- <file>` every 30 seconds with a 12-minute cap. If the substrate commit has not appeared when the cap is reached, the lane stops and reports instead of building workarounds.
- **Formatting and linting**: lanes run `bun run fmt` and `bun run lint` scope-restricted to their own files only (oxfmt/oxlint accept explicit paths). If the formatter wants to touch a file outside the lane's set, that is pre-existing drift - surface it, do not fold it in.
- **Exclusive ownership**: a lane never edits a file in another lane's set. Where recons overlap, the resolution below is binding.
- **Tests**: a lane runs the full suite before its final commit but is only responsible for greenness of tests its own files affect; cross-suite breakage is surfaced to the orchestrator, not patched over.

## Resolved file-ownership conflicts

1. `src/cli/command-manifest.ts` - Lane C (judge-eval) is the owning lane during the lane phase (its recon names the file; the decision-model entry gains the eval verbs). Lane E's `o2b search schema` verb, if the manifest enumerates search verbs, gets its row in Task I after Lane C has landed.
2. `docs/cli-reference.md` - touched by three features (freshness rows at `:2247` and `:2084-2088`, bench refusal contract near `:578-583`, schema export/check section in the Search region near `:1977-2004`). No lane touches it; Task I owns it.
3. `docs/mcp.md` - touched by freshness (`retrieval_trail` detail at `:1991-2000`) and the schema artifact (artifact line near `:461-474`). Task I owns it.
4. `CHANGELOG.md` - demanded by the freshness and wikilink recons (both list it in their files to touch) and by the cross-topic recon's CLAUDE.md versioning-discipline note. Task I writes one consolidated Unreleased section covering those three features; the other recons name no CHANGELOG obligation, and the version bump stays with the pr-prepare phase.
5. `src/core/state/surfaces.ts` - Task 0 only (the `crossTopicLedger` row). Lane C's tuning mark is machine-side state outside the vault and is deliberately not registered as a vault state surface, so Lane C does not touch this file.
6. `src/mcp/search-tools.ts` - Task 0 only (the byte-identical `SEARCH_INPUT_SCHEMA` derivation). Lane E consumes the descriptor but never edits the served schema.
7. `src/core/bench/phases.ts` - appears in the context-window recon only as an optional second-wave adoption, which is out of scope this cycle; Lane E owns the file exclusively.
8. `src/core/config.ts`, `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `src/core/brain/policy/validate.ts`, `src/core/brain/config-template.ts`, `src/core/brain/paths.ts`, `src/core/brain/path-constants.ts` - Task 0 only; lanes consume what it exports.

## Lane-exclusive file sets

- **Task 0**: `src/core/brain/types.ts`, `src/core/brain/policy/blocks/context.ts`, `src/core/brain/policy.ts`, `src/core/brain/policy/validate.ts`, `src/core/brain/config-template.ts`, `tests/core/brain/config-template-ratchet.test.ts`, `tests/core/brain/policy/context-block.test.ts`, `src/core/config.ts`, `src/core/brain/paths.ts`, `src/core/brain/path-constants.ts`, `src/core/state/surfaces.ts`, `tests/core/state/surfaces.test.ts`, `src/core/search/search-options-descriptor.ts`, `src/mcp/search-tools.ts`, `tests/core/search/search-query-schema-artifact.test.ts`.
- **Lane A**: `src/core/brain/dream-plan-cross-topic.ts`, `src/core/brain/dream-plan.ts`, `src/core/brain/dream.ts`, `src/core/brain/dream-apply.ts`, `src/core/brain/dream-summary.ts`, `src/core/brain/dream-types.ts`, `src/core/brain/dream-report.ts`, `tests/core/brain/dream-cross-topic.test.ts`, and, if they pin the changed-summary shape additively, `tests/core/brain/dream-checkpoints.test.ts`, `tests/core/brain/dream-phase-refusal.test.ts`, `tests/core/brain/trust/operator-summary.test.ts`.
- **Lane B**: `src/core/brain/model-window.ts`, `src/core/brain/context-presets.ts`, `src/mcp/brain/pack-tools.ts`, `src/cli/brain/verbs/context-pack.ts`, `src/cli/brain/verbs/context-presets.ts`, `src/cli/brain/help-text.ts`, `src/core/brain/anticipatory-cache.ts`, `tests/core/brain/model-window.test.ts`, `tests/core/brain/context-presets.test.ts`, `tests/mcp/context-presets-tool.test.ts`, `tests/cli/brain-context-presets.test.ts`, `tests/mcp/context-pack-tool.test.ts`, `tests/cli/brain-context-pack.test.ts`, plus anticipatory-cache suites only if the default derivation lands there.
- **Lane C**: `src/core/decision-model/questions.ts`, `src/core/decision-model/eval-spec.ts` (if split out), `src/core/decision-model/eval/`, `src/core/decision-model/record.ts`, `src/core/decision-model/config.ts`, `src/core/decision-model/diagnostics.ts`, `src/cli/decision-model.ts`, `src/core/platform-dirs.ts`, `src/cli/command-manifest.ts`, `src/core/doctor-readiness.ts`, `src/core/install/ownership.ts`, `docs/decision-models/`, `tests/fixtures/decision-model/`, new tests under `tests/core/decision-model/`.
- **Lane D**: `src/core/search/indexer.ts`, `src/core/search/pipeline/outcome.ts`, `src/core/search/search.ts`, `src/core/search/freshen.ts`, `src/core/search/index.ts`, `src/cli/search/verbs/status.ts`, `src/core/brain/link-graph/bridge-discovery.ts`, `tests/core/search/behind-count.test.ts`, `tests/core/search/freshen-search.test.ts`, `tests/core/search/relational-path.test.ts`, `tests/cli/search-status-freshen.test.ts`, `tests/core/brain/bridge-discovery.test.ts`.
- **Lane E**: `src/core/bench/guards.ts`, `src/core/bench/phases.ts`, `src/core/bench/run-store.ts`, `src/cli/brain/verbs/bench.ts`, `src/cli/search/verbs/query.ts`, `src/cli/search/verbs/schema-export.ts`, `src/cli/search.ts`, `schemas/brain/search-query.schema.json`, `tests/core/bench/guards.test.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/run-store.test.ts`, `tests/helpers/json-schema-subset.ts`, `tests/core/brain/published-schema-contracts.test.ts`, `tests/docs/search-query-doc-examples.test.ts`, `package.json` (optional scripts only).
- **Task I**: `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `src/cli/command-manifest.ts` (schema verb row only, after Lane C lands).

The lane sets are pairwise disjoint; every intersection above is resolved to a single owner or deferred to Task I.

## Tasks

### Task 0a: config quartet and env helper (substrate, commit 1)
- **Files**: `src/core/brain/types.ts` (`cross_topic` block on `BrainDreamConfig` near `:1450`; new `context` window block near `:2030`), `src/core/brain/policy/blocks/context.ts` (new block parser), `src/core/brain/policy.ts` (`cross_topic` parse plus block re-exports), `src/core/brain/policy/validate.ts` (register both blocks; `brainConfigKnownKeys()` follows), `src/core/brain/config-template.ts` (commented-default entries for both), `tests/core/brain/config-template-ratchet.test.ts`, `tests/core/brain/policy/context-block.test.ts` (new), `src/core/config.ts` (`OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW` parse helper beside the recall-adequacy trio, config-over-env per the resolver precedence).
- **Acceptance**: `tests/core/brain/policy/context-block.test.ts` pins block acceptance and rejection (garbage raises, out-of-range numeric accepted and passed through unclamped) on the `recall-inject-block` pattern; `tests/core/brain/config-template-ratchet.test.ts` passes with both new keys present in the generated template; absent blocks leave default behavior byte-identical.
- **Depends on**: none. Lands first.

### Task 0b: cross-topic ledger identity and state surface (substrate, commit 2)
- **Files**: `src/core/brain/paths.ts` (`crossTopicLedgerPath`), `src/core/brain/path-constants.ts` (`BRAIN_CROSS_TOPIC_LEDGER_FILE`), `src/core/state/surfaces.ts` (`STATE_SURFACE_ID.crossTopicLedger` + row, following the rollup ledger row), `tests/core/state/surfaces.test.ts` (the new row).
- **Acceptance**: `tests/core/state/surfaces.test.ts` passes with the `Brain/cross-topic-rules.json` surface registered; the state-surface architecture census stays green with no unbound new row.
- **Depends on**: none (parallel with 0a is acceptable; both precede 0c only in review order).

### Task 0c: search-options descriptor with byte-identical derivation (substrate, commit 3)
- **Files**: `src/core/search/search-options-descriptor.ts` (new; typed field table - canonical snake_case name, schema fragment with enums imported from `FTS_MATCH_MODES`/`DISCLOSURE_MODES`/`RECALL_PROFILE_NAMES`/`SEARCH_KINDS`, CLI flag spelling and kind, surface visibility, default; compile-time `satisfies` parity against `SearchOptions`), `src/mcp/search-tools.ts` (`SEARCH_INPUT_SCHEMA` becomes a one-line derivation filtering mcp-visible rows, same exported constant), `tests/core/search/search-query-schema-artifact.test.ts` (new; the derived schema deep-equals the previously literal object).
- **Acceptance**: the equality test proves the derived `SEARCH_INPUT_SCHEMA` is byte-identical to the pre-change literal, so `tools/list` and the vendored Hermes projection are untouched; the parity assertion and a reverse-direction test show no mcp/cli row missing from the derivation. Existing `tests/mcp` suites that read `tool.inputSchema` stay green unchanged.
- **Depends on**: none. All three substrate commits land before any lane starts.

### Task A1: cross-topic planner and ledger (Lane A, card `t_642bc2b8`)
- **Files**: `src/core/brain/dream-plan-cross-topic.ts` (new; pure planner - cross-bucket jaccard detection over confirmed prefs using `tokenise`/`jaccard`, deterministic ordering, content-derived `cross-<sha256-12>` slug, budget read against `Brain/cross-topic-rules.json` - plus ledger helpers on `atomicWriteFileSync`), `src/core/brain/dream-plan.ts` (`CrossTopicRulePlan` entry, `PlanState.crossTopicRules`, `emptyPlan()` init), `tests/core/brain/dream-cross-topic.test.ts` (new).
- **Acceptance**: `tests/core/brain/dream-cross-topic.test.ts` proves: cross-bucket detection fires at the configured `min_topics`/`jaccard`; same-bucket clusters never fire; config gating (absent block = off, byte-identical); content-slug dedup (same source set maps to one file, already-present or retired slug skips); one promotion per owner token per calendar day with the date from the injected `now`; a budgeted-out pass plans nothing. Modeled on `tests/core/brain/rollup-ladder.test.ts`.
- **Depends on**: Task 0a (config block), Task 0b (ledger path and surface).

### Task A2: dream pass wiring, apply, summary and report (Lane A)
- **Files**: `src/core/brain/dream.ts` (planner call after `planRefresh`, before the `hasStateChange` gate; `hasStateChange` includes the plan; thread into apply/report/summary inputs), `src/core/brain/dream-apply.ts` (write loop in `writePreferences` via `writePreferenceTxn`, `provenance: "inferred"`, `overwrite: false`), `src/core/brain/dream-summary.ts` (both summary shapes plus the synthesize phase metric), `src/core/brain/dream-types.ts` (additive `DreamRunSummary` field), `src/core/brain/dream-report.ts` (dream event body field; ledger write beside `writeRollupLedger`, only when fired), `tests/core/brain/dream-checkpoints.test.ts` / `tests/core/brain/dream-phase-refusal.test.ts` / `tests/core/brain/trust/operator-summary.test.ts` (only if they pin the changed shapes), plus an end-to-end dream run in `tests/core/brain/dream-cross-topic.test.ts` on the `dream-destructive-gate` pattern.
- **Acceptance**: the end-to-end test shows a fired promotion produces a written unconfirmed preference with `evidenced_by` wikilinks and a `related` lineage, counts as a state change, budgets per owner per day, and leaves a below-threshold pass byte-identical (no-op summary, no log write); sources are never modified or retired; the state-surface and write-site censuses stay green because the ledger routes through the shared atomic writer.
- **Depends on**: Task A1.

### Task B1: model-window resolver (Lane B, card `t_a567cc12`)
- **Files**: `src/core/brain/model-window.ts` (new; exact-id table with provenance notes, named constants `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000` / `MIN = 100_000` / `MAX = 1_000_000`, `declaredModelContextWindowTokens`, `structuralModelContextWindowTokens` (trailing delimited `1m` suffix only), `resolveModelContextWindowTokens` returning `{ windowTokens, source, clamped }`; pure - no fs, no env reads, parsed values in), `tests/core/brain/model-window.test.ts` (new).
- **Acceptance**: `tests/core/brain/model-window.test.ts` pins table exactness, suffix positives and near-misses (`-1m` inside a larger token does not match), clamping in both directions with `clamped: true`, precedence config > env > table > suffix > default, and the unknown-model 200_000 default; no family substring ever resolves.
- **Depends on**: Task 0a (for the operator `context.window_tokens` key and the env helper's parsed value shape; the resolver itself consumes parsed numbers).

### Task B2: preset suggestion resolution (Lane B)
- **Files**: `src/core/brain/context-presets.ts` (`suggestContextPreset` resolves the window through the model-window resolver when no explicit window is given; `reason` carries the source; hint match and explicit window keep today's exact answers), `src/mcp/brain/pack-tools.ts` (suggest operation, `:896-908`), `src/cli/brain/verbs/context-presets.ts` (suggest path resolves from `--model` alone), `src/cli/brain/help-text.ts` (usage strings at `:1085`), `tests/core/brain/context-presets.test.ts` (existing cases stay green byte-identically; add model-only cases such as `gemini-2.5-pro-1m`), `tests/mcp/context-presets-tool.test.ts`, `tests/cli/brain-context-presets.test.ts` (`--model`-only case).
- **Acceptance**: all existing `context-presets` pins pass unchanged; a model-only call resolves a window (suffix or table or default) and the reason discloses the source; a preset hint match never masquerades as a resolved window in the same call.
- **Depends on**: Task B1.

### Task B3: context pack and pre-compress defaults (Lane B)
- **Files**: `src/mcp/brain/pack-tools.ts` (`brain_context_pack`: `max_tokens` optional, `model` added, schema `required` relaxed at `:1214`; `brain_pre_compress_pack`: optional `model` plus resolver-derived default caps; schema blocks updated), `src/cli/brain/verbs/context-pack.ts` (`--max-tokens` optional, `--model` added), `tests/mcp/context-pack-tool.test.ts`, `tests/cli/brain-context-pack.test.ts`.
- **Acceptance**: explicit `max_tokens` behaves exactly as before; omission with a resolvable model derives the preset budget for the resolved window; omission with nothing resolvable refuses exactly as today (the pinned decision - never a silent default budget); the pre-compress unbounded-addendum case closes with resolver-derived caps. The vendored Hermes schemas stay untouched because `brain_search` is not part of this change.
- **Depends on**: Task B1 (and Touches `pack-tools.ts` jointly with B2 inside Lane B, so serial within the lane).

### Task B4: anticipatory-cache window default (Lane B, conditional)
- **Files**: `src/core/brain/anticipatory-cache.ts` (window-fraction default only when an operator setting, env value or model id resolves; `DEFAULT_ANTICIPATORY_MAX_TOKENS = 2_000` stays the nothing-resolved fallback), relevant anticipatory-cache suites.
- **Acceptance**: with nothing resolvable every existing anticipatory pin passes unchanged (2_000); with a resolved window the derived budget appears and is disclosed; no persisted stamp changes in the default-vault case.
- **Depends on**: Task B1. If the derivation cannot be kept strictly additive for the pinned suites, this task is dropped and the fallback constant stands - report rather than force it.

### Task C1: preregistered spec and seeded take (Lane C, card `t_4e1681b3`)
- **Files**: `src/core/decision-model/questions.ts` (per-use spec constants: fixture reference, seed, split rule, frozen membership receipt, metric, ceiling, min n, pinned threshold values; canonical spec-hash helper; optionally `src/core/decision-model/eval-spec.ts` if split out), `src/core/decision-model/eval/take.ts` (new; hash-order split `sha256Hex(seed + ":" + id)`, dev = first `ceil(0.3 n)`, membership frozen at preregistration, runner verification against the receipt), `tests/fixtures/decision-model/` (committed take fixtures per use, gold labels in the closed expectation vocabulary), new spec-integrity and split tests.
- **Acceptance**: spec hash is stable; a spec missing any required element is a construction error; the split is deterministic, reorder-stable, dev/counted disjoint, and the receipt matches derivation; spec and fixtures land in one reviewable commit before the runner exists.
- **Depends on**: none (Lane C is self-contained until C3).

### Task C2: grader and grade records (Lane C)
- **Files**: `src/core/decision-model/eval/grade.ts` (new; runner in the `runRerankEvalGate` mold - materialize fixture vault, `runDecision` per item with `recordOrigin: "eval"`, deterministic scorer canonical, judge advisory, spend counted toward the daily cost gate), `src/core/decision-model/record.ts` (`DECISION_MODEL_EVAL_GRADE_KIND` + `listDecisionModelEvalGrades`), new grading tests.
- **Acceptance**: grading against `tests/helpers/fake-decision-provider.ts` caches `decision_model_eval_grade` records carrying the spec hash, profile, use, seed, item ids, boolean verdicts, metric and counted n; records carry `origin: "eval"` and stay out of rerank shadow agreement (`diagnostics.ts:453` invariant); malformed records are skipped with a named note.
- **Depends on**: Task C1.

### Task C3: tuning mark and measured gate (Lane C)
- **Files**: `src/core/decision-model/eval/mark.ts` (new; write/read/validate the machine-side mark, TTL cache), `src/core/platform-dirs.ts` (state-root helper - the module's first production caller), `src/core/decision-model/questions.ts` + `src/core/decision-model/config.ts` (`thresholdsTunedFor`/`holdToProfile` accept an injected optional mark reader, default none; `resolveDecisionModelConfig` threads it), `src/core/install/ownership.ts` (machine-side state enumeration), new gate tests.
- **Acceptance**: with a valid mark a previously shadow-only use runs `enforce`; a stale or foreign spec hash, changed fixture hash, or changed threshold values keep it in shadow; with no mark file everything behaves exactly as today; the mark is written only when counted error meets the ceiling, no-regression holds and n is met (three-arm verdict per `extract-prefilter.ts:180-185`); `tests/core/decision-model/profiles-all-uses.test.ts` and `presets-profiles.test.ts` pass unchanged; the uncalibrated-provider refusal is untouched.
- **Depends on**: Task C2.

### Task C4: eval surfaces and manifest (Lane C)
- **Files**: `src/core/decision-model/diagnostics.ts` (`check` names the measured state and lists cached grades; report gains the eval section), `src/cli/decision-model.ts` (`eval run` / `eval list` verbs, USAGE string, dispatcher), `src/cli/command-manifest.ts` (decision-model entry - Lane C owns this file), `src/core/doctor-readiness.ts` (readiness probe reflects measured/untuned state), `docs/decision-models/providers.md` and siblings (the measured path narrative), listing tests.
- **Acceptance**: `eval list` round-trips records, renders prose and `--json`, rejects malformed records by skipping with a named note; `check` prints untuned / measured under spec hash X / baseline; the manifest lists the new verbs; the doctor probe reflects the measured state.
- **Depends on**: Tasks C1-C3.

### Task D1: indexBehindCount (Lane D, card `t_e4438152`)
- **Files**: `src/core/search/indexer.ts` (new `indexBehindCount(config): Promise<IndexBehind | null>` in the read-side diagnostics section; stat-only `walkVault` diffed against `Store.listDocuments()` from a read-mode open; exact fastpath comparison; `null` on any failure), `src/core/search/index.ts` (re-export beside `indexStatus`), `tests/core/search/behind-count.test.ts` (new).
- **Acceptance**: `tests/core/search/behind-count.test.ts` classifies on a temp vault: added file, edited file (explicit `utimesSync` mtime bump), touch-only file (counts as changed - upper-bound semantics documented), deleted file, ignored path not counted, admission-lane path not counted, missing index returns `null`.
- **Depends on**: none.

### Task D2: degradation flow-through (Lane D)
- **Files**: `src/core/search/pipeline/outcome.ts` (`withIndexStale` accepts the behind count; detail becomes `{ ageSeconds, behindCount }`), `src/core/search/search.ts` (compute under the `indexAge > INDEX_STALE_SECONDS` gate, once per `search()` above the cache branch; hand to `served`), `tests/core/search/freshen-search.test.ts` (or a sibling gate test), `tests/core/search/relational-path.test.ts` (update the `index-stale` detail literal where the test actually crosses the walk gate).
- **Acceptance**: a stale index reports `detail.behindCount` matching the seeded delta; a fresh index emits no code and performs no walk; a `null` measurement still emits `ageSeconds` alone; the MCP contract needs no schema change (open detail object) and no new degradation code appears.
- **Depends on**: Task D1.

### Task D3: status freshen block (Lane D)
- **Files**: `src/core/search/freshen.ts` (`FreshenStatus` + `renderFreshenStatus` + `serializeFreshenStatus` extended; the measured value is a passed-in argument so `freshenStatus` stays a pure state-file reader), `src/cli/search/verbs/status.ts` (compute via `indexBehindCount` when `status.exists`; thread into the freshen block), `tests/cli/search-status-freshen.test.ts` (human line and `--json` keys, column alignment).
- **Acceptance**: status prints `index_behind:` with the live count (or `(not measured)` on `null`) and serializes `index_behind` (plus optional `index_behind_by_root`); the doctor's `freshenFailureCheck` is untouched and picks up no walk cost; label alignment assertions stay green.
- **Depends on**: Task D1.

### Task D4: wikilink census scope filter (Lane D, card `t_fd842db0`)
- **Files**: `src/core/brain/link-graph/bridge-discovery.ts` (`countBasenameMatches` resolves `resolveVaultScope(vault).rules` once above the loop and skips pages whose vault-relative POSIX path (`toPosix(relative(vault, page.path))`) fails `matchScope`; docblock names the vault-scope rule beside the entity status rule and the target-itself-out-of-scope edge; no new exports), `tests/core/brain/bridge-discovery.test.ts` (new cases beside the existing ambiguity pin at `:189-201`).
- **Acceptance**: new tests: twin under an operator-ignored dir yields the basename form; twin under a default-ignored dir absent from `DEFAULT_SKIP_DIRS` (`node_modules/`, `Brain/.snapshots/`, `.open-second-brain/`) yields the basename form - the case that fails today; twin outside an `include_paths` allowlist root yields the basename form; the existing in-scope-twin case passes unchanged byte-identically; `bun run link-ratchet:check` passes; visibility-surface census stays green (no new exports).
- **Depends on**: none (independent of D1-D3; serial within Lane D).

### Task E1: bench guards module (Lane E, card `t_d7ce8baf`)
- **Files**: `src/core/bench/guards.ts` (new; frozen `BENCH_REFUSAL` table + closed `BenchRefusalKind` union covering P1-P7 and T1-T7, `BenchRefusalError` with kind and detail, `preflightBenchRun`, `validateBenchTrace`), `tests/core/bench/guards.test.ts` (new).
- **Acceptance**: `tests/core/bench/guards.test.ts` covers one case per refusal kind on hand-built fixtures: unwritable runs dir, fresh-run collision (prior checkpoint survives and `--resume` is suggested), corrupt checkpoint JSON names the file, unknown and out-of-order `completed_phases`, ingest-done-with-vault-deleted, retrieve-done-with-results-deleted, fixture cross-reference defects naming the question id, and per-family trace cases (missing result, truncated JSON, id mismatch, absent category field refused while present-but-empty passes, extra result file, counts mismatch via the shared counting helper).
- **Depends on**: none.

### Task E2: bench pipeline wiring (Lane E)
- **Files**: `src/core/bench/phases.ts` (move config resolution and the capability gate above run creation; call preflight before `createBenchRun`/`loadBenchRun`; call `validateBenchTrace` between the evaluate re-read and the judge/report/write block; atomic temp+rename writes for results and `report.json`; extract the shared category-counting helper from `buildReport`), `src/core/bench/run-store.ts` (`parseCheckpoint` refuses unknown phase names; expose `readBenchCheckpoint`; atomic `persist`), `src/cli/brain/verbs/bench.ts` (catch `BenchRefusalError`, render `refused (<kind>): <detail>` naming the repair, exit non-zero), `tests/core/bench/phases.test.ts`, `tests/core/bench/run-store.test.ts`.
- **Acceptance**: env-garbage provider and capability-gate refusals leave no run dir behind; a tampered run dir is refused by name before scoring; a passing small fixture produces a report byte-identical to the pre-guard shape; `benchRunIdentityHash` and `fixtureHash` frozen-hash values are unchanged; every existing bench test passes; guards add zero stdout on success.
- **Depends on**: Task E1.

### Task E3: CLI flag derivation from the descriptor (Lane E, card `t_50c81d5c`)
- **Files**: `src/cli/search/verbs/query.ts` (`parseFlags` derived from the descriptor's cli-visible rows, snake_case to kebab-case mechanically; verb-local flags `json`/`verbose`/`auto-refresh` stay local; per-surface bounds preserved - CLI keeps `SEARCH_LIMIT_MAX`, uncapped query, and the documented `semantic` tri-state asymmetry), new parity tests for the flag table.
- **Acceptance**: the derived flag table accepts exactly the flags the literal table accepted today (existing `o2b search` CLI tests pass unchanged); a reverse-direction test shows every cli row is represented and every non-internal row key exists on `SearchOptions` (with the substrate's compile-time assertion covering the forward direction).
- **Depends on**: Task 0c (waits on the descriptor by the cross-lane contract).

### Task E4: committed artifact and export/check verbs (Lane E)
- **Files**: `schemas/brain/search-query.schema.json` (new; `$schema` draft 2020-12, `$id: brain.search_query.v1`; sibling `brain.search_query_document.v1` block as `$defs` or a second file describing the structured query-document grammar), `src/cli/search/verbs/schema-export.ts` (new; `export` writes the file or `--stdout`), `src/cli/search.ts` (`schema` in `KNOWN_VERBS`, case, import), `tests/core/brain/published-schema-contracts.test.ts` (`SCHEMA_IDS` gains the file; generator check deep-compares descriptor output with the file on disk), `tests/helpers/json-schema-subset.ts` (add `minLength`/`maxLength` and `additionalProperties`-as-schema; unsupported keyword still throws).
- **Acceptance**: the published-schema file-set pin passes only with the `SCHEMA_IDS` entry (the tripwire fires in the same change); the descriptor-vs-file generator check passes; `o2b search schema check` exits 2 on injected drift and 0 on a clean tree; the subset validator rejects an unsupported keyword with an error, never a silent pass.
- **Depends on**: Task E3.

### Task E5: doc-example tests (Lane E)
- **Files**: `tests/docs/search-query-doc-examples.test.ts` (new; on the `retrieval-trail-doc` pattern), `package.json` (optional `search-schema` / `search-schema:check` scripts).
- **Acceptance**: the documented structured-query example under "Structured recall query documents" parses and validates against the committed artifact; every intent token in the documented grammar sentence appears in the artifact's enum; every `--flag` in the scoped `o2b search "<query>"` block of `docs/cli-reference.md` is derivable from the descriptor's cli rows; every backticked `brain_search` argument in `docs/mcp.md` is a property of the artifact; extraction stays scoped to the Search sections and never reads `docs/plans/**` or `docs/brainstorm/**`.
- **Depends on**: Task E4.

### Task I: integrator - consolidated docs, manifest dedup, full QA (serial, after all lanes)
- **Files**: `docs/cli-reference.md` (freshness: `index-stale` row gains `detail.behindCount` at `:2247`, status freshen block and JSON field list at `:2084-2088`; bench: the `brain bench memory` refusal contract near `:578-583`; schema: `o2b search schema export|check` in the Search section near `:1977-2004`), `docs/mcp.md` (`retrieval_trail` paragraph names `behindCount` at `:1991-2000`; artifact line with its `$id` near the `brain_search` paragraph `:461-474`), `CHANGELOG.md` (one consolidated Unreleased section covering `t_e4438152`, `t_fd842db0` and `t_642bc2b8` - the features whose recons demand an entry; no version bump here, pr-prepare owns that), `src/cli/command-manifest.ts` (the `o2b search schema` row, only if the manifest enumerates search verbs, after Lane C has landed).
- **Acceptance**: the doc-example tests from Task E5 stay green after the doc edits (their extraction is scoped to Search sections, so the freshness and bench edits cannot break them); the docs-drift-sensitive suites (`tests/docs/retrieval-trail-doc.test.ts`) stay green; then the full local QA gates in CI order pass: `bun run typecheck`, `bun run lint`, `bun run fmt:check` on the branch, and the full `bun run test` suite.
- **Depends on**: all lanes (A1-A2, B1-B4, C1-C4, D1-D4, E1-E5).

## Suggested commit boundaries

- Substrate: three commits (0a config quartet + env helper, 0b ledger identity + surface, 0c descriptor + derivation), each `feat(substrate): ...` or the lane's conventional scope, committed with explicit paths only.
- Lanes: one commit per task (`feat(dream): ...`, `feat(context): ...`, `feat(decision-model): ...`, `feat(search): ...` / `feat(links): ...`, `feat(bench): ...` / `feat(search): ...`).
- Integrator: one `docs(cycle): ...` commit plus any manifest fixup; the brainstorm commit itself predates all of these.
