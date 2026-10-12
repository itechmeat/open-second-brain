# Recall quality wave 2 - implementation plan

Executed by the implement node with PARALLEL IMPLEMENTATION LANES. Lane D lands its two contract commits first; lanes A, B, C and the rest of D then run concurrently over disjoint files; the integrator finishes. Every task is atomic and commit-sized. No new MCP tools anywhere: the tool census is pinned at 115 (`tests/core/install/tool-ceiling.test.ts:348`), and every new recall surface rides an existing tool's operations, an existing CLI verb, or the bench suite registry. Every opt-in surface is default off with a byte-identical-off regression proof; failures are typed explicit errors, never silent fallbacks.

## Cross-lane contract

### (a) File ownership - every file has exactly one owner; overlap forbidden

- **Lane A** (iterative recall loop): `src/core/search/pipeline/iterative-recall.ts` (new), `src/core/search/decider-step.ts` (new), `src/core/search/coverage.ts`, `src/core/search/pipeline/second-pass.ts`, `src/core/search/search.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`, `src/core/search/pipeline/outcome.ts`, `src/core/search/pipeline/attribution.ts`, `src/core/search/pipeline/cache-slot.ts`, `src/core/brain/retrieval-plan.ts`, and the A-lane tests listed per task.
- **Lane B** (coverage-first session recall): `src/core/brain/session-recall.ts`, `src/core/brain/thread-topics.ts` (new), `src/mcp/brain/recall-tools.ts`, `src/cli/brain/verbs/session-recall.ts`, `src/core/brain/entities/registry.ts` (read-side resolution only), and the B-lane tests listed per task. `src/core/brain/recall-budget.ts` is FROZEN: wrap `applyCharBudget` at the call site, never edit it.
- **Lane C** (graded surfacing + replay harness): `src/core/search/surfacing-key.ts` (new), `src/core/search/surfacing-gate.ts`, `src/core/brain/recall-inject.ts`, `src/core/brain/gate-telemetry.ts`, `src/core/bench/replay-fixture.ts` (new), `src/core/bench/replay.ts` (new), `src/core/bench/failure-modes.ts`, and the C-lane tests listed per task. Lane C additionally owns `src/mcp/search-tools.ts` as a file.
- **Lane D** (LongMemEval bench suite): `src/cli/brain/verbs/bench.ts`, `src/core/bench/types.ts`, `src/core/bench/phases.ts`, `src/core/bench/run-store.ts`, `src/core/bench/judge.ts`, `src/core/bench/longmemeval.ts` (new), `tests/fixtures/bench/longmemeval-sample.json` (new), and the D-lane tests listed per task. `src/core/bench/locomo.ts`, `tests/core/bench/locomo.test.ts` and `tests/core/bench/fixture.test.ts` are FROZEN for the wave and must stay green untouched.
- **Integrator**: docs pages, `CHANGELOG.md`, `package.json` + manifests synced by `scripts/sync-version.ts`, census registration fixes. No lane-owned source files.

### (b) The two shared files and their append-only splits

- `src/mcp/search-tools.ts`: Lane C owns the file and the `brain_recall_gate` tool definition, handler and telemetry thunk. Lane A holds append-only rights strictly limited to the `brain_search` tool definition and handler (iterative request fields, phase discriminator, cache-key suffix). No other region of the file may be touched by Lane A.
- Bench registration points (`src/core/bench/phases.ts` dispatch arm, `src/core/bench/types.ts` suite-registration types, `src/cli/brain/verbs/bench.ts` registry entry): Lane D owns all three. Lane C may append only its own `surfacing-replay` registration entries, and only after Lane D's two contract commits (Tasks 18 and 20) have landed.

### (c) Ordering - the bench contracts land FIRST

Lane D commits Task 18 (suite registry + per-suite capability declaration) and Task 20 (run-identity knob pinning) as its first two commits, before any other lane needs them and before D's own feature tasks. Lane C's replay-harness tasks (Tasks 15 and 16) depend on those two commits and build on top: the pure modules (`replay-fixture.ts`, `surfacing-key.ts`) can be written immediately, but the suite registration and phase dispatch wait. Lanes A and B depend on nothing and start immediately.

### (d) Dependency-wait rule

