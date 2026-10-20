# Cycle 20261020 - measured autonomy: the dream loop, the context window and every surface that reports a fact

**Status:** draft
**Author:** orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

This cycle's spine is measured autonomy. Today the system's autonomous and semi-autonomous surfaces run on assumptions: the dream pass cannot generalize a pattern across topic buckets even when the evidence is textually identical, context packs size themselves to a caller-declared guess instead of the host model's real window, a decision-model profile's `tuned` state is a hand edit to source rather than a measurement, the search answer says only how old the index is but not how far behind it is, the bench harness can publish scores from a corrupted or truncated run, the query language exists as four drifting copies with no machine-readable contract, and wikilink disambiguation counts basename twins the rest of the product refuses to index. Every one of the seven features replaces one of those assumptions with a measured, derived or scope-honest fact. Together they make the loop safer to let run: promotion is budgeted and evidence-linked, budgets derive from the real window, auto-resolve is gated by preregistered evaluation, freshness and bench output report what was actually measured, and the query-language and wikilink contracts state what is true instead of what a filename happens to look like.

## Scope

Seven features, each with its kanban card:

- `t_642bc2b8` - Cross-topic rule promotion in the dream pass: a deterministic lexical detector elects confirmed preferences recurring across at least N folded topic buckets and promotes one representative rule as an unconfirmed, evidence-linked preference, one promotion per owner per day through a new ledger.
- `t_a567cc12` - Shared model-aware context-window resolver: a pure resolver derives the model context window from an exact-id table, a structural 1M-suffix rule, an operator `_brain.yaml` key and an environment variable; context packs, preset suggestions, pre-compress guidance and the anticipatory cache default derive from it.
- `t_4e1681b3` - Preregistered judge eval gating auto-resolve: frozen, content-hashed eval specs with seeded takes and a dev/counted split; graded verdicts cached as continuity records; a machine-side tuning mark that `thresholdsTunedFor` consults so a measured profile may run `enforce`.
- `t_e4438152` - Measured index-behind count: a live stat-only walk reusing the incremental fastpath reports how many documents the next incremental run would add, update or delete, surfaced through the `index-stale` degradation detail and the status freshen block.
- `t_d7ce8baf` - Bench-run integrity guards: named preflight refusals before any run state is created, trace validation before a report publishes, strict checkpoint parsing and atomic writes for published artifacts.
- `t_50c81d5c` - Machine-readable JSON Schema for the query/search language: one descriptor module as the single source of truth, `SEARCH_INPUT_SCHEMA` derived byte-identically from it, a committed versioned artifact under `schemas/brain/`, and `o2b search schema export|check` verbs with doc-example tests.
- `t_fd842db0` - Ambiguous-wikilink disambiguation honors vault scope: `countBasenameMatches` filters its census through `resolveVaultScope`/`matchScope` so ignored twins no longer force full-path spellings.

Plus the shared substrate (Task 0 in `plan.md`): the config quartet for both new config blocks, the environment parse helper, the cross-topic ledger path constants and its state-surface census row, and the search-options descriptor with a byte-identical `SEARCH_INPUT_SCHEMA` derivation behind an equality test.

## Out of scope

- Retrieval-plan advisor and bench max-token defaults derived from the resolver (`src/core/brain/retrieval-plan.ts:40,191`, `src/core/bench/phases.ts:533`) and the pre-compact-extract char default (`src/core/brain/pre-compact-extract.ts:109`) - the context-window recon marks these optional second wave; bench numbers are pinned and stay explicit.
- Reconciling the MCP limit 50 vs CLI limit 100, the uncapped CLI query, the naming drift (`path` vs `path_prefix`), and the `semantic` tri-state asymmetry - the descriptor records them; fixing them is a deliberate surface change of its own.
- Embedding-based nomination feeding the cross-topic detector, and teaching the dedup predicates to skip pairs where one side cites the other - named as a follow-up unit, not silently widened here.
- Folding `admitToIndex` into the wikilink scope filter, changing `listVaultPages`, or making adjacent hygiene walkers scope-aware - the card's residue is bridge-discovery's private census only.
- Per-source freshness grading and a resident indexer process - ruled out by the card.
- `brain benchmark run` (the older live-vault harness) - guards stay inside `src/core/bench` plus the `brain bench memory` verb.
- A CHANGELOG entry or version bump written by the feature lanes - the consolidated entry lands in the integrator task, and the version bump stays with the pr-prepare phase.

## Premise verification

All seven premises were verified against the live source by read-only recon. Verdict per card, with the decisive evidence:

