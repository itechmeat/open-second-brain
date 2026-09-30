# Search, diagnostics and vault hygiene wave - the brain does not lie, does not stay silent, and does not rot

**Status:** draft
**Author:** design node, osb-run-cycle-20260930 (via feature-release-playbook)
**Audience:** implementation
**Board scope:** 16 cards, full union of three cuts (search / diagnostics / write-path-and-hygiene)
**Ground truth:** premise reports at `~/.cache/osb-run-cycle-20260930/premise-{search,diagnostics,writepath}.md`, all anchors re-verified against this worktree (v1.63.0 + one .apb commit, HEAD 79a71dad) on 2026-09-30. Where a card comment and a premise report disagree, the premise report wins.

## Problem statement

Three defects repeat across the board. **The brain lies**: signature equality treats two unknown-identity embedding configs as compatible (`?` sentinel), a maintenance run that timed out a pass exits the same as one that failed deterministically, and a dangling `merged_into` pointer silently excludes a page from dedup candidacy forever. **The brain stays silent**: nothing proves the store can actually init, migrate, index and search on a given machine, nothing reports an MCP registration whose command no longer resolves, a composite hybrid search can sum unbudgeted lane latencies past any host hook timeout without a typed word about it, and a near-duplicate note write lands with no advisory. **The brain rots**: hub pages never gain edges at intake, slug-suffixed stems and dead tags accumulate with nothing naming them, and pinned material surfaces no better than churn.

## Scope

Fourteen implementation tasks carrying fourteen cards (two cards - t_5f7e0dcd and t_4bccd70a - record verdicts only). Grouped in four waves:

- **Group 1 - store/schema + integrity** (t_9e1a4b3f, t_2fbdaf70): one migration adding `documents.event_time_min/event_time_max/pinned`, a countable event-time window census, the verify-before-replace gate on embedding-model change, and the `?`-sentinel signature fix so unknown identity never compares equal.
- **Group 2 - ranking/recall** (t_f7bef96a kept half + t_9e1a4b3f indexer half, t_bdc24171, t_d9f863e9): index-time persistence of pinned + event-time bounds, a bounded pinned boost layer, a composite hybrid deadline with a typed degradation code, a relational rerank pin, and a lexical-vote gate on the additive metadata boosts.
- **Group 3 - diagnostics/doctor** (t_3477c9e8, t_ff8bb8a8, t_9d155d0e, t_c00cc548, t_7c01bb39): registered-command resolvability readiness probe, dangling merge-chain brain-doctor check, honest maintenance exit + spend banner/receipt, a functional self-test harness with a stable JSON report, and a check-only write-back contract audit.
- **Group 4 - write-path/hygiene** (t_d30c0548, t_7bad7ad8, t_23bd347d, t_c8508241): a near-duplicate finding on every note receipt, a slug-collision hygiene detector, hub-candidate emission at inbox-drain feeding the existing repair lane, and a tags hygiene detector over the one shared TAG_RE definition.

## Out of scope