A lane whose upstream has not landed yet starts by writing its failing tests against the pinned contracts (they fail on the missing surface, which is the expected failure), then polls `git log -- <upstream files>` every 30 s for up to 12 min; after 30 min of waiting in total, escalate to the orchestrator instead of inventing the surface.

### (e) House rules

- Strict TDD: write the failing test first, run it, watch it fail with the expected error, then implement; refactor only with all tests green.
- One conventional commit per task (`feat(search): ...`, `feat(bench): ...`, `feat(brain): ...`); never bundle two tasks.
- Stage files by name; never `git add -A` or `git add .`; commit with `git commit --only <paths>`.
- Format and lint your own files before every commit; a green formatter and linter are a commit precondition, not end-of-PR cleanup. If the formatter touches files outside your lane, surface it instead of folding it in.
- Run tests with a throwaway HOME: `env HOME=$(mktemp -d) bun test <paths>`.
- Byte-identical-off proofs compare full serialized outcomes against frozen fixtures; a mode-on-but-inert comparison (mode on, no gaps, no operation requested) is part of every byte-identical test.
- Subprocess-spawning tests (fake judge commands) get explicit 20000 ms budgets; order-dependent assertions use sorted listings.

## Lane D - LongMemEval bench suite (contract commits first)

### Task 18: Suite registry and per-suite capability declaration (lane D, contract commit 1)
- **Files**: `src/cli/brain/verbs/bench.ts`, `src/core/bench/types.ts`, `src/core/bench/phases.ts`, `tests/cli/brain-bench.test.ts`, `tests/core/bench/phases.test.ts`
- **Acceptance**: a passing test drives the new registry mapping suite name to `{ loader, capabilities }`: `--suite longmemeval` reaches a stub loader, `--suite bogus` fails with the current message shape, omitting `--suite` stays byte-identical (locomo), capabilities ride `BenchRunOptions` set by the verb from the registry, and the default path still pins semantic off (`benchSearchConfig` assertion).
- **Depends on**: none (must be Lane D's first commit)

### Task 19: LongMemEval parser and converter (lane D)
- **Files**: `src/core/bench/longmemeval.ts` (new), `tests/fixtures/bench/longmemeval-sample.json` (new), `tests/core/bench/longmemeval.test.ts` (new)
- **Acceptance**: a passing test covers named parse errors, abstention questions excluded with the count recorded, direct gold-session-id join with unknown-id rejection, a converted fixture that round-trips `parseBenchFixture`, no reliance on `expected_text` for retrieval scoring, and an end-to-end `runMemoryBench` over the committed sample (the `tests/core/bench/locomo.test.ts` pattern).
- **Depends on**: Tasks 18, 20

### Task 20: Knob pinning into run identity (lane D, contract commit 2)
- **Files**: `src/core/bench/phases.ts`, `src/core/bench/types.ts`, `src/core/bench/run-store.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/run-store.test.ts`
- **Acceptance**: a passing test pins a `SearchConfigOverrides`-shaped record on `BenchRunOptions`, applies it last via `resolveSearchConfig`, folds it into the checkpoint hash input, gives two runs with different pins different run ids, and fails the resume hash guard on a pin change; the default pin equals today's hardcoded semantic-off override so locomo report numbers stay identical.
- **Depends on**: Task 18 (same lane, lands immediately after)

### Task 21: Embedding capability path with a shared vector cache (lane D)
- **Files**: `src/core/bench/phases.ts`, `src/core/bench/types.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/longmemeval.test.ts`
- **Acceptance**: a passing test declares the embeddings capability for the longmemeval registry entry, builds the disposable vault index through the apply-gated indexer options with the deterministic local provider (network-free), enables the semantic lane through the pin, asserts the embedding spend plan is surfaced and never silently bypassed, asserts a cache file under the runs dir keyed by provider+model+text hash makes both arms compare byte-identical vectors, and keeps the default-path semantic-off assertion green.
- **Depends on**: Tasks 18, 20

### Task 22: Strict recall_all@5 metric and report family (lane D)
- **Files**: `src/core/bench/phases.ts`, `src/core/bench/types.ts`, `src/cli/brain/verbs/bench.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/longmemeval.test.ts`
- **Acceptance**: a passing test evaluates the persisted retrieval results at cutoff 5 over non-abstention questions and surfaces `longmemeval: { recall_all_at_5, abstention_excluded }` in report and CLI output with the quality, latency and context_cost families untouched and locomo reports byte-identical.
- **Depends on**: Tasks 19, 21

### Task 23: Judge glue for official prompts (lane D)
- **Files**: `src/core/bench/judge.ts`, `src/core/bench/longmemeval.ts`, `tests/core/bench/longmemeval.test.ts`
- **Acceptance**: a passing test extends the judge stdin payload with question, answer and gold when the suite provides them (absent for locomo, whose payload is unchanged), keeps the official prompt text as module constants pinned to a named LongMemEval revision, and runs end to end with a fake judge command echoing verdicts (explicit 20000 ms budget); the default judge stays skipped.
- **Depends on**: Task 19

## Lane A - iterative recall loop

### Task 1: Extract the marginal-value stop predicate (lane A)
- **Files**: `src/core/brain/retrieval-plan.ts`, `tests/core/brain/retrieval-plan.test.ts`
- **Acceptance**: a passing test calls the extracted predicate over a synthetic search-pool density curve (arbitrary density and elapsed-time samples, not the context pack) and asserts the stop verdict follows the advisor formula (0.25 floor fraction, p95 surcharge min 0.5 at 4000 ms scale, 0.5 max extra fraction); the advisor's `buildRetrievalPlan` output is byte-identical on the existing fixtures and every pre-existing test passes untouched.
- **Depends on**: none

### Task 2: Generalize the coverage gap signal into k sub-query groups (lane A)
- **Files**: `src/core/search/coverage.ts`, `src/core/search/pipeline/second-pass.ts`, `tests/core/search/coverage-targeted-recall.test.ts`, `tests/core/search/coverage-unmeasurable.test.ts`
- **Acceptance**: a passing test seeds a pool with k uncovered rare-term groups and asserts the generalized planner emits k groups ordered by significance; the single-group behavior for the existing round-two callers is byte-identical against a frozen fixture, and the unmeasurable-coverage case still yields zero groups.
- **Depends on**: none

### Task 3: Bounded round driver with deterministic sub-queries (lane A)
- **Files**: `src/core/search/pipeline/iterative-recall.ts` (new), `src/core/search/search.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`, `tests/core/search/iterative-recall.test.ts` (new)
- **Acceptance**: a passing test runs a multi-hop seeded vault three ways: knob off produces an outcome byte-identical to the pre-change fixture (the `tests/core/search/two-pass.test.ts` kill-switch pattern, including mode-on-but-no-gaps); knob on runs bounded rounds that merge pools with round 2 recovering a chunk round 1 missed and the round cap respected; deadline expiry mid-loop degrades exactly as `tests/core/search/hybrid-deadline.test.ts` expects.
- **Depends on**: Tasks 1, 2

### Task 4: Decider envelope and commit validators (lane A)
- **Files**: `src/core/search/decider-step.ts` (new), `src/core/search/pipeline/iterative-recall.ts`, `tests/core/search/decider-step.test.ts` (new)
- **Acceptance**: a passing test builds the needs-llm-step envelope only when coverage gaps remain (never on a complete pool); the commit phase refuses unknown chunk ids, oversized or over-limit sub-queries, malformed shapes and an already-used round token with named typed errors; an accepted payload drives round N+1 with the pool growing only by the sub-query pulls.
- **Depends on**: Task 3

### Task 5: brain_search plan/commit round-trip (lane A)
- **Files**: `src/mcp/search-tools.ts` (append-only: brain_search tool definition and handler only), `src/core/search/pipeline/cache-slot.ts`, `tests/mcp/search.test.ts`, `tests/mcp/brain-search-reasons.test.ts`
- **Acceptance**: a passing test drives the MCP round-trip: the first call with the iterative flag returns a plan-phase response carrying the envelope and round token, the second call with the committed payload returns the final response; omitting the flag leaves the response byte-identical (existing `tests/mcp/search.test.ts` assertions untouched) and the cache key unchanged, while a mode-on call appends the new request fields to the cache-key suffix so plan and commit phases never collide with plain rows.
- **Depends on**: Task 4

### Task 6: Per-round outcome observability (lane A)
- **Files**: `src/core/search/types.ts`, `src/core/search/pipeline/outcome.ts`, `src/core/search/pipeline/attribution.ts`, `tests/core/search/two-pass.test.ts`
- **Acceptance**: a passing test reads per-round counts and stop reasons from the new optional outcome field with every existing attribution reason string unchanged; mode-off outcomes serialize without the field, byte-identical to the pre-change fixture.
- **Depends on**: Task 3

## Lane B - coverage-first session recall

### Task 7: Coverage-first thread selection core (lane B)
- **Files**: `src/core/brain/session-recall.ts`, `tests/core/brain/session-recall.coverage.test.ts` (new)
- **Acceptance**: a passing test imports a multi-segment lineage-linked thread and asserts the coverage call returns turns touching every detected facet, re-emitted in `compareRecords` chronological order with recomputable diagnostics; a grep call without the new operation returns byte-identical output against a frozen fixture (the omitted-operation convention, cf. `includeRaw`).
- **Depends on**: none

### Task 8: Adaptive topic budget (lane B)
- **Files**: `src/core/brain/thread-topics.ts` (new), `src/core/brain/session-recall.ts`, `tests/core/brain/thread-topics.test.ts` (new), `tests/core/brain/session-recall.coverage.test.ts`
- **Acceptance**: a passing test pins budget = clamp(distinct facets, floor 12, cap 16) with exported constants: a 40-facet thread caps at 16, a 3-facet thread floors at 12 and reports 3 realized topics honestly in diagnostics; the function is pure and deterministic across repeated calls.
- **Depends on**: Task 7

### Task 9: Typed infeasibility contract (lane B)
- **Files**: `src/core/brain/session-recall.ts`, `tests/core/brain/session-recall.coverage.test.ts`
- **Acceptance**: a passing test shrinks the character budget below the floor-weighted selection and asserts a typed error naming requested topics, kept topics and required chars; above the floor, drops appear in diagnostics and never silently; `applyCharBudget` stays frozen and its behavior for all other callers is unchanged (`tests/core/brain/recall-budget.test.ts` passes untouched).
- **Depends on**: Tasks 7, 8

### Task 10: MCP operation and CLI parity (lane B)
- **Files**: `src/mcp/brain/recall-tools.ts`, `src/cli/brain/verbs/session-recall.ts`, `src/cli/command-manifest.ts` (append-only), `src/cli/brain/help-text.ts` (append-only), `tests/mcp/session-recall-tool.test.ts`, `tests/mcp/brain-tools-parity.test.ts`, `tests/helpers/tool-probe-catalogue.ts`, `tests/cli/brain-session-recall.test.ts`
- **Acceptance**: a passing test calls the new coverage operation on brain_session_grep end to end with the typed infeasibility mapped to INVALID_PARAMS, the parity probe row and manifest entries pass, the optional brain_session_describe topic report renders the budget diagnostics, and `tests/core/install/tool-ceiling.test.ts` still pins 115 tools.
- **Depends on**: Tasks 7, 8, 9

### Task 11: Entity-thread wiring (lane B)
- **Files**: `src/core/brain/entities/registry.ts` (read-side resolution only), `src/core/brain/session-recall.ts`, `tests/core/brain/link-graph/session-mining.test.ts`, `tests/core/brain/session-recall.coverage.test.ts`
- **Acceptance**: a passing test resolves an entity key to its `session_entity_mention` rows and asserts a coverage call seeded by that key returns the turns that establish it, chronologically; an unknown key raises the same typed error family, never an empty silent result, and no new record kind is written (`tests/core/brain/continuity/reader-census.test.ts` and `record-envelope.test.ts` stay green untouched).
- **Depends on**: Task 7 (parallel with Tasks 8-10)

## Lane C - graded surfacing key and replay harness

### Task 12: Shared surfacing key calculator (lane C)
- **Files**: `src/core/search/surfacing-key.ts` (new), `src/core/search/surfacing-gate.ts`, `tests/core/search/surfacing-gate.test.ts`
- **Acceptance**: a passing test pins the graded shape `{ key, tier, admit, reason }` with admission from channel-calibrated absolute match quality (`idfWeightedCoverage`) and per-channel threshold constants exported; the structural suppressions stay named short-circuits, the binary `{retrieve, reason}` projection survives for the pinned contract tests, and the language-agnostic fails-open invariants in `tests/core/search/surfacing-gate.test.ts` hold unchanged.
- **Depends on**: none

### Task 13: Shared admission in the decision core (lane C)
- **Files**: `src/core/brain/recall-inject.ts`, `tests/core/brain/recall-inject.test.ts`, `tests/hooks/recall-inject.test.ts`
- **Acceptance**: a passing test asserts tier-boundary abstains (`below_floor`, `unmeasurable_quality`) decided through the shared calculator match the recorded decisions on a fixture corpus exactly, with the abstain reason vocabulary unchanged and the recorded empty-delivery invariant in `tests/hooks/recall-inject.test.ts` intact.
- **Depends on**: Task 12

### Task 14: Gate telemetry v2 (lane C)
- **Files**: `src/core/brain/gate-telemetry.ts`, `src/mcp/search-tools.ts` (owner: toolBrainRecallGate response and telemetry thunk), `tests/mcp/recall-gate-telemetry.test.ts`, `tests/mcp/recall-gate-contract.test.ts`, `tests/mcp/recall-gate-turn-id.test.ts`
- **Acceptance**: a passing test records optional key, tier and channel under the existing `recall_gate_telemetry` opt-in through the same lazily-evaluated gated thunk, summarizes counts by tier, keeps the fail-open contract and turn-id pins green, and leaves the opt-in-off path recording nothing; the continuity reader and envelope censuses stay green (no new record kind).
- **Depends on**: Task 12

### Task 15: Replay fixture loader (lane C)
- **Files**: `src/core/bench/replay-fixture.ts` (new), `tests/core/bench/replay-fixture.test.ts` (new)
- **Acceptance**: a passing test loads a committed session-shaped fixture into an ordered prompt sequence with expected surfacing outcomes (pure, deterministic, network-free) and converts a vault's `session_turn` records into the same fixture shape; the expected-outcome vocabulary is closed and unknown expectations are named rejections.
- **Depends on**: Tasks 18, 20 (bench framework contract commits)

### Task 16: Replay bench suite (lane C)
- **Files**: `src/core/bench/replay.ts` (new), `src/core/bench/phases.ts` (append-only dispatch arm), `src/core/bench/types.ts` (append-only registration types), `src/cli/brain/verbs/bench.ts` (append-only registry entry), `tests/core/bench/replay.test.ts` (new)
- **Acceptance**: a passing test replays a session containing a known should-abstain prompt and asserts a non-zero false-fire rate for a permissive gate and zero for the calibrated one, know_to_ask and false_fire scoring via `scoreProactiveRecall`, per-turn `injected_tokens` reporting, checkpoint and resume via the run store, and the phases invariant that an abstain injects nothing and costs zero.
- **Depends on**: Tasks 13, 14, 15

### Task 17: Close the not-scoreable caveat (lane C)
- **Files**: `src/core/bench/failure-modes.ts`, `tests/core/bench/failure-modes-baseline.test.ts`
- **Acceptance**: a passing baseline test asserts the gate's false-fire rate on the replay corpus is meaningfully bounded rather than near 1 by construction, and the rewritten docblock describes the graded gate instead of claiming the gate is unscoreable.
- **Depends on**: Task 16

## Integration

### Task 24: Integration gate - censuses, docs, version, full local gates (integrator)
- **Files**: `docs/mcp.md`, `docs/cli-reference.md`, `CHANGELOG.md`, `package.json` plus the manifests synced by `scripts/sync-version.ts`, census registration fixes
- **Acceptance**: the CI validate job's gates pass locally in CI order on the merged branch: format check, lint, the full test suite with a throwaway HOME, and manifest version sync (`sync-version.ts --check`, minor bump with the CHANGELOG entry and its compare link reference inside this pull request); the census pins are green - tool ceiling at 115, continuity reader and envelope censuses, tool-probe catalogue, parity tests - and `tests/core/bench/locomo.test.ts` passes untouched while the pre-existing byte-identical-off assertions inside `tests/core/bench/failure-modes-baseline.test.ts` and `tests/core/search/two-pass.test.ts` are preserved as the lanes' additions land.
- **Depends on**: Tasks 1-23