- `t_642bc2b8` - CONFIRMED, with one sharpening: `findMergeCandidates` buckets entries by `${p.topic}\x00${p.scope ?? ""}` (`src/core/brain/merge-candidates.ts:97`) and `planTopics` iterates the `byTopic` map one folded key at a time (`src/core/brain/dream-plan-topics.ts:62-159`, loop at `:121`), so no cross-topic promotion path exists; the dedup detector nominates merges only (`src/core/brain/hygiene/detectors/dedup.ts:174`).
- `t_a567cc12` - CONFIRMED: `suggestContextPreset` matches model ids by case-insensitive substring against two coarse hint buckets (`src/core/brain/context-presets.ts:108-118`, buckets at `:60-77`), and every context-pack budget is caller-declared (`required: ["max_tokens"]` at `src/mcp/brain/pack-tools.ts:1214`); no surface derives a budget from the real window.
- `t_4e1681b3` - CONFIRMED: the threshold profiles table is hardcoded with `tuned` as a source literal (`src/core/decision-model/questions.ts:111-139`), the zero-regret promotion rule exists only as a report recommendation (`src/core/decision-model/reports/extract-prefilter.ts:180-185`), and no preregistration machinery exists anywhere (zero repo-wide hits for "preregist").
- `t_e4438152` - CONFIRMED, with one refinement: the `index-stale` degradation carries only `ageSeconds` (`src/core/search/pipeline/outcome.ts:324-354`), the status freshen block reports only the last completed run (`src/core/search/freshen.ts:723-782`), and the incremental fastpath comparison the behind-walk reuses is mtime+size (`src/core/search/indexer.ts:510`).
- `t_d7ce8baf` - CONFIRMED, with two scoping corrections: the run-identity hash is already shipped (`src/core/bench/run-store.ts:56-70`), while the real gaps are ordering/atomicity (config resolution and capability gate run after run creation, `src/core/bench/phases.ts:271-297`; `createBenchRun` silently resets an existing run dir, `run-store.ts:100-113`; non-atomic report writes, `phases.ts:345-350`) and the absence of trace validation before publishing.
- `t_50c81d5c` - CONFIRMED, with one addition: `SEARCH_INPUT_SCHEMA` is a hand-maintained 35-property object (`src/mcp/search-tools.ts:137-353`) with a hand-parallel enforcement handler (`:996-1138`), the CLI parser and the `SearchOptions` type drift from it, and the recon found a fourth, previously uncounted copy - the vendored Python projection at `plugins/hermes/_schemas.py:244`.
- `t_fd842db0` - CONFIRMED: `acceptBridge` spells the wikilink from a basename census that never consults vault scope (`src/core/brain/link-graph/bridge-discovery.ts:329`, census at `:376-383`), because the walk applies only `DEFAULT_SKIP_DIRS` (`src/core/vault.ts:137`) and never `resolveVaultScope`/`matchScope`; the lint half of the card is already at parity.

## Chosen approach

Consultant Variant 1, substrate-first with live censuses. A short serial substrate pass (Task 0, one lane, landing first as one to three commits) puts every shared declarative surface in place before any feature lane starts: the config quartet in one coherent diff (the `cross_topic` block on `BrainDreamConfig` and the new `context:` window block in `src/core/brain/types.ts`, the policy parse/validate registration, the `config-template.ts` entries and the single config-template-ratchet test update), the environment parse helper in `src/core/config.ts`, the path constants plus the state-surface census row for `Brain/cross-topic-rules.json`, and `src/core/search/search-options-descriptor.ts` deriving `SEARCH_INPUT_SCHEMA` byte-identically behind an equality test. Five feature lanes then run in parallel on disjoint file sets, consuming the substrate; the model-window resolver is built by the context-window lane itself, and the descriptor's remaining work (CLI flag derivation, the committed schema artifact, the export/check verbs, the scoped doc-example tests) proceeds as a normal lane. Census registration stays per-lane as features go; because the substrate pre-registered the riskiest new surface, the only lane that might add a census row is judge-eval, and the design below decides it does not (the tuning mark is machine-side state outside the vault). A final integrator task consolidates the docs, dedups the command manifest and runs the full local QA gates.

## Design decisions

### t_642bc2b8 - cross-topic rule promotion (recon: recommended approach and decisions)

Recommended approach: a pure planner `dream-plan-cross-topic.ts` modeled on `rollup-ladder.ts`, called in `dream.ts` after `planRefresh` (it needs post-refresh status) and before the `hasStateChange` gate so a fired promotion counts as a state change while a below-threshold pass stays byte-identical; the write lands inside the snapshot-gated apply stage through `writePreferences`, and the ledger persists in dream-report next to the rollup ledger. Every preference write goes through `writePreferenceTxn` (the single chokepoint); the promoted rule reuses the `deriveFact` evidence-linkage shape.