- **t_5f7e0dcd (CJK-aware chunker)** - REFUTED, ships since v1.58.0 (commit 6f33c424, PR #197). Not planned; verdict recorded below. The residual cost-surface half (`estimateTokens` chars/4, `brain_token_impact`) is a separate future lane.
- **t_4bccd70a (stable note identity)** - narrowed verdict, no feature this wave (rationale below).
- **t_f7bef96a revision-stability half** - operator decision: out. No per-note revision signal exists; building one is a store + indexer feature of its own.
- **t_2fbdaf70 forget executor and export incomplete-marker** - refusals recorded below.
- **t_9d155d0e stop-early / resume / model-orchestration layers** - refusals recorded below (kernel stays model-free per the validator).
- **t_7c01bb39 repair lane** - belongs to t_af5e252f (ambient writeback); this wave ships the check only and settles the marker contract as that task's input.
- **t_c8508241 consolidation / t_11ee559f** - tag-taxonomy consolidation is deferred upstream-side; t_11ee559f (write-time tag syntax validation) is a board sibling not in this wave. Coordination note recorded.
- **t_d30c0548 body normalization half** - refusal recorded below.
- Schema-pack vocabulary (t_151a564c, t_71cbf5bf) - different concern; the tags detector stays off frontmatter relation fields and Brain artifact ids.
- Widening TAG_RE to the looser Obsidian rule - an index-semantics change with reindex gating; this wave reports the diff instead.

## Chosen approach

The wave lands as four sequential task groups; groups 3 and 4 run as two parallel lanes (see plan.md for the file-ownership boundaries that make the parallelism safe). Every change rides machinery that already exists rather than inventing a second convention: the closed degradation vocabulary, the readiness probe registry, the hygiene detector registry, the repair lane's candidate/refusal shape, the migration ladder, and the exit-code tables.

### The wave exit-code vocabulary

One table governs every new exit decision in this wave, per the diagnostics premise report:

| Code | Meaning | Already used by |
|---|---|---|
| 0 | ok (including self-resolving skips) | all tables |
| 1 | proved failure / runtime error | all tables |
| 2 | usage error | INSTALL_EXIT, MAINTENANCE_EXIT |
| 3 | drift | INSTALL_EXIT |
| 4 | user-modified block | INSTALL_EXIT |
| 5 | proved unreachable | SEARCH_CHECK_EXIT, INSTALL_EXIT (agree by test) |
| 6 | probe/run incomplete - "could not find out" | SEARCH_CHECK_EXIT, DOCTOR_EXIT |
| 7 | refusal | MAINTENANCE_EXIT |

No new numbers are minted this wave. The maintenance table gains `probeIncomplete: 6` (a safeguard-timeout pass is precisely "could not find out" - the maintenance.ts:60-84 docblock's own reasoning for why refusal got 7 instead of 6 applies verbatim to timeouts), and the self-test harness reuses `DOCTOR_EXIT`.

## Verified premises and settled design decisions, per card

### t_2fbdaf70 - Lossless-maintenance contract (CORRECTED)

Premise verdict (premise-search.md): the clear-on-model-change path (`ensureEmbeddingModel`, `src/core/search/store/vectors.ts:292-345`) never gates on rebuildability; `ForgetPlan` (`src/core/brain/governance/forget-plan.ts`) is dry-run-only; the export half is thinner than claimed (atomic rename in `deliverSpool`/`deliverBody`, `src/cli/brain/verbs/export.ts:389-405`, already fails loudly); and the real compatible-by-default bug is the `?` sentinel (`NULL_FIELD`, `src/core/search/embeddings/signature.ts:25`, null branches :39-40), not `staleEmbeddings` (whose zero-by-convention branch fires only when the current config has no model, `vectors.ts:253`). `embedding_abi: warn` stays the default (`src/core/brain/policy/blocks/integrity.ts:66-70`).

Decisions:

1. **Verify-before-replace gate.** Before `clearEmbeddings` on a model/dimension change, `ensureEmbeddingModel` asserts the source material can be rebuilt: the affected corpus has chunks rows (`countChunks` family) and the configured provider can compute embeddings (`resolveSemanticCapability` from `src/core/search/capability-tier.ts` - the same resolver `vector-backfill.ts:116` uses; a `disabled`/`credentialMissing` tier cannot rebuild). When the assertion fails, the clear is refused with a named error and the old vectors survive; the run reports the refusal instead of silently keeping or silently dropping. This gate also answers the adjacent nuance the premise flagged: a named-model to null-model transition is not a detected change today (`vectors.ts:303` requires both sides non-null). Under the gate's own logic that transition must not clear - rebuildability cannot be verified with no model configured - but it must not stay silent either: the transition logs a one-line warning naming the last recorded model.
2. **`?`-sentinel fix: unknown identity never compares equal.** `embeddingSignature` keeps the parseable `?` rendering (stable across processes), but the equality decision points learn that an unknown identity is never compatible with anything, including another unknown identity: a new exported predicate in `signature.ts` reports whether a signature carries an unknown model/dimension field, `isStaleSignature` is re-expressed over it, and the staging-resume compatibility consumer (`reindexStagingSignature`/`stagingSignatureMatches`, `src/core/search/indexer.ts:1171-1199`) renders an unknown-identity embedding component as a distinct non-resumable marker so a staging build under unknown identity always rebuilds rather than resumes. The provider-semaphore key (`src/core/search/embeddings/provider-semaphore.ts:111`) is verified safe (it appends the endpoint) and is documented, not changed. Consumers decide warn vs refuse per the `embedding_abi: warn` default - this is the warn-consistent resolution of the card's "unknown-is-incompatible" half, which the premise ruled wrong as a default flip.
3. **Refusal - export incomplete-marker.** Dropped. Publication already fails loudly and atomically (`fail()` on handler exceptions, `atomicWriteFileSync` for the body, atomic rename + spool unlink for `--out`); nothing partial lands at the destination, and the realistic residue (a failed stdout stream) already reports. A marker would decorate a window that does not exist.
4. **Refusal - scoped forget executor.** Deferred. `buildForgetPlan` already records path + sha256 per entry (:51) - exactly the raw material an executor needs - but an executor is a new destructive-write surface that needs its own design (ordering, snapshot/recovery, archived-material exclusion) and does not compound with this wave's other work. The dry-run plan ships today; the executor is recorded as the follow-up.

### t_9e1a4b3f - Persisted, countable event-time bounds (CONFIRMED)

Premise verdict: filter-first is parity (`filterCandidatesInRange`, `src/core/search/pipeline/event-time.ts:158`, applied in `second-pass.ts:123-131`); the persisted min/max bounds and any window census are genuinely absent from `StoreCounts` (`src/core/search/store/counts.ts:28-34`) and the migration ladder (`MIGRATIONS`, `src/core/search/schema.ts:256`). One correction to fold in from the live tree: `documents` already carries `event_anchor_start_ms/event_anchor_end_ms` columns (the body-anchor rung, materialized at index time) - what is missing is the RESOLVED window under the resolver's full rung order (frontmatter validity window > event anchor > mtime fallback, `event-time.ts:17-36`, `validity.ts:24,71,87`), which the query side re-derives per query and the store cannot aggregate.

Decisions:

1. **Granularity: per document.** Every resolver input is document-scoped (`validityWindowFor(path)`, frontmatter, anchor); chunk-level bounds would add a join for zero information (premise answered the card's open question).
2. **One migration** (next version in `MIGRATIONS`) adds three nullable columns to `documents`: `event_time_min`, `event_time_max` (the resolved declared window bounds in unix ms; both null = mtime fallback / unmeasured), and `pinned` (see t_f7bef96a). Backfill is lazy by construction: bounds are persisted in the indexer's document loop (Task 3), so rows refresh on their next content change, and the census reports the unmeasured bucket by name rather than pretending it is zero.
3. **One resolver, one spelling.** The index-time resolution must not re-implement the rung order: a pure exported helper beside the query-side resolver (`src/core/search/pipeline/event-time.ts`) resolves a document's window from frontmatter + its materialized anchor, and both the query-side `EventTimeResolver` and the indexer's persistence call it. This is the same one-rule-one-spelling discipline the tree applies to TAG_RE and `resolveUniqueMatch`.
4. **Countable census.** `counts.ts` gains a window-census helper answering "how many documents fall in this window" as one SQL aggregate over the new columns: `{ documents, declared, intersecting, mtimeFallback }` for a `[since, until]` range (a declared window intersects when `event_time_min <= until AND (event_time_max IS NULL OR event_time_max >= since)`, with the null-`min` open-start case handled symmetrically). `StoreCounts` itself stays as-is; the census is a separate function beside it, so existing `StoreCounts` consumers keep their shape.

### t_f7bef96a - Pinned ranking signal (CORRECTED; revision-stability out)

Premise verdict: the validator's own correction was wrong - `src/core/brain/pinned.ts:10` is the ONE curated context file, and the per-note `pinned` flag exists only for preference notes (`parsePinned`, `src/core/brain/preference.ts:1696-1710`, hard default false) and never reaches ranking. Composition pattern to mirror: `REINFORCE_BOOST_CAP = 0.05` (`src/core/search/reinforce.ts:29`), bounded pure fold, pre-top_k-cut, caps named in the `ranker.ts:110-138` block.

Decision - **the pin surface is the existing per-note `pinned` frontmatter flag**: the indexer reads `pinned` from document frontmatter (reusing the preference parser's coercion, exported from `preference.ts` rather than duplicated) and persists it in the `documents.pinned` column from the Task 1 migration; the ranker consumes a pinned-by-doc lookup as a new bounded additive layer with `PINNED_BOOST_CAP = 0.05` (matching the reinforce cap scale), a `buildReasons`/`buildBreakdown` entry, and a place in the caps block. No new frontmatter token is minted - the flag's writer today is the preference flow, and extending it to other Brain namespaces is a schema-author decision outside this wave. The boost is always-on (like reinforce/recency, inspectable via the reason strings) rather than config-gated, because it is a bounded signal over explicit operator/agent state, not a behavior mode.

**Revision-stability: out** (operator decision, recorded). No per-note revision counter exists (`INDEX_REVISION_STATE_KEY` is index-level, `src/core/search/store/state.ts:36,132-134`); a stability function would also need the fresh-note guard the card itself flags. Refused rather than deferred-with-a-date: it should ride whichever wave first adds per-note revision state.

### t_d9f863e9 - Relational pin + lexical-vote boost gate (CONFIRMED, with qualifications)

Premise verdict: the relational arm engages rrf-only (`src/core/search/pipeline/relational-arm.ts:34-36`) with no rerank protection; the cross-encoder's `minScore` (`src/core/search/types.ts:1280-1286`) is an existing weaker protection the pin should extend rather than parallel; nine additive boost layers (`src/core/search/index.ts:174-194`, caps at `ranker.ts:110-138`) have no lexical gate; the keyword-lane floor (`DEFAULT_KEYWORD_WEIGHT = 0.6`, `FRESH_KEYWORD_ONLY_TOP_SCORE`) is pinned by `tests/core/search/keyword-lane-top-score.test.ts` and must not move.

Decisions (two independent, config-keyed opt-ins, both default-off, both with explain receipts):

1. **`search_metadata_boost_gate`** (config key following the `search_relational_arm_enabled` naming at `index.ts:861-869`): when the keyword lane returned ZERO hits for the query (no lexical vote - the BM25 result set is empty before boosts), every additive metadata/structural boost layer contributes exactly ZERO (not damped; deterministic and explainable). The lexical vote is "the keyword lane produced at least one hit for this query", evaluated on the pre-boost keyword input the ranker already receives. A gated run's `buildReasons`/`buildBreakdown` says so ("gated: no lexical vote"), so the receipts make the calibration change inspectable. The caps block proportions are untouched; the keyword-lane floor pins stay green (the gate changes boost layers, not the keyword lane's own weight or top score).
2. **`search_relational_rerank_pin`**: expressed at the cross-encoder hand-off in the pipeline (`src/core/search/pipeline/assemble.ts:212-262` region where the relevance floor and cross-encoder ordering apply), not as a parallel mechanism beside `minScore`. Rule: rerank may PROMOTE relational-origin candidates, never SINK them below their pre-rerank heuristic order. The pipeline knows which candidates the relational arm contributed; when the pin is on, the post-rerank order floors every relational-origin candidate at its pre-rerank position (it may rise if the cross-encoder genuinely scores it above peers, and the existing `minScore` relevance floor still applies unchanged). Deterministic, explainable, and strictly weaker than rerank-off.

### t_bdc24171 - Composite hybrid deadline (CORRECTED residue)

Premise verdict: per-lane time-boxing, typed degrade-on-timeout, and the force-keyword knob all ship (`index.ts:222,524-526,585-587`; `semantic-phase.ts:177-194`; `pipeline/semantic-lane.ts:91-99`; `types.ts:810`). The residue: no single wall-clock deadline spans embed -> semanticTopK -> rerank -> second pass, so worst-case latency is the SUM of the per-lane budgets, and `RETRIEVAL_DEGRADATION` (`src/core/search/retrieval-trail.ts:68-144`) has no latency entry.

Decisions:

1. **`search_hybrid_deadline_ms`, default 15000** (env `OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE`, mirroring the `embedding_timeout_ms` resolution at `index.ts:585-587`). The default sits at the sum of the two named lane budgets (10s embed + 5s rerank): normal operations never reach it, both budgeted lanes keep their own earlier timeouts, and the deadline's real job is bounding the phases with no budget of their own (semanticTopK, second-pass coverage retry) and pathological sums. Upstream's 8s default is rejected in variants.md.
2. **Enforced at the composite entry** (`src/core/search/search.ts:48` with plumbing through `src/core/search/pipeline/request.ts`), passed down as a deadline over the AbortSignal seam that already threads through both embedding providers.
3. **On expiry: keyword-only partial results**, byte-for-byte the provider-unavailable degrade's shape, plus ONE new closed-vocabulary entry `hybridDeadlineExceeded` with structured detail `{ elapsedMs, budgetMs }`. Every exhaustive consumer of the `RETRIEVAL_DEGRADATION` union is updated (the union type at :142-144 makes omissions compile errors). No free-form strings.

### t_3477c9e8 - Registered-command resolvability check (CORRECTED)

Premise verdict: the card's stale-absolute-path premise and mcp-config parser are both wrong (payload registers bare `o2b`, `src/core/install/payload.ts:26`; `McpServerEntry` carries no command and `findConfigFiles` is vault-tree-scoped). The buildable shape: a read-only probe over `install.lock.json` (`readManifest`, `src/core/install/manifest.ts:40`; `ManifestEntry.config_path`, `src/core/install/types.ts:110`), re-reading each recorded config, extracting the registered OSB `command`/`args` (OSB keys via `src/core/install/json-merge.ts`), and probing resolvability. `healCliSymlinks` only heals dangling links into the plugin cache, so the gap is real.

Decisions:

1. **A readiness probe, not a `doctor()` CheckResult.** Plain `doctor` is byte-stable by contract and bundled into openclaw with import policing (`src/core/doctor-hermes-parity.ts:9-20`, `tests/openclaw/bundle.test.ts`); the readiness registry (`src/core/doctor-readiness.ts:609-611` `DEFAULT_PROBES`) already carries the pass/fail/skipped/unknown vocabulary (:131-140) and the `DOCTOR_EXIT.probeIncomplete` wiring. New probe `probeRegisteredCommands` beside `probeInstalledRuntimes` (:518).
2. **Resolution semantics bounded against false alarms.** Absolute/relative/script paths: `existsSync` - a proved-absent path is a `fail` (recovery line `o2b install <target> --apply`, same fix_hint convention as aider verify). Bare names: probed against the doctor's own PATH (and PATHEXT on win32) - an unresolved bare name is `unknown` with detail saying the host client's spawn PATH may still resolve it, never a `fail` (the false-alarm bound the premise demanded). Grok's `bun run <repo>/src/cli/main.ts` is ONE finding class whose detail distinguishes bun-unresolvable from script-absent (the `cliArgs` prefix-strip at `payload.ts:112` is reused to interpret args). Entries with `config_path: null` (e.g. pi's skill symlink) are `skipped` with a named reason - nothing-to-probe is a verdict, not silence.
3. **Aggregation:** one probe verdict, worst-of with `fail` > `unknown` > `skipped` > `pass`, and a per-entry table in the detail. No brain-doctor code is minted, so no DIAGNOSTIC_SIGNALS/exit-census obligations attach (that regime is for brain-doctor codes only).
4. The resolvability probe is a new pure helper (`src/core/install/command-probe.ts`) so it is unit-testable without a vault.

### t_ff8bb8a8 - Dangling merged_into pointers (CONFIRMED)

Premise verdict: only `lint --consolidate` reads the field; a dangling pointer excludes the page from dedup candidacy forever (`isMergeResolved` is pointer-presence, `page-id.ts:109`) with nothing naming it; lint silently rewrites links THROUGH a dangling id (`resolveCanonicalId` returns it without throwing, :211); the over-deep half already surfaces via lint's `unresolved` list; and `walkMergeChain`/`filePointerLookup` are module-private while `resolveCanonicalId` reports by throwing.

Decisions:

1. **A brain-doctor check module** (`src/core/brain/doctor/merge-chain-check.ts`), reporting-only, its own read pass over pref-/ret- files (the pointer namespace, `page-id.ts:120`) using `readMergedInto` (:56) - `PreferenceRecord` carries no raw frontmatter, and the card's known-cost note says the check needs its own pass.
2. **One exported walk helper** added to `page-id.ts` (one-file change): an exported function returning the walk outcome (terminal-at-dangling vs real terminal vs DEPTH/CYCLE/MALFORMED) instead of throwing, so the check needs no try/catch gymnastics and `resolveCanonicalId`'s throw-based contract stays untouched for lint.
3. **Dangliness test:** pointer target id has no file (`pageIdToPath` + `existsSync` logic already in page-id.ts:126-152 - exposed, not duplicated).
4. **Registration:** one new stable code `merge-chain-dangling` in `DIAGNOSTIC_SIGNALS` (`src/core/brain/diagnostics.ts:127`) with an EXCLUSION row in `DOCTOR_EXIT_EXCLUSIONS` (`src/core/brain/doctor-exits.ts:335`) - repair is a content judgement (re-point, un-merge, or restore the canonical) per the admission rules at :17-33, so no structural command can be named honestly. The exit census (`tests/core/brain/doctor-exit-census.test.ts`) enforces exactly one of the two and stays green.
5. **Over-deep chains: no second code.** The DEPTH class already appears in `o2b brain lint`'s unresolved list; a doctor code for it would duplicate a visible finding. Refusal recorded.

### t_9d155d0e - Honest maintenance reporting (CORRECTED)

Premise verdict: the card's "why" is false (dream is synchronous and model-free, `src/core/brain/dream.ts:171`); what survives is (1) an errored-distinct exit keyed off the lane's own rows and (2) honest spend accounting on the embedding backfill/reindex surface (`estimateCostUsd`/`evaluateCostGate`, `src/core/search/embeddings/signature.ts:220,240-253`; gate wired at `src/core/search/indexer.ts:983-994`; lane rows distinguish `timed_out`/`refused`/`error` at `src/core/brain/maintenance/lane.ts:226-233`; precedence collapses everything attempted into `failed: 1` at `src/cli/brain/verbs/maintenance.ts:377-381`).

Decisions:

1. **`MAINTENANCE_EXIT.probeIncomplete = 6`**, triggered ONLY by rows with `timed_out: true` (a safeguard-timeout pass is the docblock's own "could not find out": the task was killed mid-run, its outcome is unmeasurable). Deterministic task failures stay `failed: 1`. Precedence becomes `failed(1)` > `probeIncomplete(6)` > `refused(7)` > `ok(0)` - an attempted-but-unmeasured pass outranks a refusal (something ran), and a proved failure still outranks both. The :60-84 docblock table is updated with the reasoning; the wave exit-code table above is preserved with no new number.
2. **Pre-spend banner:** when the run includes the reindex task and embeddings are pending (the store census reports chunks without embeddings, or the model/signature changed), the maintenance verb prints one line before the pass naming the resolved model and the cost-kernel estimate - including when the gate is 0 (the estimate is information, not only a refusal message).
3. **After-spend receipt:** the run appends a per-run receipt (model, tokens, estimated USD, forced-bypass flag when `--force-cost` overrode a positive gate) to the lane journal row and an `appendMetric` payload (`maintenance.ts:279-291` pattern). Per-run, not per-task: one embedding pass rides one reindex task, and the journal row is the audit unit the lane already renders.
4. **Refusals:** no stop-early policy flag (the lane deliberately runs every task regardless of prior failures, `lane.ts:348-402` - changing that is a maintenance-semantics decision with no defect behind it), no resume command and no budget supervisor (validator: an LLM spend loop must not enter the kernel), no new dry-run estimate mode (`o2b search vector-backfill` is already dry-run-by-default and idempotent - a second estimate mode would be one rule, two spellings). `--force-cost` bypass is recorded in the receipt (cheap, honest).

### t_c00cc548 - Functional self-test harness (CONFIRMED)

Premise verdict: two of eight doctor checks are functional write probes; none exercises store init/migrate/index/search/concurrent-write; no self-test harness exists; `brain_eval` is read-only against the ACTIVE vault (report-shape precedent, not the harness).

Decisions:

1. **A new CLI verb `o2b doctor selftest`** - not a readiness probe (a full store roundtrip is the heaviest probe imaginable and would need a probe budget that defeats the per-probe timeout design), not inside `doctor()` (byte-stability contract + openclaw bundle constraint). New core module `src/core/doctor-selftest.ts`, verb wired in `src/cli/main.ts`.
2. **Stages, in order, on throwaway storage only** (every write path asserts vault identity first, so the harness creates its own temp vault/config): temp vault creation -> `Store.open` on a temp config (init + migration path) -> `upsertDocument` + a real index pass via the public `indexVault` entry -> a store-level keyword/trigram query roundtrip -> concurrent writers via `writer-lock.ts` -> `deleteDocument` -> close. The harness reports the WAL mode it actually measured (lifecycle downgrades on network filesystems, `store/lifecycle.ts:74-96`).
3. **Stable JSON envelope:** per-stage entries in the doctor `CheckResult` shape (name/ok/message/fix) plus a machine-readable summary with a warnings count, following the `brain_eval` metric-block precedent. A timed query loop over the temp store gives the local performance measurement without external benchmark dependencies.
4. **Exit codes reuse `DOCTOR_EXIT`:** ok 0; any stage failure 1; the harness itself could not run (temp storage unavailable) 6. No new numbers (wave table).

### t_7c01bb39 - Write-back contract audit, CHECK-ONLY (CORRECTED)

Premise verdict: the runtime machinery and the idempotent managed-block trio all exist (`HOST_MEMORY_WRITE_KIND` `host-memory-write.ts:31`; `MARKER_WRITEBACK_GUARDRAIL` now at `marker-writeback.ts:70`; `insertManagedBlock`/`removeManagedBlock`/`hasManagedBlock`/`extractManagedBlock`, `src/core/install/managed-block.ts:105,139,174,189`); what is missing is any assertion that an agent-instruction file CONTAINS a same-turn atomic-fact write gate, and no adapter references AGENTS.md/CLAUDE.md. The symlink guard does not exist anywhere on this lane and must be written even for a read-only check. Repair belongs to t_af5e252f.

Decisions:

1. **One workspace-level readiness probe (`probeWritebackContract`), not a per-adapter VerifyResult field** - a per-adapter check multiplies by the 11 registered adapters and would require extending the closed `VerifyStatus` union cross-adapter; the card's own open question (AGENTS.md only vs every adapter) dissolves at workspace level.
2. **File scope: the workspace agent-instruction file(s), AGENTS.md first**, located via the agent-source query machinery (`src/core/brain/agent-source/`) or the adapter env's workspace dirs; each candidate file is read with an lstat guard that REFUSES symlinks (the guard written here even though the write lane is out of scope).
3. **The gate contract:** a marker-delimited OSB managed block is present (`hasManagedBlock`/`extractManagedBlock`) AND its extracted body matches the same-turn atomic-fact write-gate contract, expressed in the marker-writeback guardrail's own vocabulary (`marker-writeback.ts:70`) so the check and the runtime refuse in the same words. Regex/keyword contract against the extracted block, not a semantic assertion.
4. **Verdict vocabulary:** file absent -> `skipped` (nothing installed is not a contract violation); present-without-gate -> `fail`; unreadable or symlink -> `unknown` (evidence about the probe, not the surface - the doctor-readiness rule). Detail names the file and the missing piece.
5. The settled marker contract is recorded as t_af5e252f's input; no installer/repair is built here.

### t_d30c0548 - Near-duplicate report at the write boundary (CONFIRMED, corrected)

Premise verdict: write-time near-dup reporting ships for the feedback path only (`adviseIncomingFeedback`, `src/core/brain/write-advisory.ts:132`, non-gating, jaccard via shared primitives `src/core/brain/similarity.ts:13,22,59`); note/page writes get none; the write boundary that already exists is `page-lint.ts` ("per-page write-time lint", attached to every MCP note receipt via `noteWriteResult`, `src/mcp/brain/notes-tools.ts:482-486`, never gating, no near-duplicate detector); no body normalization exists anywhere on the write seams.

Decisions:

1. **Seam: `page-lint.ts`**, not a third write-advisory. The near-duplicate report must be universal to note writes (the advisory's log-event shape is per-family); page-lint already rides every receipt, already never gates, and already has the skip/truncate accounting and exclusion-list pattern to scope a new detector in.
2. **Finding:** `near-duplicate` - the authored body compared against the candidate set (pages in the same directory AND same composite scope bucket, `compositeScopeKey` over `owner|session|project`, `src/core/scope-key.ts:86` - a bounded, deterministic candidate set per write) using `tokenise`/`jaccard` from the shared similarity module. Evidence carries the resembling paths and scores. Frontmatter untouched.
3. **Threshold: `NEAR_DUPLICATE_JACCARD = 0.8`, a named constant in page-lint.ts, not config.** The 0.5 precedent (`BRAIN_HEALTH_DEFAULTS.contradiction_jaccard`, `policy/blocks/health.ts:54`) answers a different claim ("same subject"); near-DUPLICATE claims near-identity and needs the deliberately-high bar the tree already uses for dedup-adjacent defaults (`ENTITY_DEDUP_EMBEDDING_THRESHOLD = 0.92`). Evidence includes the score so an operator judgement call is informed; if real-world noise appears, promoting the constant to config is a one-line follow-up.
4. **Body normalization: dropped** (recorded refusal). No demonstrated-safe normalization set exists (whitespace collapse, smart-quote folding and trailing-space trim all change authored bytes that receipts, dedup and byte-stability tests pin); page-lint's scope is authored-content-only; a normalization half without a concrete defect is risk without a customer.

### t_7bad7ad8 - Slug-collision hygiene detector (CORRECTED)

Premise verdict: the quiet-data-loss premise is refuted - exclusive-create allocation with a suffix ladder (`allocateAndCreate`, `src/core/brain/paths.ts:1063-1095`), caller-named refusals (`CreateNoteError("exists")` create-note.ts:584, `destination_occupied` lifecycle.ts:780,881), deterministic bounded slugify with a hash fallback (`vault.ts:542-556`). What remains is informational: suffixed stems with no explanation. Detector registry has FOUR members (`HYGIENE_DETECTOR_IDS`, `src/core/brain/hygiene/types.ts:12`; `scan.ts:24-29`).

Decisions:

1. **New detector `detectors/slug-collisions.ts`**: walk vault pages, group by `slugify(basename-without-.md)` WITHIN each directory (cross-directory same-stem is not a collision on this write path - OSB never flattens), emit one finding per group of size >= 2 naming the shared stem and member paths. `severity: "info"`, `proposed_action: "review"`, finding id via the shared `hygieneFindingId`. Brain-prefix allocations (pref-/sig-/cap-/ret-) enter via their final basenames; the detector is read-only over what landed and never re-runs allocation logic.
2. **Registration = three edits** (append to `HYGIENE_DETECTOR_IDS` - the tuple drives the applier capability check and the type - plus the `DETECTORS` entry, plus the file), exactly the pattern the registry documents.
3. **Default scan: ON.** The detector is low-noise (fires only on actual collisions), so it joins the default sweep. This task introduces the mechanism: a `DEFAULT_SCAN_IDS` list in the hygiene module that `runHygieneScan` uses when no subset is requested, distinct from the all-registered `HYGIENE_DETECTOR_IDS` - the mechanism Task 14 needs to keep the tags detector opt-in.
4. **Lost-race `-2` pairs are reported** (info, evidence carries mtimes): the detector cannot distinguish a lost race from an accidental duplicate, so the operator decides. Unicode folding is deliberately NOT an extra edge case - folding lands as `topic.md` + `topic-2.md`, which the detector already reports, and pre-collision folding inside `slugify` would break allocation regression tests.

### t_23bd347d - Hub candidate at intake (CORRECTED; deterministic hub rule adopted)

Premise verdict: the write lane exists (`repair-lane.ts` proposes AND writes behind dry-run default + confirm phrase + holdout gate + write cap + convergence); the gap is "not triggered at intake"; there is NO area->hub resolver to reuse (hub selection is new work); the natural trigger is the inbox-drain route (staging is pre-corpus), and routed idea pages land flat at `captured/<slug>.md` (`inbox-drain.ts:43,173`). `runRepairLane` accepts external candidates (:218-222) and `collectedRefusals` (:150-157) carries upstream refusals verbatim.

Decisions - **option (a) with the premise's deterministic hub-selection rule adopted in full** (source reading confirms every seam):

1. **Trigger:** after a successful IDEA-route `execute()` in an apply-mode drain (the moment the capture becomes a corpus page). Obligations and source-reference routes are excluded this wave (recorded; the extension point is the same post-route hook).
2. **Hub pool:** durable-memory corpus pages (the same population the repair lane's `loadPages` reads) that pass the moc-audit structural predicate, extracted as an exported `isHubBody(body, thresholds)` beside `auditMoc` (`moc-audit.ts:104-121`: outbound unique targets >= `minOutbound` AND link-ratio >= `minRatio` from `resolveLinkGraph` config) so the audit and the selection share ONE definition of hub.
3. **Scope restriction:** the pool is restricted to hubs in the routed page's scope bucket (`compositeScopeKey` over `owner|session|project`, `src/core/scope-key.ts:86`). A scopeless captured page matches scopeless hubs only - conservative and deterministic.
4. **Exactly-one decision** via the shared kernel `resolveUniqueMatch` (`src/core/graph/unique-match.ts:32`): `unique` -> emit a candidate (source: routed page, target: hub, strength: new `areaMembership` tier slotted between `sameTopicEvidence` and `inferred` in `IDENTITY_STRENGTH`/`STRENGTH_RANK` - area membership is structural evidence, not a textual mention and not opt-in inference; confidence: the deterministic constant 1.0; reason: names the hub path); `none` -> refusal `action: "skip-no-hub"` naming the scope bucket (NO auto-created hub - hub creation is `materializeClusterNotes`' gated job); `ambiguous` -> refusal `action: "skip-ambiguous-hub"` listing every candidate hub path in first-occurrence order. Degree-based tie-breaking is explicitly REJECTED (it would make the target depend on index state at drain time). Both refusal actions are new members of the closed `RepairAction` union, riding `collectedRefusals` verbatim.
5. **Persistence:** candidates and refusals append to a JSONL file under `Brain/.state/` (the internal machinery dir, `BRAIN_INTERNAL_STATE_DIR`) that the `o2b brain repair-lane` CLI merges with its graph-collected candidates - a small extension to the CLI verb, keeping `runRepairLane`'s contract unchanged. **Zero new write paths:** the edge lands only through the lane's apply + confirm phrase + holdout gate; idempotence comes free from the forward scan and rerun convergence.

### t_c8508241 - Tags hygiene detector over the shared TAG_RE (CORRECTED; standalone this wave)

Premise verdict: the detector registry has FOUR members (both the card's list and the validator's "five" are wrong); a fence-aware, CHECK-constrained, recall-consumed tag parser ships at `TAG_RE` (`src/core/search/links.ts:42`) and must become THE shared rule; a malformed tag is silently absent from the link table (index-side loss); the links table carries inline body tags only (frontmatter `tags:` arrays are extracted nowhere in the search layer).

Decisions:

1. **One shared definition:** `TAG_RE` and the tag extraction over cleaned text move from `src/core/search/links.ts` into a new `src/core/tags.ts` (a core-level module both layers can import without a brain->search dependency); `links.ts` re-imports it, so the incumbent regex remains the one definition - not copied. `tests/core/search/links.test.ts` stays green byte-identically.
2. **Detector `detectors/tags.ts`**, registered by the same three-edit pattern, with three finding classes: (a) **malformed** - body `#...` tokens a looser Obsidian-compatible rule would accept but TAG_RE rejects; the detector holds the Obsidian-side rule and REPORTS THE DIFF (the tag the index will never match); TAG_RE itself is NOT widened this wave (recorded refusal: an index-semantics change with reindex gating does not ride a hygiene wave); (b) **inconsistent** - same tag differing only by case or hierarchy depth (`#Foo` vs `#foo`, `#a/b` vs `#a`); (c) **orphan** - a tag value appearing on exactly one document with no cross-document sharing, computed vault-wide from prose re-extraction (not from the links table, which by construction cannot hold the malformed tags this detector exists to find). All at `severity: "info"`, `proposed_action: "review"`.
3. **Opt-in: default-OFF** via the `DEFAULT_SCAN_IDS` mechanism Task 12 introduces - the tags detector is registered but excluded from the default sweep (noisy on vaults that use tags loosely, per the card). The report header states the prose-only scope.
4. **Frontmatter `tags:` arrays: OUT** (recorded) - list-field parsing is a different reader than TAG_RE-over-prose; "vault-wide" is scoped to inline body tags and the report says so.
5. **Coordination note:** this is the detection-only lint half of board sibling t_11ee559f (write-time tag syntax validation, not in this wave); the shared `src/core/tags.ts` module is the seam that task must consume. Schema-pack vocabulary (t_151a564c, t_71cbf5bf) stays out of scope.

### t_5f7e0dcd - CJK-aware chunker (REFUTED - verdict recorded, not planned)

The whitespace-only chunker the card describes was replaced by chunker v2 in v1.58.0 (commit 6f33c424, "payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0) (#197)", 2026-09-26) - two weeks after the card's 2026-09-12 triage. `countTokens` counts each code point of an unspaced script as its own token (`UNSPACED_RE`, `chunker.ts:85-88,107-160`), `takeOverlap` cuts intra-line at token boundaries when a single line exceeds the budget (`:373-393`), overlap stays inside the budget, and `CHUNKER_VERSION = 2` forces re-chunk on upgrade. Eleven pinning tests live in `tests/core/search/chunker-dense-scripts.test.ts`. The premise was true when triaged and is false now. What legitimately remains is the card's "also observed" cost-surface follow-up (`estimateTokens` chars/4 at `signature.ts:84-91` vs the already CJK-aware store census, and `brain_token_impact`) - recorded as a future lane, not planned here.

### t_4bccd70a - Stable note identity (CORRECTED-NARROWED - verdict recorded, no feature)

The card's headline gap is refuted by the live source: `noteLifecycle` + `retargetWikilinks` (`src/core/brain/notes/lifecycle.ts:851,906,1027-1031`; `src/core/brain/page-dedup.ts:481`) already ship the gated rename-time inbound-wikilink rewrite (probe -> guards -> apply -> named failures -> IndexEvidence), since at least v1.58.1. The verified residue is not worth a wave feature, and the verdict is recorded explicitly:

1. **docId instability across moves:** the path-keyed row is deleted and re-added on a move, but everything keyed by docId is re-derived from note text on every re-index (`replaceChunks`/`replaceLinks`/`replaceEntities`/`replaceAliases`, indexer.ts:506-551) - the loss is provenance, not correctness, and the index is self-consistent after the next pass.
2. **Index staleness between rename and re-index:** reported, not hidden - `IndexEvidence` (`lifecycle.ts:1048-1060`) names the last pass and the reconciling command. This is shipped behavior, not a gap.
3. **Path-keyed provenance outside the derived index** (Brain/log note-write events, Brain/pinned content) does not follow the file. The log is append-only BY DESIGN and its events are honest history (a write event records the then-current path - it does not become a lie when the file later moves); making readers resolve through move events is a FEATURE (write-record revert lookups following renames), not a defect fix, and it needs its own design (event kind, reader resolution, retention). The recorded future shape: at `noteLifecycle` apply time, emit an additive old->new log event, and let provenance readers resolve through the latest such event. The alternative - a `documents.reid_map` old->new id table - is REFUSED: a schema change purely for provenance, when docId re-derivation already keeps the index self-consistent.

## Design decisions summary (non-obvious calls)

- One migration carries all three new `documents` columns (event-time bounds + pinned) so `schema.ts` has a single owner task and the migration ladder stays linear.
- The `?` sentinel keeps its rendering; the EQUALITY decision points learn that unknown identity never compares equal - the warn-consistent fix, per the `embedding_abi: warn` reasoned default.
- The maintenance errored case is named and numbered `probeIncomplete: 6`, not a fresh number: the docblock's own reasoning (7 exists because "this run found out precisely") proves a timeout is the 6 case.
- The hybrid deadline default (15000) sits at the sum of the named lane budgets so it bounds unbudgeted phases without cutting budgeted ones mid-flight.
- The pinned boost is always-on and bounded (reinforce pattern); the relational pin and boost gate are config-gated opt-ins (behavior modes). Different kinds of change, different default policy.
- Hygiene gains a `DEFAULT_SCAN_IDS` layer: slug-collisions joins the default sweep (low-noise), tags stays opt-in (noisy) - one mechanism, two policies, both explicit.
- The hub rule resolves with the shared exactly-one kernel and refuses auto-hub-creation and tie-breaking alike; ambiguity is surfaced, never resolved silently.

## File changes

New files: `src/core/install/command-probe.ts`, `src/core/brain/doctor/merge-chain-check.ts`, `src/core/doctor-selftest.ts`, `src/core/brain/writeback-contract.ts`, `src/core/brain/link-graph/hub-candidates.ts`, `src/core/brain/hygiene/detectors/slug-collisions.ts`, `src/core/brain/hygiene/detectors/tags.ts`, `src/core/tags.ts`, plus their test files (paths in plan.md).

Modified files: `src/core/search/schema.ts`, `src/core/search/store/documents.ts`, `src/core/search/store/counts.ts`, `src/core/search/store/vectors.ts`, `src/core/search/embeddings/signature.ts`, `src/core/search/indexer.ts`, `src/core/search/ranker.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`, `src/core/search/search.ts`, `src/core/search/retrieval-trail.ts`, `src/core/search/pipeline/event-time.ts`, `src/core/search/pipeline/request.ts`, `src/core/search/pipeline/assemble.ts`, `src/core/search/links.ts`, `src/core/brain/preference.ts`, `src/core/doctor-readiness.ts`, `src/core/brain/page-meta/page-id.ts`, `src/core/brain/diagnostics.ts`, `src/core/brain/doctor-exits.ts`, `src/core/brain/maintenance/lane.ts`, `src/cli/brain/verbs/maintenance.ts`, `src/cli/main.ts`, `src/core/brain/page-lint.ts`, `src/core/brain/hygiene/types.ts`, `src/core/brain/hygiene/scan.ts`, `src/core/brain/link-graph/moc-audit.ts`, `src/core/brain/link-graph/repair-lane.ts`, `src/core/brain/capture/inbox-drain.ts`, `src/cli/brain/verbs/repair-lane.ts`.

## Risks and open questions

- **Anchors drift.** Line anchors in this doc were verified 2026-09-30 against this worktree; the tree moved ~15-25 lines under v1.62/v1.63 alone. Re-pin at implementation time from the symbol names, not the line numbers.
- **Two registration regimes must not be conflated:** brain-doctor codes are policed by the exit census (DIAGNOSTIC_SIGNALS vs DOCTOR_EXIT_EXCLUSIONS); core doctor/readiness CheckResults are not. Task 7's finding lands in the first regime (with its exclusion row), Tasks 6/10's in the second.
- **The bundle constraint** (`src/core/doctor.ts` is bundled into openclaw/index.js with import policing) is why Tasks 9/10 are separate modules and not `doctor()` checks.
- **The pinned boost and the boost gate both edit the ranker's caps/reasons regions** - that is why Tasks 3 and 5 are sequenced, not parallel (plan.md).
- **The near-duplicate candidate set** (same directory + same scope bucket) is a precision/recall trade made without a corpus benchmark; evidence carries scores, and the threshold is a named constant precisely so tuning is a one-line change.
- **The tags malformed class** requires the detector to hold the looser Obsidian-side rule. If the diff on real vaults turns out to be dominated by exotic tokens, widening TAG_RE (with its reindex gate) becomes the honest follow-up - deliberately deferred, not forgotten.
