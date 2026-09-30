# Search, diagnostics and vault hygiene wave - implementation plan

Fourteen tasks carrying fourteen cards (t_5f7e0dcd REFUTED and t_4bccd70a narrowed-verdict record no tasks; t_f7bef96a ships its pinned half only, and t_9e1a4b3f's indexer persistence rides Task 3 because it edits the same document loop as the pinned read). Each task is one atomic commit, test-first. Line anchors are from the 2026-09-30 premise verification - re-pin from symbol names at build time.

## Parallelism and file ownership

Groups run in order: **Group 1 -> Group 2 -> (Group 3 ∥ Group 4)**. Inside a group, tasks marked **∥** run in parallel and are safe ONLY because their file sets are disjoint; the file-ownership boundary is named per task. Two tasks in the same group must never touch the same file; where a file is needed by two tasks, they are sequenced instead. Groups 3 and 4 are mutually disjoint and run as two parallel lanes.

House rules for every task: write the failing tests first and watch them fail with the expected error; keep the pinned-behavior tests listed per task green (`bun test`); run the project formatter and linter before every commit.

---

## Group 1 - store/schema + integrity (must land first)

### Task 1: documents migration - event-time bounds + pinned column + window census
- **Cards**: t_9e1a4b3f (+ the schema half of t_f7bef96a's pinned surface)
- **Files**: `src/core/search/schema.ts` (next `MIGRATIONS` version: nullable `documents.event_time_min`, `documents.event_time_max`, `documents.pinned`); `src/core/search/store/documents.ts` (`DocumentInput` gains OPTIONAL `eventTimeMinMs`/`eventTimeMaxMs`/`pinned` so existing callers compile; `upsertDocument` persists them); `src/core/search/store/counts.ts` (new `eventTimeWindowCensus(db, sinceMs, untilMs)` -> `{ documents, declared, intersecting, mtimeFallback }`, one SQL aggregate, open-start/open-end null cases handled); `src/core/search/pipeline/event-time.ts` (export the pure per-document resolver `resolveDocumentEventTimeWindow(frontmatter, anchor): ValidityWindow | null` implementing the shared rung order - frontmatter validity window > event anchor (admitted rungs only) > null - and re-point the query-side `EventTimeResolver` internals at it so index-time and query-time cannot drift)
- **Tests first**: `tests/core/search/store.event-time-census.test.ts` (new) - migration applies on a fresh DB and on a v(n-1) DB with rows (lazy backfill leaves nulls); `upsertDocument` round-trips the three columns; census counts declared/intersecting/mtimeFallback correctly for closed, open-start and open-end windows; rung order respected (frontmatter beats anchor beats null)
- **Definition of done**: existing store/schema tests green (`tests/core/search/store.test.ts`, schema migration tests); `StoreCounts` shape unchanged; census answers the window question without hydrating rows
- **Depends on**: none
- **File-ownership boundary**: Task 1 owns `schema.ts`, `store/documents.ts`, `store/counts.ts`, `pipeline/event-time.ts` inside Group 1. **∥ parallel with Task 2** (disjoint sets).

### Task 2: `?`-sentinel signature fix + verify-before-replace gate
- **Card**: t_2fbdaf70
- **Files**: `src/core/search/embeddings/signature.ts` (export `signatureIdentityKnown(sig): boolean` - true iff no `?` sentinel in the model/dimension fields; re-express `isStaleSignature` so an unknown-identity signature is stale against everything, including itself); `src/core/search/indexer.ts` (ONLY the staging region :1162-1199: `reindexStagingSignature` renders an unknown-identity embedding component as a distinct non-resumable marker so staging under unknown identity always rebuilds; docblock states the rule); `src/core/search/store/vectors.ts` (`ensureEmbeddingModel` gains the verify-before-replace gate: before `clearEmbeddings`, assert pending rebuildability - affected corpus has chunks rows AND `resolveSemanticCapability` (from `src/core/search/capability-tier.ts`, the resolver `vector-backfill.ts:116` already uses) is not blocked; refuse with a named error when it cannot; named-model -> null-model transition logs a one-line warning naming the last model and does NOT clear); `src/core/search/embeddings/provider-semaphore.ts` (docblock note only: key already appends the endpoint, verified not fooled)
- **Tests first**: extend `tests/core/search/embeddings.signature.test.ts` (two distinct unknown-identity signatures are never compatible; known-vs-unknown never compatible; known-vs-known unchanged); extend `tests/core/search/store.vec.test.ts` + new `tests/core/search/embedding-model-gate.test.ts` - model change with a blocked capability tier refuses the clear and keeps the old vectors; model change with a configured provider clears as today; named->null transition warns and keeps vectors; staging signature under unknown identity never resumes
- **Definition of done**: `embedding_abi` tests green unchanged (`tests/core/search/embedding-abi.test.ts`, `tests/mcp/embedding-abi-visibility.test.ts` - warn default untouched); staging-resume tests green; no clear path can destroy embeddings that cannot be rebuilt
- **Depends on**: none
- **File-ownership boundary**: Task 2 owns `signature.ts`, `store/vectors.ts`, and the staging region of `indexer.ts` inside Group 1.

---

## Group 2 - ranking/recall (after Group 1)

### Task 3: index-time signal persistence + pinned ranking boost
- **Cards**: t_f7bef96a (kept half) + the indexer half of t_9e1a4b3f
- **Files**: `src/core/brain/preference.ts` (export the `pinned` coercion - export `parsePinned` as-is, no duplicate); `src/core/search/indexer.ts` (document loop: read `pinned` from frontmatter and resolve the event-time window via Task 1's `resolveDocumentEventTimeWindow` using the already-parsed frontmatter + materialized anchor; pass both into `upsertDocument`); `src/core/search/ranker.ts` (new bounded `PINNED_BOOST_CAP = 0.05` in the :110-138 caps block; a pinned additive layer over a pinned-doc lookup in `RankerInputs`; `buildReasons`/`buildBreakdown` entries)
- **Tests first**: `tests/core/search/pinned-boost.test.ts` (new) - a pinned document outranks its unpinned self by at most the cap; BM25 lead preserved (`tests/core/search/rank-clock-determinism.test.ts` constants untouched); reasons/breakdown name the layer; unpinned behavior byte-identical; extend indexer/store tests - a note with `pinned: true` frontmatter persists `documents.pinned = 1`, changed frontmatter re-persists, `pinned: "true"` string form coerces
- **Definition of done**: `tests/core/search/keyword-lane-top-score.test.ts` and `tests/core/search/rank-clock-determinism.test.ts` green; event-time bounds populate on next index of changed documents (census `mtimeFallback` bucket shrinks); preference-note pinned flag reaches ranking end to end
- **Depends on**: Task 1 (columns + resolver), Group 1 complete
- **File-ownership boundary**: Task 3 owns `indexer.ts` (document loop + stats) and `ranker.ts` inside Group 2. **∥ parallel with Task 4** (disjoint sets).

### Task 4: composite hybrid deadline + typed degradation code
- **Card**: t_bdc24171
- **Files**: `src/core/search/index.ts` (`search_hybrid_deadline_ms` config, default 15000, env `OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE`, validated like `embedding_timeout_ms` at :403/:585-587); `src/core/search/search.ts` (composite deadline created at entry, passed down); `src/core/search/pipeline/request.ts` (deadline plumbing onto the existing AbortSignal seam); `src/core/search/retrieval-trail.ts` (new closed-vocabulary entry `hybridDeadlineExceeded` with detail `{ elapsedMs, budgetMs }`; union type at :142-144 updated)
- **Tests first**: `tests/core/search/hybrid-deadline.test.ts` (new) - a stalled semantic lane past the budget yields keyword-only results byte-shaped like the provider-unavailable degrade; the degradation carries the code and the elapsed/budget detail; deadline 0/off and the default keep normal-path results byte-identical; every exhaustive consumer of `RETRIEVAL_DEGRADATION` still compiles (update the switch consumers the compiler names)
- **Definition of done**: `tests/core/search/semantic-degrade-quota.test.ts`, `tests/core/search/semantic-explicit-blocked.test.ts`, `tests/core/search/search.test.ts` green; worst-case composite latency bounded by the budget; no free-form degradation strings
- **Depends on**: Group 1 complete (no schema need, but lands after to keep Group 1 first per the wave order)
- **File-ownership boundary**: Task 4 owns `search.ts`, `retrieval-trail.ts`, `index.ts`, `pipeline/request.ts` inside Group 2. **∥ parallel with Task 3**.

### Task 5: relational rerank pin + metadata-boost lexical gate
- **Card**: t_d9f863e9
- **Files**: `src/core/search/index.ts` (two config keys following the `search_relational_arm_enabled` pattern at :861-869: `search_metadata_boost_gate`, `search_relational_rerank_pin`, both default false); `src/core/search/ranker.ts` (boost gate: when `inputs.keyword` is empty and the gate is on, every additive metadata/structural boost layer contributes 0; `buildReasons`/`buildBreakdown` report "gated: no lexical vote"); `src/core/search/pipeline/assemble.ts` (cross-encoder hand-off :212-262: when the pin is on, relational-origin candidates are floored at their pre-rerank heuristic position after rerank ordering - they may rise, never sink; the `minScore` floor applies unchanged); `src/core/search/types.ts` (option/config plumbing for the pin)
- **Tests first**: `tests/core/search/metadata-boost-gate.test.ts` (new) - a vector-only query (empty keyword lane) with the gate on ranks identically to boost-free ranking and says why in the receipts; a query with one keyword hit leaves boosts fully intact; gate off keeps today's behavior byte-identical; `tests/core/search/relational-rerank-pin.test.ts` (new) - with rerank on and the pin on, a relational-origin candidate never lands below its pre-rerank position; may rise; pin off keeps rerank behavior byte-identical
- **Definition of done**: `tests/core/search/keyword-lane-top-score.test.ts`, `tests/core/search/rank-clock-determinism.test.ts`, `tests/core/search/relational-arm.test.ts`, `tests/core/search/rerank.test.ts`, `tests/core/search/rerank.config.test.ts` all green; both guards off by default (byte-identical default pipeline)
- **Depends on**: Task 3 and Task 4 (owns `ranker.ts` and `index.ts` after both)
- **File-ownership boundary**: Task 5 is the only Group 2 task allowed to touch `ranker.ts` + `index.ts` after the parallel pair lands.

---

## Group 3 - diagnostics/doctor (parallel lane; also after Group 2)

### Task 6: registered-command resolvability readiness probe
- **Card**: t_3477c9e8
- **Files**: `src/core/install/command-probe.ts` (new, pure: absolute/relative/script paths via `existsSync`; bare names via PATH + win32 PATHEXT; `cliArgs` from `payload.ts:112` reused to strip `cmd /d /c`; returns a typed verdict per entry); `src/core/doctor-readiness.ts` (new probe `probeRegisteredCommands` beside `probeInstalledRuntimes` :518, registered in `DEFAULT_PROBES` :609-611: enumerate `readManifest(vault)` entries, skip `config_path: null` with a named "nothing to probe" verdict, re-read each config, extract OSB `command`/`args` via the json-merge OSB keys, probe, aggregate worst-of fail > unknown > skipped > pass with a per-entry table in the detail; recovery line `o2b install <target> --apply`)
- **Tests first**: `tests/core/install/command-probe.test.ts` (new - existing absolute path, missing absolute path, bare name on/off PATH, `bun run <missing script>`, `cmd /d /c` stripping, PATHEXT on win32-shaped input); extend `tests/core/doctor-readiness.test.ts` - probe verdicts for: absent manifest, all-ok entries, one proves-absent path (fail), bare-name unresolved (unknown, detail says spawn PATH may differ), `config_path: null` (skipped)
- **Definition of done**: plain `o2b doctor` output byte-identical (probe is readiness-only); `tests/core/doctor.test.ts` and `tests/docs/install-verify-conformance.test.ts` green; no brain-doctor code minted (exit census untouched)
- **Depends on**: none inside Group 3
- **File-ownership boundary**: Task 6 owns `doctor-readiness.ts` and `install/command-probe.ts` inside Group 3. **∥ parallel with Tasks 7, 8, 9**.

### Task 7: dangling merged_into brain-doctor check
- **Card**: t_ff8bb8a8
- **Files**: `src/core/brain/page-meta/page-id.ts` (export a walk/report helper returning the outcome - dangling terminal vs real terminal vs DEPTH/CYCLE/MALFORMED - reusing the private `walkMergeChain`/`filePointerLookup` internals; `resolveCanonicalId`'s throw contract untouched); `src/core/brain/doctor/merge-chain-check.ts` (new check module: own read pass over pref-/ret- files via `readMergedInto` :56; dangliness = pointer target id has no file via the exposed `pageIdToPath` + `existsSync` logic); `src/core/brain/diagnostics.ts` (register code `merge-chain-dangling` in `DIAGNOSTIC_SIGNALS`); `src/core/brain/doctor-exits.ts` (exclusion row with reason: repair is a content judgement - re-point, un-merge or restore the canonical; admission rules :17-33)
- **Tests first**: `tests/core/brain/doctor-merge-chain.test.ts` (new - dangling pointer reported with page + target; resolved chain not reported; over-deep chain not duplicated here (lint owns DEPTH); ret-/ files in scope; unreadable dirs degrade per the records.ts sweep-sink convention); `tests/core/brain/doctor-exit-census.test.ts` stays green (registration + exclusion row present)
- **Definition of done**: a page pointing `merged_into` at a deleted canonical appears in brain-doctor output with the code; reporting-only (no writes); lint behavior unchanged (`tests/core/brain/lint-consolidate.test.ts`, `tests/cli/brain-lint.test.ts` green)
- **Depends on**: none inside Group 3
- **File-ownership boundary**: Task 7 owns `page-id.ts`, `brain/doctor/merge-chain-check.ts`, `diagnostics.ts`, `doctor-exits.ts` inside Group 3.

### Task 8: honest maintenance exit + spend banner/receipt
- **Card**: t_9d155d0e
- **Files**: `src/cli/brain/verbs/maintenance.ts` (`MAINTENANCE_EXIT.probeIncomplete = 6`; precedence arm at :377-381 becomes failed > probeIncomplete > refused > ok, keyed ONLY on rows with `timed_out: true`; docblock :60-84 updated with the reasoning; pre-spend banner line before the reindex task when embeddings are pending - resolved model + cost-kernel estimate, printed even when the gate is 0; per-run receipt appended after the pass); `src/core/brain/maintenance/lane.ts` (journal row carries the receipt fields: model, tokens, estimatedUsd, forced); `src/core/search/indexer.ts` (embedding phase accumulates a run-total `{ tokens, estimatedUsd, model, forced }` from the `evaluateCostGate` results it already computes at :983-994, exposed on `IndexStats`); `--json` rendering at `maintenance.ts:351` includes both
- **Tests first**: extend `tests/cli/brain-maintenance.test.ts` - a lane run with a `SafeguardTimeoutError` row exits 6; a deterministic task error still exits 1; timeout + refusal -> 6; error + timeout -> 1; banner appears when embeddings pending (and when gate is 0), absent when nothing pending; receipt fields present in journal row and `--json`; `--force-cost` bypass flagged in the receipt
- **Definition of done**: `tests/cli/search-check-provider.test.ts` and `tests/core/doctor-readiness.test.ts` green (the 5/6 precedent tables unchanged); no stop-early/resume surface added; no LLM spend loop in the kernel
- **Depends on**: Group 2 complete - Task 3 owns the `indexer.ts` document loop in Group 2; Task 8's stats region is a different region of the same file, so the two are sequenced to keep one owner at a time
- **File-ownership boundary**: Task 8 owns `maintenance.ts`, `lane.ts`, and the `indexer.ts` stats region inside Group 3.

### Task 9: functional self-test harness
- **Card**: t_c00cc548
- **Files**: `src/core/doctor-selftest.ts` (new, standalone - never imported by `src/core/doctor.ts`, keeping the openclaw bundle clean: temp vault + temp config -> `Store.open` (init + migration) -> `upsertDocument` + real index pass via `indexVault`/`resolveSearchConfig` -> store-level keyword/trigram query -> concurrent writers via `store/writer-lock.ts` -> `deleteDocument` -> close; reports the WAL mode actually measured (`store/lifecycle.ts:74-96`); timed query loop; per-stage `CheckResult`-shaped entries + machine-readable summary with warnings count); `src/cli/main.ts` (verb `o2b doctor selftest`; exit codes reuse `DOCTOR_EXIT`: ok 0, stage failure 1, harness could not run 6)
- **Tests first**: `tests/cli/doctor-selftest.test.ts` (new - every stage passes on a healthy machine and the JSON is stable/key-ordered; a deliberately broken stage fails with name + fix; temp vault always cleaned up even on failure; configured vault untouched - assert no writes outside the temp dir; concurrent-writer stage exercises the writer lock)
- **Definition of done**: `tests/openclaw/bundle.test.ts` green (bundle imports unchanged); report is valid JSON with stable keys across two runs; zero writes to the operator's vault
- **Depends on**: none inside Group 3
- **File-ownership boundary**: Task 9 owns `doctor-selftest.ts` and the `main.ts` verb registration inside Group 3.

### Task 10: write-back contract audit (CHECK-ONLY)
- **Card**: t_7c01bb39
- **Files**: `src/core/brain/writeback-contract.ts` (new, pure: locate the workspace agent-instruction file(s) - AGENTS.md first - via the agent-source query machinery (`src/core/brain/agent-source/`); lstat guard REFUSING symlinks; `hasManagedBlock`/`extractManagedBlock` (`src/core/install/managed-block.ts:174,189`) presence check; content contract over the extracted block expressed in the `marker-writeback.ts:70` guardrail vocabulary); `src/core/doctor-readiness.ts` (probe `probeWritebackContract`: absent file -> `skipped`, present-without-gate -> `fail`, unreadable/symlink -> `unknown` with reason; detail names the file and the missing piece)
- **Tests first**: `tests/core/brain/writeback-contract.test.ts` (new - file with a conforming block passes; file without the block fails naming it; absent file skips; symlink refused as unknown; block present but wrong content fails); extend `tests/core/doctor-readiness.test.ts` for the probe verdicts
- **Definition of done**: no repair/installer built (t_af5e252f's lane); the settled marker contract is written into the module docblock as that task's input; `tests/docs/install-verify-conformance.test.ts` green (no per-adapter changes)
- **Depends on**: Task 6 (both own `doctor-readiness.ts` - sequenced within the lane)
- **File-ownership boundary**: Task 10 takes over `doctor-readiness.ts` from Task 6 and owns `writeback-contract.ts`.

---

## Group 4 - write-path/hygiene (parallel lane; runs alongside Group 3)

### Task 11: page-lint near-duplicate finding
- **Card**: t_d30c0548
- **Files**: `src/core/brain/page-lint.ts` (new `near-duplicate` detector: authored body vs candidate set = same directory AND same composite scope bucket (`compositeScopeKey`, `src/core/scope-key.ts:86`), compared with `tokenise`/`jaccard` from `src/core/brain/similarity.ts` (imported, not duplicated); `NEAR_DUPLICATE_JACCARD = 0.8` named constant; evidence carries resembling paths + scores; wired into the existing skip/truncate accounting and exclusion-list pattern; never gates)
- **Tests first**: extend `tests/core/brain/page-lint.test.ts` - a write closely matching a same-bucket page yields the finding with paths + jaccard; a below-threshold resemblance yields nothing; a different-directory or different-scope lookalike yields nothing; clean write produces byte-identical receipts (`tests/mcp/brain-create-note.test.ts`, `tests/mcp/brain-update-append-note.test.ts`, `tests/mcp/brain-write-batch.test.ts` stay green - the `lint` key is additive-absent-when-clean)
- **Definition of done**: finding rides every MCP note receipt; write always proceeds; frontmatter untouched; no body normalization introduced
- **Depends on**: none
- **File-ownership boundary**: Task 11 owns `page-lint.ts` inside Group 4. **∥ parallel with Tasks 12, 13**.

### Task 12: slug-collisions hygiene detector (+ DEFAULT_SCAN_IDS)
- **Card**: t_7bad7ad8
- **Files**: `src/core/brain/hygiene/detectors/slug-collisions.ts` (new: walk vault pages, group by `slugify(basename-without-.md)` within each directory, one finding per group of size >= 2 - shared stem + member paths in `targets`, mtimes in `evidence`; `severity: "info"`, `proposed_action: "review"`, id via `hygieneFindingId`); `src/core/brain/hygiene/types.ts` (append `"slug-collisions"` to `HYGIENE_DETECTOR_IDS` - drives the applier capability check and the type - and add the `DEFAULT_SCAN_IDS` list: detectors included when no subset is requested); `src/core/brain/hygiene/scan.ts` (`DETECTORS` entry; `runHygieneScan` resolves the default sweep from `DEFAULT_SCAN_IDS` - explicit subset selection still filters over all registered ids)
- **Tests first**: `tests/core/brain/hygiene-slug-collisions.test.ts` (new - `topic.md` + `topic-2.md` in one directory yields exactly one finding, targets sorted, stable id; same stem in different directories yields nothing; `-3` group of three yields one finding; empty vault yields nothing); extend the hygiene scan/plan tests for the new id (subset filtering, per-detector counts, applier capability table - `tests/core/brain/hygiene*`)
- **Definition of done**: default scan includes slug-collisions; detector never mutates; registration is exactly the three-edit pattern; `o2b brain hygiene` and MCP hygiene tools render it unchanged
- **Depends on**: none
- **File-ownership boundary**: Task 12 owns `hygiene/types.ts`, `hygiene/scan.ts`, `detectors/slug-collisions.ts` inside Group 4. **∥ parallel with Tasks 11, 13**.

### Task 13: hub candidates at inbox-drain
- **Card**: t_23bd347d
- **Files**: `src/core/brain/link-graph/moc-audit.ts` (export `isHubBody(body, thresholds): boolean` extracted from `auditMoc`'s structural check :104-121 - outbound unique targets >= `minOutbound` AND link-ratio >= `minRatio` from `resolveLinkGraph`; `auditMoc` re-calls it so audit and selection share one definition); `src/core/brain/link-graph/repair-lane.ts` (new `IDENTITY_STRENGTH.areaMembership` tier slotted between `sameTopicEvidence` and `inferred` with its `STRENGTH_RANK`; `RepairAction` gains `skip-no-hub` and `skip-ambiguous-hub`; `runRepairLane` unchanged - the new actions ride `collectedRefusals` verbatim); new `src/core/brain/link-graph/hub-candidates.ts` (the deterministic selection: corpus-page pool passing `isHubBody` within the routed page's scope bucket via `compositeScopeKey`; `resolveUniqueMatch` (`src/core/graph/unique-match.ts:32`) decides unique/none/ambiguous; append-only JSONL store under `Brain/.state/` for candidates + refusals); `src/core/brain/capture/inbox-drain.ts` (apply-mode idea-route success emits through `hub-candidates.ts`; obligations and source-reference routes excluded); `src/cli/brain/verbs/repair-lane.ts` (merge file-based candidates + refusals into the run)
- **Tests first**: `tests/core/brain/capture/inbox-drain-hub-candidates.test.ts` (new) - one scope-matching hub -> candidate appended with the areaMembership tier, confidence 1.0, reason naming the hub; zero hubs -> `skip-no-hub` refusal naming the bucket, no candidate, no hub created; multiple hubs -> `skip-ambiguous-hub` listing every hub in first-occurrence order; non-idea routes emit nothing; dry-run drain emits nothing; re-draining after apply proposes nothing new; extend the repair-lane tests - the new refusals render verbatim in decisions and never count in `written`; `tests/core/brain/link-graph/` suites and `tests/core/brain/capture/` stay green
- **Definition of done**: zero new write paths (edges land only through the lane's apply + confirm + holdout gate); moc-audit behavior byte-identical (it now goes through `isHubBody`); `REPAIR_CONFIRM_PHRASE`, threshold, write cap and convergence invariants untouched
- **Depends on**: none
- **File-ownership boundary**: Task 13 owns `moc-audit.ts`, `repair-lane.ts`, `hub-candidates.ts`, `inbox-drain.ts`, `cli/brain/verbs/repair-lane.ts` inside Group 4.

### Task 14: shared TAG_RE + tags hygiene detector
- **Card**: t_c8508241
- **Files**: `src/core/tags.ts` (new: `TAG_RE` and the tag extraction over cleaned text MOVE here from `src/core/search/links.ts` - one shared definition, not a copy); `src/core/search/links.ts` (re-import from `src/core/tags.ts`; behavior byte-identical); `src/core/brain/hygiene/detectors/tags.ts` (new: (a) malformed - body `#...` tokens a looser Obsidian-compatible rule accepts but TAG_RE rejects, reported as the diff naming what the index will never match; (b) inconsistent - same tag differing by case or hierarchy depth; (c) orphan - tag value on exactly one document; all `severity: "info"`, `proposed_action: "review"`, prose-only scope stated in the report header); `src/core/brain/hygiene/types.ts` + `src/core/brain/hygiene/scan.ts` (register `"tags"` by the three-edit pattern; `DEFAULT_SCAN_IDS` excludes it - opt-in only)
- **Tests first**: `tests/core/brain/hygiene-tags.test.ts` (new - malformed tag reported as the diff; `#Foo` vs `#foo` and `#a/b` vs `#a` reported inconsistent; single-document tag reported orphan; tag shared across documents not orphan; frontmatter `tags:` arrays ignored); `tests/core/search/links.test.ts` green unchanged (the move is behavior-preserving); extend hygiene subset tests - `tags` runs only when explicitly requested
- **Definition of done**: exactly ONE tag regex in the tree (`rg` for tag-shaped patterns finds `src/core/tags.ts` alone); default hygiene scan excludes it; TAG_RE not widened; coordination note for t_11ee559f recorded in the module docblock
- **Depends on**: Task 12 (`DEFAULT_SCAN_IDS` mechanism + registration pattern)
- **File-ownership boundary**: Task 14 takes over `hygiene/types.ts` + `scan.ts` from Task 12 and owns `tags.ts`, `links.ts`, `detectors/tags.ts`.

---

## Verdict-only cards (no tasks)

- **t_5f7e0dcd** - REFUTED: CJK-aware chunking ships since v1.58.0 (commit 6f33c424, #197); pinned by `tests/core/search/chunker-dense-scripts.test.ts`. Cost-surface follow-up (`estimateTokens`, `brain_token_impact`) recorded as a future lane.
- **t_4bccd70a** - narrowed verdict, no feature: the rename-rewrite ships (`noteLifecycle`/`retargetWikilinks`); the residue (docId provenance, index staleness reporting, move-following provenance) is documented in design.md with the future shape and the refused `reid_map` alternative.