Named decisions, with the recon's recommendations:

1. Recurring-across-topics definition - deterministic and lexical: confirmed preferences in at least N (default 2) distinct folded `topicKey` buckets whose principles reach a jaccard threshold, via a cross-bucket variant of the `findSimilarPairs` walk reusing `tokenise`/`jaccard`; deterministic code-unit ordering everywhere so the same corpus elects the same cluster on every machine. The kernel stays embedding-free.
2. Principle text - no synthesis: the promoted rule takes one source principle verbatim (lexicographically smallest source, same total-order trick as `preferredTopicDisplay`). The cross-topic fact lives in the evidence, not in invented prose.
3. Artifact and lifecycle - a new unconfirmed preference (`status: unconfirmed`, `provenance: "inferred"`, `evidenced_by` = sorted `[[pref-...]]` wikilinks of every source, `unconfirmed_until` = now + `dream.unconfirmed_window_days`) written through `writePreferenceTxn`, then living under the normal refresh/confirm/retire machinery. Append-only by construction; sources are never retired or edited.
4. Topic - a deterministic join of the sorted source topic displays, with `related` carrying the source pref ids for lineage; the recall-visibility limitation (topic-keyed recall never surfaces a synthetic topic) is named in the release note rather than hacked in this unit.
5. Slug - content-derived `cross-<sha256-12>` over the sorted source pref ids, so the same source set maps to the same file and a rerun is a no-op below the changed gate; reserved against `collectReservedPreferenceSlugs`; optionally reused as `idempotency_key` for the ledger's payload-mismatch protection.
6. Budget - a new ledger `Brain/cross-topic-rules.json` shaped `{ version, last_promoted: Record<ownerToken, date> }`, read at plan time, written atomically (shared `atomicWriteFileSync`, never an append-mode writer) only when fired, next to the rollup ledger write; one promotion per owner token per calendar day, enforced at plan time so a budgeted-out pass is a no-op; the date comes from the pass's injected `now`, never wall clock.
7. Config - an opt-in `cross_topic?: { enabled?, min_topics?, jaccard? }` block on `BrainDreamConfig`; absent means off and the default install stays byte-identical (the `heal_enrich_enabled`/`salience_threshold` pattern).
8. Owner semantics - source preferences must share one normalized owner token (ownerless counts as the shared empty token); cross-owner sets are never merged into one owner-visible rule.
9. Known interaction - the promoted rule will be similar to its own sources and a near-certain future nomination of the dedup detector; mitigation is the verbatim principle plus content slug; teaching dedup to skip `evidenced_by`-cited pairs is a named follow-up, not a silent widening.

### t_a567cc12 - model-aware context-window resolver

Recommended approach: a new pure module `src/core/brain/model-window.ts` mirroring `src/core/search/embeddings/presets.ts` piece by piece - an exact-id table with provenance notes, named constants (`DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000`, `MIN = 100_000`, `MAX = 1_000_000`), two matching tiers, and one `resolveModelContextWindowTokens` entry point returning `{ windowTokens, source, clamped }`.

Named decisions, with the recon's recommendations:

1. Matching tiers - exact table lookup (`null` means UNKNOWN, never a default synonym; the id normalizes first so host-side spellings - provider and region prefixes, trailing date snapshots, `-vN:N` revision suffixes - still reach the exact row without ever widening a family name into a hit) plus one structural rule: a trailing, delimited `1m` suffix (`-1m` / `_1m`, or the trailing `[1m]` bracket form hosts report) resolves to 1_000_000. No family substring matching ever - that is the defect being removed; the suffix is a published declaration, a family name is not.
2. Precedence - operator config > operator env > declared table > 1M suffix > default; an explicit per-call argument wins over both operator channels. Every first-hand declaration - operator config, operator env, an exact table row - passes through unclamped: a declared 8k/32k window must budget inside the real window, not be re-inflated to the band floor. The [100_000, 1_000_000] band with `clamped: true` governs the guessed answers only - the 1M-suffix expansion and the unknown-model default, where the true window is unknown; both published figures sit inside the band today.
3. Operator override channels - a new `context:` block in `Brain/_brain.yaml` (`context.window_tokens`), parsed by a new `src/core/brain/policy/blocks/context.ts` block parser (not an extension of `anticipatory`, because the window governs packs, presets and compact guidance alike), and the environment variable `OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW` parsed beside the recall-adequacy trio in `src/core/config.ts` (substrate); the `_brain.yaml` block wins over the env var - the resolver's deliberate precedence (decision 2: config over env), not the standing env-over-config rule. Non-integer garbage in `_brain.yaml` is a block-parse validation raise.
4. `suggestContextPreset` integration - the resolver runs when no explicit window is given, and the suggest order is DELIBERATE (changed from the draft's hint-first order after external review, not preserved): explicit window first, then a table-declared or suffix-resolved window, then a `model_hints` match, then the conservative fallback. Rationale: the suggestion must name the same mapping every derived budget sizes from - the resolved window - so a table-known id that also matches a hint answers from the table on both surfaces, and an explicit `context_window_tokens` outranks a heuristic read off the id because it is the caller's own number for the deployment at hand; a hint answers only when nothing published resolves and never claims a `resolvedWindow`. The `reason` string carries what decided. An id nothing published places answers the conservative fallback here and is refused on the pack budget surfaces - never a silent default budget.
5. `brain_context_pack` contract - `max_tokens` becomes optional with `--model`/`model` added on CLI and MCP; when absent, the budget derives from the preset the resolver selects (the preset's `context_pack.max_tokens` is the curated mapping); an explicit `max_tokens` stays first-class. Decision to pin: when `max_tokens` is absent and nothing resolves (no model, no operator setting, or a model nothing published places - no table row, no suffix, no hint), the tool refuses exactly as today - never a silent default budget. `packContext` itself keeps its caller-budgeted signature.
6. Pre-compress guidance - optional `model` and resolver-derived default caps close the unbounded-addendum case.
7. Anticipatory cache - the 2_000 default yields to a window-fraction budget only when an operator setting, env var or model id actually resolves; 2_000 stays the nothing-resolved fallback so default-vault behavior is byte-identical and pinned suites do not shift.
8. Census obligations - registering the block in `validateBrainConfigDetailed` is what makes `brainConfigKnownKeys()` see the key; the config-template ratchet test is the gate; the block parse test pins acceptance and rejection because a misspelled top-level key only warns and silently defaults.

### t_4e1681b3 - preregistered judge eval

Recommended approach: build the missing measured link in three pieces - a frozen spec, a grader, and a machine-side tuning mark - reusing the bench suite's committed-fixture, seeded-sampling and run-store machinery and the `runRerankEvalGate` template.

Named decisions, with the recon's recommendations:

1. "Preregistered" means - a content-hashed spec frozen before any grading that identifies: fixture and seeded take (ids, seed, cap, strata receipt), the split rule and the derived dev/counted membership, the promotion metric with its threshold and minimum counted n, the exact threshold values of the use being validated, and the grading protocol (deterministic scorer canonical, judge advisory). Every cached grade stamps the spec hash; a spec edit invalidates prior marks.
2. Dev/counted split - hash-order split: `h = sha256Hex(seed + ":" + id)`, sort ids by `(h, id)`, first `ceil(0.3 n)` are dev, the rest counted; the derived membership lists are frozen into the spec receipt at preregistration time and the runner verifies current fixture membership against the receipt. Only dev may inform threshold selection; counted alone produces the promotion number.
3. Promotion metric - counted-split error rate against frozen gold, per (profile, use), with three conditions mirroring the in-repo gate styles: error at or below a preregistered per-use ceiling (conservative constants beside the profile table), no regression versus the deterministic baseline on the same counted items (the `rerankEvalVerdict` rule), and a minimum counted n (30 floor) below which the verdict is "not enough evidence". Metric name and ceiling live in the spec, not the grader.
4. Grade cache - verdicts are continuity records, new kind `decision_model_eval_grade` beside `decision_model_call` (ids and numbers only, `origin: "eval"` so they stay out of shadow agreement, spend counted toward the daily cost gate). Vault records are review evidence only; a hand-written record cannot mark a profile tuned.
5. Tuning mark - the machine-consumed summary is a small file under the platform state root (`src/core/platform-dirs.ts` gains its first production caller), keyed by (profile, use) and carrying the spec hash; `thresholdsTunedFor`/`holdToProfile` accept an injected optional mark reader (default none, existing callers untouched), consult it only when the source table says untuned, and accept the mark only if spec hash, fixture hash and threshold values match; a deleted mark fails closed to shadow. The mark read is a single small file with a TTL cache (hot path).
6. Decision on census registration - the mark file is machine-side state outside the vault and is deliberately NOT registered as a vault state surface in `src/core/state/surfaces.ts`; judge-eval does not touch that file (it belongs to the substrate for the cross-topic ledger row).
7. Surfaces - `o2b decision-model eval run|list` verbs plus an eval section in `report --use`; `check` gains one line naming the profile's measured state; the doctor readiness probe reflects measured/untuned state. The independent uncalibrated-provider refusal is never weakened by a measured mark.

### t_e4438152 - measured index-behind count

Recommended approach: a new exported `indexBehindCount(config): Promise<IndexBehind | null>` in the read-side diagnostics section of `src/core/search/indexer.ts`, beside `indexStatus`: one stat-only `walkVault` pass (inheriting all scope, admission-lane, extension and symlink rules with zero new scope logic) diffed against `store.listDocuments()` from a read-mode store. The walk is live, never persisted - a count frozen at scan start would read zero exactly when the operator wants to trust it.

Named decisions, with the recon's recommendations:

1. Definition - exact fastpath comparison: `unindexed` (walked path, no row), `changed` (row where mtime or size differs - the fastpath miss), `deleted` (indexed path not seen on the walk); `behind = unindexed + changed + deleted`, the same quantity the freshen child records as `lastChanged`, measured now. Documented semantics: an upper bound on content changes (touch-only counts as changed), second-granularity (same blindness as the fastpath, not fixed locally), and the deleted component needs the full walk before the diff.
2. Failure polarity - any failure (missing index, unreadable dir) returns `null`: absent, never zero; a failed measurement is not a measurement.
3. Search gating - compute only when the degradation will fire (`indexAge > INDEX_STALE_SECONDS`); fresh answers pay nothing, a stale answer pays one stat walk; `withIndexStale` gains the count and emits `detail: { ageSeconds, behindCount }` (both integers, type-compatible with `RetrievalDegradationDetail`; no envelope change, no MCP schema change - the detail object is open by design). No new degradation code, so the code enum is untouched.
4. Status surfacing - a new `index_behind` human line and `index_behind`/optional `index_behind_by_root` JSON keys on `renderFreshenStatus`/`serializeFreshenStatus`; per-root breakdown is status-only because the degradation detail rule forbids paths and cannot hold a breakdown.
5. Purity boundary - the measured value is passed into `freshenStatus` from `status.ts` so `freshenStatus` stays a pure state-file reader and the doctor's `freshenFailureCheck` cannot silently pick up the walk cost.
6. No census obligations - read-only walk, no new write sites, no new persisted state file, no new CLI verb, no new doctor exit.

### t_d7ce8baf - bench-run integrity guards

Recommended approach: a new CLI-agnostic module `src/core/bench/guards.ts` with three exports - a frozen `BENCH_REFUSAL` table with a closed `BenchRefusalKind` union (one member per preflight state P1-P7 and trace state T1-T7, on the `DEGRADATION_CODE` pattern), a `BenchRefusalError` carrying kind and detail (the `BenchEmbeddingError` pattern), and `preflightBenchRun`/`validateBenchTrace`, both throw-on-failure.

Named decisions, with the recon's recommendations:

1. Ordering - preflight runs before `createBenchRun`/`loadBenchRun`, and config resolution plus the capability gate move above run creation so a refusal can never leave an orphan run dir; trace validation runs between the evaluate re-read and the judge/report/write block, on every invocation, so fresh and resumed runs are both covered.
2. Trace strictness keys on absence, not content - a category-required field ABSENT from a persisted record is a refusal; present-but-empty is a legitimate miss; an all-questions-failed run stays publishable (score content never triggers refusal); judge errors stay advisory.
3. Faulted proactive decisions - the guard consumes `scoreProactiveRecall().faults` and refuses with the question named and the "start a fresh run" repair; `failure-modes.ts` is unchanged - guards abort, scorers score.
4. Counts check - the T7 recomputation extracts `buildReport`'s category-counting loop into a shared helper (including the standing_instruction headline-exclusion rule) rather than duplicating it, avoiding false refusals on facet runs.
5. Checkpoint strictness - `parseCheckpoint` refuses unknown phase names with a named error instead of silently filtering (consistent with the pre-knob-pinning refusal stance), and preflight refuses out-of-order/duplicate phases and missing phase artifacts (ingest done but `vault/` missing is the dangerous one); the error says the checkpoint was written by a different build where applicable.
6. Atomicity - `report.json` and per-question results move to temp+rename writes (the `writeVectorCache` pattern), making truncated traces genuinely rare; `run-store.ts` `persist` goes atomic too.
7. Identity freeze - guards add no knobs and change no measured behavior: `fixtureHash` stays content-only and `benchRunIdentityHash` is unchanged, because `report.fixture_hash` is a published cross-run comparison field; existing run ids, checkpoints and reports remain valid, no migration; a passing report stays byte-identical and guards add zero output on success.
8. Rendering - `cmdBrainBench` catches `BenchRefusalError`, emits `refused (<kind>): <detail>` naming the repair, exits non-zero; unknown errors keep propagating.

### t_50c81d5c - machine-readable query-language schema

Recommended approach: a descriptor module as the single source of truth - not a schema generated from the TypeScript type (no reflection; `SearchOptions` carries non-wire fields by design). `src/core/search/search-options-descriptor.ts` holds one typed table with a row per caller-facing field: canonical snake_case name, JSON Schema fragment (enums imported from the existing core vocabularies), CLI flag spelling and kind, surface visibility (mcp | cli | internal), and default.

Named decisions, with the recon's recommendations:

1. Derived, not copied - the substrate derives `SEARCH_INPUT_SCHEMA` in `src/mcp/search-tools.ts` from the descriptor's mcp-visible rows as a one-line filter keeping the same exported constant, proven byte-identical by an equality test before anything else ships; the lane derives the CLI `parseFlags` table from the cli-visible rows (snake_case to kebab-case mechanically), with verb-local flags (`json`, `verbose`, `auto-refresh`) staying local.
2. Parity - a compile-time `satisfies` assertion that every non-internal row key exists on `SearchOptions`, plus a unit test in the reverse direction (no mcp/cli row missing from the schema/flag derivations) - the descriptor must not be able to drift from `SearchOptions`, the very failure mode being fixed.
3. Artifact - `schemas/brain/search-query.schema.json` with `$schema: https://json-schema.org/draft/2020-12/schema` and `$id: brain.search_query.v1`, joining the existing published set (the `published-schema-contracts` file-set pin is the tripwire; the SCHEMA_IDS entry lands in the same PR). A sibling `brain.search_query_document.v1` block (as `$defs` or a second file) describes the line-oriented query_document grammar; it describes the hand-rolled parser and is validated by doc examples, not used for enforcement.
4. CLI verbs - `o2b search schema export` (file or `--stdout`) and `o2b search schema check` (regenerate and diff, exit 2 on drift), registered in `KNOWN_VERBS` in `src/cli/search.ts`. Deliberately not `o2b brain schema ...`, which already means the vault schema pack. Regeneration is a human action; CI enforces freshness via tests.
5. Doc-example tests - new `tests/docs/search-query-doc-examples.test.ts` on the retrieval-trail-doc pattern: the documented structured-query example must parse and validate against the artifact; every documented `--flag` in the scoped `o2b search "<query>"` block must be derivable from the descriptor's cli rows; every backticked `brain_search` argument in `docs/mcp.md` must be a property of the artifact. Extraction is scoped to the Search sections only; `docs/plans/**` and `docs/brainstorm/**` are excluded forever.
6. Validator extension - `tests/helpers/json-schema-subset.ts` gains `minLength`/`maxLength` (and `additionalProperties`-as-schema if the `properties` row keeps it) without weakening the core promise: an unsupported keyword is an error, never a silent pass; no full JSON Schema library dependency.
7. Compatibility neutrality - the artifact presents canonical MCP names with the descriptor mapping CLI spellings onto them; renaming CLI flags is out of scope. The vendored Hermes projection stays byte-neutral (the substrate guarantees it); if any description or bound were ever reworded, `plugins/hermes/_schemas.py` must be regenerated by hand in the same change because the anti-drift test diffs a live `tools/list`.

### t_fd842db0 - wikilink disambiguation honors vault scope

Recommended approach: filter inside `countBasenameMatches` (narrow placement) - resolve `resolveVaultScope(vault).rules` once, then per candidate page compute the vault-relative POSIX path (`toPosix(relative(vault, page.path))`) and skip the page when `matchScope(rel, rules).inScope` is false, keeping the existing entity status-scope check. Shape mirrors `page-dedup.ts`'s `basenameCollides`, the exact precedent.

Named decisions, with the recon's recommendations:

1. Placement - inside the private census, not the enumeration layer: filtering `listVaultPages` would silently shrink a dozen unrelated products (co-occurrence, repair-lane, freshness, heal-run, hygiene detectors, doctor counts, MCP query); the narrow placement can only decrement out-of-scope matches and changes nothing for in-scope files. One rule set does not require one call site - the predicate called is the same `matchScope`/`resolveVaultScope` pair the lint walkers call.
2. Boundary - `admitToIndex` is deliberately not folded in: the vault-scope module separates policy scope from lane admission on purpose, and a `Brain/state` twin exists even though it is never indexed. No changes to `src/core/vault.ts` or the vault-scope module.
3. Visibility - `countBasenameMatches` stays private, no new exports, so the visibility-surface census and surfaces registry prose stay untouched.
4. Documented edges - the docblock names both pre-existing edges: the target-itself-out-of-scope case (accept semantics unchanged) and the intended-target-was-the-ignored-twin case (the operator's remedy is fixing `vault.ignore_paths`/`include_paths`, the same remedy every other scope-aware surface shares). The write-time idempotency check already accepts either spelling, so no write storms on upgrade.
5. Not gitignore-dependent - the filter reads `Brain/_brain.yaml` plus frozen defaults through `resolveVaultScope`; no git invocation, identical behavior in a non-git vault.

### Cross-cutting substrate decisions

1. The two new config blocks land together in one reviewable diff: `cross_topic` on `BrainDreamConfig` (`src/core/brain/types.ts` near `:1450`) and the `context:` window block (near `:2030`), with policy parse/validate registration, `config-template.ts` entries and the single config-template-ratchet test update resolving both features' obligations in one pass.
2. The environment parse helper for `OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW` lives in `src/core/config.ts` beside the recall-adequacy trio, so the resolver in the context-window lane stays pure (parsed values in, no env reads inside).
3. The cross-topic ledger gets its identity early: `crossTopicLedgerPath` in `src/core/brain/paths.ts`, `BRAIN_CROSS_TOPIC_LEDGER_FILE` in `path-constants.ts`, and a `STATE_SURFACE_ID.crossTopicLedger` row in `src/core/state/surfaces.ts` with its `tests/core/state/surfaces.test.ts` row - so the cross-topic lane adds no census rows at all.
4. The descriptor lands with `SEARCH_INPUT_SCHEMA` derived byte-identically behind an equality test, converting the highest-blast-radius feature into an additive one before any lane starts.

## File changes

### Substrate (Task 0)

New: `src/core/brain/policy/blocks/context.ts`, `src/core/search/search-options-descriptor.ts`, `tests/core/brain/policy/context-block.test.ts`, `tests/core/search/search-query-schema-artifact.test.ts`.
Modified: `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `src/core/brain/policy/validate.ts`, `src/core/brain/config-template.ts`, `tests/core/brain/config-template-ratchet.test.ts`, `src/core/config.ts`, `src/core/brain/paths.ts`, `src/core/brain/path-constants.ts`, `src/core/state/surfaces.ts`, `tests/core/state/surfaces.test.ts`, `src/mcp/search-tools.ts`.

### t_642bc2b8 cross-topic

New: `src/core/brain/dream-plan-cross-topic.ts`, `tests/core/brain/dream-cross-topic.test.ts`.
Modified: `src/core/brain/dream-plan.ts`, `src/core/brain/dream.ts`, `src/core/brain/dream-apply.ts`, `src/core/brain/dream-summary.ts`, `src/core/brain/dream-types.ts`, `src/core/brain/dream-report.ts`, plus the shape-pinning suites if they assert the changed summary additively (`tests/core/brain/dream-checkpoints.test.ts`, `tests/core/brain/dream-phase-refusal.test.ts`, `tests/core/brain/trust/operator-summary.test.ts` conditionally).

### t_a567cc12 context-window

New: `src/core/brain/model-window.ts`, `tests/core/brain/model-window.test.ts`.
Modified: `src/core/brain/context-presets.ts`, `src/mcp/brain/pack-tools.ts`, `src/cli/brain/verbs/context-pack.ts`, `src/cli/brain/verbs/context-presets.ts`, `src/cli/brain/help-text.ts`, `src/core/brain/anticipatory-cache.ts`, `tests/core/brain/context-presets.test.ts`, `tests/mcp/context-presets-tool.test.ts`, `tests/cli/brain-context-presets.test.ts`, `tests/mcp/context-pack-tool.test.ts`, `tests/cli/brain-context-pack.test.ts`, plus anticipatory-cache suites only if the default derivation lands there.

### t_4e1681b3 judge-eval

New: `src/core/decision-model/eval-spec.ts` (or kept inside `questions.ts`), `src/core/decision-model/eval/take.ts`, `src/core/decision-model/eval/grade.ts`, `src/core/decision-model/eval/mark.ts`, `tests/fixtures/decision-model/`, new decision-model eval tests.
Modified: `src/core/decision-model/questions.ts`, `src/core/decision-model/record.ts`, `src/core/decision-model/config.ts`, `src/core/decision-model/diagnostics.ts`, `src/cli/decision-model.ts`, `src/core/platform-dirs.ts`, `src/cli/command-manifest.ts` (decision-model entry; owning lane), `src/core/doctor-readiness.ts`, `src/core/install/ownership.ts`, `docs/decision-models/providers.md` and siblings.

### t_e4438152 freshness

New: `tests/core/search/behind-count.test.ts`.
Modified: `src/core/search/indexer.ts`, `src/core/search/pipeline/outcome.ts`, `src/core/search/search.ts`, `src/core/search/freshen.ts`, `src/core/search/index.ts`, `src/cli/search/verbs/status.ts`, `tests/core/search/freshen-search.test.ts` (or a sibling gate test), `tests/core/search/relational-path.test.ts` (detail literal), `tests/cli/search-status-freshen.test.ts`.

### t_d7ce8baf bench guards

New: `src/core/bench/guards.ts`, `tests/core/bench/guards.test.ts`.
Modified: `src/core/bench/phases.ts`, `src/core/bench/run-store.ts`, `src/cli/brain/verbs/bench.ts`, `tests/core/bench/phases.test.ts`, `tests/core/bench/run-store.test.ts`.

### t_50c81d5c schema artifact

New: `src/cli/search/verbs/schema-export.ts`, `schemas/brain/search-query.schema.json`, `tests/docs/search-query-doc-examples.test.ts`.
Modified: `src/cli/search/verbs/query.ts`, `src/cli/search.ts`, `tests/helpers/json-schema-subset.ts`, `tests/core/brain/published-schema-contracts.test.ts`, `package.json` (optional `search-schema` scripts).

### t_fd842db0 wikilink scope

Modified: `src/core/brain/link-graph/bridge-discovery.ts`, `tests/core/brain/bridge-discovery.test.ts`.

### Integrator

Modified: `docs/cli-reference.md`, `docs/mcp.md`, `src/cli/command-manifest.ts` (the search schema verb row, after the judge-eval lane lands), `CHANGELOG.md` (consolidated entries for the features whose recons demand them: `t_e4438152`, `t_fd842db0`, and `t_642bc2b8` per its CLAUDE.md versioning-discipline note).

## Risks and open questions

1. Served `tools/list` is a frozen public surface. The descriptor's derivation must be byte-identical on day one - the equality test is the gate - and the vendored Hermes Python projection stays byte-neutral with it; any schema byte change would silently require a manual Python edit and would only be caught after the churn by the live-server anti-drift test.
2. Config keys that silently default. A misspelled top-level key only warns (`validate.ts:203-213`), so a typo'd `context:` or `cross_topic` block resolves to defaults with no error; the block parse tests must pin acceptance and rejection, and the resolved `source` should be visible in preset-suggest output so an operator can see their key took effect.
3. Cross-topic generalization vs dedup nomination. A cross-bucket lexical cluster is simultaneously the strongest generalization evidence and a near-certain future dedup/digest nomination of the promoted rule (thresholds 0.8/0.6); the verbatim-principle and content-slug mitigations reduce it, and the dedup-skip follow-up is named but not built. The sign-derivation fallback (tier 3 "assume opposite" on a synthetic topic) and stale-no-evidence retirement of a never-applied rule need an explicit decision during implementation.
4. Host model visibility is conditional. No caller knows the host model today; `ServerContext` carries no model id. The resolver upgrades every hint into a real number, but a host that never forwards its id still gets the 200_000 default; tool descriptions and help text must say so.
5. Byte-identical blast radius on pinned defaults. Anticipatory cache (2_000), retrieval plan (2_000) and bench (1_000) budgets are pinned by tests and persisted stamps; window-derived defaults may only fire when something actually resolves, or those suites and cached stamps shift. Context-window and bench lanes are separate lanes precisely so a pin break is attributable.
6. Bench false refusals. T4 must key on field absence only; T5's refusal repeats under `--resume` (resume re-evaluates the same persisted decisions) so the detail must say a fresh run is required; T7 must reuse `buildReport`'s aggregation. The strongest false-refusal check is byte stability: a passing report identical to the pre-guard shape and every existing bench test green unchanged.
7. Flaky mtime tests. Second-granular mtime makes behind-count tests clock-edge sensitive; tests must set explicit mtimes (`utimesSync`) or sleep past a second boundary, as the existing fastpath tests already do.
8. Preregistration theater and grade-cache poisoning. A spec committed after grades were inspected looks preregistered but is not: spec and fixtures land in one reviewable commit before the runner is usable, and the authoritative mark is written solely by the eval command machine-side, with grade records carrying correlated `decision_model_call` ids so a reviewer can match grades to real spend.
9. Walk cost on large vaults. The stale-only gate bounds the behind-count walk to the abnormal state, but repeated stale searches (freshen off, backoff active) each pay a full stat walk inside the long-lived MCP server; the escape hatch is a per-process memo keyed on `dbPath + lastIndexedAt` with a short TTL - never persistence to the state file.
10. Open question - retirement semantics for `inferred` cross-topic rules: whether stale-no-evidence should eventually retire a never-applied promoted rule or a `pinned`-style exemption applies. Decide during implementation of `t_642bc2b8`; the default (no code change) is the existing `planAutoRetires` behavior.
11. Open question - whether the command manifest enumerates the new `o2b search schema` verbs. If it does, the row is added by the integrator task after the judge-eval lane (the manifest's owning lane) has landed, so the two never edit the file concurrently.
