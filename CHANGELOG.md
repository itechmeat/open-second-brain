# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.32.0] - 2026-07-18

A memory write-path integrity and store safety wave: eleven units across four subsystems that make every durable write choke point validate its input, every destructive vault operation snapshot first, and every embeddings failure surface as a typed, actionable outcome. All gates are deterministic (the kernel still calls no LLM), every rejection is a typed error or a logged, visible skip, and no new dependency is added.

### Added

- **Vector validity gate.** A new `EMBEDDING_INVALID_VECTOR` error rejects non-finite (NaN/Infinity) and all-zero vectors at the store choke points (`vecUpsert`, `semanticTopK`) and in unit normalisation, so a broken embedder can no longer poison cosine distances silently. Previously only the dimension was checked and a NaN vector inserted cleanly.
- **e5 instruction prefixes at index and query time.** Instruction-tuned embedders get the prompts they require: the embed path now distinguishes `query` from `passage` inputs, the multilingual-e5 preset carries `"query: "`/`"passage: "` defaults, and `embedding_prefix_query`/`embedding_prefix_passage` config keys (with env twins) override them; an explicit empty string disables. The active prefix pair is persisted in index meta, and changing it surfaces the same reindex-required path as a model change, so prefixed queries are never compared against unprefixed stored vectors.
- **Embeddings quota classification.** HTTP 402, and 429 responses carrying provider quota tokens (for example `insufficient_quota`), now classify as a dedicated non-retriable `EMBEDDING_QUOTA_EXHAUSTED` outcome with an actionable message (quota or billing exhausted, semantic search degraded, check provider billing) instead of folding into a generic HTTP failure with blind retries. The classifier reads structured status fields on the error, not message strings.
- **Retry-After honoring and graceful semantic degrade.** Rate-limit and transient retries honor the provider's `Retry-After` header (bounded by a 30-second cap); quota outcomes fail fast with zero retries; implicit semantic search degrades to the lexical lane with a warning that names the failure category, while explicit `--semantic` requests keep throwing the typed error rather than silently falling back.
- **Snapshot-before-destructive-write gate.** A shared `withDestructiveSnapshot` wrapper over the existing tar+zst snapshot engine now fronts `o2b brain forget-source --confirm` (previously an unrecoverable bulk delete) and the new entity prune. The snapshot is taken before any deletion, the run id and archive path are reported as the recovery point, and dry runs take no snapshot.
- **Entity label quality gate and prune.** `sanitizeEntityLabel` strips surrounding Markdown decoration and punctuation before normalization at every label-intake boundary, and a structural validator (no letter or digit in any script, empty after stripping, over-length, or on the operator-supplied `entities.label_denylist`) rejects junk labels: a typed error at creation, a logged skip at anchoring. `o2b brain entity prune` lists malformed historical nodes (dry-run default) and on `--confirm` removes them and their edges behind the snapshot gate; a new `entity-label-malformed` doctor lint surfaces candidates. Identity keys for all currently-valid labels are byte-stable.
- **Deterministic durability gate for extracted facts.** A structural classifier (temp paths, progress counters, run-id and timestamp shapes, measurement-token dominance, exit-status shapes; extendable via `durability.denylist` regexes) rejects transient operational content before it persists as durable memory. Rejections are counted and logged as `durability-skip` events, never dropped silently; operator feedback writes are not gated. The classifier ships zero built-in natural-language word lists.
- **Opt-in write-approval queue.** With `write_approval.enabled: true`, extracted signals stage into `Brain/pending/` instead of landing directly in the inbox; `o2b brain pending list | apply <id> | reject <id> --reason <text>` reviews the queue. Apply moves the unchanged document (anchors and dedup hash preserved) into the inbox; reject moves it to `Brain/retired/` with the reason. Default off preserves the direct-write behavior byte for byte.
- **Write-time conflict advisory.** Recording feedback whose principle closely resembles a confirmed same-scope preference now returns an advisory naming the conflicting preference id and similarity evidence, in both the `brain_feedback` MCP response and the CLI output, and logs a `write-conflict-advisory` event. The write always proceeds; the advisory tightens the feedback loop that previously waited for the next health pass.
- **Signal retire lifecycle.** `o2b brain signal retire <id> --reason <text> [--superseded-by <id>]` moves an inbox signal to `Brain/retired/` with retire frontmatter (`_status`, `retired_at`, `retired_reason`, optional `superseded_by`, old-id alias), mirroring the preference retire conventions, so an outdated extracted fact can be superseded without deleting its history. Retired signals leave the dream-pass intake but stay queryable.
- **Store hardening.** A `harden-permissions` auto-safe remediation step (idempotent, step-capped, dry-run first) tightens existing `Brain/` files to owner-only modes; a `symlink-escape` doctor lint reports vault-internal symlinks resolving outside the vault root.

### Changed

- **MCP responses no longer expose absolute host paths by default.** The `vault_path` fields returned by the core MCP tools now carry a stable opaque reference (`vault://<hash>`) instead of the raw filesystem path, because tool responses land in model context. Set `expose_host_paths: true` (or `OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS=true`) to restore the raw value.
- **Zero-norm and non-finite vectors now throw during normalisation.** `unitNormaliseInPlace` previously returned an all-zero vector unchanged on zero norm and propagated NaN silently; both cases now raise the typed `EMBEDDING_INVALID_VECTOR` error, because a silent all-zero embedding is a misleading no-op.

## [1.31.0] - 2026-07-17

A today-operator-surface release: one read-only dashboard answering "what matters right now", a chronologically merged activity timeline, prose-native open loops, and a guarded write-back that turns prose markers into schema-validated frontmatter mutations. Every read surface is live-derived on demand and never stored; the single write path is opt-in, deterministic, and audited. No new dependency; the kernel still calls no LLM.

### Added

- **Today dashboard (`o2b brain today`, `brain_brief view=today`).** A read-only, multi-section operator overview: due and overdue obligations (reusing the obligation store's own due math), open loops, a recent-activity timeline, and totals. Every section is an independent live query re-derived on demand - nothing is stored, so nothing drifts. Sections are fault-isolated: a section that fails to compute reports an explicit per-section error entry while the rest still render, never a silent healthy-looking blank. Text or `--json`; `--lookback-days` and `--limit` bound the activity window and both accept `0` (empty activity section) consistently across the core builder, the CLI, and the MCP `view=today` handler.
- **Merged chronological activity timeline.** `buildActivityTimeline` renders the Brain log's `TimelineIndex` as one newest-first typed bullet list across all event kinds - `- [<kind>] <field>=<value> pairs · <relative age>` - instead of the section-grouped brief. Tags are the event-kind strings themselves and text derivation is a fixed structural field-priority walk, so the surface stays language-agnostic with no display-name table.
- **Open-loop prose markers with survive-until-closed semantics.** The `@osb` marker grammar gains a `loop` kind: `@osb loop <text>` (optional `id=`) keeps an informal intention visible on the dashboard until a structural close token `@osb loop close id=<id>` appears anywhere in scanned prose. Loop ids derive deterministically from normalized text (sha256 prefix) or an explicit `id=`; loop markers are never consumed by any scanner; duplicates and orphan closes are reported, not guessed away. Lighter-weight than an obligation - the gap between formal cadence commitments and one-off notes.
- **Guarded marker write-back (`o2b brain apply-markers`).** The grammar also gains a `set` kind: `@osb set note=<target> field=<field> value=<value>` resolves its target fail-closed (a `[[Title]]` resolves by Obsidian basename semantics; zero or multiple matches list candidates instead of guessing; paths pass the vault-containment check) and applies the mutation through the existing schema-pack-validated attribute path. Report mode is the default and writes nothing; `--apply` requires the new opt-in `guardrails.marker_writeback` flag (default off), emits one `attribute-write` Brain log event per applied mutation carrying the prior value, and consumes exactly the applied markers so a re-run applies nothing. Per-marker isolation: one failing marker never aborts the rest. A mutation that lands but whose post-write audit or consumption step fails is reported honestly as `applied-unconsumed` (never a clean `applied`) with the cause; the CLI renders it, adds an `unconsumed` count, and exits non-zero so the operator can reconcile the still-live marker before a retry re-applies it.

### Changed

- **The note-space walker is a shared module.** The read-path/ignore-path/size-cap walking rules previously private to the inline scan now live in `src/core/brain/notes/note-walk.ts` and back the inline scan, the new title resolver, the open-loop scan, and the write-back file list - one set of rules instead of per-feature copies. Existing scan behavior is pinned unchanged by its tests.
- **Marker grammar validation is per-kind.** `@osb` markers validate against a per-kind required-field table (`feedback`, `loop`, `set`) instead of feedback-specific hardcoded checks. Feedback parsing, downstream signal emission, and unknown-kind rejection are byte-identical; the three existing marker consumers now explicitly process only feedback markers.

## [1.30.1] - 2026-07-17

A structural maintenance release with zero behavior change: every import cycle in the TypeScript source tree is removed and the largest source file is decomposed. The analysis and the verification gate come from code-ranker (v5.0.3); the full suite (5687 tests) is byte-for-byte green before and after.

### Changed

- **All seven import cycles removed from `src/`.** Dependency inversion at the type level, cycle by cycle: doctor/trust and procedural-* shapes move to the leaf module `src/core/brain/types.ts`; `LinkOutputFormat` moves from `config.ts` to its only consumer `wikilink.ts`; the ~35-file `src/mcp` component dissolves into a one-directional layering over a new `src/mcp/tool-contract.ts` contract leaf; `src/core/search` gains `embeddings/contract.ts`, `rerank/contract.ts`, and `embeddings/configured-provider.ts` while `search/types.ts` becomes a pure leaf; and a new `search/tuning-store.ts` splits the tuned-parameter read side from the grid optimizer, closing the last `search -> tuning -> benchmark` triangle. `code-ranker` now reports zero `cycle.chain` violations and zero cycles in the file graph.
- **`src/core/search/search.ts` decomposed.** The worst-ranked file in the tree (maintainability index -85.8, cognitive complexity 442, 1722 lines) keeps only the `search()` orchestration; progressive disclosure (`cards.ts`), structured-lane application (`structured-lanes.ts`), the semantic phase (`semantic-phase.ts`), frontmatter result filters (`result-filters.ts`), graph expansion phases (`graph-phases.ts`), and evidence-pack coverage (`evidence-verification.ts`) move to focused leaf modules with byte-identical function bodies.

## [1.30.0] - 2026-07-11

A governance-visibility release that adds two aggregate views over the preference set the existing per-item hygiene lints could not answer, plus an efficiency refinement to how one of them sources its data. Both new surfaces are additive and read-only over `Brain/preferences/`; the release adds no new dependency and the kernel still calls no LLM.

### Added

- **Aggregate governance scorecard (`o2b brain vitals`).** A single read-only scorecard over confirmed preferences that the per-item lints (`doctor`, `health`, `moc-audit`) do not surface: `domain_diversity` (normalised Shannon entropy of the `scope` distribution), `connectivity_index` (mean `evidenced_by` count per preference), `orphan_preferences` (confirmed preferences below an evidence threshold, default 2, `--orphan-threshold`), and `gap_pressure` (open `concept-gap` findings, reused from the semantic-health pass, divided by preference count). Text or `--json`; records one `vault_vitals` metric per run, following the existing `clusters`/`benchmark` surface pattern.
- **Batch-concept-inflation lint.** The existing `duplicate-preferences` lint only catches near-identical pairs (Jaccard >= 0.7 within one topic/scope). `detectBatchInflation` is a deterministic, non-overlapping window scan over confirmed preferences' `confirmed_at` timestamps (default 24h window, burst size >= 5, both configurable) that flags a burst of individually-distinct preferences confirmed together - the signal that a batch or concurrent ingestion session skipped its dedup/consolidation pass. Wired end to end: `reconcileSemanticHealth`, the `batch-concept-inflation` doctor lint, `o2b brain health` (CLI) and `brain_health` (MCP), and a new `batch_inflation` Workspace Insight trigger kind.

### Changed

- **Vault vitals sources `gap_pressure` from a semantic-only health pass.** `computeVaultVitals` now calls a new exported `computeSemanticHealth` instead of the full `runDoctor` sweep to read the open concept-gap count. Both route through the same detector over the same inputs, so `gap_pressure` is byte-for-byte identical (proven by an equivalence test), but vitals no longer pays for the structural config, signals, backlinks, logs, and entities checks it never reads. `runDoctor`'s own report is unchanged.

## [1.29.0] - 2026-07-10

An operability, safety, and first-run release that makes Open Second Brain robust and pleasant to set up and operate: a guided first-run checklist, actionable config diagnostics, resilient hooks and rate-limit handling, safe mutating operations, a hardened optional HTTP transport, and usage visibility. Every new surface is additive and off by default or byte-identical when its condition is absent; the release adds no new dependency and the kernel still calls no LLM.

### Added

- **Guided first-run onboarding checklist.** `o2b init` now prints a state-aware, ordered set of next steps beyond search indexing (vault config, Brain scaffold, first index, agent identity, an optional embedding key, a first feedback signal, session import, and a health check), each with a done flag and a copy-pasteable command. A re-runnable `o2b onboarding` verb (text or `--json`) shows the same checklist any time. It reuses the runtime-notice and doctor-remediation surfaces; read-only, no network, no model.
- **Config-validator remediation.** The install/config doctor's `CheckResult` gains an optional `fix` field carrying a copy-pasteable remediation command, populated in every failing check (`mkdir`/`chmod` for vault and config, `o2b update` for a missing or invalid manifest). `o2b doctor` renders it under failing checks, gains a scriptable `--json` report (per-check `fix` plus an aggregate `{total, failed}` summary) and a summary line, and surfaces `fix` through `vault_health` and the OpenClaw doctor. The 0/1 exit stays the scriptable gate - the doctor becomes a self-service repair tool.
- **Runtime-state notice channel.** A deterministic, no-network, no-LLM probe surfaces OSB's own transient conditions - semantic search degraded (enabled but no embedding key resolved), the search index missing or rebuilding, and a read-only vault - as notices that ride the existing SessionStart injection surface (prepended only when a condition holds, so a healthy vault stays byte-identical) and fold into `vault_health` for pull consumers. Default on; opt out with `OPEN_SECOND_BRAIN_RUNTIME_NOTICES=false`.
- **Hook process self-watchdog and fail-open context load.** A lifecycle hook now arms a hard time ceiling on itself (default 55s, override `OPEN_SECOND_BRAIN_HOOK_CEILING_MS`): a healthy run exits normally, and a hung hook self-terminates at the deadline with an audit line instead of orphaning a process or blocking the agent. SessionStart context assembly runs fail-open - a slow or failing assembly degrades to the last-good cached body (or empty), never a partial or poisoned write. Distinct from the `brain_watchdog` vault-health probe.
- **Expectation and strict count guards on mutating ops.** `--expect N` asserts how many items a mutation will touch and `--strict` refuses a guardless mutation; on a mismatch the op aborts before writing and surfaces the matched list. Wired into delete-by-source, hygiene apply, and dream run (MCP and CLI), each reporting honest `matched` vs `changed` counts. The atomic writer gains an opt-in content-equality short-circuit that skips an identical write (no mtime churn). No block-query DSL; guards default off.
- **Per-skill invocation telemetry.** How often each installed skill is actually invoked is captured as an append-only `skill_invoked` continuity record, emitted from the session-import tool-call scan across Claude Code and opencode logs (`get_skill` and the host-native `Skill`; discovery and attach are not invocations). Counts are derived read-side, deduped by content-address id so re-import is idempotent, and surfaced via `brain_skill_proposals` `operation: usage` and `o2b brain skill-proposals usage`. Deterministic, no LLM; distinct from proposal ranking and outcome-weighted recall.

### Changed

- **Configurable embedding retry budget for 429/5xx.** The embedding provider's per-batch transient-retry budget is now runtime-configurable via `embedding_max_retries` / `OPEN_SECOND_BRAIN_EMBEDDING_MAX_RETRIES`, with the default raised from a hardcoded 3 to 6, threaded into both the OpenAI-compatible and ZeroEntropy providers, so a reindex against a strict-RPM account no longer exhausts the budget and silently drops chunks. `ping()` still probes once and multi-key auth failover stays independent; the concurrency knob already exists as `embedding_concurrency`.
- **Hardened optional loopback HTTP transport.** The opt-in `o2b mcp --transport http` server gains a mandatory, non-bypassable Host/Origin DNS-rebinding guard (a foreign Host or cross-origin/opaque Origin is rejected before auth) and an unauthenticated `GET /health` liveness probe. The bearer token is now optional on a loopback bind (loopback + guards are the baseline defence) but mandatory on a non-loopback host - the server refuses to expose an unauthenticated endpoint on the network, with no permissive fallback. stdio stays the default transport.

## [1.28.0] - 2026-07-10

A retrieval and ranking quality release: embedding-layer robustness, faster and smarter candidate retrieval, a fully offline reranker with a per-store eval gate, ranking signals learned from real outcomes, and a named benchmark to score the whole. Every new surface is additive and off by default where it changes an existing path; the release adds no new dependency and no ML runtime, and the kernel still calls no LLM.

### Added

- **Curated embedding-model presets and a recommended default.** A static, shippable catalog of known-good multilingual-first embedding models (with native dimensions and guidance) is surfaced at provider registration via `o2b search provider presets`; `provider add` defaults `--model` to the recommended model when omitted. Advisory only - a custom `--model` stays first-class and verbatim. No server, no network.
- **Native ZeroEntropy embedding provider.** `zeroentropy` is now a first-class embedding provider calling the native `POST {base}/models/embed` API directly over `fetch` (no SDK, no dependency), with Bearer auth, input-order-preserving vectors, and Matryoshka `dimensions` when configured. It reuses the shared retry/backoff and `ping` contract; the resolved-provider union stays closed.
- **Trigram candidate prefilter for large-vault search.** A native SQLite FTS5 `trigram` shadow index (schema v9, populated in-place by a reindex-safe migration, no dependency) backs an opt-in prefilter that merges substring / partial-token candidates the word tokenizer misses into the keyword pool - a strict superset of substring matches, so it never drops a result. It engages only past a corpus-size floor and skips short, CJK, and low-selectivity queries. Off by default (byte-identical); knobs fold into the query-cache fingerprint.
- **Graph-index query pre-pass with multi-hop BFS.** A new read planner (`o2b search plan`) ranks seed notes by title match and wikilink degree over index metadata, connects them through multi-hop BFS on the link graph, and returns a `should_read` shortlist - surfacing notes reachable only via several hops that the 1-hop link boost misses. An `index_only` mode answers from title / degree / link metadata with zero note bodies hydrated. Pure-stdlib.
- **Bundled offline reranker and per-store reranker eval gate.** A deterministic, dependency-free `local` reranker (coverage / proximity / density blend) behind the existing rerank interface makes reranking work fully offline with no model runtime or network, selected via `search_rerank_kind=local`. A new evaluation gate runs the recall benchmark rerank-off vs rerank-on and recommends enabling only when it lifts ranking without regressing hit@k.
- **Session-end observed-use verdict feeding recall ranking.** A new `recall_observed_use` continuity record captures a USED / IGNORED / CONTRADICTED verdict per injected memory - classified deterministically from transcript token overlap plus a structural stance flip (no LLM) or supplied by the host via the new `brain_observed_use` MCP tool (mirroring `brain_apply_evidence`). The folded observed-reuse rate becomes a preferred, capped recall-ranking signal so demonstrably reused memories outrank merely-predicted-important ones; contradictions demote. Inspectable via `brain_recall_telemetry observed_reuse`. Byte-identical when no verdicts exist.
- **LoCoMo benchmark suite.** `o2b brain bench memory --suite locomo` converts a LoCoMo-shaped dataset into the existing staged harness's fixture and runs it as a parallel named suite (`locomo-*`), so runs are comparable to the published long-conversation-memory literature. OSB's six categories stay canonical; the run is deterministic and network-free by default, with the LLM judge opt-in. Ships a small committed sample dataset.

### Changed

- **Multi-key fallback for the embeddings API key.** A provider profile's `envKey` may now be an ordered probe list (a single string still works and stays byte-identical); resolution takes the first present key and the `OpenAICompatProvider` fails over to the next on an HTTP 401/403, pinning the first that authenticates. `o2b search provider add --env-key A,B` registers a probe list. Rerank stays single-key. Removes the single point of failure in the only networked path without touching the LLM-free kernel.
- **Outcome-validated procedural recall.** Procedural entries and their usage sidecar gain additive success / failure counters (outcome-free vaults stay byte-identical), a host-supplied `recordProceduralOutcome` (deterministic, no LLM), and success-rate ranking that surfaces proven procedures and sinks failing ones, with the usage count as the neutral prior for unproven ones. Exposed via `brain_procedural_memory mark_outcome` and `list ranked:true`.



### Fixed

- **Resolve `o2b`/`bun` when the memory provider inherits a tiny `PATH`.** When Hermes starts the provider from a process with a minimal inherited `PATH`, `shutil.which("o2b")` cannot see a user-local install and `subprocess.Popen` later fails with `No such file or directory: 'o2b'`. Resolution now falls back to a curated scan of user-local and system executable directories (`~/.local/bin`, `~/.bun/bin`, `~/.hermes/node/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`) and uses the resolved absolute path for both `o2b` and `bun`. `shutil.which` still wins first, the POSIX-only `o2b` branch and the repo-local `bun run <entry> mcp` fallback are preserved, and on Windows the scan matches `PATHEXT` suffixes rather than gating on the POSIX execute bit.

## [1.27.0] - 2026-07-10

An ingestion and import robustness layer that hardens and extends the source pipeline in one coherent scope: interrupted batches resume, more memory stores import, deterministic refresh skips when nothing changed, and sources distill into citeable claims. Every new surface is additive and off by default where it changes an existing path; the kernel still calls no LLM.

### Added

- **Resumable per-item batch checkpointing.** A plan-scoped checkpoint under `<vault>/.open-second-brain/ingest-checkpoints/<plan_id>.json` records completed items union-as-you-go, so an interrupted large-folder ingest resumes at the item boundary instead of re-planning from scratch. `planBatches` accepts `resume`, which excludes checkpointed items before content-hash classification (a fast-path that avoids re-hashing completed work on a large-vault resume) and returns a stable `plan_id` plus a `resumed_completed` count; `ingestSource` records completion when handed a `plan_id`. The `brain_ingest_batch_plan` MCP tool gains `resume` and returns `plan_id`, clearing a drained plan; `brain_ingest_source` and the `o2b brain batch-plan --resume` CLI carry it through. The content-hash manifest stays the authoritative final state. Opt out with `OSB_INGEST_NO_CHECKPOINT`.
- **mem0 and generic-JSON memory-store importers.** The `MemorySourceBackend` seam widened from one-file-one-entry to discover-files plus parse-entries, so a single JSON export maps to many Brain preferences. New `mem0` and `generic` backends parse a memory export (a top-level array or a `results`/`memories`/`entries` envelope) into preferences on the shared render path; the `claude` backend stays byte-identical. The `o2b brain import-claude-memory` CLI gains `--from`/`--backend` to select a non-default backend and can be pointed at a single export file. Unknown ids fail loudly with the registered list.
- **Staleness fast-path for deterministic refresh.** A reusable mtime staleness gate plus an opt-in `o2b brain clusters run --if-stale` that no-ops when the materialized `Brain/clusters/` notes are already newer than every input note, recording a freshness-skip metric and skipping the recompute entirely. Default behavior is unchanged; the `>=` comparison errs toward recompute, and a missing input never forces a needless rebuild.
- **Source distillation into atomic claims.** A new `o2b brain distill` CLI verb and `brain_distill_source` MCP tool condense a source into agent-supplied atomic claims, each with an optional source block id, and write an idempotent `Brain/distillations/` page that cites each claim as `[[source#^block]]` alongside a Sources provenance section and a content sha256 the verifier can reproduce. Provider-agnostic: the core runs no model, validates claims structurally, and rewrites one page per source in place.

## [1.26.1] - 2026-07-08

An upstream-alignment guard release. Two regression suites now pin Open Second Brain's Hermes-facing surface against two landed upstream Hermes changes, with no source edits and no runtime behavior changes. The kernel still calls no LLM.

### Added

- **Structural invariant tests for the memory-provider tool schemas.** A new `NormalizeContractTests` suite in `tests/python/test_static_schemas.py` asserts that every entry `get_tool_schemas()` exports, on both the static-fallback and the live-bridge code paths, is flat (no `{type: function}` wrapper nested anywhere) and carries a non-empty top-level `name`, exactly the preconditions core's new shared `normalize_tool_schema()` (upstream Hermes PR #52140) relies on. A companion `ProviderNormalizeSurvivalTests` case drives the provider's live-listing path with a mixed tool list (a curated tool, a non-curated tool, and an accidentally pre-wrapped entry) and asserts only the curated, flat, named tools survive, so a strict-provider turn (DeepSeek) can no longer be disabled by a malformed schema. The `inputSchema` to `parameters` remap is also shown to preserve the curated name set, count, and order, and to be idempotent with deep-copied output.
- **Repeated in-place-compaction regression under a stable session id.** A new `InPlaceCompactionLifecycleTests` suite in `tests/python/test_memory_provider.py` drives `sync_turn` followed by repeated `on_pre_compress` and `on_session_end` with one fixed session id (the new `compression.in_place` default flipped by upstream Hermes PR #52658) and asserts exactly-once flush semantics: `brain_pre_compact_extract` fires once per boundary that has buffered turns, the in-memory buffer is cleared between flushes with no double-flush or clobber, and no duplicate Brain session writes accumulate across repeated in-place compaction. The provider is shown to make no assumption that the session id rotates.

## [1.26.0] - 2026-07-08

A memory-signal provenance and lifecycle integrity layer that closes five gaps in one coherent scope. Every new surface is additive and byte-identical when off, and the kernel still calls no LLM.

### Added

- **Content-hash skip-unchanged manifest.** Ingest now classifies source files as new, modified, unchanged, or missing by SHA-256 over file bytes, distinct from identity dedup which hashes the source path. A machine manifest at `<vault>/.open-second-brain/ingest-manifest.json` records post-ingest hashes; a rerun where every source is unchanged skips the LLM extraction pass and rewrites nothing. Atomic write; idempotent.
- **Per-row event-time on batch remember and import.** `WriteSignalInput` gains optional `valid_from` and `recorded_at` that flow into the same frontmatter keys `readBiTemporalSlots()` already parses; session-import prefers `SessionTurn.timestamp` for `created_at` and `recorded_at` and falls back to `now` only when absent or unparseable, so backfilled signals are stamped with the original turn time instead of the import moment. `brain_feedback` and the batch import path forward an optional per-row `event_time`. Absent by default, existing records byte-identical.
- **Batch-plan step for large-folder ingest.** A new `planBatches` helper discovers ingestible files, skips unchanged ones through the content manifest, then splits the remainder into size- and count-bounded batches for the caller (agent or CLI) to dispatch as parallel subagents. Deterministic sort-by-path greedy fill; no parallel execution inside the kernel.
- **Idempotent writes via client idempotency keys.** `writeSignal`, `writePreference`, and `appendApplyEvidence` accept an optional `idempotency_key`; the writer hashes the would-be payload and consults a month-sharded JSONL ledger under `Brain/logs/idempotency/`. Same key and same hash is a deduped no-op; same key with a different hash is an explicit `payload_mismatch` error, never a silent overwrite. `brain_feedback` forwards an optional `idempotency_key`.
- **Dry-run extraction preview.** `extractPreCompactRecords` and the other extraction entry points accept an optional `dryRun` flag that returns the exact records the real path would append without calling `appendContinuityRecord` (no vault mutation, no log event, no dream or retire trigger). Mirrors the existing `opts.dryRun` idiom in `import.ts`; a parity test asserts dry-run candidates equal real-run records for the same input.
- **Bounded verbatim last-N-turns buffer.** A hard-capped ring buffer of the last N turns (default 20) persisted as a new `recent_turn` continuity kind (additive; legacy records read as v1). `appendRecentTurn` evicts oldest beyond N; reads are bounded. An opt-in post-compaction flag appends the buffer so the agent can recover recent verbatim wording after compaction. Default off; its own kind and reader, clearly separated from curated memory.
- **Batch checkpoint save for whole sessions.** A new `brain_session_checkpoint` MCP tool saves a whole session signals, learnings, and summary in one round-trip. Idempotency is session-id plus content-hash, reusing the idempotency ledger; a checkpoint that needs review returns a `{ status: "ok" | "mixed", partial: [...] }` result and never silently drops an item.
- **Caller-settable per-memory expiration date.** `WritePreferenceInput` and `WriteSignalInput` accept an optional ISO `expiration_date`. The read path silently drops anything past its expiration by default; an opt-in `showExpired` re-includes expired records for audit. Orthogonal to dream heuristic retirement: an expired-by-date memory is filtered, not moved to `Brain/retired/` (audit trail preserved).
- **Delete and search by exact source file.** Search accepts an exact `source_file` filter matching the source-ref frontmatter, and a new `delete_by_source` command is dry-run by default, reporting the blast radius (which derived signals, preferences, index entries, and summary pages trace back to the source) without deleting. An explicit `--confirm` deletes the derived entries and index artifacts; original user notes are removed only with `--include-originals`. Every cleanup is recorded as a continuity event.
- **Signed source-diversity grounding score.** A new `computeGroundingScore` projection over the same `ClaimEvent`s that feed `computeTruthState` returns `{ score, confidence, band, supportingSources, contradictingSources }`. Confirming vs contradicting evidence is counted across independent sources (distinct `source` and `agent`), not raw mention count, so N mentions in one document count far below N mentions across N independent sources. Signed: plus for confirming, minus for contradicting; confidence captures how much evidence backs the direction. Pure projection, order-insensitive, never mutates the append-only truth ledger; replaces nothing (the CONTESTED flag stays, the score quantifies it).
- **Note-position contradiction detection.** `detectNoteContradictions` pairs same-subject permanent notes asserting opposite stances, deriving position-sign from note prose rather than `evidenced_by` signals. Reuses the existing language-agnostic token-overlap machinery; emits `ask_user` findings quoting the relevant span from each note and never auto-resolves.
- **Declared-thesis register with new-note monitor.** A new `Brain/theses/` frontmatter kind records operator positions (statement, supporting and counter evidence, last-updated, falsification criterion). A monitor evaluates each newly-ingested note against active theses, flagging support or contradiction, reuses the obligations cadence machinery for a staleness check and a thesis-graveyard pass, and alerts when incoming evidence matches a thesis documented falsification scenario.
- **Session-bracketing memory wrapper for Aider.** A new `scripts/o2b-aider` wrapper (also `o2b aider wrap`) brackets an Aider session: it re-renders the static context sidecar at start, execs the Aider binary with the injected `read:` context, and at session end runs the write-back half (capture and persist the session into the Brain), mirroring Hermes `prefetch`, `sync_turn`, and `on_session_end`. The install-time sidecar adapter stays as the fallback for users who do not run through the wrapper.

### Fixed

- **Shared preference no longer deletable by `forget-source`.** `deleteBySource` now reads a preference's managed `_evidenced_by` links (not only the legacy `evidenced_by` key) and applies the foreign-evidence guard to preferences matched by a `[[source]]` wikilink, so a preference folded from any foreign signal is reported, never auto-deleted on `--confirm`.
- **Provenance folded into idempotency hashes.** The preference idempotency hash now includes `owner`, and the session-checkpoint hash now includes `host` and `sourceTurnIds`, so a retry that changes only owner-visibility or checkpoint provenance raises `IdempotencyPayloadMismatchError` instead of silently deduping under the wrong scope.
- **Apply-evidence honors the idempotency ledger verdict.** `appendApplyEvidence` now acts on `rememberKey`'s return value: a concurrent same-key write with a different payload raises the mismatch error, and a same-payload race returns the winner's row as a deduped result instead of a second normal write.
- **Partial `forget-source` cleanup stays auditable.** A `removeFile` failure mid-cleanup now still writes the `source_invalidation` audit record for the paths already removed before rethrowing, so a retry can reconstruct the state.
- **CLI error contracts.** `brain batch-plan` with no `<source-dir>` now exits 2 as a usage error, and `brain forget-source --json` emits a parseable `{ ok: false, message }` envelope on a runtime failure instead of plain-text stderr.

## [1.25.0] - 2026-07-07

An economics and observability layer for the context pack. Five new
opt-in surfaces make the value of memory measurable and close the
quality feedback loop, each off by default with byte-identical output
when unconfigured. The kernel still calls no LLM.

### Added

- **Value-per-token density ranking in the context pack.** With
  `density_ranking_context_pack` on (default off), the context-pack
  builder adds a deterministic density comparator that breaks within-tier
  ties after session focus and before recency, ordering candidates by
  structural signal per estimated token rather than only by freshness.
  Tier stays the coarse gate so a peripheral page never outranks a core
  one; off/absent keeps the density field off the item and the ordering
  byte-identical. The score is a language-agnostic count (evidence-ref
  grounding plus `[[wikilink]]` connectivity plus a fixed epistemic
  weight), never a wordlist or LLM judgement.
- **Durable token-impact ledger.** With `token_impact_ledger_enabled`
  on (default off), every context pack posts one `token_impact` sample
  carrying the tokenizer-exact prompt-token delta
  (`baseline_tokens` − `packed_tokens`, labelled `method: exact` or
  `fallback`) plus an optional modeled inference-avoidance estimate.
  `brain_token_impact` `record` posts a sample, `outcome` posts a
  `first_pass` / `repair` / `retry` result used only to calibrate the
  modeled figure, and `summary` keeps the two ledgers strictly
  separate: `prompt_token_delta` reports the measured net, saved, and
  added tokens with a per-method split, while
  `modeled_inference_avoidance` reports the raw modeled figure and a
  `calibrated_savings_tokens` value dampened by the observed
  first-pass rate (null until an outcome exists, uncalibrated not
  zero). `list` reads raw samples. Writes are payload-safe (counts and
  an opaque `pack_id` only); reads ignore the gate. Aggregates are
  recomputed from the continuity store on every read, so they survive
  restarts.
- **Agent-operable context-pack outcome loop.** With
  `context_pack_outcome_enabled` on (default off),
  `brain_context_pack_outcome` `post` records one compact outcome row
  for a carried context-pack quality-sample id: first-pass, repair,
  and retry counters plus three strictly separate token signals
  (`exact_prompt_token_savings`, `modeled_inference_avoidance`,
  `observed_provider_tokens`), and composes the token-impact ledger
  by posting a matching first-pass, repair, and retry calibration
  outcome. `list` and `summary` read the rows keeping the signals
  separate. A field the caller omits is never invented; writes are
  payload-safe (counters and an opaque `sample_id` only); reads ignore
  the gate.
- **Route-level MCP tool latency metrics.** With
  `mcp_route_metrics_enabled` on (default off), the MCP server emits
  one `mcp_route_latency` continuity record per tool call: tool name,
  scope, status (`ok` / `error`), duration, and the sorted set of
  argument key names only, never argument values. `brain_route_metrics`
  `list` returns raw records and `summary` rolls each tool up into
  count, error count, min, avg, max, and p50, p95, p99 latency ordered
  slowest-first, so an operator can identify which endpoint blocks an
  agent turn by route rather than by aggregate benchmark. Read-only;
  the emit is gated and fail-open.
- **Proactive active-memory budget-pressure watermark.** The active
  budget now reports a pressure signal before the pack is forced to
  trim, so an operator or agent can react to approaching limits
  instead of only observing the trim after it happens. The signal is
  derived from existing budget metadata; behavior is byte-identical
  when no consumer reads it.

## [1.24.0] - 2026-07-06

A hardening and correctness pass over the PR #121 refactor. Thirteen fixes
across four classes land as one minor because the `basename` column addition
forces a `LATEST_SCHEMA_VERSION` bump and reindex on upgrade, and because the
`created_at` validation tightening turns previously-accepted garbage into
`INVALID_PARAMS`. The kernel still calls no LLM, and every new field is off or
absent by default with byte-identical output when unconfigured.

### Added

- **Self-heal on an unreadable search index.** `openReadOrSelfHeal` now rebuilds
  on `INDEX_UNREADABLE` alongside the existing `INDEX_MISSING` and
  `SCHEMA_MISMATCH` cases, so a corrupted but present index self-heals instead of
  surfacing a raw read error.

### Changed

- **`basename` column and index in the search store.** Resolved-wikilink
  discovery is now an equality join over a populated `documents.basename` column
  instead of a `documents` SUBSTR scan per link, removing a scan that grew with
  vault age. The column requires a `LATEST_SCHEMA_VERSION` bump, so every
  existing install reindexes once on next open. The reindex is absorbed together
  with the Han-bigram tokenizer change below, so users pay one reindex, not two.
- **Hot-path memoization.** The entity index, backlink index, and heal regex are
  now memoized with mtime and generation keys so they are not rebuilt on every
  query. The memos are opt-in by construction: they introduce a bounded staleness
  window (a write inside mtime granularity can serve one stale read), which is
  documented at the call site and pinned by write-then-read invalidation tests.
- **`links normalize --mode short` rewritten over a basename-to-paths Map.**
  Output is byte-identical to before, captured by a characterization fixture.
- **Continuity latest-record queries exit early in reverse chronological order.**
  The working-memory recompute no longer scans the full history when only the
  most recent record is needed.

### Fixed

- **Search index rebuild race and crash-restore clobber.** A separate reindex
  lock (`acquireReindexLock` / `isReindexInProgress`, distinct from the per-Store
  writer lock) now guards the staging build so a concurrent reindex cannot swap
  an empty staging database over the live index, and the crash-restore preamble
  no longer clobbers a freshly built index with a stale `.bak`. Three regression
  tests pin the path.
- **`created_at` validation tightened.** Continuity and query-demand records now
  require a full canonical UTC timestamp; a `YYYY-MM`-prefix timestamp that was
  previously accepted now fails with a structured `INVALID_PARAMS`. This is the
  contract-tightening gate that places these fixes behind a minor version.
- **Surrogate-safe card snippet truncation.** Snippet truncation now cuts on code
  points instead of UTF-16 code units, so an emoji or other astral character at
  the boundary no longer splits into a lone U+FFFD on the `cards` disclosure
  surface.
- **Second-precision `since` / `until` filtering.** Filter bounds run through
  timestamp normalization before the lexical compare, so millisecond and second
  precision are handled consistently and up to a second of records is no longer
  dropped at each boundary.
- **Secret-exec audit redaction.** The `command` field logged by the secret-exec
  path is now redacted before it reaches the audit trail, so a foreign bare
  credential is no longer persisted in cleartext.
- **Han-bigram tokenizer restricted to contiguous Han spans.** The CJK bigram
  pass no longer emits cross-script bigrams (`n实`) for mixed tokens, matching
  the docstring's Han-only scope. Pure-Han and pure-ASCII tokenization are
  unchanged.

## [1.23.1] - 2026-07-06

### Fixed

- **`o2b init` fails on native Windows** -- `resolve()` produces backslash
  paths that `setConfigValue()` rejects via `CONFIG_VALUE_REJECTED_CHARS`.
  Vault path is now normalized to forward slashes before persisting; forward
  slashes work identically in Node/Bun fs APIs on Windows. (#119)
- **Hermes memory provider bridge fails on Windows** -- `scripts/o2b` is a
  bash script that `subprocess.Popen` cannot execute directly (Windows
  delegates to `cmd.exe`, not a POSIX shell). Added `_resolve_command()`
  which detects the platform and falls back to `bun run <entry> mcp` when
  `o2b` is not available as a native executable.
- **`detectTooling()` fails to find tools on Windows** -- PATH was split on
  `:` only (POSIX); now uses `;` on Windows. Executable probing now honours
  `PATHEXT` (`.exe`, `.cmd`, `.bat`, `.com`) instead of hardcoding `.exe`.
- **MCP `inputSchema` not recognized by Hermes adapters (all platforms)** --
  Hermes adapters (Anthropic, OpenAI, Bedrock) expect tool schemas under
  `parameters`, but MCP serves them as `inputSchema`. Without this remap
  brain tools had no visible arguments on any OS. Both live and static
  fallback schemas now remap `inputSchema` -> `parameters` at the provider
  boundary.

## [1.23.0] - 2026-07-05

Two optional precision layers that complete the retrieval-precision loop
started in 1.22.0. Each is off by default with byte-identical output when
unconfigured, and the kernel still calls no LLM.

### Added

- **Proposal-only semantic entity dedup.** With `entity_semantic_dedup_enabled`
  set, `brain_doctor` (and the `doctor` lint surface) surfaces lexical
  entity-name variants ("Google LLC" vs "Google Inc") as PROPOSAL-ONLY
  alias-merge candidates through a deterministic jaccard layer
  (`entity_semantic_dedup_lexical_threshold`, default 0.8). An embedding-cosine
  reader (`entity_semantic_dedup_threshold`, default 0.92) reuses the configured
  embedding provider and is exposed as a library reader for apply plans. The
  deterministic `entityIdentityKey` is never rewritten and no entity is ever
  auto-merged; a human or apply plan owns the actual merge, preserving audit
  friendliness. Optional `identity_type` tagging derives from frontmatter and
  structural signals only (language-agnostic by construction). Registry and
  search behavior is byte-identical until opted in.
- **Optional cross-encoder rerank stage.** A learned final reader step
  re-scores the top-K fused search candidates jointly against the query,
  appended after every heuristic rerank. Off by default
  (`search_rerank_enabled`); when on, it resolves an OpenAI-compatible
  `/rerank` endpoint (`search_rerank_base_url` / `search_rerank_model` /
  `search_rerank_env_key`, or a profile registered via
  `o2b search rerank-provider add`) and re-orders the
  `search_rerank_top_k` candidates by the returned relevance, promoting a
  genuinely-relevant hit the heuristic ranker placed deep. Zero HTTP cost and
  byte-identical ordering when disabled; a request-time endpoint error
  degrades to the heuristic ordering (a `rerank_degraded:` warning, never a
  throw). Most valuable on the `thorough` profile.

## [1.22.0] - 2026-07-05

A retrieval-precision and quality-loop pass. Four new surfaces close the
loop between what recall surfaces, how honestly it reports its own
grounding, and how observed failures turn into a prioritized backlog.
Each new field is optional and absent by default, so every call site
whose caller does not opt in produces byte-identical output, and the
kernel still calls no LLM.

### Added

- **Epistemic provenance markers on packed and recalled items.** Every
  item emitted by `brain_context_pack`, `brain_context_receipts`, and
  recall results now carries a structural `epistemic` status
  (`observed` | `derived` | `hypothesis` | `plan` | `unknown`) plus
  `evidence_refs`, derived from existing graph metadata with no manual
  tagging and no natural-language word lists. A consuming model can now
  tell a source-backed fact from a conjecture or a plan. The status is
  language-agnostic by construction; fields are absent when the status
  is `unknown`, so the off-path is byte-identical to today.
- **Recall adequacy verdict with explicit low-adequacy actions.** A thin
  verdict layer classifies each recall attempt as `sufficient`, `weak`,
  or `insufficient` and emits a recommended action (`proceed`,
  `re_recall`, `abstain`) with an optional `escalate` flag, reusing the
  existing gate-telemetry relevance scores plus the new epistemic mix.
  The verdict appears in `brain_recall_gate` output and the
  context-receipts summary when the caller passes recall scores;
  otherwise the field is absent and output is unchanged. Thresholds are
  configurable (`recall_adequacy_sufficient`, `recall_adequacy_weak`,
  `recall_adequacy_min_results`).
- **Cross-query demand log surfacing recurring poorly-answered queries.**
  A rolling, size-capped demand log under `Brain/log/query-demand.jsonl`
  records each recall (normalized terms plus timestamp, result count,
  and the existing coverage score) and an aggregation reader ranks
  recurring queries the vault answers poorly, ranked by frequency
  times (1 minus IDF-weighted coverage). Surfaced read-only as the
  `brain_knowledge_gaps` MCP tool and `o2b brain knowledge-gaps` CLI.
  The log is written only when recall gate telemetry is opt-in (default
  off) and queries are normalized before append; the reader is always
  available and never writes.
- **Unified outcome-tagged lessons loop.** A `Brain/lessons.md` digest
  folds positive knowledge (preferences and their applied evidence) and
  negative knowledge (`violated` / `outdated` rows and `Brain/dead-ends/`)
  into one outcome-tagged corpus scored by a signed, recency-decayed
  weight (shared 30-day half-life from working-memory continuity). Each
  lesson lands in a tier: `preferred` (net-positive and corroborated by
  at least N distinct results), `tentative` (net-positive but under the
  corroboration floor), `contested` (both positive and negative recent
  evidence, recency-wins), or `avoid` (dead-ends and net-negative). The
  digest is regenerated at the tail of every `dream` pass alongside
  `active.md`, exposed as the `osb://lessons` MCP resource, and injected
  on SessionStart and PostCompact. Tunable via `lessons.limit`,
  `lessons.half_life_days`, and `lessons.corroboration_min`.

## [1.21.0] - 2026-07-04

A safety-hardening pass around the surfaces that write to or trust the
vault and the codegraph. Each change tightens a boundary or closes a
silent-loss gap; none changes default behaviour when the new path is
unused, and the kernel still calls no LLM.

### Added

- **Fail-closed redactor scan window and opt-in infra-topology
  detectors.** The secret redactor now enforces a hard 1 MiB input
  window and fails closed instead of silently truncating oversized
  input, so a too-large document can no longer slip past redaction. Two
  opt-in detector families (hostnames that resolve to a private range,
  and well-known infrastructure tokens) extend coverage beyond secrets
  when enabled; off by default, the shipped redaction set is unchanged.
- **Read-only codegraph health gate before labeling and import.** Before
  the partner surface mutates the codegraph (labeling, edge import), it
  runs a read-only `codegraph health` check and refuses the write when
  the index reports stale, partial, or inconsistent state, instead of
  importing into a graph it cannot trust.
- **Report-only hardcoded-path check for shipped surfaces.** A new
  `check-hardcoded-paths` script scans the shipped source for absolute
  or machine-local paths and reports them, without failing a build on
  pre-existing hits, so path leakage stays visible without blocking
  history it did not create.
- **Memory cost meter: write-volume versus read accounting.** The
  recall-telemetry surface now separates memory write volume from read
  volume, so a runaway writer (a provider looping on store) is
  distinguishable from a busy reader in the same numbers.

### Changed

- **Stable `unnamed-<hash>` slug fallback for punctuation-only titles.**
  A note whose title collapses to empty after slugification now gets a
  deterministic `unnamed-<hash>` slug instead of colliding into a single
  shared `unnamed` note, so distinct punctuation-only titles no longer
  overwrite one another.
- **Portable session-provenance key.** Session import records its
  provenance as a stable logical key rather than the absolute
  session-file path, so a vault moved between machines no longer breaks
  session provenance lookups.

## [1.20.0] - 2026-06-28

Two optional, opt-in config keys widen the agent skill surface without
changing any default behaviour: skill discovery can point at an external
directory, and skill auto-attach can score on a `triggers` keyword field.

### Added

- **Configurable skill discovery root (`skills_dir` /
  `OPEN_SECOND_BRAIN_SKILLS_DIR`).** Points `list_skills` / `get_skill` /
  `skills_attach` at an arbitrary directory (e.g. an external
  `~/.hermes/skills/`) instead of vault-local `Brain/skills/`, with no
  symlinks or vault restructuring. `~` is expanded; a relative value is
  anchored to the resolved config file's directory so the root is
  deterministic regardless of the process working directory. Unset leaves
  discovery byte-identical to before.
- **Trigger-keyword scoring for skill auto-attach (`skills_attach_triggers`
  / `OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS`).** When `"true"` or `"1"`,
  each skill's `triggers` frontmatter field (a scalar string or an inline
  array) participates in the lexical scorer as a 2x BM25 tag signal,
  alongside name (3x) and description (1x). Default off: `triggers` is
  ignored and scoring stays name + description only. The tokenizer also
  emits overlapping bigrams for runs of Han characters, so a spaceless CJK
  query can match a trigger keyword.

## [1.19.1] - 2026-06-26

Three correctness and hygiene follow-ups deferred from the v1.18.0 review,
shipped together. No behaviour changes beyond the fixes; the kernel still
calls no LLM and the default `full` search path stays byte-identical.

### Fixed

- **Cross-vault search now returns `disclosure: "cards"` results
  (`t_fd411665`).** In `--global` (cross-vault) mode a cards search returned
  nothing: single-vault `search()` puts cards on `outcome.cards` and leaves
  `outcome.results` empty, but `searchAcrossVaults` merged only `results`, so
  every origin's cards were dropped. The union now merges each origin's cards
  (labelled by origin, ranked and capped like results) and returns them on
  `outcome.cards` with `results` empty, mirroring single-vault semantics. The
  normalized-confidence chain-stop now gates on the top card score when cards
  mode leaves `results` empty.
- **A genuine event-trace IO error is a runtime failure, not a usage error
  (`t_27ea0daa`).** `o2b brain event-trace` mapped any throw from the resolver
  to a usage error (exit 2). A real IO failure from the log-shard reader (an
  existing-but-unreadable `Brain/log`: EACCES / EIO / ENOTDIR) is now exit 1,
  while a bad `--date` / `--at` / `--kind` selector stays exit 2. The MCP twin
  `brain_event_trace` likewise maps a runtime IO error to `INTERNAL_ERROR` and
  a bad selector to `INVALID_PARAMS`, via a shared `EventTraceSelectorError`
  tag thrown only by the pre-IO selector checks.
- **Registry-guard exempt membership is own-key only (`t_6fbdba4b`).**
  `auditPreviewBudgets` tested exemption with `name in PREVIEW_BUDGET_EXEMPT`,
  which walks the prototype chain - so a tool named like an `Object.prototype`
  member (`constructor`, `toString`, ...) would be falsely treated as exempt
  and escape the unbudgeted-output guard. Membership now uses a name set
  hoisted once at module load, removing the per-call `Object.keys` as well.

## [1.19.0] - 2026-06-24

Session-boundary capture durability and a post-compaction survival
audit for pinned context. Three durability gaps at session boundaries
are closed, and each new behaviour is off by default or otherwise
byte-identical until opted in. The kernel still calls no LLM.

### Added

- **Post-compaction pinned-anchor survival audit and selective
  re-assertion (`t_post_compact_audit`).** A deterministic, LLM-free
  audit symmetric to the existing pre-compaction capture
  (`extractPreCompactRecords`). After a Hermes context-compaction demotes
  a pinned anchor's text into the background summary block, nothing
  previously verified the anchor still lived in the ACTIVE region or
  re-surfaced it. `detectCompaction` scans the conversation for Hermes
  compressor handoff markers (Unicode SUMMARY_PREFIX, ASCII fallback, and
  legacy `[CONTEXT SUMMARY]:`; overridable per-host) and splits summary
  versus active. A per-session summary-body hash
  (`sessionId:summaryHash` dedupe key on a new `post_compact_audit`
  continuity record) ensures only a genuinely new compaction triggers an
  audit, so re-running each turn cannot churn the prompt cache.
  Locale-agnostic keyword probes (length-based, no stopword list)
  classify each pinned and static anchor as survived, drifted, or absent;
  only drifted anchors (present in the summary, gone from active) are
  re-asserted via `appendPinnedContext`, so survivors cost zero tokens.
  Fail-open throughout (every recoverable error lands in `errors`, never
  thrown), with a bounded drift log. Surfaced as the `o2b brain
  post-compact-audit` CLI verb and gated by `post_compact_survival_audit`
  (default OFF, env/config), with `--force` for diagnostics; unchanged
  installs stay byte-identical.

### Changed

- **Interrupted sessions are captured instead of dropped
  (`t_interrupted_capture`).** Since Hermes PRs #50004/#50003/#50312, a
  SIGHUP/SIGTERM/force-quit/restart-drain now flushes the in-flight
  transcript and fires `on_session_end(interrupted=True)`. Previously
  Open Second Brain swallowed the `interrupted` flag into `_kwargs` and
  these sessions left no memory trace. `session-lifecycle.ts` now threads
  an absent-by-default `interrupted` flag through `NormalizedPayload`; on
  an interrupted `SessionEnd` it consumes the persisted pre-restart
  transcript via the session adapters and runs its user turns through the
  same marker/fact extraction as a live prompt. Double-counting on resume
  is prevented by the existing content-keyed dedupe seams (signal
  `dedup_hash` and the fact dedup index). `interrupted` and
  `transcript_consumed` are recorded honestly in the audit record/result;
  an unreadable transcript surfaces `transcript_consumed: false` rather
  than coercing to a clean close. The Hermes `provider.py` surfaces the
  `interrupted` kwarg from `on_session_end` onto the flush payload
  (absent by default, so a clean close is byte-identical) and makes no
  capture decision. The `pre-compact-extract` path and the
  `brain_pre_compact_extract` MCP schema accept an optional `interrupted`
  flag recorded on the continuity record so an interrupted capture is
  marked honestly. Fail-soft throughout.

## [1.18.1] - 2026-06-24

### Fixed

- **Cross-vault chain-stop reads the max normalized score, not the first
  result (`t_23c1b929`).** The normalized-confidence chain-stop gated on
  `results[0].score`, assuming a score-descending order, but `rerank` and MMR
  reorder results by relevance/diversity, so the positional first element is
  not always the score maximum. It now gates on the maximum normalized score
  across the origin's results, so an enabled chain-stop short-circuits exactly
  when an origin truly answers confidently. Off by default, and byte-identical
  on the default ranking path where the first result already is the maximum.

## [1.18.0] - 2026-06-24

Recall precision, coverage, and provenance hardening. Six related
improvements make recall more accurate, more complete, and more auditable:
an end-to-end provenance reader, exact line-span citations, progressive
disclosure for all recall, normalized-confidence cross-vault early
termination, coverage-driven targeted self-correction, and a configurable
chunk floor. Every new decision is deterministic and LLM-free, and each new
behaviour is off by default or otherwise byte-identical until opted in.

### Added

- **Configurable chunk minimum size (`t_122b2cbc`).** The markdown chunker's
  packing floor (`minTokens`) is now operator-tunable per vault via
  `search_chunk_min_size` / `OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_SIZE`,
  threaded through `chunkMarkdown` and the indexer alongside the existing
  `search_chunk_size` and `search_chunk_overlap` knobs. Default `100` is
  unchanged, so vaults that do not set it hash identical chunks across
  Syncthing peers.

- **Event-to-context provenance reader (`t_8da11868`).** A new read-only
  correlation-join surface attaches a logged event's context traces via its
  correlation IDs, so an operator can answer "why did the agent do this"
  from one surface: the `o2b brain event-trace` CLI verb and the
  `brain_event_trace` MCP tool. Read-only; joins existing records and writes
  nothing.

- **Read-time line-span citations (`t_0b83c97b`).** A shared `LinePointer`
  type and `line-numbering.ts` helpers resolve recalled content to exact
  `path:Lstart-Lend` spans at read time (no Markdown mutation), and evidence
  records and session-recall hits now carry those line anchors for sharper
  citation-depth and answer-containment signals.

- **Progressive disclosure for all recall (`t_468190f5`).** The compact-card
  to expand to raw-transcript disclosure already used by session-recall is
  generalized to the main vault search via `disclosure: "cards"`, so callers
  can pay layer-1 token cost up front and drill deeper only when needed. The
  default `full` path stays byte-identical.

- **Normalized-confidence cross-vault chain-stop (`t_23c1b929`).** Opt-in via
  `search_chain_stop_enabled` / `OPEN_SECOND_BRAIN_SEARCH_CHAIN_STOP`:
  `searchAcrossVaults` stops querying further origins once a completed
  origin's top NORMALIZED `[0,1]` result score reaches
  `search_chain_stop_score` (default `0.8`), recording the skipped origins on
  the new `SearchOutcome.chainStop`. The gate reads the normalized result
  score, never the raw lane score, so a tiny-corpus origin with a high raw
  score never short-circuits. Off by default and byte-identical when no
  origin is skipped.

- **Targeted retry on partial coverage (`t_8eb5ca32`).** In evidence-pack
  mode, when the first pass returns candidates but their IDF-weighted
  coverage of the query is below `COMPLETENESS_COMPLETE_THRESHOLD` with at
  least one RARE significant term still uncovered, `search()` issues
  exactly ONE follow-up FTS pass built from those uncovered rare terms
  (the specifically-missing high-signal facts), merges the recovered
  candidates into the pool, and lets them flow through the normal ranking
  and a regenerated evidence pack. The new pure helper
  `planTargetedRetry(coverage)` (in `coverage.ts`) is the deterministic
  trigger: it fires only on a below-threshold coverage WITH uncovered rare
  terms (a rare gate keeps it off when only corpus-common terms are
  missing) and returns exactly those terms to re-query. This retry is
  mutually exclusive with the existing zero-candidate broadened OR retry
  (one needs an empty pool, the other a non-empty one), so at most one
  retry fires per query — the same single-retry discipline. The
  regenerated pack still abstains on any term left uncovered after the
  retry, so the conservative-on-final-miss posture is unchanged.

- **`SearchOutcome.secondPass.kind` (`t_8eb5ca32`).** The two-pass marker
  now carries `kind: "broadened" | "targeted"` to distinguish the two
  triggers, plus `targetedTerms` (the uncovered rare terms re-queried) for
  the targeted variant. Recovered results carry a
  `second_pass: targeted retry on uncovered rare terms` reason; first-pass
  hits they merge with do not.

### Fixed

- **MCP search output contracts.** Aligned the MCP search tool output with
  the new line-span and disclosure result shapes so the typed-relation and
  evidence fields surface consistently across the CLI and MCP surfaces.

## [1.17.0] - 2026-06-21

CodeGraph link-graph depth and MCP exposure. A set of strictly additive
leaves inspired by Graphify: richer Markdown link resolution, MCP transport
surfaces, and an explicit offline-first guarantee for keyless processing. No
default behavior changes when the new options are unused, and the kernel still
calls no LLM.

### Added

- **Reference-style Markdown links become link-graph edges
  (`t_13c92d85`).** The deterministic link extractor now resolves
  CommonMark reference definitions into the existing `markdown_link` row shape:
  full (`[text][label]`), collapsed (`[text][]`), and shortcut (`[text]`)
  references match labels case-insensitively with collapsed whitespace, reuse
  the same external-URL / `mailto:` filtering and `#anchor` stripping as inline
  links, and ignore image embeds and code fences. Inline-link behavior remains
  unchanged while reference-heavy notes now contribute real graph edges.

- **Standalone `graphify-mcp`-style console entry (`t_da6321a9`).** Packages now
  expose an `o2b-mcp` bin that mirrors the existing `o2b` launcher and injects
  the `mcp` subcommand, so `o2b-mcp --vault X` is equivalent to
  `o2b mcp --vault X`. The shim is transport-agnostic and forwards all flags
  verbatim, including the new HTTP transport flags.

- **Streamable HTTP MCP transport with API-key auth (`t_31dfae18`).** `o2b mcp`
  accepts `--transport stdio|http` (default `stdio`) plus `--host`, `--port`,
  and `--api-key` for HTTP. The HTTP transport is a thin additive peer to stdio:
  it authenticates every request with a generic constant-time API-key check,
  rejects unauthenticated traffic with the same `401 Unauthorized` response,
  rejects JSON-RPC batches per the 2025-06-18 MCP contract, supports JSON or
  single-event SSE responses based on `Accept`, and dispatches every accepted
  request through the existing `MCPServer.handleRequest` core.

- **Explicit offline/deferred backend resolution for indexing
  (`t_85252236`).** The structured `IndexStats` now declares which backend
  processed a run: `backend: "offline"` when only the deterministic lexical
  pipeline ran and no provider credentials were resolved, or
  `backend: "semantic"` when the embedding backend was actually engaged. An
  accompanying `deferredReason` string explains why the semantic backend was
  not used (embeddings not requested, semantic search disabled, or
  `embedding_api_key` not configured); it is null on a semantic run. Backend
  resolution is lazy - the credential check stays inside the explicitly
  requested embedding path, so a deterministic-only corpus indexes to
  completion with no key and never hard-fails for a missing credential.
  Borrowing Graphify's offline-first idea, this makes the already-keyless code
  path an explicit, tested guarantee rather than an implicit side effect:
  `importSession` is verified to never read provider-credential environment
  variables, and keyless indexing is verified to report `offline`. The new
  fields are additive; existing `IndexStats` fields are byte-identical when no
  option changes.



Memory subsystem alignment: the write paths the Hermes memory provider
declares now match the live host memory semantics. The release makes
pinned-context budget handling honest, adds atomic batch writes for
pinned context and continuity, and connects the `on_memory_write` host
bridge so the vault is the durable backing store for native built-in
memory writes. No new LLM, search, dream, or recall behavior; the
storage model stays vault-first Markdown and JSONL.

### Added

- **Atomic batch writes for pinned context and continuity.** An agent can
  now free space and add content in one turn without a partial write
  leaking to disk. `brain_pinned_context` accepts an optional `operations`
  array of ordered `write` / `append` / `clear` / `replace` steps; the
  whole batch is projected and validated in memory first, and a malformed
  operation, an absent `replace` target, or an over-budget final state
  throws `PinnedBatchError` before any write, leaving `Brain/pinned.md`
  byte-for-byte unchanged. Successful writes return a terminal `done`
  marker so an agent does not redundantly re-call. The continuity store
  gains `appendContinuityRecords`, which builds and validates every record
  before any disk write and then appends per month shard under a single
  lock; single-month batches are fully atomic, while cross-shard atomicity
  is deliberately not guaranteed and is documented as such.
  Single-operation pinned and continuity writers stay byte-identical when
  no `operations` array is passed.

- **Hermes `on_memory_write` host bridge.** The provider declared the
  `on_memory_write` memory-provider hook but only mirrored writes to
  `brain_note`; the vault was never the durable backing store for native
  host memory writes. The hook is now a thin adapter over the shared
  continuity substrate: `plugins/hermes/provider.py` forwards verified
  `(action, target, content, metadata)` writes to the new
  `brain_memory_bridge` MCP tool (a deliberate v1.x surface addition,
  pinned in the parity guard; hidden tools are banned by the 1.0.0 sweep),
  which delegates to a deterministic core that persists each write as a
  `host_memory_write` continuity record via `appendContinuityRecord(s)`.
  The contract was verified against Hermes source
  (`on_memory_write(action, target, content, metadata=None)`, action in
  `{add, replace}`, target in `{memory, user}`, batches decomposed
  host-side so a provider never receives an array) before implementation.
  Unknown action, unknown target, and empty content are rejected
  explicitly with nothing written; the path is fail-soft and a no-op when
  the host never calls the hook. The tool is advertised but kept out of
  the provider's `MEMORY_TOOLS` allowlist, so the Hermes agent surface is
  unchanged and only the hook calls it.

### Fixed

- **Pinned-context budget is honest.** Single-operation `write` / `append`
  on `brain_pinned_context` previously normalized pinned content through
  `sanitiseTextField`'s `maxLen` cap, silently dropping the tail and
  returning `done: true`: a deceptive truncated-success the project brief
  forbids. `writePinnedContext` / `appendPinnedContext` now enforce the
  budget explicitly through a shared `assertWithinPinnedBudget` that
  throws `PinnedBatchError` (`code: budget_exceeded`) before any write,
  carrying `operation`, `length`, `budget`, `over_by`, and a
  consolidate-then-retry hint; the MCP layer maps it to a structured
  `INVALID_PARAMS`, mirroring the batch path (which now reuses the same
  assertion). Within-budget writes are byte-for-byte unchanged.

## [1.15.0] - 2026-06-19

### Added

- **Calendar-aware obligations and agenda synthesis.** Two deterministic,
  vault-native surfaces inspired by the obsidian-second-brain calendar
  commands, built to Open Second Brain's contract: the kernel never
  reaches a calendar API or calls a model - the host runtime (e.g. the
  google-workspace skill) fetches events and the Brain owns the durable,
  deterministic record and analysis.
  - **Recurring obligations (`brain_obligation`, `o2b brain obligation`).**
    First-class Brain pages under `Brain/obligations/<slug>.md` tracking a
    periodic commitment (weekly review, monthly report, quarterly audit)
    with a cadence and a deterministically computed `next_due` date.
    `add` creates the page (next-due starts at the anchor), `done` records
    a completion and advances next-due by exactly one cadence interval from
    the completion date, `list` (optionally `--overdue`) sorts by next-due
    with an overdue flag and days-until-due, `show` reads one, `remove`
    archives into `Brain/obligations/archive/`. Cadences: `daily`,
    `weekly`, `biweekly`, `monthly`, `quarterly`, `yearly`, and
    `every-<N>-days`; month-based cadences clamp to the last day of short
    months (Jan 31 + 1 month -> Feb 28/29). Markdown-first and operator
    readable in Obsidian; cadence arithmetic is pure UTC calendar math, so
    the same inputs always yield the same next-due date.
  - **Agenda synthesis (`brain_agenda`, `o2b brain agenda`).** A stateless
    analysis over caller-provided calendar events (a JSON array, or piped
    on stdin for the CLI): overlap **conflicts** between events, free
    **focus blocks** (the gaps a scheduler would slot work into, optionally
    clipped to a `--workday-start`/`--workday-end` window), and
    **external-organizer** flags for events organised outside the
    operator's own email domain(s). Pure function of its input - no vault
    writes, no clock, no model - so a given event list always yields the
    same snapshot.
  - **MCP surface.** Adds `brain_agenda` and `brain_obligation` to the
    frozen tool set; both carry input schemas and the deliberate
    surface-change is pinned in the parity guard.

- **Open Knowledge Format (OKF) export and import.** A portable,
  producer-agnostic bundle for moving a Brain (or part of one) between
  vaults and producers, with a deterministic export-then-import
  round-trip and a review gate for untrusted sources.
  - **Export (`brain okf-export`, `o2b brain okf-export`).** Writes a
    self-contained OKF bundle to a directory: `concepts/`, `queries/`,
    and `references/` pages plus a date-grouped `log.md` and an
    `okf.json` manifest. Read-only on the vault; `--force` overwrites a
    non-empty target directory.
  - **Import (`brain okf-import`, `o2b brain okf-import`).** Reads an OKF
    bundle directory. By default pages land under `OKF Review/` stamped
    `okf_review: pending` as review candidates; `--trusted` writes each
    page straight to its recorded vault-relative path. Foreign-producer
    bundles get producer and raw-type provenance stamped, with
    producer-specific (`x-*`) frontmatter preserved.

- **Obsidian Bases view definitions stamped at vault init.** Four
  native `.base` files are now written into `Brain/bases/` whenever a
  vault is bootstrapped (`o2b brain init`), giving operators structured,
  performant views over the Brain collections without any Dataview
  plugin dependency. Inspired by the obsidian-second-brain
  `/obsidian-projects` + Bases templates work, adapted to Open Second
  Brain's real frontmatter rather than copied verbatim:
  - `projects.base` → canonical entities with `category: project`
    (`Brain/entities/project/`), with Active / Archived / All table
    views, a status icon, and a "stale since update" formula.
  - `people.base` → canonical entities with `category: person`
    (`Brain/entities/person/`), surfacing optional operator-added
    `role` / `company` columns alongside status and freshness.
  - `tasks.base` → recurring obligations (`Brain/obligations/`), ordered
    by an `overdue` formula and `next_due`, with days-until-due.
  - `daily.base` → log days (`Brain/log/`) as a date-sorted table plus a
    calendar view.
  - Files are inert structural scaffolding (no plugin required; ignored
    by editors that do not render Bases) and are stamped like the
    operating manual: written only when absent, overwritten under
    `--force`, never clobbering operator edits on a plain re-run. The
    templates ship under `src/core/brain/templates/bases/` so they
    travel with the published `src/` tree.

- **Strongest-objection steelman in synthesis outputs.** Both the
  `osb://topic/{slug}` resource and `brain_deep_synthesis` now surface
  the single best-formed argument *against* their own implicit
  conclusion, rather than only enumerating tensions within the source
  material. Inspired by obsidian-wiki's steelman section, adapted to
  Open Second Brain's deterministic-core contract (no generated prose —
  the strongest counter-finding is selected by fixed priority and
  framed as a seed for the calling agent to develop).
  - `brain_deep_synthesis` (and `o2b brain deep-synthesis`) add a
    `strongest_objection` field with `basis`
    (contradiction → superseded → stale → knowledge_gap →
    thin_evidence), `statement`, and `source_artifacts`. It is `null`
    only for a larger internally-consistent body, and
    `strongest_objection` joins the dossier's `checked` dimensions.
  - `osb://topic/{slug}` gains an always-present **Strongest objection**
    section steelmanning the current preference: a previously-retired
    rule, a quarantined rule, a recorded negative counter-signal, or an
    unconfirmed-trial caveat, falling back to an explicit "no standing
    objection" line.

## [1.14.0] - 2026-06-18

### Added

- **Configurable default scope for feedback signals
  (`feedback.default_scope`).** A vault-local default applied to
  `brain_feedback` / `o2b brain feedback` writes that pass no explicit
  `scope`, so agent-recorded signals can land in a consistent category
  (for example `coding`) instead of staying uncategorized. The rule is a
  single precedence at the signal write boundary: an explicit per-call
  scope always wins; otherwise the configured default is used; otherwise
  the `scope` field is omitted exactly as before. With no
  `feedback.default_scope` configured and no explicit scope, signal
  output is byte-identical to prior behaviour.
  - **Config block.** Optional `feedback:` block in `Brain/_brain.yaml`
    with a `default_scope` string, validated through the normal Brain
    config policy against the same constraints as a signal `scope` field
    (non-empty after trim, single-line, at most 128 characters). Invalid
    values are rejected by config validation and surfaced by
    `o2b brain doctor` rather than silently ignored.
  - **Parity across surfaces.** The effective scope is computed once and
    reused for the inbox signal, its shared-namespace mirror, and any
    force-confirmed preference, so a preference never diverges in scope
    from the signal that produced it. Distinct from the `owner_scoped_facts`
    and vault guardrail settings, which govern fact visibility rather than
    feedback categorization.

### Security

- **Write-containment backstop at the write-session commit chokepoint.**
  The single point where a write-session lands an agent-supplied artifact
  now re-resolves its target through `ensureInsideVault` before any
  directory creation, read, or write. The earlier target check is purely
  lexical and runs at session-open time, so it cannot see a symlinked
  ancestor (for example a `Brain/<symlink>/note.md` whose ancestor links
  outside the vault) and is decoupled from the write by the persisted
  session record. The backstop fails closed: a target that resolves
  outside the configured vault root is rejected and nothing is written.
  Audit confirmed every other caller-derived vault path (slugs, ids,
  device shards, artifacts) already funnels through the guarded
  `paths.ts` constructors or `ensureInsideVault`, and `validateSlug`
  continues to admit `@` and `+` so email-style and plus-addressed
  identifiers remain valid file basenames while dot-traversal tokens stay
  rejected. Regression tests pin both invariants.

## [1.13.0] - 2026-06-16

### Added

- **Per-handoff LLM generation tracing (`generation_report`).** An
  additive, opt-in, fail-open way to record the real LLM usage an agent
  performs on behalf of a brain handoff, without the kernel ever calling
  an LLM. Open Second Brain owns sequencing and the atomic commit; the
  calling agent owns generation, so tracing is an INBOUND path: after the
  agent fulfils a write-session step, a context-pack consume, or a
  dream-stage proposal, it optionally reports back the usage and Open
  Second Brain stores it as a `generation_report` continuity record.
  - **Inbound report surface (`brain_generation_reports` action `record`,
    `o2b brain generation-reports record`).** Gated (default off) by a
    per-call `enable` flag or the `generation_trace_enabled` config /
    `OPEN_SECOND_BRAIN_GENERATION_TRACE_ENABLED` env. With the gate off no
    payload is built and nothing is written; a throwing build is swallowed
    so tracing never fails the primary operation (`emitGatedTelemetry`).
  - **Payload-safe by construction.** The handoff prompt is hashed and
    counted but never persisted - only `prompt_hash` (SHA-256 hex) and
    `prompt_chars`, plus token counts, reach disk, and the whole payload
    still passes `safeContinuityPayload` redaction. The local token
    estimate (`local_estimate.input_tokens`) is always present; the
    agent-reported `usage` block is present only when supplied and absent
    is reported as absent, never fabricated.
  - **Memory to trace linkage.** `sourceRefs` join each report to the
    handoff ref (write-session session id, context-receipt id, or dream
    run id) and the memory paths involved, lifted to first-class
    `handoffKind` / `handoffRef` read-model fields. The `summary` read
    (`brain_generation_reports` action `summary`,
    `o2b brain generation-reports summary`) rolls up call counts,
    per-handoff-kind breakdown, the local estimate, reported usage, and a
    per-path map so a memory path resolves back to the reports that
    produced or consumed it.
  - **Read surfaces.** `o2b brain generation-reports list|summary|show`
    and the matching `brain_generation_reports` actions (`list` and
    `summary`; `show` is CLI-only). The kernel never
    adds an outbound `fetch`/provider HTTP call - a grep-guarded
    regression test pins this, and a persisted-file assertion confirms no
    raw prompt survives. Default behaviour is byte-identical: the
    write-session envelope, context_receipt, dream_stage metric, and
    recall_telemetry keep their current shapes when the gate is off.
    Documented in `docs/observability.md`, `docs/cli-reference.md`, and
    `docs/mcp.md`.
- **Structural prompt-prefix stability (`prompt_prefix` metric).** A
  deterministic prefix layer plus a run-level metric that reports how
  stable the prompt preamble was across the repeated generation handoffs
  of one brain operation. Open Second Brain cannot port Hindsight's
  provider prompt-prefix caching verbatim - the kernel never calls an
  LLM, so it has no outbound request to cache - but it can guarantee the
  precondition a provider prefix cache rewards: a byte-stable, cache-
  eligible prefix across a pass.
  - **Deterministic prefix helper (`src/core/brain/prompt-prefix.ts`).**
    `deterministicPrefix` certifies a stable preamble (`prefix`, full
    SHA-256 `hash`, code-point `chars`) from stable inputs only - no
    clock, no random, sorted keys via `canonicalSegment`. The decision-
    panel builder routes its shared `Decision topic:` frame through it;
    the bytes of the persona and synthesis prompts are unchanged.
  - **Run-level `prompt_prefix` metric.** A decision-panel commit (opt-in
    `promptPrefixMetric`) and a context-pack consume (opt-in
    `promptPrefix`) emit one record under
    `Brain/metrics/prompt_prefix.jsonl` carrying `kind`, `prefix_hash`,
    `prefix_chars`, `call_count`, and `stable_count`. The reader is
    surface-agnostic (no `metrics.ts` change), exactly like `dream_stage`.
  - **Stability, not cache-hit rate.** The metric measures STRUCTURAL
    prefix stability (what the kernel handed the agent), never a
    provider's cache-hit rate (which the kernel cannot observe). The raw
    prompt is never stored - only its hash and length. Emission is opt-in
    and fail-soft; with the gate off no record is written and the panel
    commit, write-session envelope, and context_pack report are
    byte-identical. Documented in `docs/metrics.md` and
    `docs/observability.md`.

## [1.12.0] - 2026-06-15

### Added

- **CodeGraph and MCP Operational Readability.** Additive, deterministic
  operator surfaces over the optional Codegraph partner and vault community
  detection. With no new option in use, existing reads stay byte-identical and
  the kernel never calls an LLM.
  - **CodeGraph report surface (`o2b partner codegraph report`,
    `brain_codegraph_report`).** A read-only report that resolves the in-scope
    code project, reports the partner index state (`no_project`, `absent`,
    `not_indexed`, `indexed` with node/file/edge counts, or `error`), and
    structurally parses `Cargo.toml` for Rust workspace members. It never
    installs, initializes, extracts, or mutates a codegraph or Graphify index:
    a missing CLI, a missing `.codegraph/` index, and a non-Rust project are all
    honest report states (the latter returns `cargo_workspace: null` with an
    explicit reason) rather than failures or silent no-ops. The report is
    schema-versioned (`schema_version: 1`) and the same shape backs both the CLI
    (`--json`) and the MCP tool. This surfaces the operationally useful kernel of
    Graphify's Cargo workspace work (workspace membership) without adopting the
    extraction binary as a dependency or adding a `crate_depends_on` edge type to
    the Open Second Brain graph schema.
  - **Batched community materialization (`o2b brain clusters run --batch-size N`,
    `brain_clusters` `batch_size`).** Borrowing Graphify's multi-batch labeling
    for large graphs, cluster note materialization can now run in fixed-size,
    order-preserving chunks. Batched mode returns the same community summaries
    plus a `batches` array, each entry carrying `index`, `start`, `end`,
    `written`, `removed`, and an optional `error`; a batch that fails is isolated
    and reported instead of dropping the whole pass. The stale sweep keys off the
    full detected set, so a failed batch leaves its prior note in place rather
    than deleting it, and the single global sweep is attributed to the final
    batch. Detection stays deterministic and label-free (no LLM labeling, no
    natural-language classification, no Graphify dependency). Without
    `--batch-size`/`batch_size` the run is byte-identical to before, and invalid
    sizes are rejected with the usual usage/`INVALID_PARAMS` errors.

## [1.11.0] - 2026-06-14

### Added

- **Session Knowledge Synthesis Suite.** Three additive, deterministic,
  language-agnostic units that turn temporal activity into structured,
  queryable, provenance-traced knowledge. Every unit is a new surface; with no
  new surface in use, reads are byte-identical to before, and the kernel never
  calls an LLM (agent-extracted data is stored verbatim; everything else is a
  pure read).
  - **Structured session summary (`o2b brain session-summary`,
    `brain_session_summary`).** A session-scoped digest over four canonical
    categories - request, decisions, learnings, next_steps - stored as one
    append-only continuity record (`session_summary_digest`), distinct from the
    `session_summary_node` recall rollup and the per-line `pre_compact_extract`.
    The agent supplies the already-extracted categories; the kernel validates,
    dedupes by content hash, and appends, never parsing prose into categories.
    An all-empty digest is rejected; absent a write, reads return null.
  - **Idea-lineage provenance tracer (`o2b brain idea-lineage`,
    `brain_idea_lineage`).** A read-only tracer reconstructing how a derived
    artifact was reached as an observation -> synthesis -> conclusion graph. A
    continuity id walks the `sourceRefs` graph (raw turns are observations,
    summaries/extracts/digests synthesis, the queried record the conclusion),
    resolving edges by record id or turn id, cycle-guarded and depth-bounded; a
    preference id adapts the existing `buildBeliefEvolution` lifecycle into the
    same shape. Unknown ids fail with a typed error rather than a silent empty
    chain.
  - **Episodic note-history decomposition (`o2b brain note-history`,
    `brain_note_history`).** Splits a note's git commit chain into recallable
    episodic phases on a deterministic commit-time gap (default 72h) - a
    language-agnostic rule that never depends on commit-message wording. Each
    phase carries the commit subjects, dates, and authors. A missing repo
    reports `available: false` (no fabricated phase); a path with no commits
    reports `available: true` with zero phases (empty is distinct from broken).
    The sanitized read-only git reader gains an additive `path` pathspec filter.

## [1.10.0] - 2026-06-14

### Added

- **Recall & Working-Memory Quality Suite.** Four additive, deterministic,
  language-agnostic units on top of the mature search/recall subsystem. Every
  unit is flag- or surface-gated; with no profile, flag, or new surface in use,
  search and continuity reads are byte-identical to before.
  - **Selectable recall profiles (`o2b search --profile`, `brain_search`
    `profile` field).** Named presets `fast | balanced | thorough` expand to a
    fixed knob tuple over the same bounded axes the self-tuning grid ranges over
    (candidate pool, traversal depth, learned weights, query expansion) and are
    applied through the same `applyTunedParameters` machinery, so a profile and
    a learned grid point stay coherent. An explicitly selected profile takes
    precedence over a persisted self-tuning grid point; an unknown profile name
    fails loud with a typed `SearchError`. No profile selected leaves ranking on
    the existing config path, bit-for-bit.
  - **Usage-driven working-memory decay (`o2b brain continuity rank`).**
    Continuity records are append-only and immutable, so decay is a pure
    read-side weight in `(0, 1]`, never a mutation. `decayWeight` combines
    record age (exponential half-life) with a usage signal derived only from
    existing `recall_telemetry` surfaced-artifact references; a record whose
    sources were never surfaced - such as a session-scoped `pre_compact_extract`
    decision - has no usage and decays by age alone, with no fabricated coupling.
    `rank` lists working-memory records freshest and most-recalled first.
  - **Language-agnostic co-occurrence auto-relate (`o2b brain co-occurrence`).**
    Entities repeatedly co-referenced from the same notes are scored with a
    structural PMI / document-frequency metric over the wikilink graph - link
    incidence only, no natural-language word list in any language, so a
    non-Latin vault scores identically for the same structure. Output is a
    derived, schema-versioned, hashed suggestion artifact (re-validated on read,
    fail-soft); notes are never mutated and an already directly-linked pair is
    never re-suggested. `--write` persists `Brain/link-graph/co-occurrence.json`.
  - **File-context recall (`o2b brain file-context`, `brain_file_context` MCP
    tool).** Given a file path, surface prior vault work that mentions it by
    querying the existing index with terms derived structurally from the path
    (basename + stem, no natural-language processing, no LLM). A size gate skips
    trivial files (default 1500 bytes) and returns an explicit reason rather
    than a fabricated empty hit.

## [1.9.0] - 2026-06-14

### Added

- **Brain Portability & Interop Suite.** Brain content becomes portable in and
  out of a vault, with provenance, and programmatically writable - composing the
  existing portability helpers rather than adding a new subsystem. Every unit is
  an additive new surface; no existing exporter, importer, CLI verb, or MCP tool
  changes behaviour.
  - **Whole-vault bank export/import (`o2b brain bank-export` / `bank-import`).**
    `exportBankBundle` composes the existing exporters - preferences, the page
    link-graph, the page interchange contract, and the read-only sources
    dashboard - into one deterministic, schema-versioned envelope for backup,
    cross-instance migration, or downstream-tool ingest. `importBankBundle`
    reconstructs the part that round-trips (the page graph, delegated to
    `importVaultGraph` under a conflict mode) and reports preferences, page
    contracts, and the sources dashboard as carried-not-restored - no silent
    partial restore. An unsupported bundle schema fails loudly with a typed
    `BankImportError`.
  - **Page interchange contract (`projectPageContracts`).** A pure, read-only
    projection of every user vault page to a stable, schema-versioned record
    (`path`, `kind`, advisory `confidence`/`provenance`, flattened `citations`,
    `aliases`, `freshness`) a downstream importer can consume without knowing
    Open Second Brain internals. Derivation is structural only (frontmatter
    fields, body wikilinks, typed-relation targets, file mtime); an absent
    advisory field is reported as `null`, never synthesised.
  - **`brain_create_note` MCP tool.** Writes an actual vault note file (path +
    frontmatter + content) atomically through `ensureInsideVault` - distinct
    from `brain_note`, which only appends a log line. Refuses path traversal, the
    Brain machinery root, vault-scope-excluded paths, and overwriting an existing
    note, each with a typed error mapped to INVALID_PARAMS.
  - **In-process SDK (`createBrain(vault)`).** A thin façade over the existing
    core functions - bank export/import, graph export/import, preference export,
    `ingestSource`, and `createNote` - plus source-backed reads
    (`listSources`/`getSource`/`deleteSource`) over the `kind: brain-source`
    summary pages. Every method is a one-line delegation; the upstream
    `writeStatus` maps to `ingestSource` (Open Second Brain has no separate
    source status lifecycle). A source id that resolves outside `Brain/sources`
    is treated as not-found and never deleted.

## [1.8.0] - 2026-06-13

### Added

- **Indexer Durability & Resilience Suite.** Interrupting a long index run no
  longer risks losing work or wedging the index. The suite makes cancellation
  cooperative, the watcher shutdown graceful, and a full rebuild resumable -
  reusing the existing `Safeguard` and per-vault lock rather than adding a new
  lifecycle subsystem. Every behavioural change defaults to today's behaviour;
  a vault that sets nothing is byte-identical.
  - **Cooperative abort (`Safeguard` + `AbortSignal`).** The cooperative
    deadline gains an optional `AbortSignal`: one `checkpoint()` now trips on
    either an aborted signal (a new `SafeguardAbortError`, checked first) or the
    existing timeout. The signal threads through `indexVault` and
    `populateEmbeddings`, checked at the same boundaries the deadline uses -
    between files and between embed batches, never mid-write - so a run can be
    cancelled on demand. Bun's SQLite is synchronous, so abort stays
    cooperative; the deletion sweep runs only on full completion, so an aborted
    run leaves a consistent, partially-refreshed index.
  - **Graceful `o2b search watch` shutdown.** SIGINT/SIGTERM now stops accepting
    new flushes, aborts the in-flight pass, and awaits it to settle at a
    cooperative boundary before exiting - bounded by `search_shutdown_grace_seconds`
    (default 5). A signal no longer kills a pass mid-write. The flush/shutdown
    coordination lives in a testable `IndexWatchRunner`; a second signal falls
    back to the default terminate. `0` grace exits immediately after signalling.
  - **Opt-in resumable reindex (`search_resume_reindex`).** An interrupted full
    `reindexVault` rebuild no longer discards all progress: a compatible
    in-progress `brain.sqlite.new` staging build is resumed via the incremental
    fastpath instead of rebuilt from scratch. Resume is gated on a signature
    marker (schema version + chunk parameters + embedding signature) stored in
    the staging DB's `index_state` KV - no schema migration - so a drifted or
    unreadable staging DB is discarded and rebuilt, never trusted. The marker is
    cleared before the atomic swap, so the live index never carries staging
    state. Default off keeps the always-fresh rebuild.
  - **Writer-lock heartbeat + WAL-flush-on-exit.** The async writer lock refreshes
    its mtime mid-run (explicit heartbeat below the 60s stale window) so a long
    index is never mistaken for a stale lock. A process-exit registry consolidates
    each open writer's WAL on a bypassed `close()`, mirroring the existing
    sync-lock cleanup hook.
- Honest multi-instance story (no new daemon): the MCP server is stdio-only, so
  isolation comes from the per-`dbPath` writer lock. Two instances on different
  vaults run conflict-free; a second writer on the same vault gets a typed
  `INDEX_LOCKED`. Pinned by tests; no `--port`/`--instance` model was fabricated.

## [1.7.0] - 2026-06-13

### Added

- **Knowledge Provenance Suite.** Six features share one theme: every piece of
  knowledge in the brain carries its origin (which source, which premises, which
  owner, whether stated or inferred), and the operator can steer what surfaces.
  All generation lives on the agent side of the MCP boundary - Open Second Brain
  is provider-agnostic and bundles no model. Every behavioural change is opt-in;
  a vault that enables nothing is byte-identical in results, ordering, and shape.
  - **Source-ingest pipeline (`brain_ingest_source`).** One text-bearing source
    (document / note / URL text) becomes entity and concept pages plus a
    per-source summary page that backlinks the source, lists the entities it
    introduced, and lists its connections to pre-existing material. Idempotent on
    the source path. No OCR or binary/media path.
  - **Parameterized research pipeline (`brain_research_report`).** N consulted
    sources plus an agent synthesis become one dated report page where each
    finding cites the source that flagged it. A finding with no source, or one
    citing an unconsulted source, is rejected - no uncited claims.
  - **Model-based entity intake (`brain_intake_entities`).** The agent extracts
    entities from note text (it owns the recognition; no ML model is bundled) and
    submits them; Open Second Brain validates the typed payload and commits it
    through one shared, idempotent intake into the entity registry. Opt-in and
    non-blocking: a plain note write never triggers it.
  - **Derived-fact synthesis (`brain_derive_fact`).** The agent reasons a
    second-order conclusion from existing premises; Open Second Brain validates
    each premise exists and commits an unconfirmed preference carrying a
    `deduced`/`inferred` provenance level and premise links. Opt-in behind the
    `derived_fact_synthesis` guardrail. Recall trust ordering
    (`provenance_trust_ordering` guardrail) ranks stated > deduced > inferred in
    the active digest.
  - **Owner-scoped canonical facts.** A preference may declare an `owner:` token;
    `brain_query` gains an `agent_scope` argument (gated by the
    `owner_scoped_facts` guardrail) that returns an owner-private fact only to its
    owner and keeps shared facts visible. Reuses the v1.6 owner-visibility model;
    fails closed.
  - **Operator-editable standing-query attention layer.** The attention-flows
    mechanism gains a `standing_query` action: an operator declares scope tokens
    in a flow doc and the matching confirmed preferences always surface into the
    assembled context. Structural selector, language-agnostic.

## [1.6.0] - 2026-06-13

### Added

- **Vault Integrity & Trust Suite.** Five language-agnostic units that harden
  the trust and identity boundaries of the vault. Every behavioural unit is
  opt-in, so a vault that enables nothing keeps byte-identical results and
  output shape; the one unconditional change (NFC path identity) is idempotent
  on already-NFC input, so the dominant platform is unaffected.
  - **Untrusted-source containment.** A new guardrail flag
    `untrusted_source_delimiting` (default off) wraps each untrusted memory body
    surfaced into an agent-facing context pack in a provenance-carrying
    `<untrusted_source path="..." sha256="...">` delimiter and structurally
    neutralizes it (invisible/control characters stripped, delimiter breakouts
    escaped) instead of matching it against an English-only injection blocklist
    and blanking it. Lossless and identical across every language: neutralization
    keys off structure, never a natural-language word list.
  - **Canonical NFC note-path identity.** The vault walker funnels every note's
    vault-relative identity through `canonicalNotePath` (POSIX + Unicode NFC), so
    the same note has one identity across a macOS (NFD) / Linux (NFC) Syncthing
    peer set. Kills the cross-device re-index churn and phantom duplicates that a
    byte-different path produced. Idempotent on already-NFC input.
  - **File-watcher index sync.** `o2b search watch` watches the vault for `.md`
    edits and incrementally re-indexes after a debounced quiet window, reusing
    the existing incremental `indexVault` fastpath. A single-flight guard
    prevents overlapping passes; recursive `fs.watch` unavailability fails loudly
    with guidance rather than silently no-op-ing. No new dependency.
  - **O(1) graph stats/queries.** A precomputed link-graph side-index (resolved
    adjacency, degree, top-degree) is memoized on the store and invalidated on
    the index revision, so community detection and the new `brain clusters` graph
    summary stop rebuilding the adjacency on every call. Byte-identical community
    output; in-memory only, never persisted.
  - **Agent-scoped recall isolation.** `brain_search` accepts an `agent_scope`
    input: a page that declares an `owner:` frontmatter token is returned only to
    its own owner, while shared (ownerless) pages always match. Absent scope = no
    ownership filtering, so existing callers are byte-identical. Fails closed on
    an unparseable page under an active scope.

## [1.5.0] - 2026-06-13

### Added

- **Search & Recall Quality Suite.** Seven language-agnostic enhancements to
  the retrieval core. The five `brain_search` enhancements are each gated behind
  their own flag, so a call that sets none of them returns byte-identical
  results, ordering, and shape to before; the hybrid-degrade warning fires only
  in a genuinely degraded state, and `brain_eval` is a new read-only tool.
  - **Structured score breakdown.** `brain_search` accepts `explain: true` and
    returns a per-result `score_breakdown` object (keyword, semantic, rrf,
    entity, activation, coAccess, link, recency, tier, trend, sessionFocus)
    alongside the existing human-readable `reasons[]`. The ranker now emits the
    breakdown first-class, and the learned-weights fold reads it directly
    instead of re-parsing reason strings.
  - **Hybrid-degrade warning.** When a caller wants the semantic lane but it
    cannot run (missing embeddings, unloaded vec extension, unconfigured key),
    the result set carries one greppable `hybrid_degraded:` warning instead of
    silently serving keyword-only. A keyword-only-by-choice query and a
    semantic-disabled vault never carry it.
  - **Inline trust metadata.** `brain_search` accepts `trust: true` and stamps
    each hit with a computed-at-read-time `trust` object: `age_days` from the
    document mtime, plus `superseded` and `conflict` derived from the
    `superseded_by` / `contradicts` typed relations the recall path already
    surfaces. Never stored.
  - **Relevance threshold and rerank.** `threshold` (a `[0,1]` score floor
    applied before the diversity rerank) drops weak hits so an irrelevant query
    returns no match instead of noise; `rerank` re-orders the qualified set by
    core textual relevance. Both off by default.
  - **Self-tuning reinforce.** `reinforce: [paths]` records proven-useful
    memories to a conflict-free one-file-per-signal ledger under
    `Brain/search/reinforce/` and lifts ledger-strong memories by a bounded
    boost before the top_k cut. Surfaced-only frequency is never recorded and
    never boosts; the ledger is resettable.
  - **Answer-containment@k benchmark metric.** The recall benchmark accepts an
    optional per-query `answer` and reports `answerContainmentAtK` - whether the
    answer text appears (folded substring) in the retrieved content within the
    top k. The committed fixture gains answer-bearing queries with a CI floor;
    datasets without `answer` keep hit@k / MRR behaviour unchanged.
  - **`brain_eval` MCP tool.** A read-only tool that scores retrieval quality
    over a caller-supplied dataset against the active vault, returning hit@k,
    MRR, answer-containment@k, source-utilization@k, citation-depth, and a
    source-warnings count a CI gate can cap. The fast path needs no embedding
    key.

## [1.4.0] - 2026-06-12

### Added

- **Native Grok Build (xAI `grok`) integration.** `o2b install --target grok
  --apply` registers the two Open Second Brain MCP servers in
  `${GROK_HOME:-~/.grok}/config.toml` under `[mcp_servers.*]` (grok's
  highest-priority MCP source) and writes lifecycle hooks to
  `${GROK_HOME:-~/.grok}/hooks/open-second-brain.json` (grok's native hooks
  dir), each with an absolute `bun run <repo>/src/cli/main.ts …` command.
  Verified against live grok 0.2.45 (session debug log): grok spawns MCP and
  hook processes with a restricted PATH that excludes `~/.local/bin`, so a bare
  `o2b` command fails to spawn - the absolute form is what actually handshakes
  in a session (71 + 5 MCP tools registered; active-context inject, post-write
  reminder, session capture, and the stop-log guardrail dispatched). The shared
  hook layer normalizes grok's camelCase stdin payload (`hookEventName` /
  `sessionId` / `toolName` / `toolInput`) into the internal shape, detects the
  `grok` runtime, and counts grok's `search_replace` as a file-mutating tool. A
  new `grok` session adapter imports grok's ACP `updates.jsonl` stream into the
  Brain via `o2b brain import-session` (autodetected). The integration uses grok's
  own config, not the `~/.claude/` namespace. See
  [`install/grok.md`](install/grok.md).
- **Per-runtime host-qualified Brain identity.** Every runtime that registers
  the MCP servers (grok, opencode, openclaw, and Codex via `codex mcp add`) now
  attributes its Brain writes to its OWN host-qualified name rather than the
  shared operator `agent_name`. The host segment of the operator name is kept and
  the vendor token is swapped to the runtime's own id (`claude-vps-agent` ->
  `grok-vps-agent` / `opencode-vps-agent`; a name outside the
  `<vendor>-<host>-agent` shape is prefixed with `<runtime>-`). This keeps a
  shared multi-device vault (e.g. Syncthing across a VPS, a dev box, and a Mac)
  able to tell the same runtime apart both across runtimes and across devices.
  The derived name is read from the payload's operator name, so `apply` and
  `verify` produce the identical value and `o2b install --check` reports no drift
  after an apply. For grok, both the `config.toml` MCP env and the hooks file
  carry the same derived name.

## [1.3.1] - 2026-06-11

### Fixed

- **Hermes provider returned a dict where the contract requires a string**
  (`plugins/hermes/provider.py`): `handle_tool_call` forwarded the raw MCP
  `tools/call` result dict straight back to Hermes, which feeds it to the
  model as tool-message content. Lenient providers (Anthropic) accept a
  dict, so the bug stayed hidden; strict ones (DeepSeek) reject it with
  HTTP 400 (`content should be a string or a list`) on the next API call.
  The bridge result is now serialized at the boundary through a single
  `_as_tool_content` seam (lossless JSON, `default=str`, string results
  passed through), and `handle_tool_call` is typed `-> str` to match the
  base-class contract. Contract tests now assert the return type against
  every result shape, closing the gap that let the leak through unnoticed.
  Reported in #82.

## [1.3.0] - 2026-06-10

Continuity, Hygiene & Freshness Suite: one conversation stays one
session across host context compressions, and the Brain gains a
remediation pipeline for the entropy it accumulates - contested facts,
near-duplicate rules, stale derived pages, never-recalled memories.
Two kernels carry the release: a session-lineage resolver consumed by
capture, recall, and the new anticipatory cache, and a hygiene
findings pipeline composing pure detectors behind one scan/apply
surface.

Native opencode integration: the install adapter now writes the config
opencode actually reads, and a bundled plugin brings the runtime to
near-parity with the Claude Code and Codex integrations - live active
context injection, lifecycle-driven session capture, and the post-write
logging reminder.

### Added

- **Bundled opencode plugin** (`plugins/opencode/open-second-brain.ts`):
  a single zero-dependency file installed into
  `~/.config/opencode/plugins/` by `o2b install --target opencode
  --apply`. On each chat request it appends the rendered
  `Brain/active.md` digest to the system prompt (via the same
  `o2b-hook active-inject` shim the Claude Code and Codex hook layers
  use, cached with a 5 minute TTL); on `session.idle` /
  `session.compacted` / `session.deleted` it snapshots the session as
  a deterministic JSONL spool under
  `${XDG_DATA_HOME:-~/.local/share}/open-second-brain/opencode/`; after
  file-mutating tools it appends the standard logging nudge to the
  tool output. Every hook is fail-soft - a missing vault, missing
  binary, or SDK error never breaks the opencode session.
- **opencode session adapter** (`src/core/brain/sessions/opencode.ts`):
  fourth adapter in the session registry. Imports the plugin-owned
  spool format (`format: 1`, originator
  `open-second-brain-opencode-plugin`) through the same
  `o2b brain import-session` flow as Claude, Codex, and Hermes
  transcripts; a spool written by a newer plugin fails with a
  versioned error instead of silently dropping fields.
- **Pluggable MCP entry shape** in the shared JSON-merge install layer:
  `createJsonMcpAdapter` accepts `serializeEntry` / `entryEquals`, so
  runtimes whose MCP config schema differs from the default
  `{command, args, env}` entry reuse the same
  detect/plan/apply/verify/uninstall body with drift detection intact.
  Existing targets (Cursor, kiro, Gemini CLI) are byte-identical.

- **Session lineage kernel** (`src/core/brain/lineage/`): every session
  id resolves to a lineage (root id, parent segment, compression
  depth). Native path reads the new optional `parent_session_id` /
  `root_session_id` / `compression_depth` hook-payload fields (ready
  for upstream Hermes PR #42940); until the deployed host emits them,
  a conservative interim inference - isolated in one file and marked
  `CRUTCH(t_1459706f)` - links a brand-new session to a predecessor
  only on compression evidence plus same cwd inside a bounded window.
  Time proximity alone never stitches; every ambiguous case stays flat.
- **Compression-aware session recall**: imported session records carry
  additive lineage payload fields, and `brain_session_grep` /
  `brain_session_describe` resolve any segment id to the whole stitched
  conversation. Describe exposes the segment chain with its continuity
  edges; never-compacted sessions keep the exact pre-lineage shapes.
- **Staged degradation ladder** for over-budget recall entries:
  `recall.degradation: staged` in `_brain.yaml` trims at the last
  sentence terminator (structural multi-script punctuation), then whole
  leading lines, then the historical hard cut - which stays the
  byte-identical default.
- **Anticipatory context cache**: lifecycle hooks keep a small
  turn-specific bundle (active context pack + session-recall hits for
  the latest prompt) warm under `Brain/.state/`, keyed by the lineage
  root, TTL-debounced, atomically written - no daemon, no watcher. New
  `brain_anticipatory_context` MCP tool and `o2b brain anticipate` verb
  read it cache-or-live with an explicit `cache_state`.
- **Source-freshness contract**: derived pages record `source_paths` +
  `source_hashes` at derivation (handoff notes stamp their transcript
  automatically); freshness computes on demand as fresh / stale /
  orphaned with no background jobs.
- **Hygiene findings pipeline** (`src/core/brain/hygiene/`): pure
  detectors - truth-layer value conflicts, semantic near-duplicate
  preferences (embedding cosine with a labeled lexical fallback),
  freshness, never-recalled low-usefulness candidates - compose into a
  read-only scan digest; apply executes only explicitly selected
  finding ids through existing primitives (preference merge, claim
  append, targeted recompile, archive-never-delete) with an audit
  record per run. New `brain_hygiene` MCP tool and `o2b brain hygiene
  scan|apply` verbs.
- **Advisory conflict resolution** through the shared external-command
  bridge: when the operator configures `hygiene.resolver_cmd`, contested
  truth slots get supersede / merge / flag verdicts with recorded
  rationale; without it (or on any failure) every conflict stays
  flagged for review. The command comes exclusively from operator
  config - never from tool arguments.
- **Targeted recompile**: `o2b brain refresh --stale [--dry-run]`
  re-derives only pages whose recorded sources changed (handoff notes
  re-derive in place from their transcript), archives orphans into
  `Brain/.snapshots/`, and reports unknown pipelines as manual.
- **Config blocks** `hygiene` (resolver_cmd, dedup_threshold),
  `anticipatory` (ttl_seconds, max_tokens), and `recall` (degradation)
  parse through the existing YAML subset with hard shape errors.
- **Shared external-command JSON bridge**
  (`src/core/reliability/command-bridge.ts`) extracted from the bench
  judge: one sanctioned fail-open boundary for every external-judgment
  consumer.

### Changed

- The frozen Brain MCP tool surface grows deliberately from 54 to 56
  names (`brain_hygiene`, `brain_anticipatory_context`); the parity,
  name-list, and count guards were updated in the same change.
- `HookPayloadBase` gains optional lineage fields and the SessionStart
  `source` discriminator; hosts without them behave byte-identically.

### Fixed


- **opencode install adapter targeted a file opencode does not read.**
  The adapter now merges the two Open Second Brain servers into
  `~/.config/opencode/opencode.json` under the `mcp` key using
  opencode's entry schema (`{type: "local", command: [bin, ...args],
  environment, enabled: true}`), honouring `XDG_CONFIG_HOME`. Apply
  also migrates the stale `~/.config/opencode/mcp.json` written by
  earlier releases: the two Open Second Brain keys are removed, and the
  file is deleted when nothing else remains.

## [1.2.0] - 2026-06-09

Codebase-wide SOLID/DRY refactor: god modules decomposed into cohesive
domain modules and duplicated helpers unified, with zero behavior change.
The public surface is untouched - MCP tool names, CLI verbs, file formats,
output strings, and exit codes are all byte-identical to 1.1.0, and a new
frozen-surface parity test now guards the MCP tool-name set mechanically.

### Changed

- **MCP brain tools split by domain**: the 5,614-line `src/mcp/brain-tools.ts`
  monolith (54 tools, 100+ helpers) is now 16 cohesive modules under
  `src/mcp/brain/` (feedback, review, context, pack, query, entity, health,
  brief, analytics, knowledge, admin, recall, workspace, procedure, landscape,
  shared), mirroring the per-domain split the sibling tool files already used.
  `brain-tools.ts` remains the aggregation seam exporting `BRAIN_TOOLS`, so
  every existing import keeps working. Tool registration order within
  `tools/list` enumeration changed; the name set and each tool's schema,
  description, and handler are unchanged.
- **Dream pass decomposed**: `dream.ts` (2,239 lines) now orchestrates four
  extracted modules - `dream-plan.ts` (scan-record and plan-state shapes),
  `confidence.ts` (Wilson-bound confidence computation), `dream-refresh.ts`
  (apply-evidence scan and refresh/promotion planning), and
  `reconcile-outcomes.ts` (contradiction classification) - each independently
  unit-tested.
- **Brain config parser extracted**: the 230-line YAML subset parser moved out
  of `policy.ts` into `yaml-parse.ts`; `policy.ts` keeps config semantics only.
  The grammar is unchanged.
- **One wikilink syntax module**: seven divergent `[[...]]` regex definitions
  collapsed into named, purpose-documented variants in
  `src/core/brain/wikilink.ts`, with characterization tests pinning each
  former call site's contract.
- **One atomic-write module**: `src/core/reliability/atomic.ts` merged into
  `src/core/fs-atomic.ts`; the validate-hook and private-mode variant
  (`atomicWriteText`) now shares the single temp-file + fsync + rename
  pipeline.
- **CLI brain verbs share context helpers**: 76 verb files replaced the
  repeated config/vault/agent resolution boilerplate with
  `brainVerbContext(flags)` and `resolveBrainAgent(flags, config)` from the
  helpers barrel, called at the exact position of the former inline code so
  validation order and error output stay identical.

### Added

- **Frozen-surface parity test**: `tests/mcp/brain-tools-parity.test.ts` pins
  the exact v1.x Brain tool-name set; any future registry change that drops,
  duplicates, or renames a tool fails CI.
- **Core layering guard**: `tests/core/layering.test.ts` fails when anything
  under `src/core` calls `process.exit`, `process.stdout.write`, or
  `console.log` - the calls that belong to the CLI layer.

### Removed

- **`scripts/sync-version.py`**: superseded by `scripts/sync-version.ts`
  (the only version the build invokes) since 0.8.1.

## [1.1.0] - 2026-06-09

Removal of the Pay Memory layer. The pay.sh integration and the entire
payment-memory subsystem it supported have been taken out of Open Second
Brain. Brain (observing memory), schema, search, and the rest of the surface
are unchanged. Historical records are preserved: this changelog, the dated
`docs/plans/` and `docs/brainstorm/` design notes, and any existing
`Brain/payments/` content in a vault are left untouched.

### Removed

- **BREAKING - Pay Memory MCP tools**: `payment_memory_init`,
  `payment_receipt_append`, `asset_capture`, `payment_report_generate`,
  `payment_policy_check`, `payment_request_approval`, `payment_request_status`,
  and `payment_request_consume` are no longer advertised or callable on any
  scope. The advertised full-surface tool count drops from 77 to 69.
- **BREAKING - Pay Memory CLI verbs**: `init-pay-memory`,
  `append-payment-receipt`, `capture-asset`, `payment-report`,
  `check-payment-policy`, `request-payment-approval`, `approve-payment-request`,
  `reject-payment-request`, `consume-payment-request`, `list-pending-payments`,
  and `payment-digest` are removed from the `o2b` command surface.
- **OpenClaw plugin**: the eight payment tool registrations are removed from the
  native plugin entry; the bundle now exposes `second_brain_status`,
  `second_brain_query`, and `vault_health` only.
- **Core modules and docs**: `src/core/pay-memory/`, the payment CLI module, the
  `docs/pay-memory.md` guide, the Hermes payment-digest example and cron
  section, and the `payment` / `asset` surface-group prefixes are deleted. The
  shared `vaultRelativePath` helper now imports from `core/path-safety`.

### Changed

- **Language-agnostic fact extraction**: the real-time fact extractor
  (`fact-extract.ts`) and the assertion-to-claim ingest (`truth/ingest.ts`) no
  longer rely on hardcoded English trigger phrases. Extraction now keeps only
  structurally detectable, language-neutral facts - URLs, e-mail addresses, and
  quantities bound to a currency glyph, ISO-4217 code, or percent - so a fact
  extracts identically whatever the surrounding language. This completes the
  language-agnostic work that made search and classification structural; the
  extractor was the last component carrying per-language word lists. Prose facts
  (name, preference, location) are no longer auto-captured by this real-time,
  LLM-free path: a deliberate, precision-safe recall reduction.
- **Quantity aggregation by unit**: `parseQuantityFact` no longer derives a
  prose `action` verb. The quantity claim keeps a nullable `action` for the
  explicit-label path (MCP ingest `quantity_action`), and `aggregateQuantities`
  / the `o2b brain truth aggregate` and `brain_truth` `action` argument are now
  optional - totals combine by entity + unit by default.
- **README** trimmed to user-facing value: the version-by-version feature
  catalog and the full CLI command dump moved behind the existing documentation
  links, leaving a compact "What you get" overview.

### Removed

- **`FactFamily` prose members**: `identity`, `preference`, `possession`,
  `location`, and `confirmation` are removed from the structural fact extractor;
  only `url`, `email`, and `quantity` remain. The matching English
  `STRUCTURERS` and `POSSESSION_RE` in `truth/ingest.ts` are deleted.

## [1.0.1] - 2026-06-07

Hermes registration fix. The memory provider now advertises its curated
`brain_*` tool set from the very first `get_tool_schemas()` call, so a fresh
gateway start registers it with the full tool count instead of zero and tool
calls route correctly.

### Fixed

- **Hermes registered the provider with 0 tools and `brain_*` calls failed as
  "Unknown tool"**: Hermes builds its memory-tool routing table at provider
  registration, before `initialize()` starts the `o2b mcp` bridge, and never
  rebuilds it - while the provider only produced schemas from the live bridge.
  `get_tool_schemas()` now falls back to vendored static copies of the curated
  tool schemas (`plugins/hermes/_schemas.py`) whenever the bridge is not
  available or the live listing fails; once the bridge is up, live `tools/list`
  schemas win as before. The `handle_tool_call()` initialization guard is
  unchanged.

### Notes

- The vendored copies are verbatim (name, description, inputSchema) projections
  of the live server's `tools/list` and are locked by an anti-drift test
  (`tests/python/test_static_schemas.py`) that compares them against a live
  `o2b mcp` in CI, so they cannot silently diverge from the TypeScript core.
- Lifecycle hooks (prefetch, sync_turn, system prompt block, pre-compress,
  session end) were unaffected by the bug and are unchanged.

## [1.0.0] - 2026-06-05

Stability & Trust: the first major release formalizes what eleven
release cycles built. The public contracts - the MCP tool surface,
the CLI verb tree, configuration keys, the search schema ladder, and
every on-disk format schema - are now frozen under an explicit
stability policy (`docs/stability.md`), and the one breaking change a
major allows is spent deliberately: the 18 hidden alias tools left
over from the token-diet consolidation are removed, replaced by
server-side tombstones that answer a stale call with the exact
replacement tool and view. The hardening set makes "production-ready"
an earned label: every long-running operation (dream, reindex, bridge
discovery, communities, the maintenance lane) runs under a
cooperative safeguard deadline with clean abort semantics and
config-resolvable budgets; the self-improvement loop gains a staged
stage -> validate -> apply lifecycle over a persisted, discardable
proposal bundle while `dream()` stays the only promotion engine;
user-facing and LLM-facing timestamps render the operator's
configured timezone at the presentation layer while storage stays
canonical UTC; and the digest / daily / weekly surfaces persist
machine-diffable snapshots that report a deterministic "since last
run" delta. A vault that configures nothing behaves identically -
except calls to the 18 removed aliases, which is the documented
break with a migration table in `docs/updating.md`.

### Removed

- **The 18 deprecated hidden MCP alias tools** (10 brain aliases of
  `brain_brief` / `brain_analytics` views, 8 schema aliases of
  `schema_inspect` views). Hidden from `tools/list` since v0.34.0,
  they stayed callable; 1.0.0 deletes the alias layer so the
  advertised list and the callable surface are the same set. Calling
  a removed name answers an INVALID_PARAMS tombstone naming the
  replacement (`brain_digest was removed in 1.0.0; call brain_brief
  with view="digest"`). Full table in `docs/updating.md`.

### Added

- **Stability policy.** `docs/stability.md` pins the frozen contracts
  and defines what counts as breaking per class; `docs/updating.md`
  gains the 0.x -> 1.0.0 upgrade section.
- **Doctor removed-surface check.** `removed-tool-reference` warnings
  for Brain notes, root instruction files, and installed skills that
  still name a removed tool, each with its replacement.
- **Operation safeguard.** A cooperative deadline object checkpointed
  at natural iteration boundaries in dream, indexing, bridge
  discovery, communities, and the maintenance lane - honest abort
  between atomic writes, never a fake async cancellation. Budgets
  resolve per-operation (`safeguard_timeout_<op>_seconds`) -> env
  (`OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`) -> global
  (`safeguard_timeout_seconds`) -> default 600s; `0` disables. Lane
  task results classify `timed_out`; persisted error strings cap at
  4096 bytes with an explicit marker.
- **Staged dream pipeline.** `o2b brain dream stage | validate
  <run-id> | apply <run-id> | discard <run-id> | list` (MCP
  `brain_dream` gains an `action` parameter - no new tools). Stage
  persists a reviewable bundle under `Brain/dream/staged/<run-id>/`
  (manifest with schema `o2b.dream-stage.v1`, human REPORT.md,
  sources with content hashes, proposals as data); validate
  recomputes the clock-normalized plan and reports drift; apply
  re-validates and runs the same engine live, archives the bundle,
  and records a `dream_stage` metric. A drifted bundle aborts before
  any write.
- **Timezone presentation layer.** With `timezone:` configured
  (env `VAULT_TIMEZONE`), brief and analytics envelopes gain additive
  `timezone` + `local_time` fields and human output renders local
  wall time; storage, frontmatter, log headings, and run ids stay
  canonical UTC.
- **Dual-output reports.** With `report_snapshots_enabled` (env
  `OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS`), digest / daily / weekly runs
  persist `Brain/reports/<surface>/<date>.json` (schema
  `o2b.report-snapshot.v1`) and report a deterministic keyed delta -
  arrays diff by stable identity, never by order - as a `delta` JSON
  field and a "Since last run" block.

### Changed

- Error-message prefixes inside the consolidated view handlers now
  name the consolidated form (`brain_brief view=monthly: ...`).
- The `o2b brain dream` verb accepts an optional positional action;
  the bare form is unchanged.

## [0.45.0] - 2026-06-05

Link & Recall Intelligence Suite: the graph self-organizes and recall
quality becomes measurable. Wikilinks to frontmatter aliases resolve
at index materialization; an orphan-first bridge pass over the vec
index proposes links between embedding-near notes that never name
each other, as a reviewable artifact with an accept/dismiss
lifecycle; deterministic label propagation discovers graph-wide
communities and materializes derived cluster digests; a fixed-dataset
recall benchmark (hit@k + MRR) gates ranking regressions in CI and
scores operator vaults on demand; a bounded, replayable self-tuning
fold selects retrieval parameters judged by that benchmark, applied
only under an explicit opt-in flag; and a bare query can expand into
the existing structured lex/vec/hyde lanes with no model and no paid
call. Every feature reports run-level numbers into one
schema-versioned `Brain/metrics/` layer - the stable on-disk contract
the upcoming dashboard plugin reads without importing internals. A
vault that enables none of it behaves bit-identically. MCP tool count
grows 73 -> 77.

### Added

- **Dashboard-ready metrics layer.** One append-only JSONL file per
  surface under `Brain/metrics/` (`index`, `bridge_discovery`,
  `communities`, `recall_benchmark`, `self_tuning`), envelope
  `{schema: "o2b.metrics.v1", surface, run_at, payload}` with the
  continuity-record evolution rule (additive fields keep the
  version). Run-level only - per-query events stay in recall
  telemetry. Contract documented in `docs/metrics.md`.
- **Vault-wide alias resolution** (schema v7). The indexer extracts
  frontmatter `aliases:` arrays into a `doc_aliases` table
  (NFC-normalised, lower-cased - the `alias-index.ts` rule); after
  exact-path resolution a shadowing-safe alias pass materializes
  `target_document_id` for slash-free wikilink targets, so traversal,
  backlinks, and link constraints see `[[PA]] -> project-alpha.md`.
  Exact paths always win; a real document basename is never shadowed;
  collisions resolve first-wins by sorted path.
  `IndexStats.aliasResolved` counts the pass.
- **Bridge discovery** (`o2b brain bridges`, MCP `brain_bridges`).
  Orphan-first scan (ascending inbound-link order) takes chunk
  embeddings to sqlite-vec KNN, converts unit-vector L2 to cosine,
  aggregates to document level, and proposes pairs above the
  similarity threshold that share no edge in either direction.
  Output is the regenerated reviewable
  `Brain/proposals/bridges.md`; `dismiss` persists pair suppressions;
  `accept` writes exactly one `related:` wikilink into the source
  frontmatter, idempotently, honoring schema-pack link constraints.
  Fail-soft without an index or embeddings.
- **Community detection with cluster notes** (`o2b brain clusters`,
  MCP `brain_clusters`). Deterministic synchronous label propagation
  (sorted sweeps, lowest-label tie-break, iteration cap against
  bipartite oscillation) over the resolved doc-level link graph;
  communities of size >= 4 materialize
  `Brain/clusters/cluster-<id>.md` digests - members by internal
  degree, shared entities, link density, no LLM prose. Derived notes
  regenerate every run; stale generated notes are removed;
  hand-written files in the directory are never touched;
  `brain-cluster` joins the frontmatter tier map as framework-owned.
- **Reproducible recall benchmark** (`o2b brain benchmark`, MCP
  `brain_benchmark`). `runRecallBenchmark` scores hit@k and MRR per
  query and aggregate against the live hybrid pipeline; the committed
  15-note fixture vault + 12-query dataset pin CI thresholds
  (hit@5 >= 0.9, MRR >= 0.85; measured 1.000/0.958 with the
  deterministic local embedding provider), so a ranking regression
  fails the suite. The same runner scores operator vaults on demand
  and serves as the self-tuner's objective function.
- **Deterministic query expansion** (`o2b search --expand`,
  `search(config, {expand: true})`). A bare query becomes a
  structured lex/vec/hyde document locally: stopword-stripped lex
  terms for the implicit-AND FTS lane, an entity-context vec line
  from the vault's own registry, one template hyde passage. Opt-in
  per call, never silently active, no GGUF model, no paid call.
- **Opt-in self-tuning recall** (`o2b brain tune`, MCP `brain_tune`).
  `tuneRecall` grid-evaluates bounded parameters (keyword pool
  multiplier {3,4,5}, traversal depth {1,2}, learned weights on/off,
  expansion on/off) with the benchmark as the objective and persists
  the winner - with every evaluated score and the dataset hash - to
  `Brain/search/tuning.json`. `search()` applies the re-validated
  grid point only when `search_self_tuning_enabled` /
  `OPEN_SECOND_BRAIN_SEARCH_SELF_TUNING` is on; an explicit `expand`
  always wins; the tuned state joins the query-cache key; reset
  deletes the file and nothing else changes. The keyword candidate
  pool becomes the configurable `search_pool_multiplier` (default 3,
  byte-identical).
- **Maintenance-lane passes.** `o2b brain maintenance run` gains
  `bridges` and `clusters` tasks after `reindex`, riding the existing
  quiet window, busy gate, and lease.

### Notes

- The bridge verb ships as `bridges` because `o2b brain links` is the
  v0.38.0 wikilink-normalize contract.
- Re-scope: the upstream benchmark task referenced a nonexistent
  yantrikdb integration directory; the benchmark targets Open Second
  Brain's own hybrid search instead.

## [0.44.0] - 2026-06-05

Write-Time Integrity & Governance Suite: every write into the Brain
passes declared contracts. The schema pack becomes the single
declarative ontology - controlled-vocabulary labels, link-type
endpoint constraints, per-type attribute descriptors, and a
frontmatter field tier map, all additive - with enforcement at each
feature's existing seam: fail-closed classification whose errors
teach the declared vocabulary, typed edges blocked at index
materialization when their endpoint page types violate the declared
pairs, a tier guard that detects identity-key hand-edits without
ever write-denying a human, capability-gated secret custody that
lets an agent use a credential without the value entering its
context, and a quiet-window lease-guarded lane that keeps heavy
maintenance off live interactive recall. A vault that declares none
of the new fields behaves bit-identically. MCP tool count grows
69 -> 73.

### Added

- **Schema-pack ontology fields.** Four additive fields turn the
  pack from a flat token list into a real ontology: `labels`
  (dimension -> fixed enum values), `link_constraints` (link type ->
  allowed `source->target` page-type pairs), `attributes` (type ->
  field -> natural-language description), and `frontmatter_tiers`
  (kind -> field -> tier). All parse, render, and mutate through the
  existing audited machinery (`o2b brain schema apply` gains
  `add_label_dimension`, `add_link_constraint`,
  `set_attribute_field`, `set_frontmatter_tier`, and their inverses,
  with reference validation and cascade on `remove_type` /
  `remove_link_type`).
- **Controlled-vocabulary labels** (`o2b brain label`, MCP
  `brain_labels`). Assignment is fail-closed - an unknown dimension
  or value is rejected with the declared vocabulary in the error -
  single-choice per dimension, persisted as a sorted
  `labels: [dim/value]` frontmatter array (filterable via
  `o2b search <q> --property labels=<dim>/<value>`) plus a canonical
  `label` entity in the registry, so related notes cluster without
  free-form tag drift.
- **Link-type endpoint constraints** enforced at index
  materialization. Each page's declared frontmatter `type` is
  persisted (index schema v6) and a post-pass recomputes every typed
  edge's blocked flag from the current pack on every run: violating
  edges fall back to plain untyped links instead of feeding
  typed-relation recall, `o2b brain schema lint` (and MCP
  `schema_inspect` lint) lists each violation, and removing a
  constraint restores the edges on the next index run without
  touching files. Fail-open on missing information - undeclared
  relations and unknown endpoint types always pass.
- **Per-type attribute fields** (`o2b brain attr`). The note's own
  frontmatter `type` selects the descriptor set; assigning an
  undeclared field lists the declared fields WITH their descriptions
  so the vocabulary teaches itself. One value per field, persisted
  as a sorted `attributes: [field=value]` frontmatter array;
  descriptors render in schema explain output as agent guidance. The
  regex fact extractor is unchanged.
- **Frontmatter tier guard** (`o2b brain tiers`, MCP `brain_tiers`).
  Four tiers (identity / system / business / user) with built-in
  defaults grounded in the fields framework writers actually emit -
  the preference files' `_`-prefix convention becomes an explicit
  system-tier rule. `writePreference` merges through the tier model:
  a hand-added user field survives every framework rewrite, legacy
  unprefixed Group C keys migrate away, and a changed identity join
  key throws instead of being silently re-accepted. The index pass
  snapshots identity fields and stages drift findings the snapshot
  never absorbs; `tiers check | restore --apply | accept` is the
  staged repair surface and `brain_doctor` warns with the open
  count. Unknown kinds resolve everything to user - a human's own
  vault is never constrained.
- **Capability-gated secret custody** (`o2b brain secret`, MCP
  `brain_secrets`). Per-value AES-256-GCM ciphertext (random IV,
  verified auth tag - tampering fails closed) beside an
  exclusive-create 0600 keyfile under the vault-local state dir,
  never synced as vault content. The value enters via stdin or
  `--from-env` (never argv), no surface returns plaintext, and
  `run <name> -- cmd...` injects the credential into a subprocess
  whose command must match the operator-declared glob allowlist -
  captured output passes through the redactor with the resolved
  value as a known literal. Every operation lands a no-values audit
  record in `Brain/log/secret-custody/`. MCP exposes list and run
  only; storing and removing stays on the operator's CLI. Threat
  model stated honestly: protects against context leakage, sync
  exposure, and casual reads - not against root.
- **Quiet-window maintenance lane** (`o2b brain maintenance`, MCP
  `brain_maintenance`). Dream + reindex run behind three gates: a
  tz-aware local-time hour window with midnight wrap (unset = always
  open), a busy gate over recent recall-telemetry records, and an
  expiring SQLite lease in a dedicated `maintenance.sqlite` so
  holding it never contends with the search index writer lock.
  `--force` bypasses the soft gates but never the lease, tasks run
  stale-first, every attempt including gate refusals lands in a
  bounded journal, and a gate skip exits 0 so cron never alarms on a
  quiet hour.

### Changed

- The search index schema advances to v6 (additive):
  `documents.page_type`, `documents.tier_snapshot`,
  `links.relation_blocked`, and the `tier_drift` table - all
  reindex-safe, existing rows default to neutral values.
- `redactRawOutput` gains a `literals` option: known secret values
  are scrubbed verbatim before the pattern passes run.
- `IndexStats` reports `relationViolations` and `tierDrift` for the
  materialization post-passes.

## [0.43.1] - 2026-06-04

Patch release: the Hermes CLI discovery contract is now actually
satisfied for standalone installs. Hermes'
`discover_plugin_cli_commands()` scans only `<plugin_root>/cli.py`,
while the implementation lives in `plugins/hermes/cli.py`, so the
documented `hermes open-second-brain` CLI subtree was never
discoverable on a stock Hermes. A root re-export shim closes the gap.

### Fixed

- **Root `cli.py` shim for Hermes CLI discovery.** A relative
  re-export (`from .plugins.hermes.cli import register_cli, run`)
  through the synthetic parent packages the upstream loader registers
  (hermes-agent PR #37366) makes the `hermes open-second-brain`
  subcommands discoverable before the provider itself loads. The
  import stays SDK-free. A loader-contract test mirrors the upstream
  scan's exact import sequence so the contract cannot break silently.

## [0.43.0] - 2026-06-04

Entity Truth & Self-Improving Dream Suite: a current-truth surface
over entities and a dream pass that learns from outcomes, not only
from claims. An append-only claim ledger folds extracted facts into
addressable per-entity aspect slots with superseded history, detects
contradictions and cross-agent convergence, guards merges against
collapsing different people's claims, and answers quantitative
questions by exact-match aggregation; on the learning side,
apply-evidence carries a downstream outcome that stages regression
findings against rules that look confirmed but hurt, failed
approaches persist as recallable negative knowledge, inbox signals
rank by embedding novelty, the weekly synthesis nominates the
most-developable note, and a foresight fold projects what comes due
next. Everything is deterministic, bounded, fail-closed, and
explainable; a vault without the new data behaves bit-identically.
MCP tool count grows 66 -> 69.

### Added

- **Entity claim ledger** (`Brain/truth/`). Device-sharded append-only
  JSONL claim events (`claims.<deviceId>.jsonl`, schema-versioned,
  fail-closed line parsing) fold into per-`(entity, aspect)` slots
  holding the current value plus superseded history with provenance
  lineage; the derived `state.json` is a recomputable cache, never
  authority. Conflict detection is purely temporal-structural: two
  distinct values for one slot within the window (default 30d) from
  independent sources materialize a `value_conflict` with
  `resolution: ask_user` - never auto-resolved - while a later value
  outside the window supersedes silently. `o2b brain truth
  ingest|slots|conflicts|aggregate|collisions|sweep` and the
  `brain_truth` MCP tool are the operator surface.
- **Atomic-fact decomposition and the quantity family**. `o2b brain
  facts decompose` deterministically splits session text into discrete
  assertions via markdown structure (heading paths, list items,
  sentence boundaries with an abbreviation guard) anchored to
  canonical entities - no model calls; `--ingest` bridges
  structured-family assertions into the ledger. Fact extraction gains
  an actor-framed `quantity` family (spent/ran/worked + value + unit),
  and `aggregateQuantities` sums only exact `(entity, action, unit)`
  matches so nearby numbers never pollute a total.
- **Name-aware merge guard and contamination check**. `mergePreferences`
  refuses to collapse claims about disjoint people/orgs
  (`entity-guard`, CLI `--force` bypass), and the deep-synthesis
  dossier flags notes asserting registered entities their cited
  sources never mention (`entity_contamination` dimension, present
  only when the vault has an entity registry).
- **Cross-agent collision detection**. Two agents independently
  logging claims about one entity within 14 days - citing different
  sources - surface push-mode through the standing trigger queue as
  the new `agent_collision` kind with cooldown dedup, instead of
  waiting for an operator-run diff.
- **Outcome-tied apply-evidence**. `brain_apply_evidence` and the CLI
  accept an optional `outcome: success|failure|unknown`; the dream
  refresh stages an `outcome_regressions` finding with a deterministic
  0.8 confidence penalty when applied events carry 2+ failures
  outnumbering successes - staged, never silent retirement, idempotent
  on rerun.
- **Dead-end registry** (`Brain/dead-ends/`). Tried-and-failed
  approaches persist as markdown notes (approach + why it failed +
  context) bounded to the most-recent-N with archive-on-overflow;
  FTS indexes them with zero search changes so recall surfaces
  "avoid X" alongside "prefer Y". `o2b brain dead-end record|list`
  and the `brain_dead_ends` MCP tool.
- **Surprisal novelty sampling**. Inbox signals rank by mean kNN
  distance to their nearest indexed neighbours over the existing
  sqlite-vec index (zero provider calls); `brain_review_candidates`
  gains a `signal_novelty` annotation present only when at least one
  signal actually scores.
- **Weekly top-source**. The weekly synthesis nominates the single
  most-developable note of the window (recency + inbound links + link
  centrality, per-signal breakdown, one-line why), absent when nothing
  qualified.
- **Foresight** (`o2b brain foresight`, `brain_foresight`). The
  Brain's first forward-looking fold: recurrence cadences project
  next-due routines inside the horizon (default 14d), recent open
  commitments and open questions surface with sources; `--write`
  persists `Brain/foresight/<date>.md`.

### Changed

- `extractFacts`' span dedup key is now written with a `\u0000`
  escape instead of a literal NUL byte, so the file diffs as text
  again; chunk embeddings are copied out of the SQLite buffer instead
  of viewed, hardening against unaligned pooled buffers.

## [0.42.0] - 2026-06-04

Time-Aware Recall & Activation Suite: ranking that reflects what the
agent actually keeps using, and time filters that respect when things
happened rather than when files were written. Recorded accesses
reinforce a per-document activation that decays by content-type
half-life (preferences and decisions never fade), habitual companions
boost each other through co-access edges, preference pages carry a
dream-stamped freshness trend that biases recall, `since`/`until`
filters obey declared `valid_from`/`valid_until` validity windows,
time-scoped traversal bridges in causes and consequences from a padded
event-time neighbourhood, and a zero-candidate evidence query runs one
broadened retry instead of dead-ending in an abstention. Everything is
deterministic, bounded, and explainable; a vault without the new data
ranks bit-identically. MCP tool count is unchanged (66).

### Added

- **Access-reinforced activation** (`Brain/search/activation/`).
  CLI/MCP searches record which documents they surfaced (one JSON file
  per access, query hashed, never raw text; `--no-record-access` /
  `record_access: false` opt out, cross-vault and cached queries never
  record); the derived activation state is a replayable fold, and a
  bounded `activation` ranking boost (cap 0.04) decays the stored
  strength by a content-type half-life table - preferences, decisions,
  and antipatterns never decay, projects ~120d, handoffs/sessions
  ~30d, notes 60d. Reinforcement is miss-driven: a query-cache hit
  returns early and records nothing. `o2b brain activation
  status|sweep` inspects and compacts the event store
  (`search_activation_enabled` is the kill switch).
- **Co-access reinforcement edges**. Documents habitually surfaced
  together gain pairwise counts in the same fold; when one appears in
  a candidate pool with its companions, each gains a bounded
  `co_access` boost (cap 0.03, pairs seen fewer than twice are noise).
- **Freshness-trend classification on preferences**. The dream refresh
  classifies every preference's evidence time distribution into
  `new | strengthening | stable | weakening | stale` and stamps
  `freshness_trend` into frontmatter; recall multiplies the relevance
  portion (strengthening 1.05, weakening 0.93, stale 0.85) with an
  explainable reason, and the belief-evolution envelope carries the
  live classification.
- **Event-time recall discipline**. Documents declaring `valid_from` /
  `valid_until` pass `since`/`until` filters by validity-window
  overlap - storage mtime is only the fallback, so an old file about a
  recent event is found and a fresh file about a closed-out past event
  is excluded. Unparseable values warn and fall back to mtime.
- **Temporal-bridge traversal**. With an active time range, link-graph
  traversal keeps an expansion document only when its event time falls
  within a padded neighbourhood of the window (default 7d) and decays
  its score by temporal proximity (`temporal_bridge` reason) - causes
  and consequences bridge in, arbitrary old neighbours do not.
- **Self-correcting two-pass recall**. In evidence-pack mode a
  zero-candidate first pass (implicit-AND too strict) triggers exactly
  one broadened OR retry; recovered results carry a `second_pass`
  reason and the envelope reports `secondPass: {triggered, reason,
  added}` (`search_two_pass_enabled` is the kill switch).

### Changed

- The Hermes plugin entrypoint dropped its file-path self-bootstrap:
  the upstream loader now registers the synthetic parent namespace for
  user-installed providers, so the root `__init__.py` is a plain
  relative re-export of `plugins/hermes`.

## [0.41.0] - 2026-06-04

Agent Write Contract Suite: how external agents write into and
deliberate with the Brain without an LLM inside the core. One
file-backed write-session kernel gives callers a JSON-envelope
lifecycle - open a session, receive the generation prompt, submit the
artifact, get machine-readable correction errors without losing
state, and commit only when validation is clean. A multi-persona
decision panel rides the same kernel as a session kind, memory
import gains a pluggable backend boundary, and explicit
remember-writes can mirror into a cross-agent shared namespace with
fail-soft semantics. The calling agent generates every word; the
Brain sequences, validates, and commits. MCP grows by exactly one
tool (65 -> 66).

### Added

- **Write-session protocol** (`o2b brain session`, MCP
  `brain_write_session`). `open` returns a `needs-llm-step` envelope
  with a generation prompt, schema hints, and collision metadata when
  the target is occupied; `submit` validates fail-closed and returns
  `done`, `needs-correction` (coded `{code, path, message}` errors
  plus a compact correction prompt, retry cap default 3), or
  `needs-review` for operator-gated sessions (`approve` commits,
  `abandon` is terminal). Sessions persist as JSON under
  `Brain/.sessions/write/` with lazy TTL (default 24h) and a `sweep`
  op; `create` intent never overwrites, `merge` appends a
  session-stamped delimited section, reserved namespaces
  (`Brain/preferences/`, `Brain/log/`, `Brain/_brain.yaml`, dot-stores)
  are refused outright. Every terminal transition lands one
  `write-session` audit event in the Brain log.
- **Decision panel** (`o2b brain panel`). Distinct analytical lenses
  walk deterministic steps (`persona:<slug>` ... then `synthesis`) on
  the write-session kernel; persona definitions are operator-curated
  notes under `Brain/personas/` (built-in default set: technical,
  strategic, risk, user-experience), and the committed decision note
  lands under `Brain/decisions/panels/` with per-persona sections.
  The Brain supplies prompts and validation only - the calling agent
  authors every answer and the synthesis.
- **Memory backend boundary**. A `MemorySourceBackend` protocol
  (`discoverMemoryDir`, `parseMemoryFile`, `renderPreference`,
  `slugifyName`) with a frozen registry and config-driven selection
  (`memory_backend`, default `claude`); the Claude Code adapter
  delegates to the existing import modules byte-identically, and an
  unknown backend id fails with the registered list.
- **Cross-agent shared namespace**. The opt-in `shared_namespace`
  config key mirrors explicit remember-writes (feedback signals and
  narrative notes) into a second vault after the primary write
  succeeds, with agent plus `origin_vault` attribution. Mirroring is
  fail-soft by contract - a broken or self-pointing shared vault
  degrades to `mirror: "failed"` and the primary write is never
  affected; the key absent means zero behavior change.

## [0.40.0] - 2026-06-04

Project History Suite: a linked project's git history and code
structure become queryable Second Brain memory. A sanitized read-only
git reader ingests commits, tags, and release ranges into a per-repo
record store inside the vault with a watermark for duplicate-free
incremental runs, a deterministic digest note makes each repo's
history FTS-discoverable, decision-shaped commits surface as draft
ADR candidates that operator curation owns from the moment they
exist, a stdlib-only scanner maintains regeneration-safe architecture
notes through sentinel regions, and `brain_query` - the one recall
surface v0.39.0 left without telemetry - joins the observability
contract. Everything deterministic, no LLM anywhere; the MCP contract
stays at 65 tools.

### Added

- **Git history memory** (`o2b brain git ingest <repo-path>`).
  Commits, tags, and release ranges from a worktree land as
  structured records in `Brain/projects/git/<repo-key>/commits.jsonl`
  (typed edges as fields: touched files, author, carrying release via
  chronological tag-range attribution). Incremental re-runs walk
  `<watermark>..HEAD` only; a force-pushed or tampered watermark
  degrades to a reported full re-scan and store dedup keeps that
  duplicate-free; a bounded walk announces truncated older history.
  The reader shells out with fixed argv and validates every
  caller-supplied sha against the full-40-hex grammar before it can
  reach git.
- **Git history query** (`o2b brain git find [text] [--file F]
  [--author A] [--since/--until] [--repo K]`, `o2b brain git
  status`). Answers "why and when did this file change" and "which
  release carried it" purely from the store - no live git on the
  query path, so the answers survive checkout deletion. A
  deterministic per-repo digest note (releases, recent commits, hot
  files) anchors the history in full-text search.
- **Commit-decision miner** (`o2b brain git mine`). Deterministic
  heuristics (conventional breaking markers, BREAKING CHANGE footers,
  word-boundary decision keywords, revert shape) turn decision-shaped
  commits into draft ADR candidate notes under
  `Brain/decisions/candidates/` with matched-signal provenance and
  sha-stable identity: re-runs never duplicate, an existing candidate
  is never touched.
- **Sentinel-region merge engine** (`src/core/brain/regions.ts`).
  Paired `<!-- o2b:begin <id> -->` / `<!-- o2b:end <id> -->` markers
  delimit generated note content; merging replaces only generated
  bodies, preserves operator bytes outside regions verbatim, appends
  new regions, and fails closed (no partial rewrite) on unbalanced,
  duplicate, nested, or mismatched sentinels.
- **Architecture docs generator** (`o2b brain architect
  <project-path>`). A deterministic stdlib-only scanner (module
  layout, language mix, entry points, manifest, test layout - no LLM,
  no network) renders an overview plus per-module notes under
  `Brain/projects/arch/<repo-key>/` through the region engine:
  re-scans refresh facts, operator prose survives byte-for-byte, an
  unchanged tree regenerates byte-identically.
- **`brain_query` recall telemetry.** Per-call opt-in arguments
  (`telemetry`, `telemetry_host`, `session_id`, `turn_id`) mirroring
  `brain_search`; mode `query` joins the `RecallTelemetryMode` union;
  emission goes through the lazy gated kernel on both success and
  error paths. The payload records the query kind
  (preference|topic|since) and counts only - the supplied preference
  id, topic slug, or timestamp value never lands in a continuity
  record.

## [0.39.0] - 2026-06-03

Memory Observability Suite: the continuity store becomes a documented,
versioned, exportable contract, and recall quality becomes a measured
number instead of an intuition. Every new continuity record carries a
contract-wide schema version, gated telemetry surfaces route through
one lazy emit kernel that makes "no consumer, no payload work" and
"telemetry never fails the primary operation" structural guarantees, a
read-model normalizes legacy and stamped records identically for every
consumer, trajectories export as standard ATOF/ATIF formats for replay
and eval tooling, and a deterministic memory benchmark reports
quality, latency, and context cost as separate families with
checkpoint/resume. One contract document enumerates every event kind,
gate, correlation id, and safety rule. Everything additive; telemetry
stays default-off.

### Added

- **Versioned continuity schema.** Every new continuity record is
  stamped `schema: "o2b.continuity.v1"`; legacy records without the
  field read as v1 and existing JSONL files are never migrated. The
  dedup id deliberately excludes the stamp, so identical records keep
  identical ids across the transition (locked by a known-answer
  test). Evolution rule documented: additive fields never bump the
  version, renames/removals/semantic changes do.
- **Lazy gated telemetry emit kernel.** One `emitGatedTelemetry(gate,
  build)` helper now carries every gated telemetry surface
  (context-pack receipts and telemetry, pre-compress, `brain_search`
  telemetry, recall-gate telemetry): with the gate off the payload
  thunk is never invoked and nothing reaches the continuity store; a
  throwing thunk or write is swallowed, so telemetry can no longer
  fail a pack, a search, or a gate decision. No-consumer regression
  tests pin the property per surface; session-recall import and
  pre-compact extract stay deliberately fail-fast (their write IS the
  operation).
- **Continuity read-model.** `loadNormalizedContinuityRecords()`
  absorbs schema-version dispatch, lifts `session_id`/`turn_id` into
  first-class fields, drops `private` records by default, and never
  un-masks redacted text - the single normalization layer every
  read-side consumer shares.
- **ATOF/ATIF trajectory export.** `o2b brain continuity export
  --format atof|atif [--session <id>] [--month YYYY-MM]` renders the
  store as standard trajectory formats: ATOF JSONL events (recall
  telemetry as `retriever` scope pairs with a marked synthetic start,
  other kinds as marks) and ATIF v1.7 documents (one per session,
  memory-layer events as `llm_call_count: 0` system steps). Read-only
  over the read-model; private records never reach an export file.
- **Memory quality benchmark.** `o2b brain bench memory --fixture
  <name|path>` ingests a fixture into a disposable vault inside the
  runs directory (never the configured vault), indexes, retrieves,
  evaluates, and reports - quality (pass rate per category), latency,
  and context cost as separate families, never one collapsed score.
  Checkpointed phases resume by run id with a fixture-hash guard;
  shipped fixtures cover single-hop recall, temporal supersession (a
  stale-fact regression catcher), contradiction visibility,
  multi-record evidence, session handoff, and context budget
  truncation. Deterministic and network-free; `bench_judge_cmd` arms
  an optional external judge that is advisory and fail-open.
- **Observability contract.** `docs/observability.md` enumerates every
  Brain log event kind and continuity record kind verified against
  source, the always-on vs opt-in matrix, correlation ids, payload
  safety guarantees, fail-open rules, and the schema version with its
  evolution rule.

## [0.38.0] - 2026-06-03

Workspace Insight Suite: eight changes in two themes. Theme A makes
the Brain reachable from anywhere in the workspace - a pointer file
links any project directory to its owning vault, external vaults
attach as read-only recall sources, one query can search every
registered vault with origin labels, and a shell-native surface
(materialized profile digest plus a grep-shaped search verb) works
without MCP. Theme B makes the Brain proactive with memory of what it
already said - a topic dossier cross-references notes for
contradictions and gaps, a Markdown trigger queue gives findings an
anti-nag lifecycle, idea discovery ranks next directions from open
loops, and recall-gate decisions become observable telemetry. All
behaviour-changing pieces are off by default or per-call explicit.

### Added

- **Project vault pointers.** `o2b brain project link <path>` writes a
  `.o2b-vault.json` pointer into any project directory - a repo, a
  monorepo package, a sibling worktree - and `resolveVault` now walks
  up from the working directory and honours it (after the `VAULT_DIR`
  env override, before the profile chain). `list`, `remove`, and
  `status` inspect and repair links via a `projects.json` registry
  beside the config; malformed pointers and dangling targets fail soft
  and are reported, never thrown.
- **Read-only recall sources.** `o2b brain source add <vault> --alias
  <name>` attaches an external vault as a read-only recall origin of
  the active Brain. The registry is keyed by owning vault (switching
  profiles never leaks sources), validation concentrates in one place
  (alias and path uniqueness, self-links, direct circular links), and
  deleted targets are flagged BROKEN rather than dropped.
- **Cross-vault union search.** `o2b search <query> --global` (and
  `brain_search { global: true }`) fans one query out over the active
  vault, registered profile vaults, and read-only sources, merging
  results by score. Every result carries its origin as an additive
  `origin` field plus an `origin:<label>` entry in `reasons[]`
  (`local`, `profile/<name>`, `source/<alias>`). Read-only invariant:
  non-active origins search with self-healing and the query cache
  disabled, so an external vault is never written to - a missing index
  degrades to a per-origin warning.
- **Configurable wikilink path format.** The `wiki_link_format` config
  key selects `preserve` (default, byte-identical), `full`
  (vault-relative key path), or `short` (shortest unambiguous suffix)
  for generated and normalized links. `o2b brain links normalize
  [path] [--mode M] [--write]` rewrites wikilinks across Brain notes -
  dry-run by default, decorations and code blocks preserved verbatim,
  ambiguous and unknown targets left as typed and reported.
- **Shell-native Brain surface.** `o2b brain profile` materializes a
  compact `Brain/profile.md` digest (facts, top preferences, recent
  activity; age-gated regeneration) plus a `.o2bfs` root marker so
  shell wrappers can detect a Brain root safely. `o2b brain sgrep
  <query> [path]` is a grep-shaped semantic search - `path:line:`
  output lines, path scoping, `--json`, exit 1 on no matches - with no
  MCP and no OSB-specific knowledge required.
- **Grounded trigger queue with anti-nag lifecycle.** `o2b brain
  trigger scan` turns existing semantic-health and retention findings
  into Markdown trigger records under `Brain/triggers/` (urgency,
  reason, suggested action, source artifacts, context snippets).
  Stable cooldown keys make repeated scans idempotent: an open twin
  blocks recreation, a dismissed/acted twin blocks for
  `trigger_cooldown_days` (default 7), an expired twin allows.
  Lifecycle is a strict machine (`pending → delivered → acknowledged →
  acted`, dismiss from any open state) over `list`, `ack`, `dismiss`,
  `act`, and `history` verbs plus one consolidated `brain_trigger` MCP
  tool. The morning brief surfaces capped pending triggers and marks
  them delivered, so the same prompt shows at most once per cooldown
  window and dismissed items never resurface.
- **Deep vault synthesis.** `o2b brain deep-synthesis <topic>` (and
  `brain_deep_synthesis`) assembles a deterministic topic dossier:
  matched notes, agreements (positive typed relations),
  contradictions (`contradicts` relations), stale claims (aged or
  superseded notes), and knowledge gaps (dangling wikilink targets).
  The dossier names exactly which dimensions it checked; prose
  synthesis stays with the calling agent. `--triggers` enqueues
  contradiction and gap findings into the trigger queue.
- **Idea discovery.** `o2b brain ideas` (and `brain_idea_discovery`)
  ranks next-direction candidates from the vault's open loops -
  unanswered open questions, orphan research notes with no inbound
  links, and aging unresolved inbox signals - with documented
  deterministic scoring. `--triggers` enqueues the ranked ideas.
- **Recall-gate telemetry.** With `recall_gate_telemetry: "true"`
  (default off), every `brain_recall_gate` decision lands as a
  `gate_telemetry` continuity record - decision, stable reason, host,
  and a SHA-256 prompt prefix; the raw prompt is never stored.
  `brain_recall_telemetry` and `o2b brain recall-telemetry` gain
  `gate_list` / `gate_summary` operations for skip/retrieve analysis.

## [0.37.0] - 2026-06-03

Agent Surface Suite: eight changes in two themes. Theme A makes the
MCP tool and skill surface adaptive - skills become discoverable over
MCP, a two-pass catalog keeps schemas out of the prompt until needed,
named profiles curate the surface per host, and relevant skills can
auto-attach to a turn. Theme B closes the session lifecycle - capture
filters by role, search focus binds to a session and auto-clears, a
finished session leaves an operator-readable handoff note, and every
workstream gets a versioned current-intention chain. All
behaviour-changing pieces are off by default.

### Added

- **Skills as callable MCP tools.** `list_skills` returns the agent
  skills Open Second Brain ships in `skills/` (plus vault-local
  `Brain/skills/`, which shadow shipped ones by name) with one-line
  descriptions; `get_skill` fetches SKILL.md content or a
  traversal-guarded auxiliary file inside the skill directory. Any
  MCP-connected agent can now self-discover and load skills without
  shell access.
- **Two-pass tool catalog hydration.** A new `catalog` scope
  (`o2b mcp --scope catalog`) advertises a compact first pass - the
  capability diagnostic, the five always-loaded Brain tools, and
  `tool_hydrate` - while every other tool stays callable but
  unadvertised. `tool_hydrate` with no arguments returns the sorted
  compact catalog (name, one-line description, group); with a `names`
  batch it returns full input/output schemas, reporting unknown names
  per-name. Schema tokens stay out of the prompt until the agent
  actually needs the tool.
- **Adaptive tool-surface profiles.** Five named profiles (`full`,
  `writer`, `catalog`, `recall`, `minimal`) resolve to a scope plus
  capability window, selected via the `mcp_tool_profile` config key or
  `o2b mcp --tool-profile`. An unknown profile fails OPEN to the full
  surface with a logged note; hard-window profiles always retain the
  `second_brain_capabilities` diagnostic so withheld tools stay
  discoverable with reasons.
- **Deterministic skill auto-attach.** `skills_attach` scores skills
  against the current turn text with a shared BM25-style lexical
  scorer (name > tags > description field weights, no LLM) and returns
  a char-budgeted block of top matches with `get_skill` load hints.
  Gated by `skill_auto_attach` (default off); the native Hermes
  provider's prefetch appends the block through one fail-soft bridge
  call.
- **Config-level capture role filtering.** `session_capture_roles`
  (comma-separated subset of `user,assistant,system,tool,meta`)
  supplies the default `--filter-role` set for `brain import-session`.
  Absent captures every role; an explicit flag wins; an unknown role
  fails fast.
- **Session-scoped search focus.** `o2b search focus set|status|clear
  --session <id>` binds a focus to one session's file under
  `search-focus/` beside the global file; a bound session focus wins
  over the global one, `brain_search` gains an optional
  `focus_session` input, and SessionEnd lifecycle capture auto-clears
  the ending session's focus. When `search_focus_context_pack` is true
  (default off), `brain_context_pack` promotes focus-matching memories
  within their tier.
- **Operator-readable handoff notes.** `o2b brain handoff
  <session-file>` (and, when `session_handoff` is true, SessionEnd
  lifecycle capture) writes `Brain/handoffs/<date>-<scope>.md` with
  request, completed work, changed files, learned context, and next
  steps - extracted by deterministic regex from the recorded turns, no
  LLM.
- **Scoped current-intention chains.** `o2b brain intention
  set|show|list|move` (and the consolidated `brain_intention` MCP
  tool) maintain per-workstream now-documents at
  `Brain/intentions/<scope>.md`: every update bumps `version` and
  appends the superseded text to an in-file history trail; `move`
  retires the chain into `Brain/intentions/history/`. `Brain/pinned.md`
  stays the scope-free scratchpad.

## [0.36.0] - 2026-06-03

Embedding Provider Suite: four changes to the semantic layer that make
recall cheaper, more portable, and provider-flexible - an offline
embedder that needs no cloud, a runtime registry for embedding
endpoints, spend visibility with a cost gate, and an alternative
rank-fusion mode - all behind one shared signature kernel and all
off-by-default where they could change behaviour.

### Added

- **Offline local embedder.** A new `local` embedding provider produces
  deterministic vectors with no cloud call, no API key, and no model
  download: token unigrams and character trigrams are feature-hashed
  (FNV-1a, signed buckets) into a configurable fixed dimension (default
  256) and unit-normalised, so the existing cosine ranker math is
  unchanged. Set `embedding_provider: local` (and
  `search_semantic_enabled: true`) for a privacy-first, no-cloud recall
  path; both indexing and query embedding run without a key. It is a
  lexical baseline - `openai-compat` remains the recommended provider for
  semantic depth.
- **CLI provider registry.** Register OpenAI-compatible embedding
  endpoints at runtime with `o2b search provider add | list | show |
  remove`, persisted to `Brain/search/embedding-providers.json` (base
  URL, default model, and the NAME of the environment variable holding
  the key - never the key itself, so the file is safe to sync). A
  registered name resolves to `openai-compat` config during config
  resolution, AFTER the built-ins, so it never shadows an explicitly
  configured key; explicit config or environment always wins over a
  profile's fields. The resolved provider union stays closed.
- **Embedding cost gate and signature reporting.** A best-effort
  per-model pricing table plus a chars/4 token estimate gate large
  embedding runs: when `embedding_cost_gate_usd` is positive (default 0 =
  disabled) and the estimated spend exceeds it, the run is refused with
  the estimate, and `o2b search index --force-cost` overrides. The local
  provider and any unlisted model price at 0 and never block.
  `o2b search status` now reports the active
  `<provider>:<model>:<dimension>` embedding signature and a best-effort
  refresh-cost estimate.
- **Reciprocal Rank Fusion mode.** `search_fusion_mode: rrf` (default
  `linear`) fuses the sparse (BM25) and dense (cosine) lanes by rank
  position - `1 / (search_rrf_k + rank)`, `search_rrf_k` default 60 -
  rather than by weighted score magnitude, rewarding cross-lane presence
  and staying robust to differing score scales. The fused relevance is
  min-max-normalised so the link, recency, entity, tier, and
  session-focus boosts compose unchanged, and results carry an `rrf:`
  recall reason. The default `linear` mode keeps ranking bit-identical;
  storage stays SQLite + sqlite-vec + FTS5 (no cloud vector database).

## [0.35.0] - 2026-06-02

Memory Integrity Suite: four changes that make the memory itself
trustworthy - named things get one canonical home, the daily log stops
sync-conflicting across devices, runtime noise stops entering memory, and
structured facts from user turns are captured in real time with canonical
anchors.

### Added

- **Canonical entity registry.** One canonical entity per
  `(category, normalized name)` lives at `Brain/entities/<category>/<id>.md`
  as plain Obsidian Markdown with frontmatter identity (`entity_id`,
  `category`, `name`, `aliases`, `status`, lifecycle stamps). The identity
  index rebuilds from the Markdown files on every read - nothing to persist,
  nothing to sync-conflict. `o2b brain entity set | get | list | relate |
  archive` drives the registry from the CLI (upsert resolves names AND
  aliases before creating anything and refuses duplicate claims; archive
  removes from active lookup, `--restore` returns); the read-only
  `brain_entity` MCP tool (`view: get | list`) serves lookups to agents.
  Relations reuse the typed relation vocabulary, so graph export and
  relation polarity pick entities up without new plumbing. Search expands
  query entities through the registry: a query naming an alias boosts
  documents naming the canonical entity and explains the hop with an
  `entity_canonical` reason - vaults without a registry rank
  bit-identically. Doctor lints duplicate identity claims
  (`duplicate-entity`) and dangling relations (`broken-entity-relation`).
- **Per-device Brain log shards.** `appendLogEvent` writes
  `Brain/log/<date>.<deviceId>.jsonl` + `.md`, so two Syncthing devices
  never touch the same file on the same day - the write-conflict class
  observed live on 2026-06-01 is gone. The device id is a stable
  per-install value in the DEVICE-LOCAL config, generated once on first
  use (`O2B_DEVICE_ID` overrides; identity-resolution failure falls back
  to the legacy pair - an append never fails on identity). `readLogDay`
  merges every shard of a day sorted by (timestamp, shardId, line) with
  per-shard JSONL-over-markdown preference, and `listLogDates` becomes the
  single date-discovery helper behind every reader (doctor, digest,
  query, dream, evidence, status, backlinks, most-applied, temporal index,
  MCP log resource). Legacy single-file days keep reading forever - no
  migration. Doctor flags leftover Syncthing conflict copies
  (`sync-conflict-log`).
- **Capture boundaries.** A `sessions:` block in `_brain.yaml` declares
  what may become memory: `ignore_patterns` (sessions that produce
  nothing), `stateless_patterns` (sessions that read but never write),
  and `ignore_message_patterns` (message text that never reaches
  extraction). Session patterns are anchored globs, message patterns are
  regexes; an invalid regex degrades to a doctor warning
  (`invalid-capture-pattern`), never an error. Machine-local config can
  ADD patterns (comma-separated `sessions_*` keys) but never remove vault
  policy. Both ingestion seams consult the boundary FIRST - live hooks
  (`captureSessionLifecycleEvent`) and batch import (`importSession`) -
  and suppression is counted in results and audit rows, never stored raw.
  An unconfigured vault captures bit-identically to before.
- **Regex fact extraction.** Seven precision-first pattern families
  (identity, preference, possession, location, url, email, confirmation)
  capture structured facts from USER turns in real time, without an LLM
  call. Every family requires an explicit first-person or confirmation
  frame; code blocks and quoted lines are stripped; bare assistant output
  is never auto-extracted (the HANDOFF carve-out's conservative core).
  Facts land as `source_type: extracted` signals with family-scoped dedup
  hashes - repeats and re-imports dedup identically - and a fact naming a
  registered canonical entity (or alias) carries the canonical id, the
  shared canonicalization kernel at work. Extraction runs strictly BEHIND
  the capture boundary; the pipeline order is pinned by tests at both
  seams.

### Process wins

- The capture pipeline order (classify/suppress -> extract -> route) is a
  tested contract, not a convention - suppressed input can never become
  evidence.
- The entity identity index is a pure projection of the Markdown files;
  "rebuildable" is satisfied by never persisting it.
- Every reader refactor shipped behind golden tests: legacy-only vaults
  read byte-identically through the new shard-merging path.

## [0.34.0] - 2026-06-02

Token Diet: six changes that cut what an agent pays in context before it does
any work - a broken post-compaction injection fixed, the session preamble
budgeted and deduplicated, the per-edit reminder compressed to a nudge, three
consolidated read tools replacing seventeen, hard description caps with a
contract guard, and preview budgets on by default. All deterministic; the
behavior of every consolidated view is byte-identical to its predecessor.

### Fixed

- **Post-compaction preference injection.** Current Claude Code has no
  `PostCompact` hook event; emitting `additionalContext` under that name was
  rejected by the hook output schema, silently dropping the re-injection and
  echoing the full payload into a validation error. `active-inject` now emits
  only under a default-closed allowlist of context-bearing event names
  (`SessionStart`, `UserPromptSubmit`), and the post-compaction path is the
  SessionStart `compact` matcher. A contract test pins the allowlist.
- **Frontmatter escape amplification.** The YAML-like parser now unescapes
  double-quoted scalars symmetrically with the formatter, so
  parse -> format cycles are byte-stable instead of doubling backslashes on
  every rewrite - the root cause of the `\\\"` chains observed in live
  preference frontmatter. Principle text is additionally sanitised at every
  write seam (leaked tool-call XML fragments cut, escape chains collapsed),
  `brain_doctor` warns about files corrupted before the fix
  (`principle-corrupted`), and `o2b brain upgrade --apply` repairs them once,
  idempotently, behind the usual pre-apply snapshot.

### Added

- **Budgeted active.md injection.** The SessionStart hook drops the
  provenance frontmatter and fits the injected body into a character budget
  (default 8,000 chars; `active.inject_budget_chars` in `_brain.yaml`).
  Sections drop deterministically - recently retired first, then quarantine,
  then most-applied - and a one-line notice points the agent at
  `brain_context` for the full set. The `Most-applied (Nd)` section now
  renders id + scope + count one-liners; the principle bodies already appear
  verbatim under `Confirmed`, and the duplication was 31% of the injected
  bytes on a real vault. Backed by a shared pure section-aware text-budget
  core.
- **Once-per-session reminder cadence.** The ~1.3KB post-write reminder -
  the single largest recurring token cost of a long coding session - now
  shows its full text once per Claude Code session and a 181-char nudge on
  later writes (marker keyed by `session_id`, 48h opportunistic pruning,
  fail-soft to the full text on any IO problem; Codex one-shot runs always
  get the full text).
- **Consolidated read tools.** `brain_brief`
  (`view: morning | daily | weekly | monthly | operator | digest`),
  `brain_analytics`
  (`view: timeline | attention_flows | belief_evolution | concept_synthesis`),
  and `schema_inspect`
  (`view: graph | lint | stats | orphans | explain_type | active_pack | packs`)
  replace three overlapping families; dispatch goes to the exact predecessor
  handlers, locked by per-view equality tests. The 18 predecessor names stay
  callable through `tools/call` as deprecated aliases for at least one minor
  release but are hidden from `tools/list`, so clients stop paying for
  schemas slated for removal. `brain_recurrence` stays standalone - its
  learn/forget operations are writes, not analytics.
- **Registry guard.** Tool descriptions cap at 300 chars and per-property
  schema descriptions at 160, enforced by a contract test; long-form guidance
  moved to `docs/mcp.md` and a rewritten terse `initialize.instructions`
  (5.4KB to 1.6KB). Preview budgets flip from opt-in to default: nine more
  verbose read tools park oversized results in the artifact store, and every
  remaining budget-less tool must hold an explicit exempt-list entry with a
  reason. `scripts/measure-token-surface.ts` reports the advertised surface,
  hidden-alias overhead, instructions size, and the budgeted active.md
  injection so regressions stay visible.

### Notes

- Measured on the live vault: SessionStart injection 16,550 -> 8,012 chars
  (-52%); advertised tool count 71 -> 56 with 18 aliases hidden;
  `initialize.instructions` 5,434 -> 1,630 chars. The serialized schema
  surface of the advertised tools is 43,790 chars including output schemas.
- MCP clients calling the old per-view tool names keep working unchanged;
  migrate to the consolidated tools before the aliases are removed in a
  future minor release.

## [0.33.0] - 2026-06-02

Recall Trust Suite: five features that make recall something an agent can
trust — typed relations carry ranking polarity, ranking weights learn from
explicit feedback within audited bounds, recall scopes by time, evidence packs
verify multi-record coverage with IDF weighting, and a completeness verdict
guards against false-absence claims. All deterministic; no LLM in the core
path.

### Added

- **Relation-aware recall polarity.** Typed relation edges
  (`superseded_by` / `contradicts` / `related` / `extends` / `depends_on` /
  `refines`) now participate in ranking: a matched `superseded_by`
  predecessor is demoted and its successor boosted or pulled into the result
  window; `contradicts` adds warning-style `why_retrieved` reasons on both
  endpoints without a score change; positive relations grant a small bounded
  boost between co-retrieved pages. History mode (`--include-superseded`,
  MCP `include_superseded`) keeps predecessors undemoted. Kill switch:
  `search_relation_polarity_enabled` /
  `OPEN_SECOND_BRAIN_SEARCH_RELATION_POLARITY` (default on; vaults without
  typed relations rank identically either way).
- **Retrieval feedback loop with learned recall weights.** `o2b search
  feedback --query <q> --result <path> --verdict up|down` and the new MCP
  tool `brain_recall_feedback` record one JSON event per feedback under
  `Brain/search/feedback/` (the conflict-free one-file-per-signal pattern).
  A deterministic, order-insensitive fold derives per-layer multipliers
  bounded to [0.8, 1.2] into `Brain/search/learned-weights.json`; ranking
  applies them only behind the `search_learned_weights_enabled` opt-in, and
  affected results carry a `learned_weights:` reason. `o2b search weights`
  shows base + learned + bounds; `--reset` drops the derived file while
  keeping events. The weights state is part of the query-cache key.
- **Time-aware recall.** `--since` / `--until` on `o2b search` and
  `since` / `until` on MCP `brain_search` accept ISO dates and datetimes,
  `today` / `yesterday` / `last week` / `last month`, and `24h` / `7d` /
  `2w` shorthand, resolved deterministically in UTC and filtered on document
  mtime before ranking. Invalid input fails with `INVALID_INPUT`;
  time-filtered queries bypass the query cache.
- **Verified multi-record recall.** Evidence packs gain a coverage engine:
  IDF-weighted support coverage, rare-term classification (document
  frequency within 2% of the corpus), a rare-term abstention gate, and a
  bounded per-token recall union (`union_records`, up to 2 records per
  uncovered term / 8 total) so evidence spanning multiple records is visible
  even when the AND-joined primary ranking returns nothing. Completes the
  verified-recall scope started by the v0.27.0 evidence-pack foundation.
- **Search-completeness guard.** Evidence packs carry a deterministic
  `completeness` verdict (`complete` at 0.8+ IDF-weighted coverage,
  `partial` at 0.4+, else `sparse`) and a false-absence guard:
  `uncovered_but_present_in_corpus` lists every uncovered term the corpus
  does contain, including the zero-results case, so a downstream summarizer
  cannot honestly claim the vault has nothing on a term that sits in an
  unreturned page.

## [0.32.1] - 2026-06-02

### Changed

- The repo-root `__init__.py` now loads the `plugins/hermes` implementation
  through a single, intentional self-bootstrap (file-path import under a private
  package name) instead of a three-branch import cascade with a file-path
  fallback. Loading no longer depends on the host runtime registering a parent
  namespace for the plugin, so the entrypoint is host-agnostic and the
  implementation keeps its small single-responsibility modules. Behaviour is
  unchanged - the provider still discovers and loads on a stock Hermes install;
  `tests/python/test_hermes_plugin.py` locks that it loads even when the parent
  namespace is absent.

### Notes

- This supersedes the 0.32.0 "Temporary loader workaround" note: the file-path
  load is now treated as the plugin's permanent load path, not a stopgap. An
  upstream Hermes loader change (registering the `_hermes_user_memory` parent)
  remains the route to fully-native relative imports as bundled providers use,
  but it is a future enhancement, not a dependency for this plugin to work.

## [0.32.0] - 2026-06-01

Open Second Brain is now a native Hermes memory provider. The Hermes
integration is consolidated into one mechanism: a Python `MemoryProvider` that
bridges to the existing `o2b mcp` server over JSON-RPC, replacing the separate
`pre_llm_call` shim and the standalone `mcp_servers` registration. Claude Code
and Codex are unchanged - their canonical path is still MCP plus hooks.

### Added

- `plugins/hermes` memory provider (`provider.py`, `bridge.py`, `config.py`,
  `_base.py`, `cli.py`): implements the Hermes `MemoryProvider` contract -
  `get_tool_schemas`/`handle_tool_call` over a curated `brain_*` subset,
  `system_prompt_block` from `Brain/active.md`, `prefetch` (recall gate plus the
  per-turn identity reminder), non-blocking `sync_turn` buffering, deterministic
  `on_pre_compress`/`on_session_end` flush via `brain_pre_compact_extract`,
  `on_memory_write` mirroring of Hermes `MEMORY.md`/`USER.md` into `Brain/`, and
  `shutdown`.
- `hermes open-second-brain status` / `config` diagnostics CLI (`cli.py`).
  Surfacing is gated on an upstream Hermes loader fix - see Notes.

### Changed

- `register(ctx)` now wires the memory provider via `register_memory_provider`
  alongside the health check.
- Both Hermes manifests declare the memory provider and the lifecycle hooks it
  implements instead of `provides_hooks: [pre_llm_call]` and an `mcp_server`
  block. They no longer set `kind: standalone`, so Hermes auto-routes the plugin
  to its memory-provider path; the repo-root `__init__.py` re-exports the
  provider so Hermes' provider discovery detects it.
- `install/hermes.md` documents the activation lifecycle: activate with
  `hermes memory setup open-second-brain`, deactivate with `hermes memory off`;
  `memory.provider` persists across `hermes plugins update` (no re-activation).

### Removed

- The Hermes-only `pre_llm_call` hook: its per-turn identity reminder is now
  carried by the provider's `prefetch`.

### Notes

- The bridge restarts the `o2b mcp` subprocess only on a transport failure
  (EOF / broken pipe); a JSON-RPC error response (e.g. invalid tool arguments)
  propagates unchanged. Behaviour is locked by `tests/python/test_memory_provider.py`
  and `tests/python/test_hermes_plugin.py`.
- **Temporary loader workaround.** Hermes' external memory-provider loader
  imports a plugin under a synthetic package (`_hermes_user_memory.<name>`)
  without registering that parent namespace, so an external provider's relative
  imports raise `ModuleNotFoundError: No module named '_hermes_user_memory'`
  (a flat single-directory layout hits this too). The repo-root `__init__.py`
  carries a file-path fallback to load the implementation, marked for removal
  once the upstream loader registers the parent namespace
  (`NousResearch/hermes-agent`). The same limitation gates the
  `hermes open-second-brain` CLI subcommand; it needs no further changes here
  and surfaces automatically when the upstream fix ships.

## [0.31.2] - 2026-06-01

Hands-off post-upgrade migration. After an update, the plugin now brings an
already-initialised vault current by itself - no manual `o2b search reindex` or
`o2b brain upgrade`. Completes the "an update must never need manual steps" goal
started in 0.31.1.

### Fixed

- Search self-heals a stale or missing index on read: instead of throwing
  `SCHEMA_MISMATCH` / `INDEX_MISSING` (which told the user to run
  `o2b search reindex` / `o2b search index`), the read path rebuilds the index
  once and retries.

### Added

- `ensureVaultCurrent`: a state-driven, best-effort maintenance pass run at
  `o2b mcp` startup (the path Hermes/Claude Code/Codex all spawn) and on the
  Claude Code `SessionStart` hook. On an already-initialised vault it migrates a
  stale `_brain.yaml`/`_BRAIN.md` (snapshot-backed, additive) and rebuilds a
  stale or missing search index in the background. It never throws and never
  blocks startup.

### Notes

- Migration is **state-driven, not version-stamped**: each step keys off actual
  on-disk state (index `schema_version`, `_brain.yaml` pending plan, dir
  existence), so a Syncthing-synced vault cannot let one device mark a migration
  done and make another skip its own per-device reindex. The behavior is locked
  by `tests/core/search/self-heal.test.ts` and
  `tests/core/maintenance/ensure-current.test.ts`.
- The manual `o2b search reindex` / `o2b brain upgrade` commands remain for
  explicit use; auto-migration reuses their logic.

## [0.31.1] - 2026-06-01

Update-resilience and repair. Plugin updates no longer strand the hooks or
require manual symlink surgery, a broken attention-flow guard integration is
fixed, and CI now gates formatting, lint, types, and tests on every pull
request so regressions cannot merge to `main` again.

### Fixed

- Hooks are now fail-soft and version-current. `scripts/o2b-hook` never exits 2
  (the only hook exit code Claude Code treats as blocking) and resolves the
  plugin checkout from `$CLAUDE_PLUGIN_ROOT` first, then its own location, then
  `$OSB_PLUGIN_ROOT`. `hooks/hooks.json` commands resolve the launcher via
  `$CLAUDE_PLUGIN_ROOT` with a PATH fallback for Codex and always `exit 0`, so a
  stale `~/.local/bin` symlink left by a previous version can no longer block
  the agent - and the next update repairs an already-broken install with no
  user action.
- `o2b install-cli` re-points a dangling or stale Open Second Brain symlink to
  the current checkout instead of erroring (no manual `rm`), while still
  refusing to touch a real file or a symlink owned by another tool.
- Repaired the `attention_flow_ids` context-pack path, which called the context
  safety guard with a stale API shape and failed to typecheck (and would have
  thrown at runtime).

### Added

- Automatic CLI symlink self-heal: the `SessionStart` hook repairs dangling or
  plugin-cache-stale `~/.local/bin/{o2b,o2b-hook,vault-log}` symlinks from the
  current checkout, leaving stable-directory installs and foreign symlinks
  untouched.
- A `CI` workflow that runs `sync-version:check`, `fmt:check`, lint, typecheck,
  and the full test suite on every pull request and push to `main`.
- [`docs/updating.md`](docs/updating.md): the update-safety contract and the
  invariants any change to the hooks, launcher, or `install-cli` must preserve.
- Optional local git hooks under `.githooks/` (enabled via `core.hooksPath` by
  the `prepare` script or `bun run hooks:install`): `fmt:check` + lint on
  pre-commit and typecheck on pre-push. The required `CI` check stays the
  enforced gate; the hooks just catch issues earlier and are bypassable with
  `--no-verify`.

### Notes

- Applied the `oxfmt` baseline to files that had merged unformatted in 0.29.0-0.31.0.

## [0.31.0] - 2026-06-01

Procedural attention suite. The procedural-learning foundations gain an operator-visible attention layer and stronger ingestion controls: deterministic procedural graph and hint projections, declarative attention-flow recipes for open loops and recurrent learnings, and scoped session import with a filtered write mode. Behavior stays local-first and review-first, and the new surfaces are exposed consistently across CLI and MCP.

### Added

- Deterministic procedural graph projection and derived procedural hints projection over installed procedures and recurrence evidence, rebuilt through write-time hooks. CLI `o2b brain procedural-graph <rebuild|show|hints>` and MCP `brain_procedural_graph`.
- Declarative attention-flow recipes for open loops and recurrent learnings, with an evaluator/renderer surface. CLI `o2b brain attention-flows <list|evaluate|render>` and MCP `brain_attention_flows`.
- Context-pack attention-flow injection: `brain_context_pack` accepts `attention_flow_ids` to fold evaluated flows into the assembled context.
- Scoped session import and filtered write mode: `o2b brain import-session` gains `--ingest-scope`, `--filter-role`, and `--filter-text` to reduce noisy carry-over while preserving default import behavior.

### Changed

- CLI help/verb registry and the MCP tool listing now expose the procedural-graph and attention-flow surfaces.

### Notes

- Procedural graph, hints, and attention-flow projections are deterministic and local-first by default; derived projections are kept in sync through write-time rebuild hooks rather than hidden background mutation.
- Full suite green on merge: 3042 tests passing, typecheck clean, lint warning-only on the existing baseline; canonical version `0.31.0` synced across all manifests.

## [0.30.0] - 2026-06-01

Self-learning procedural memory foundations. Open Second Brain can now detect repeatable workflows from continuity records, route them through a reviewable proposal queue, index procedural artifacts, and track recurrence/support evidence across scopes.

### Added

- Deterministic skill-proposal learning core (`repeated_action`, `structural_similarity`, `co_occurrence`, `temporal_routine`) with watermark tracking and duplicate suppression.
- Proposal review lifecycle in core: accept/reject transitions, review notes, and accepted procedure artifact emission under `Brain/procedures/`.
- Procedural memory reconciler with stable entry IDs, frontmatter metadata parsing, stale-entry pruning, and usage sidecar updates without rewriting source files.
- Recurrence/support ledger with same-scope support increments, cross-scope recurrence evidence, threshold-based commitment diagnostics, and reference-counted forget/source purge behavior.
- New Brain CLI verbs for the procedural-learning workflow:
  - `o2b brain skill-proposals <learn|list|accept|reject>`
  - `o2b brain procedural-memory <reconcile|list|mark-used>`
  - `o2b brain recurrence <list|show|learn|forget|purge-source>`

### Changed

- Brain path contracts now include dedicated procedural-learning artifacts (`Brain/skill-proposals/*`, `Brain/procedures/`, `Brain/procedural-memory/*`, and recurrence ledger path helpers).
- CLI help/verb registry now exposes procedural-learning surfaces in `o2b brain --help` and per-verb help.

### Notes

- Existing formatter-only baseline warnings remain warning-only (`oxlint`: 110 warnings, 0 errors).
- Proposal learning and recurrence flows are deterministic and local-first by default; no network calls are required.

## [0.29.0] - 2026-05-31

Context continuity and receipt surfaces. Agent-facing context can now leave redacted receipts and telemetry behind, operators can inspect budget presets before applying them, and session transcripts can be imported into a continuity-backed recall DAG.

### Added

- Append-only continuity records under `Brain/log/continuity/` with redaction-safe payloads, stable IDs, source references, pagination, and source invalidation markers.
- Opt-in prompt context receipts for `brain_context_pack` and `brain_pre_compress_pack`, with CLI/MCP list/show surfaces that expose item IDs, budgets, source hashes, safety/redaction metadata, and final text hashes without storing raw private content.
- Opt-in recall telemetry for search, context-pack, and pre-compress calls, including duration, status, result counts, top artifacts, budget/cache metadata, coverage gaps, and CLI/MCP summaries.
- Opt-in context-pack transforms for cache-stable ordering and repeated-context deduplication. Transform annotations report original/stable ranks and reference hints while leaving default ordering unchanged.
- Read-only context budget presets (`tight-context`, `long-context`) with CLI/MCP `show`, `suggest`, and `diff` diagnostics, confidence/reason reporting, explicit override preservation, and invalid override detection.
- Pre-compaction extraction through CLI/MCP and core APIs. Bounded text segments emit typed decision, commitment, outcome, rule, and open-question continuity records with deterministic base64/media sanitization and idempotent deduplication.
- Session recall DAG foundation. `import-session --recall` stores normalized turns as raw continuity records, deterministic two-depth summary nodes preserve source lineage, and CLI/MCP `session-grep`, `session-describe`, and `session-expand` inspect bounded hits and paginated raw turn content.

### Changed

- MCP full-server tool count is now 65 after adding context receipt, telemetry, preset, pre-compaction, and session recall tools.
- `o2b brain import-session --json` includes recall import counters; they remain zero unless `--recall` is explicitly enabled.

### Notes

- All new context receipt, telemetry, transform, preset, pre-compaction, and session recall behavior is opt-in or read-only by default.

## [0.28.0] - 2026-05-31

Brain safety and governance foundations. Automatically surfaced Brain context now has a deterministic guardrail against prompt-injection-like note content, config can point at local secrets without exposing values to agents, and larger governance workflows get preview-first core manifests.

### Added

- Deterministic context-safety guard for `brain_context_pack` and `brain_pre_compress_pack`. Hostile snippets are replaced with a stable placeholder and machine-readable `safety.reasons`; source Markdown is never rewritten.
- Explicit trusted-instruction bypass via `context_safety: trusted-instruction` for intentional instruction pages without weakening the default guard for ordinary notes.
- `$secret:NAME` references with local environment resolution helpers, missing-secret errors, known-value redaction, and `o2b secrets list|status` output that never prints resolved values.
- Governance preview foundations: source-scoped dry-run forget plans, privacy-scanned knowledge-pack preview manifests, and a vault-local oversized payload registry with bounded retrieval.

### Changed

- MCP `brain_context_pack` item payloads can include `safety` reports when content is filtered or explicitly trusted.
- Pre-compress pack output applies the same context guard to `active.md` and selected preference principles before producing host-injectable text.

### Notes

- Hard-forget apply, knowledge-pack install/uninstall, and payload lifecycle eviction remain follow-up work behind the preview/core contracts introduced here.

## [0.27.0] - 2026-05-31

Recall control and trust surfaces. Search can now expose the evidence behind a
retrieval decision, agents get explicit gates before automatic recall, and
context packs can separate directives from constraints and softer context.

### Added

- FTS5 safety hardening for malformed/operator-only lexical queries and external-content
  drift. Search now repairs a desynchronised FTS table, retries safely, and returns warnings
  instead of letting recall fail opaquely.
- Structured recall query documents for CLI and MCP search. `--query-doc` and
  `query_document` accept line-oriented `intent:`, `lex:`, `vec:`, and `hyde:` lanes,
  including quoted lexical phrases and `-excluded` terms.
- Session-scoped search focus through `o2b search focus set|status|clear` and explicit
  MCP `focus_query` / `focus_path_prefix` inputs. Focus nudges ranking toward the active
  task window without hiding unfocused matches.
- MCP `brain_recall_gate`, a read-only classifier that tells an agent whether an
  automatic recall attempt should run and why it was allowed or skipped.
- Polarity-aware context lanes for `o2b brain context-pack --lanes` and
  `brain_context_pack` with `lanes: true`. The legacy flat `items` list remains present
  while `directives`, `constraints`, and `consider` lanes give host agents safer prompts.
- Verified evidence packs for search via `--evidence-pack` and MCP `evidence_pack`.
  Evidence packs report significant, matched, and missing terms; support coverage;
  abstention text for unsupported terms; per-record `why_retrieved`; and terminal-state
  downrank reasons for retired/superseded support.

### Changed

- Evidence-pack mode is opt-in and part of the search cache key, so legacy search output
  and cache rows remain stable unless callers request the diagnostic payload.
- `brain_search` and CLI JSON search results include per-result `why_retrieved` when an
  evidence pack is requested.
- MCP full-server tool count is now 58 after adding `brain_recall_gate`.

### Notes

- `bun run lint` remains warning-only on the existing repository baseline.
- Files touched by this release were formatted with targeted `oxfmt --write` runs.

## [0.26.0] - 2026-05-30

CJK search, schema administration, real-time lifecycle capture, and safe
watchdog recovery probes. This release completes the runtime schema pack work
from v0.25.0 and makes recovery/capture paths explicit and auditable.

### Added

- CJK-aware search indexing and query tokenization for Chinese/Japanese/Korean
  text. FTS stores expanded shadow content for recall while returned snippets
  keep the original vault text clean; optional `@node-rs/jieba` and
  `tiny-segmenter` improve segmentation when available, with deterministic
  fallback n-grams when they are not.
- Atomic schema mutation engine for all schema primitives: add/remove/update
  types, aliases, prefixes, link types, extractability, and expert routing.
  Writes to `Brain/_brain.yaml` are file-locked, atomically replaced, validated
  before commit, and audited under `Brain/log/schema-mutations` JSONL roots.
- Schema admin CLI and MCP surfaces: `o2b brain schema stats|lint|graph|explain|orphans|apply|sync`
  plus MCP tools `get_active_schema_pack`, `list_schema_packs`, `schema_stats`,
  `schema_lint`, `schema_graph`, `schema_explain_type`, `schema_review_orphans`,
  `schema_apply_mutations`, and `reload_schema_pack`.
- `skills/schema-author`, a dedicated agent skill for reviewing and applying
  schema changes through the audited mutation path.
- Real-time lifecycle capture through `hooks/session-capture.ts` and
  `o2b brain session-hook`. SessionStart, UserPromptSubmit, PostToolUse,
  Stop, PostCompact, and SessionEnd events now produce non-blocking lifecycle
  audit/log observations; prompt `@osb` markers and `brain_feedback` tool calls
  are captured immediately through the existing signal dedup boundary.
- `o2b brain watchdog` and MCP `brain_watchdog` for Brain config/dir/search-index
  probes, exponential backoff metadata, safe directory remediation, and snapshot
  restore refusal unless restore intent and force are explicit.

### Changed

- MCP full-server tool count is now 57 after adding schema admin tools and
  `brain_watchdog`.
- `o2b brain schema` is now an admin command group; the original read-only
  report remains available as the default `report` mode.

### Notes

- `bun run lint` remains warning-only on the existing repository baseline.
- `bun run fmt:check` still fails on the pre-existing formatter baseline; files
  touched by this release were formatted with targeted `oxfmt --write`.

## [0.25.0] - 2026-05-30

Runtime schema packs foundation. Vaults can now declare custom taxonomy tokens
in `Brain/_brain.yaml` and inspect resolved schema usage without introducing a
mutation-heavy registry or changing deterministic dream behavior.

### Added

- Shared runtime schema vocabulary boundary with built-in `preference`,
  `feedback`, `note`, and Brain log event kinds plus deterministic
  normalization and validation for optional `_brain.yaml schema:` declarations.
- Optional inert `schema_type:` metadata on preferences, retired preferences,
  and signals. Writers omit the field unless supplied; parsers normalize token
  shape and can validate against a resolved vocabulary when callers opt in.
- Read-only schema inspection report plus `o2b brain schema [--json]`, showing
  resolved vocabulary, artifact token usage, unknown tokens, and unused custom
  declarations.

### Notes

- Full schema mutation primitives, MCP admin operations, schema-author skill,
  and lifecycle/control enum widening remain deferred behind the foundation ADR.

## [0.24.0] - 2026-05-30

Brain model semantics foundation. Preferences can now carry explicit typed
relationship metadata, memory-layer labels, and branch labels while preserving
the existing Markdown-first source of truth and deterministic dream behavior.

### Added

- Preference-oriented relation vocabulary (`depends_on`, `refines`) layered on
  the existing typed graph semantics boundary. Brain backlinks and the explorer
  now surface typed preference relations without introducing a parallel graph.
- Optional preference frontmatter metadata: `memory_layer: L0|L1|L2|L3`,
  `memory_branch: <slug>`, and typed relation fields such as `depends_on:` /
  `refines:` / `contradicts:`. Absent fields remain byte-identical for legacy
  preferences.
- Deterministic dry-run semantics backfill planner plus
  `o2b brain semantics-backfill --json`, currently previewing missing inverse
  `superseded_by` pointers when an active preference already declares
  `supersedes` against a retired one.

### Notes

- Full branch isolation, selective branch pick mutation, and per-layer dream /
  retention policy are intentionally deferred behind the ADR in
  `docs/brainstorm/brain-model-semantics-foundation/adr.md`.
- Full suite green on merge: 2854 tests passing.

## [0.23.0] - 2026-05-30

Agent capability and CLI integration. MCP servers can now narrow the advertised
tool surface at runtime without changing the static registry, while the CLI gains
a shared command manifest, shell completions, and inherited JSON fallback for
commands that did not previously have a machine-readable output mode.

### Added

- Runtime MCP capability window (`src/mcp/capabilities.ts`) with repeatable
  `o2b mcp --allow-tool`, `--disable-tool`, and `--max-tools` flags. The
  evaluator runs after static scope filtering, so it can narrow the full server
  but cannot expose full-server tools through the writer-only scope.
- Full-scope diagnostic MCP tool `second_brain_capabilities`, returning the
  available tool list and stable withheld-tool reasons for the current server
  process. `o2b mcp --probe --json` emits the same report for install checks and
  operator diagnostics.
- Shared CLI command manifest (`o2b help --json`) and generated shell completion
  scripts via `o2b completions --shell bash|zsh|fish|elvish|nushell|powershell`.
- Inherited `--json` parsing for CLI commands plus a redacted fallback envelope
  for commands without an existing semantic JSON contract.

### Changed

- Existing semantic JSON commands keep their native payloads instead of being
  wrapped by the fallback envelope, including nested Brain/Search/Vault/Pay
  Memory command groups and `o2b install --json`.

### Notes

- New full-server MCP tool count: 46 -> 47. Writer scope remains the same five
  always-loaded tools (`brain_feedback`, `brain_apply_evidence`, `brain_note`,
  `brain_context`, `brain_pinned_context`).
- Full suite green on merge: 2842 tests passing.

## [0.22.0] - 2026-05-29

Vault portability + session economy. A new `portability/` subsystem makes
the brain portable across folder layouts and vaults, gives per-source
visibility into signal intake, and adds a deterministic lossless codec
for session prose - every new behaviour opt-in or no-op so a default
install stays byte-identical.

### Added

- Deterministic, lossless session codec (`src/core/brain/portability/codec.ts`).
  Pure `compress` / `expand` where `expand(compress(x)) === x` for
  sentinel-free input; token savings come from reversibly collapsing whitespace and
  blank-line runs behind a Private-Use-Area marker, with fenced/inline
  code protected and structured tokens (URLs, paths, identifiers, version
  numbers) preserved byte-for-byte. Opt-in on the signal store via
  `writeSignal({ rawCodec })` / the `importSession` `rawCodec` option,
  gated by a `_raw_codec` marker so `parseSignal` expands only marked
  bodies; default off -> verbatim, byte-identical. Exposed as
  `o2b brain codec --compress|--expand`.
- `o2b brain sources` dashboard + `brain_sources` MCP tool
  (`portability/sources.ts`). Read-only aggregation of inbox + processed
  signals by (agent, source_type) with active/processed and
  distinct-topic counts. (The upstream parallel-sync worker pool +
  connection-budget warning are out of scope.)
- Vault-map role tokens (`portability/role-tokens.ts`). Resolve
  `{{role}}` tokens (`{{inbox}}`, `{{projects}}`, ...) to user content
  folder names via an optional `Brain/_vault-map.yaml`, falling back to
  built-in defaults; wired into scan-inline read paths and the
  graph-import target. Mapped values are validated against traversal /
  absolute / control characters. The FIXED Brain machinery layout is not
  routed through the resolver. Inspect with `o2b vault map`.
- Named multi-vault profiles (`portability/profiles.ts`). A registry in
  `profiles.json` beside the config with `o2b vault profile list / create
/ switch` and a `brain_switch_vault` MCP tool; activation is a pointer
  (no symlinks). `resolveVault` consults the active profile before the
  bare config `vault` key; with no registry, resolution is unchanged.
- Vault graph export/import (`portability/graph.ts`). `o2b brain
graph-export` serialises the user's pages (wikilinks + typed relations)
  to a stable, byte-identical `graph.json`; `o2b brain graph-import
--mode skip|overwrite|merge` reconstructs page stubs, every write
  guarded by `ensureInsideVault`.

### Notes

- New MCP tools `brain_sources` and `brain_switch_vault` (tool count
  44 -> 46). New CLI verbs under `o2b brain` (codec, sources,
  graph-export, graph-import) and `o2b vault` (profile, map).
- Default-install behaviour is byte-identical: the codec is opt-in and
  marker-gated, vault-map and profiles are no-ops without their files,
  and graph import is operator-invoked.
- Full suite green on merge: 2825 tests passing.

## [0.21.0] - 2026-05-29

Brain lifecycle suite. The nightly `dream` consolidation becomes an
explicit ordered pipeline, every preference gains an authoritative
mutation trail, contradictions are classified by domain instead of a
flat list, a budgeted session-start brief surfaces what matters, and
formal temporal constraints are lifted from signal text - all
deterministic and language-agnostic, with each new layer a no-op until
it applies or is opted in.

### Added

- Per-preference mutation audit log (`src/core/brain/pref-audit.ts`).
  An append-only JSONL trail under `Brain/log/pref-audit/<pref-id>.jsonl`
  captures every mutation (create / promote / update / retire / merge)
  with agent, reason, and revision + content-hash before/after, written
  at the mutation chokepoints (`writePreferenceTxn`, `moveToRetired`,
  `mergePreferences`) so it is authoritative and also records manual
  edits. Counter-only `update` churn is suppressed, so a no-op dream run
  writes no audit line. Read surface: `o2b brain audit <pref-id>` and
  the `brain_audit` MCP tool.
- Multi-phase dream pipeline (`src/core/brain/dream-phases.ts`). The
  proven `dream()` internals are unchanged; the existing seams are named
  as ordered phases (close -> reconcile -> synthesize -> heal -> log),
  each emitting a workrun checkpoint and a structured
  `DreamRunSummary.phases` summary. A no-op run returns `phases: []`.
- Reconcile-phase domain classification
  (`src/core/brain/reconcile-domains.ts`). Each contradiction is bucketed
  by structural signal shape into claims / entity / decisions /
  source-freshness. Only source-freshness with a decisive recency gap
  auto-resolves (recorded as a `reconcile` log event, never a
  sub-threshold mutation); the rest surface as `DreamRunSummary.open_questions`.
  The legacy `contradictions` field stays a derived view. No forced merge,
  no LLM fan-out.
- Morning brief (`src/core/brain/morning-brief.ts`). A read-only,
  character-budgeted session-start summary of the top confirmed
  preferences (confidence then recency), recent reconcile open questions,
  and recent notes. Exposed as `o2b brain morning-brief` and the
  `brain_morning_brief` MCP tool.
- Language-agnostic temporal extraction
  (`src/core/brain/temporal-extract.ts`). On promotion, an empty
  `valid_from` / `valid_until` is filled from the source signal - explicit
  bi-temporal fields preferred, else formal ISO-8601 tokens (date,
  interval, duration anchored to a co-occurring date or `now`) parsed from
  the signal text. No localized month/day names; the preference writer now
  emits the bi-temporal fields.
- Opt-in heal-phase vault enrichment (`src/core/brain/heal-enrich.ts` +
  `heal-run.ts`). When `dream.heal_enrich_enabled` is true, the heal phase
  completes a missing `title` from the first H1 and inserts wikilinks for
  exact title/alias matches across user pages, excluding the Brain root and
  the standard ignored dirs, never self-linking, via atomic writes.
  Default false, so a default install stays byte-identical.

### Notes

- New config key `dream.heal_enrich_enabled` (default `false`). New MCP
  tools `brain_audit` and `brain_morning_brief` (tool count 42 -> 44). New
  `reconcile` log event kind (additive; tolerated by the JSONL reader).
- Default-install behaviour is byte-identical: the audit is mutation- and
  content-gated, phases and open questions are additive, temporal fields
  fill only when empty, and heal enrichment is opt-in.
- Full suite green on merge: 2771 tests passing.

## [0.20.0] - 2026-05-29

Recall and ranking quality. The retrieval layer gains a tunable recency
curve, query-shape awareness, and language-agnostic recall broadening;
the context-injection surface gains character budgets and a
pre-compression bundle; and repeated searches can be served from a
self-invalidating cache.

### Added

- Configurable Weibull recency decay (`src/core/search/recency.ts`).
  The previous stepwise recency boost becomes a continuous Weibull
  survival curve with `search_recency_shape`, `search_recency_scale`
  (days), and `search_recency_amplitude` config keys. Defaults
  approximate the prior curve; a sub-display epsilon floors effectively
  stale content to exactly zero. Pure and deterministic.
- Query-intent classification via a pure `QueryPlan`
  (`src/core/search/query-plan.ts`). One structural pass classifies a
  query (neutral / exact / entity / broad) and emits a bounded ranking
  weight profile that re-weights the keyword / semantic / entity /
  recency layers. Intent derives only from query shape - quoted phrases,
  FTS wildcards, wikilinks, entity-token share, token count - never from
  any natural-language word list. On by default
  (`search_intent_enabled`); the neutral profile is bit-identical to
  prior ranking.
- Language-agnostic synonym / query expansion
  (`src/core/search/synonyms.ts`). Local co-occurrence (pseudo-relevance
  feedback) over the top candidates' own content surfaces related terms
  that are OR'd onto the FTS query to broaden recall, with no synonym
  dictionary or per-language list. Off by default
  (`search_synonym_enabled`), capped by `search_synonym_max_terms`, and
  always suppressed for exact-intent queries.
- Per-memory and total character caps for `brain_context_pack`, backed
  by a shared `recall-budget` primitive (`src/core/brain/recall-budget.ts`).
  `max_chars_per_memory` trims an oversized page before it consumes the
  token budget; `max_total_chars` bounds the cumulative size and drops
  the lowest-priority overflow. Caps are measured in Unicode code points.
- Persistent query cache with corpus-generation invalidation (schema
  migration v4, `query_cache` table). A search result is served for an
  identical request while the corpus generation - embedding model +
  dimension + schema version + a monotonic index revision bumped on every
  content reindex - is unchanged and the row is within the TTL. Off by
  default (`search_cache_enabled`, `search_cache_ttl_seconds`); cache
  reads and writes are best-effort and never fail a search.
- `brain_pre_compress_pack` MCP tool: a read-only, budgeted
  system-prompt addendum of the top confirmed preferences (by confidence,
  then recency) plus the head of `active.md`, for a host runtime to
  inject just before a context-compression event.

### Changed

- Search ranking now reflects the resolved recency curve and, when query
  intent is enabled, the per-query weight profile. Vaults that opt out of
  intent and keep the default recency parameters see ranking consistent
  with prior behaviour aside from the intentional recency-curve smoothing.

### Notes

- The schema migration to v4 is additive and reindex-safe; existing
  rows are preserved and a newer-than-supported index still raises
  `SCHEMA_MISMATCH`. As with prior schema bumps, run `o2b search reindex`
  after upgrading.
- Synonym expansion and the query cache are opt-in, so a default install
  keeps byte-identical search results (apart from the recency-curve
  change) until they are enabled.

## [0.19.0] - 2026-05-28

Typed graph semantics. The vault's link graph and page frontmatter gain
typed, machine-readable meaning that the search and query layers honor:
edges can carry a semantic relation, pages can declare typed
relationships and a visibility scope, and the Model Context Protocol
servers configured around the vault become a queryable landscape.

### Added

- Relation vocabulary as a single validation boundary
  (`src/core/graph/relation-vocab.ts`) plus a nullable `relation` column
  on the search `links` table (schema migration v3), orthogonal to the
  syntactic `link_type`. The vocabulary is data-driven and carries no
  SQL CHECK, so adding a relation type is a one-line change rather than a
  migration.
- Typed frontmatter relationships. Any page can declare `related`,
  `extends`, `contradicts`, or `superseded_by` in frontmatter; these
  become typed edges in the graph, are recorded with a relation type in
  the backlink index, and surface inline on `brain_search` results
  (structured output and CLI render). The result `relations` field is
  computed at query time and never stored.
- Content visibility scoping. A page may declare a `visibility:`
  frontmatter field; `brain_search` honors a requested visibility scope
  (`visibility` MCP argument, `--visibility` CLI flag). Untagged pages
  are always returned; a tagged page only when the caller's scope
  includes one of its values.
- `brain_mcp_landscape` MCP tool and `o2b brain mcp-landscape` CLI verb:
  list the MCP servers configured across the vault - each server's name,
  source config file, packages, and required env-var names. Environment
  values are never read. Recognises `.mcp.json`, `mcp.json`,
  `mcp_servers.json`, and `claude_desktop_config.json`.

### Changed

- Vaults that adopt frontmatter relations: those typed edges are written
  as wikilink-type edges, so `related`/`extends`/etc. now also
  contribute to link-boost and traversal recall. Additive; vaults
  without relation frontmatter are unaffected.

### Notes

- The schema migration is additive and reindex-safe; existing link rows
  keep a NULL relation until a reindex repopulates frontmatter-derived
  edges. All-untagged vaults see byte-identical search results.

## [0.18.0] - 2026-05-28

MCP context economy. Large tool results no longer flood the calling
agent's context window: budgeted tools return a bounded preview inline and
park the full payload in a vault-local artifact the agent can fetch on
demand. Search results also gain a one-line recall hint.

### Added

- Per-tool MCP preview budget. When a budgeted tool's serialized result
  exceeds its character budget, the JSON-RPC `tools/call` response returns
  a valid-JSON preview envelope (`preview_truncated`, `bytes_preview`,
  `full_chars`, `artifact_id`, `note`) in `content[0].text` while
  `structuredContent` stays the full, contract-validated object. Tools
  with no budget, and the CLI, are unaffected.
- `brain_artifact_get` MCP tool to fetch the complete payload of a
  preview-truncated result by its `artifact_id`. Read-only, full scope.
- Vault-local artifact store under `Brain/.artifacts/<run-id>/`, with
  secret redaction, path-safety, content-hashed ids, and best-effort TTL
  pruning of stale run directories on server start.
- `recall_hint` on `brain_search` results: a computed, never-stored
  one-line summary of the recalled set (count, per-type breakdown, top
  hit) built from a single language-agnostic template.

### Changed

- `redactRawOutput` accepts an optional `maxInput` so the artifact store
  can scrub secrets without inheriting the receipt-oriented 256 KiB
  truncation cap, preserving full payloads for later fetch.

## [0.17.0] - 2026-05-28

Brain Lifecycle Review Suite. Open Second Brain now adds read-only review
surfaces around the existing deterministic learning loop: pre-dream signal
readiness, retention recommendations, monthly timeline synthesis, schema
contracts for lifecycle artifacts, and a discipline warning when vault
structure grows faster than recorded thinking.

### Added

- `o2b brain intent-review` and `brain_intent_review` for deterministic
  pre-dream review of active signal clusters. `dream` and
  `brain_review_candidates` now include the same `intent_reviews` audit data
  without changing existing mutation outcomes.
- `o2b brain retention` and `brain_retention` for recommendation-only
  keep/improve/park/prune review over retired preferences and processed
  signals. The review never deletes, moves, or edits Brain artifacts.
- `o2b brain monthly` and `brain_monthly_review` for monthly synthesis over
  timeline events, status transitions, retirements, contradictions, and
  neglected areas.
- Public lifecycle schema artifacts under `schemas/brain/` plus the local
  schema-contract registry used by tests and agent-facing envelopes.
- Discipline-report complexity-to-thinking metric, with an explicit
  productivity-trap sub-reason when structural churn outpaces recorded taste
  or evidence output.

### Changed

- Brain lifecycle CLI/MCP surfaces now reject malformed timestamps and month
  values with stable validation errors.

## [0.16.0] - 2026-05-28

Agent boundary control surfaces. Open Second Brain now gives agents a
transient current-task scratchpad, configurable Markdown-link output for
presentation surfaces, explicit MCP output contracts, and deterministic
private-region stripping before memory writes. These are additive controls:
permanent preferences still live in Obsidian-compatible Brain files, while
short-lived facts and boundary checks stay outside the learning loop.

### Added

- `Brain/pinned.md` plus the `brain_pinned_context` MCP tool for read/write/
  append/clear operations on transient current-task context.
- `brain_context` now returns a structured `pinned` block and includes pinned
  content in its text card when present.
- `link_output_format: markdown` config support, with `OBSIDIAN_LINK_FORMAT`
  as an env override for presentation output such as `brain_digest`.
- Lightweight MCP `outputSchema` contracts and boundary validation for
  `brain_context`, `brain_pinned_context`, `brain_query`, and `brain_search`.
- `<private>...</private>` region stripping in the shared redactor before
  secret-shaped assignment masking.

### Changed

- The always-loaded writer MCP surface now has five tools: `brain_feedback`,
  `brain_apply_evidence`, `brain_note`, `brain_pinned_context`, and
  `brain_context`.

## [0.15.0] - 2026-05-28

Cross-agent query foundation. Open Second Brain now exposes a read-only
agent-source layer over existing Brain provenance, so operators and agents can
ask what Claude, Codex, Hermes, or any future registered source contributed and
compare their coverage without hardcoding a present-day agent matrix. The first
provider reads vault provenance from signals, preferences, and Brain log events;
future providers can register behind the same query/diff contracts.

### Added

- `src/core/brain/agent-source/` with registry-driven provider, query, summary,
  and diff helpers over normalized source-agent contributions.
- `brain_agent_query` and `brain_agent_diff` MCP tools for structured
  source-agent retrieval and browse/search/diff/map comparison modes.
- `o2b brain agent-query` and `o2b brain agent-diff` CLI mirrors with markdown
  output and `--json` envelopes matching the MCP semantics.
- Core, MCP, and CLI tests covering provenance collection, filtering, summary,
  comparison, and tool/command wiring.

### Changed

- Centralized session-adapter runtime metadata in the registry: format choices,
  validation, and default agent labels now come from adapter registration rather
  than duplicated `claude|codex|hermes` checks in the import path.

## [0.14.1] - 2026-05-27

Project-wide validation and formatting foundation. Open Second Brain gains
a single, explicit green-path: `oxlint` for linting, `oxfmt` for
reproducible formatting, and a `bun run validate` entrypoint that chains
typecheck, lint, and the test suite. Formatting is now enforced across the
TypeScript / JavaScript / JSON scope and lint errors are blocking, while
the remaining pre-existing cleanup surface stays visible as non-blocking
warnings. The same pass folds in the fixes required to keep the suite green
under the stricter workflow. No runtime behaviour changes.

### Added

- `oxlint.json` and `.oxfmtrc.json` configs, plus `lint`, `lint:fix`,
  `fmt`, `fmt:check`, `validate`, and `validate:fix` package scripts.
  `bun run validate` is the main verification command; `bun run
validate:fix` is the single autofix path for lint and formatting.
- `scripts/test` wrapper so `bun test` runs through the shared bun and
  sqlite prechecks.
- `tests/cli/coerce.test.ts`, `tests/core/validate.test.ts`, and
  `tests/helpers/sqlite-vec.ts` covering the consolidated helpers and the
  runtime-gated sqlite-vec path.

### Changed

- Applied a repository-wide formatting baseline across the TypeScript,
  JavaScript, and JSON scope to lower diff noise for future changes.
- Consolidated the shared input validation and coercion helpers used by
  the CLI and MCP layers into one place.

### Fixed

- Removed the dream snapshot / workrun id collision that could occur when
  both were generated within the same second.
- Made the macOS sqlite shim-backed test execution path reliable.
- Gated the sqlite-vec integration tests on actual runtime extension
  loadability instead of package presence alone, so they no longer fail in
  environments where the extension cannot load.

## [0.14.0] - 2026-05-27

Semantic Brain Health and Self-Maintenance suite: `brain_doctor` grows
from a structural well-formedness checker into a semantic quality gate,
and gains a bounded, deterministic self-maintenance path. It now surfaces
confirmed preferences that contradict each other (same subject, opposite
sign of record), concepts that recur across the vault with no dedicated
preference, and confirmed rules running on stale evidence. Every
preference write through the dream pass leaves an append-only edit-history
trail, so a rule's wording can be replayed from first signal to current
form. A new reconciliation surface folds the three detectors into one
clean/watch/investigate verdict, and `doctor --remediate` plans a
dependency-ordered repair and applies the auto-safe fixes (with a
dry-run preview). Every detector is dependency-free, deterministic,
language-agnostic, and config-tunable.

### Added

- `src/core/brain/health/contradiction.ts` (`detectContradictions`) -
  pairs confirmed preferences by principle token overlap and keeps only
  opposite-sign pairs. Polarity comes from the shared sign-of-record
  helper; no negation word list.
- `src/core/brain/health/concept-gap.ts` (`detectConceptGaps`) -
  recurring entities (via the v0.13.0 entity extractor) with no covering
  preference topic. Frequency-only, language-agnostic.
- `src/core/brain/health/stale-claim.ts` (`detectStaleClaims`) -
  confirmed preferences whose newest evidence is older than a window
  (injected clock).
- `src/core/brain/health/edit-history.ts` - append-only
  `pref-<slug>.history.jsonl` sidecar (`appendEditHistory` /
  `readEditHistory` / `renderEditHistory`), idempotent on
  `(revision, field, after)` so Syncthing peers converge. Recorded from
  the `writePreferenceTxn` chokepoint (opt-in); the dream pass threads it.
- `src/core/brain/health/remediation.ts` - `planRemediation` (ordered,
  auto-safe vs needs-review classification) and `applyRemediation`
  (dry-run safe, applies only auto-safe content-hash re-stamps under the
  sync lock, bounded by a step cap).
- `src/core/brain/health/reconcile.ts` (`reconcileSemanticHealth`) -
  runs the three detectors as domains in one deterministic pass and
  returns a `clean | watch | investigate` verdict.
- `src/core/brain/sign.ts` - shared sign-of-record helper extracted from
  `dream.ts` (behaviour-preserving).
- `brain_health` MCP tool; `o2b brain health`, `o2b brain history <slug>`,
  and `o2b brain doctor --remediate [--dry-run]` CLI surfaces.
- Optional `health:` config block (`contradiction_jaccard`,
  `concept_gap_min_frequency`, `stale_claim_max_age_days`,
  `remediation_step_cap`) with `BRAIN_HEALTH_DEFAULTS` + `resolveHealth`.

### Changed

- `runDoctor` now runs the semantic-health reconciliation best-effort,
  merges findings as warnings (`contradictory-preferences`,
  `concept-gap`, `stale-claim`), and attaches a `semantic_health` report
  to `RunDoctorResult`. The doctor remains non-mutating.
- `writePreferenceTxn` accepts an optional edit-history option; the dream
  pass passes its agent + run clock so promotions, refreshes, and
  retirements are recorded.

## [0.13.0] - 2026-05-26

Hybrid Search and Recall Quality suite: the fused FTS5 + semantic
ranking is now completed by four scoring/expansion layers and made
introspectable. Every search result carries a `why_retrieved` list of
the layers that ranked it. Maximal Marginal Relevance diversifies the
top pool so near-identical paraphrases stop crowding out complementary
notes. Link-graph traversal walks outbound wikilinks from the top hits
and surfaces related documents one or more hops away, decayed by
distance. A deterministic, language-agnostic entity signal boosts
proper-noun overlaps between query and note. Header-anchored chunking
keeps a mid-document chunk's section context searchable. MMR and
traversal are enabled by default and tunable via config; entity-boosting
and header anchoring populate on the next reindex - so v0.13.0 is a
deliberate ranking change and requires `o2b search reindex`.

### Added

- `src/core/search/mmr.ts` (`mmrRerank`) - greedy Maximal Marginal
  Relevance with deterministic token-set Jaccard similarity. Config
  `search_mmr_lambda` (default `0.7`; `1` disables).
- `src/core/search/traversal.ts` (`expandByTraversal`) - pure two-stage
  retrieve-then-walk expansion. Config `search_max_hops` (default `1`;
  `0` disables), `search_hop_decay` (`0.5`), `search_max_expansion_per_hit`
  (`3`). Backed by store `outboundLinkTargets` + `representativeChunks`.
- `src/core/search/entities.ts` (`extractEntities`) - structural,
  language-agnostic entity extraction (wikilink targets/aliases, quoted
  spans, capitalized runs, CamelCase, ALLCAPS, digit tokens). No NER
  dependency, no per-language word list.
- `reasons: string[]` on `BrainSearchResult` (explainable recall),
  surfaced in `brain_search` MCP output and `o2b search --verbose`/`--json`.
- `headingPath` on chunks plus a searchable `chunks.heading_path` FTS
  column (header-anchored chunking), weighted below content in bm25.
- Recall config block (`ResolvedRecallConfig`) on `ResolvedSearchConfig`,
  with matching env vars and per-query `mmrLambda` / `maxHops` overrides.

### Changed

- Search index schema migrated to version 2: adds the `chunk_entities`
  table and the `chunks.heading_path` column, and rebuilds `chunk_fts`
  as a two-column external-content FTS (`content`, `heading_path`).
  Requires `o2b search reindex`.
- The fused ranker now accepts an optional entity-match map and adds a
  capped (`0.04`) entity boost; the rank pool widens when MMR or
  traversal is active so expansions cannot displace genuine hits.

## [0.12.0] - 2026-05-26

Brain Integrity Suite: the write path for confirmed preferences is now
auditable, gated, and survivable. Promotion to `confirmed` stamps a
content-hash so the doctor can detect silent hand-edits. Every brain
write goes through `writePreferenceTxn`, a sync chokepoint that wraps
`fs.openSync(target + '.lock', 'wx')` for cross-process safety and a
chain of typed-error expectations (`StaleUpdate`, `UnsafeShrink`,
`SourceLock`, `DuplicateWrite`). Dream pass invocations open a durable
JSONL workrun so a crash mid-run leaves an inspectable trail. A new
`brain_review_candidates` MCP tool projects the next dream invocation
without mutating anything. The destructive-from-confirmed retire gate
refuses to retire a high-evidence confirmed pref through a single
weak signal when the operator opts in via config.

### Added

- `src/core/brain/sync-lockfile.ts` (`acquireLockSync`, `scanStaleLocks`)
  - a sync exclusive-create primitive for the brain write path. Pay
    Memory keeps its async `proper-lockfile` recipe; the brain ships
    its own sync variant to avoid migrating every caller signature.
- `src/core/brain/preference-txn.ts` (`writePreferenceTxn`,
  `BrainCollisionError`, `BRAIN_COLLISION_KIND`, plus three
  expectation factories: `expectRevision`, `noUnsafeShrink`,
  `noDuplicateWriteWithin`). Single chokepoint for every preference
  write. Auto-stamps `_revision` and (on confirmed promotions)
  `_content_hash` for callers that opt in.
- `src/core/brain/content-hash.ts` (`computeContentHash`,
  `verifyContentHash`). sha256 over the trimmed `(principle, scope)`
  pair, neutral when no stored hash is available.
- `_revision: number` and `_content_hash: string` optional fields on
  `BrainPreference`. Both emitted only when the writer supplies them;
  pre-v0.12.0 fixtures and the starter bundle stay byte-identical.
- `src/core/brain/dream-workrun.ts` (`openWorkrun`,
  `scanDanglingWorkruns`, `WORKRUN_PHASE`). One JSONL workrun at
  `Brain/log/dream-runs/<run-id>.jsonl` per mutation-path dream
  invocation; phase markers at `started`, `cluster_complete`,
  `promote_complete`, `retire_complete`, `finalized` (or
  `interrupted` on caught crash). Dry-runs skip workrun emission.
- `DreamRunSummary.gated_retires` carrying `DreamGatedRetireEntry`
  records for retires the destructive-from-confirmed gate skipped.
- `DreamGatedRetireEntry` interface exposing `pref_id`, `topic`,
  `applied_count`, `violated_count`, `threshold`, `attempted_reason`.
- `shouldGateRetireFromConfirmed` exported pure decision helper.
- `retire.confirmed_evidence_min_threshold?: number` optional config
  field on `BrainRetireConfig`. Default-off; when set, the dream
  pass refuses to retire a confirmed (unpinned) pref whose
  `applied_count + violated_count` is below the threshold.
- New `brain_doctor` checks: `content-hash-drift` (warning when the
  stored hash diverges from the recomputed hash of a confirmed
  pref's live principle / scope) and `dangling-workrun` (warning
  for workrun files whose last phase is neither `finalized` nor
  `interrupted`).
- `brain_review_candidates` MCP tool, a read-only projection over
  `dream({ dryRun: true })`. Returns `would_create`,
  `would_promote`, `would_retire`, `would_supersede`,
  `clusters_below_threshold`, `gated_retires`. No state mutates.
- Path helpers `dreamRunsDir(vault)` and `dreamWorkrunPath(vault,
runId)` in `src/core/brain/paths.ts`.

### Changed

- `dream()` routes its two `writePreference` call sites through
  `writePreferenceTxn`. Promotion writes now produce `_content_hash`
  automatically; refresh writes auto-stamp `_revision` only when the
  proposed bytes would change (idempotent dream reruns stay
  byte-identical with the existing `wouldRewritePreference` shortcut).
- `DreamRunSummary.retired` is filtered to exclude entries that the
  destructive-from-confirmed gate skipped. The public summary now
  matches what actually landed on disk.

## [0.11.0] - 2026-05-26

Brain-centric vault layout. The agent now owns one top-level
directory in the vault: `Brain/`. The legacy `AI Wiki/` subtree is
gone; Pay Memory writes nest under `Brain/payments/`. User-authored
notes (daily journals, weekly notes, etc.) live wherever the
operator names them and become read-only inputs to the agent only
when listed under a new `notes.read_paths` config block. The
`appendEvent` / `o2b append-event` writer that previously touched
`Daily/<date>.md` is removed entirely; agents record narrative
milestones through `brain_note` into `Brain/log/<today>.md`.

This release also clears every pre-1.0 backward-compat shim from
the codebase. Open Second Brain has no public users yet — keeping
dual-shape parsers, legacy migration verbs, or "lift-only" band
overlays just to honour an unpublished contract was pure dead
weight.

### Added

- `_brain.yaml` gains a `notes:` block with `read_paths` - the
  vault-relative folders the agent may READ user-authored notes
  from. Empty (or absent) means no scanning; the agent never writes
  to those paths.
- Path constants module (`src/core/brain/paths.ts`,
  `src/core/pay-memory/paths.ts`): every vault-relative path used
  by Brain or Pay Memory now lives behind a named constant
  (`BRAIN_ROOT_REL`, `PAY_MEMORY_*_REL`, etc.). Future renames are
  a one-line edit.
- README poster at `docs/images/readme-poster.jpg`, rendered under
  the H1.

### Changed

- `o2b init` no longer scaffolds vault content. Vault bootstrap is
  `o2b brain init`'s job; `o2b init` now only persists machine-local
  config (vault path, agent name, timezone).
- `o2b brain init` no longer writes `AI Wiki/_OPEN_SECOND_BRAIN.md`.
  The operating manual lives at `Brain/_BRAIN.md` only.
- `o2b index` writes to `<vault>/Brain/_INDEX.md` instead of
  `<vault>/AI Wiki/index.md`.
- `o2b brain scan-inline` walks only folders listed under
  `notes.read_paths` (or `--path` overrides). Default is "no folders
  to scan"; the agent never crawls the vault without an operator
  opt-in.
- Pay Memory writes under `Brain/payments/` (receipts go directly
  into `Brain/payments/<YYYY-MM-DD>/<slug>.md`, no nested
  `payments/` subdir).
- Brain upgrade plan: only `Brain/_brain.yaml` and `Brain/_BRAIN.md`
  (the legacy overview file is gone from the plan and from the
  release entirely).
- `computeConfidence` (the `dream` band derivation) uses only the
  numeric Wilson-lower-bound × freshness thresholds. The
  step-function band and the max-with-numeric overlay are deleted;
  the bands now move strictly with the numeric value.
- README quick start leads with the agent-delegated path: paste a
  one-liner into your agent, the agent reads `install/hermes.md`
  and runs every command. The hand-run command sequence stays as a
  fallback.
- README top-features table re-curated around human impact: each
  row is "what this means for you", not "what this does in code".

### Removed

- `o2b append-event` CLI verb, the `appendEvent` core function,
  and `src/core/event-log.ts`. Use `o2b brain note` or the
  `brain_note` MCP tool instead.
- `o2b brain migrate-frontmatter` CLI verb and its core module.
  Files with the legacy un-prefixed Group C frontmatter (`status:`,
  `applied_count:`, ...) no longer parse — the only shape on disk
  is `_status:`, `_applied_count:`, ... `BrainDoubleShapeError` and
  the dual-shape detection in `normalizeDerivedKeys` are gone.
- `src/core/init.ts` (the legacy `bootstrapVault` scaffolder).
- `src/core/brain/templates/_OPEN_SECOND_BRAIN.md.tpl` and the
  `LEGACY_OVERVIEW_*` exports.
- Legacy step-function band derivation in `computeConfidence`. The
  `legacyBand` / `max(legacy, numeric)` "lift-only" overlay is
  gone; numeric thresholds win outright. The dead config fields
  `confidence.high_min_applied` and `confidence.high_freshness_factor`
  that fed the step-function are removed from the schema, validator,
  default YAML, and type declarations.
- Historical inline comments referencing the retired
  `second_brain_capture` / `event_log_append` / `appendEvent` /
  AI Wiki/ / Daily/ surfaces, and the pre-v0.10.3 / pre-v0.10.6
  fallback notes that documented them.

### Breaking changes

- Shell scripts and cron jobs that piped messages into
  `Daily/<date>.md` via `o2b append-event` must migrate to
  `o2b brain note` (writes into `Brain/log/<today>.md` + JSONL
  sidecar).
- Operators who relied on scan-inline's old "scan everything"
  default must add the desired folders under `notes.read_paths` in
  `_brain.yaml`, or pass `--path` explicitly on every invocation.
- Preference / retired files using the legacy un-prefixed
  frontmatter keys (`status:`, `applied_count:`, ...) no longer
  parse. Rename them to the `_`-prefixed shape (`_status:`, ...).
- Confidence bands move stricter on stale prefs and on prefs with
  fewer than ~15 applied events. Anyone tuning thresholds may want
  to revisit `confidence.high_min` / `medium_min` against the new
  numeric semantics.

## [0.10.18] - 2026-05-25

Temporal + synthesis layer: seven related features that add time as
a first-class axis. A new `src/core/brain/temporal/` subsystem
materializes one `TimelineIndex` per invocation from
`Brain/log/<date>.jsonl` plus retired/ frontmatter, then five pure
projection helpers (`selectEvents`, `buildBeliefEvolution`,
`findStaleEntries`, `buildDailyBrief`, `buildWeeklySynthesis`) feed
five operator surfaces over that same index. Preference, signal,
and retired frontmatter grow additive optional `valid_from` /
`valid_until` / `recorded_at` slots so future write paths can
populate the bi-temporal axis without breaking existing files. A new
`temporal:` block in `_brain.yaml` tunes per-kind staleness
thresholds, daily window offset, and weekly window alignment. No
helper calls an LLM; every output is a deterministic data shape the
agent assembles into prose externally.

### Added

- `src/core/brain/temporal/types.ts` - `TemporalEvent` (flat shape
  reusing `BrainLogEventKind` plus optional denormalized slots),
  `TimelineIndex` (frozen materialized view with `ReadonlyMap`
  groups by kind / prefId / topic), `DreamSummarySlots` (denormalized
  array slice for belief-evolution).
- `src/core/brain/temporal/build-index.ts` -
  `buildTimelineIndex(vault, opts)`: the single disk-touching helper.
  Walks `Brain/log/*.jsonl` via the canonical `readLogDay` reader
  plus `Brain/retired/*.md` frontmatter; normalises every entry to
  one `TemporalEvent`; groups, sorts (ties broken by source path +
  line), freezes.
- `src/core/brain/temporal/select-events.ts` -
  `selectEvents(index, filters)`: pure projection, filters by AND
  of `prefId` / `topic` / `kind` / `since` / `until`. Picks the
  narrowest pre-grouped bucket the filter set permits.
- `src/core/brain/temporal/belief-evolution.ts` -
  `buildBeliefEvolution(index, vault, target)` for `prefId` or
  `topic`. Returns frozen `{target, transitions, evidence,
retirements, generatedAt}`. Transitions derived from dream
  summary arrays (`new_unconfirmed` / `confirmed` / `retired`);
  evidence rollup carries per-row running counts; retirement chain
  walked via `supersedes` / `superseded_by` with a visited-set
  cycle guard.
- `src/core/brain/temporal/stale-watch.ts` -
  `findStaleEntries(index, vault, cfg)`. Pure structural staleness:
  walks `Brain/preferences/`, `Brain/inbox/`, `Brain/log/` against
  the configured per-kind day thresholds. Uses the timeline's
  most-recent event timestamp as the staleness anchor when present,
  falls back to `last_evidence_at` then `created_at` then file
  mtime depending on kind.
- `src/core/brain/temporal/daily-brief.ts` -
  `buildDailyBrief(index, vault, date, opts?)`. Daily counters,
  status transitions, vault delta, deduplicated artifact wikilinks.
  Window aligned to UTC midnight by default; configurable via
  `temporal.daily_window_offset_hours`.
- `src/core/brain/temporal/weekly-brief.ts` -
  `buildWeeklySynthesis(index, vault, weekEnd, cfg, opts?)`. 7-day
  window ending at `weekEnd`. Same counters as daily plus
  `retired-in-window` list and `contradictions` (`signal-suppressed`
  events combined with `apply-evidence` rows where `result ===
"violated"`).
- `src/core/brain/temporal/period-common.ts` - shared helpers
  consumed by both briefs: `countByKind`, `collectTransitions`,
  `computeVaultDelta`, `collectSourcePointers`, `extractId`. One
  canonical implementation per helper.
- New atoms on existing types:
  - `BrainPreference`, `BrainSignal`, `BrainRetired`
    (`src/core/brain/types.ts`) gain optional `valid_from`,
    `valid_until`, `recorded_at` slots. Existing files stay
    byte-identical; parsers populate the slots only when present.
  - `isBrainLogEventKind(value)` exported from
    `src/core/brain/types.ts` so callers narrow strings without a
    runtime cast.
- New `temporal:` block in `_brain.yaml`
  (`src/core/brain/policy.ts`):
  - `stale_pref_days` (default 90)
  - `stale_signal_days` (default 30)
  - `stale_log_days` (default 180)
  - `weekly_start_dow` (default 1 - ISO-8601 Monday)
  - `daily_window_offset_hours` (default 0 - UTC)
- Five new full-scope MCP tools (`src/mcp/brain-tools.ts`):
  `brain_timeline`, `brain_belief_evolution`, `brain_stale_scan`,
  `brain_daily_brief`, `brain_weekly_synthesis`. Writer scope
  remains frozen at four tools.
- Five new CLI verbs: `o2b brain timeline`, `o2b brain evolution`,
  `o2b brain stale`, `o2b brain daily`, `o2b brain weekly`. Each
  honours `--vault` / `--json` plus verb-specific flags.

### Changed

- README capability paragraph extended; MCP tool inventory bumped
  from `Brain (14)` to `Brain (19)`.
- `tests/mcp/mcp.test.ts` tool-inventory assertion updated 26 -> 31.
- `loadTemporalConfigSafe(vault)` exported from
  `src/core/brain/policy.ts` so MCP wrappers and CLI verbs share
  one load-with-defaults helper.

### Notes

- Language-agnostic by construction. No vocabulary lists, no
  stopwords, no per-language regex tables. Filters use only typed
  event-kind enums, frontmatter keys, ISO-8601 timestamps, and the
  `pref-/ret-/sig-` slug regex.
- Backwards compatible. The new frontmatter slots are additive
  optionals; existing preference / signal / retired files stay
  byte-identical when not opted in. Existing public APIs unchanged.
- No LLM call inside helpers. The brief and evolution helpers
  return frozen deterministic envelopes; downstream agents do the
  narrative work.
- Window bounds are second-precision canonical UTC (matching
  `appendLogEvent`'s emitted timestamps) so string comparison
  semantics are unambiguous at midnight boundaries.
- 2343 tests pass (+83 over the v0.10.17 baseline of 2260);
  typecheck and version-sync remain clean.

## [0.10.17] - 2026-05-25

Link graph surfaces: seven related features that expose the vault
as a connected graph. A new `src/core/brain/link-graph/` subsystem
holds pure helpers (rich wikilink parse, frontmatter alias index,
unlinked-mentions scanner, concept-cluster assembler, per-MOC
audit). The backlink index now resolves Obsidian-style frontmatter
`aliases:` arrays and preserves `#heading` / `#^block-id` anchors
on every `BacklinkRef`. Three new MCP tools
(`brain_unlinked_mentions`, `brain_concept_synthesis`,
`brain_moc_audit`) and three new CLI verbs (`o2b brain unlinked`,
`synthesise`, `moc-audit`) surface the helpers; `brain_search`
gains an optional `properties` argument and `o2b search` grows a
repeatable `--property KEY=VALUE` flag for frontmatter-scalar
filters; `brain_context` envelope optionally surfaces a vault-root
instruction file (`VAULT.md` by default).

### Added

- `src/core/brain/link-graph/parse-wikilink.ts` -
  `parseWikilinkRich(value)` returns
  `{target, anchor, block, alias}` for any Obsidian wikilink
  shape; existing `parseWikilink` / `normaliseWikilinkTarget`
  string contracts are unchanged. Sibling helper
  `extractWikilinkRichBodies(content)` yields full bracket bodies
  so anchor info survives the body walk.
- `src/core/brain/link-graph/alias-index.ts` -
  `buildAliasIndex(vault)` walks `Brain/preferences/` +
  `Brain/retired/` and returns a frozen
  `Map<aliasLowerNFC, canonicalId>`. Collisions resolve first-wins
  by sorted canonical id; aliases that would shadow an existing
  on-disk basename are silently dropped (no backlink hijack).
- `src/core/brain/link-graph/unlinked-mentions.ts` -
  `findUnlinkedMentions(vault, targetId, opts)` returns raw-text
  occurrences of the target's title / aliases that are NOT inside
  `[[...]]` brackets and NOT inside code spans. **Language-agnostic
  by construction** - matches only via Unicode codepoint classes
  (`\p{L}`, `\p{N}`), rejects single-codepoint terms.
- `src/core/brain/link-graph/concept-cluster.ts` -
  `buildConceptCluster(vault, targetId, opts)` assembles a
  deterministic envelope: target + every linker (depth-1) +
  optional unlinked mentions. Pure assembler; no LLM call.
- `src/core/brain/link-graph/moc-audit.ts` -
  `auditMoc(vault, hubId, opts)` classifies cluster members into
  `wellCovered`, `fragile`, `candidateMissing`, plus a
  `suggestedNext` pick. MOC detection is purely structural -
  outbound link count + non-whitespace link-density ratio. No
  vocabulary detection of "this looks like a MOC".
- `src/core/search/property-filter.ts` -
  `filterByProperties(rows, filters, reader)` is a pure post-FTS
  phase. Multi-value within a key = OR; multiple keys = AND.
  Dependency-injected frontmatter reader keeps the helper testable
  without I/O.
- `src/core/brain/vault-instruction-file.ts` -
  `readVaultInstructionFile(vault, name?)` reads a vault-root
  user-authored instruction file (default `VAULT.md`,
  configurable via `link_graph.vault_instruction_file`).
  Rejects unsafe overrides at config time (absolute paths, `..`
  segments). `brain_context` envelope grows an optional
  `vault_instruction: {path, content, lines}` field; absent file
  = field omitted.
- New atoms on existing types:
  - `BacklinkRef` (`src/core/brain/backlinks.ts`) gains optional
    `targetAnchor`, `targetBlock`, `aliasSource` fields. Existing
    consumers reading only the four legacy fields keep compiling.
  - `SearchOptions.properties` (`src/core/search/types.ts`)
    optional `ReadonlyMap<string, ReadonlyArray<string>>`.
- New `link_graph:` block in `_brain.yaml`
  (`src/core/brain/policy.ts`):
  - `moc_min_outbound_links` (default 5)
  - `moc_min_link_ratio` (default 0.3)
  - `vault_instruction_file` (default `VAULT.md`)
- Three new full-scope MCP tools (`src/mcp/brain-tools.ts`):
  - `brain_unlinked_mentions(id, limit?)`
  - `brain_concept_synthesis(id, include_unlinked?)`
  - `brain_moc_audit(id)`
- `brain_search` (`src/mcp/search-tools.ts`) accepts an optional
  `properties` argument; the schema validates each key maps to
  an array of strings.
- Three new CLI verbs:
  - `o2b brain unlinked <id> [--limit N] [--json]`
  - `o2b brain synthesise <id> [--include-unlinked] [--json]`
  - `o2b brain moc-audit <id> [--json]`
- `o2b search` grows a repeatable `--property KEY=VALUE` flag
  (`src/cli/search.ts`); malformed entries fail loudly with a
  usage error before any I/O.

### Changed

- `buildBacklinkIndex` (`src/core/brain/backlinks.ts`) rewrites
  its push helper to consult the alias index and call
  `parseWikilinkRich` on every incoming target string, populating
  the new `BacklinkRef.targetAnchor` / `targetBlock` /
  `aliasSource` fields. Dedup key now includes the anchor/block
  so two refs to different sections of the same target keep both
  entries.
- `brain_context` envelope additively grows the optional
  `vault_instruction` field. Hosts that strip unknown fields stay
  byte-identical.
- README capability bullets describe the new link-graph surfaces,
  property-filtered search, and vault-root instruction file. MCP
  tool inventory bumps from 11 to 14 Brain tools.

### Notes

- **Language-agnostic by construction.** None of the new
  helpers uses a vocabulary list, stopword set, per-language
  regex table, or unit dictionary. Detectors rely on Unicode
  codepoint classes and structural sigils only.
- **Backward compatibility by construction.** New fields on
  `BacklinkRef` are additive optionals. Existing consumers that
  destructure only the four legacy fields keep compiling. The
  `brain_context` envelope's `vault_instruction` field is absent
  when the file is missing. `SearchOptions.properties` absent =
  identical pre-v0.10.17 behaviour.
- **No new external dependencies.** Helpers use only
  `node:fs`, `node:path`, and existing internal utilities.
- **No LLM calls in core helpers.** `buildConceptCluster` and
  `auditMoc` are pure assemblers; downstream consumers can feed
  the deterministic envelope to an LLM later.
- Three new tools register in the full MCP scope only. The
  writer-scope surface stays at four tools
  (`brain_feedback`, `brain_apply_evidence`, `brain_note`,
  `brain_context`); the last grows the additive
  `vault_instruction` field on the existing envelope.

## [0.10.16] - 2026-05-25

Trust and operator surfaces: eight related self-reporting features
ship together under the theme "trust the brain's self-reporting".
A new `src/core/brain/trust/` subsystem holds pure helpers that
compute verification deltas, an aggregate trust verdict, a
language-agnostic preference quality gate, role-permission
boundaries, a self-approval guardrail, and instruction-file
compliance warnings. One new MCP tool (`brain_operator_summary`)
plus one new CLI verb (`o2b brain summary`) aggregate doctor,
dream, and vault metadata into a single operator dashboard.

### Added

- `src/core/brain/trust/role.ts` - `BRAIN_ROLES` (`writer`,
  `dreamer`, `applier`, `unknown`) and `BRAIN_OPERATIONS` enums.
  Atom for the role-permission gate.
- `src/core/brain/trust/check-role-permission.ts` -
  `checkRolePermission(role, op, currentStatus?)`. Static
  allow-list per role; rejects cross-role attempts with a
  structured reason.
- `src/core/brain/trust/assess-rule-quality.ts` -
  `assessRuleQuality(principle)`. **Language-agnostic** structural
  detector. No vocabulary list, no stopword set, no unit
  dictionary; only codepoint shape (Unicode `\p{L}` / `\p{N}`,
  digit / operator presence, single-character token ratio).
  Surfaces as a quality gate at `brain_feedback` time.
- `src/core/brain/trust/self-approval-guardrail.ts` -
  `applySelfApprovalGuardrail({signal_count, distinct_agents,
age_days}, config)`. Promotes only when all three thresholds
  pass; quarantines otherwise. Defaults
  (`promotion_min_signals: 2`, `promotion_min_distinct_agents: 1`,
  `promotion_min_age_days: 0`) keep pre-v0.10.16 dream behaviour
  bit-identical.
- `src/core/brain/trust/compute-verification-delta.ts` -
  `computeVerificationDelta(vault, dream)`. Classifies each
  preference id cited by a dream summary into one of `confirmed`,
  `drift`, `regression`, `missing_evidence`. Pure read-only;
  emits vault-relative paths only.
- `src/core/brain/trust/instruction-file-ceiling.ts` -
  `checkInstructionFileCeiling(vault, { maxLines })`. Warns when
  any tracked vault-root instruction file (`CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`) exceeds the configured ceiling.
- `src/core/brain/trust/compute-trust-verdict.ts` -
  `computeTrustVerdict({ doctorWarnings, doctorErrors,
dreamWarnings, verification, driftWatchThreshold? })`. Returns
  one of `clean`, `watch`, `investigate`.
- `src/core/brain/trust/operator-summary.ts` -
  `buildOperatorSummary(vault, opts)` and
  `renderOperatorSummaryMarkdown(summary)`. One read-only call
  that aggregates doctor, dream, verification, instruction-file
  warnings, and ranked maintenance actions into a single
  envelope.
- `BRAIN_GUARDRAIL_DEFAULTS` and `resolveGuardrails(cfg)` in
  `policy.ts`. Backward-compatible defaults; an explicit
  `guardrails:` block in `_brain.yaml` overrides any subset.
- `DreamRunSummary.uncertain: ReadonlyArray<DreamUncertainEntry>`
  and `DreamRunSummary.quarantined:
ReadonlyArray<DreamQuarantinedEntry>` (empty on every clean run).
- `RunDoctorResult.trust_verdict` (always populated),
  `RunDoctorResult.verification_delta_summary` (present when a
  dream summary is threaded through), `RunDoctorResult.
instruction_file_warnings`, and `RunDoctorResult.uncertain`.
- `DigestJson.trust_verdict?`, `DigestJson.uncertain_count`,
  `DigestJson.quarantined_count`. Markdown digest gains a `##
Trust` section when doctor or dream input is supplied.
- `brain_operator_summary` MCP tool in the full scope. Returns
  the structured envelope from `buildOperatorSummary`.
- `o2b brain summary [--skip-dream] [--top-actions <n>]
[--vault <path>] [--json]` CLI verb. Markdown by default, JSON
  on demand.
- `BrainRolePermissionError` thrown by
  `appendApplyEvidence(vault, input, { role })` when the role is
  not permitted.

### Changed

- `brain_feedback` rejects structurally-broken principles
  (empty, single token) via `assessRuleQuality`. Warn-level
  findings (too-long, no-measurable-signal, filler) are
  advisory and do not block submission.
- `brain_dream` invokes `applySelfApprovalGuardrail` before
  creating a new unconfirmed preference. Clusters that pass
  `candidate_threshold` but fail a guardrail threshold land in
  `quarantined`; the contributing signals stay in `inbox/` so the
  cluster naturally re-evaluates on the next pass. With default
  guardrails this never fires (all defaults at or below the
  existing thresholds), so existing tests stay green.
- `brain_dream` MCP wrapper surfaces `uncertain[]`,
  `quarantined[]`, and `suppressed[]` arrays.
- `brain_doctor` always populates `trust_verdict` (computed from
  doctor warnings/errors plus the verification delta when
  available) and `instruction_file_warnings`. The MCP wrapper
  emits both.
- `brain_apply_evidence` MCP wrapper asserts `applier` role at
  the boundary; rejects calls from other roles with a structured
  error.
- `BrainConfig.guardrails?: BrainGuardrailConfig` (new optional
  block in `_brain.yaml`). Validates each subfield as a positive
  integer (`promotion_min_age_days` allows zero); rejects values
  above the hard `INSTRUCTION_FILE_MAX_LINES_CEILING` of 10000.
- `brain_digest` accepts optional `doctorResult` and
  `dreamSummary` in `RenderDigestOptions`. When neither is
  supplied, output stays bit-identical to v0.10.15.

### Notes

- The trust subsystem follows the v0.10.15 precedent
  (`page-meta/`, `maintenance/`): atoms (field additions on
  existing summary types) -> helpers (pure functions in
  `trust/`) -> consumers (existing brain tools call into helpers
  but keep their public contract).
- The preference quality gate is **shape-based only**. The
  detector reads codepoints, never vocabulary. A vague rule
  expressed in one language and the same rule expressed in
  another language are treated identically by construction.
- No on-disk migration. Existing preference and retired pages
  stay byte-identical; readers fall back to documented defaults
  when the new fields are absent.
- `brain_operator_summary` is registered in the full MCP scope
  only. The always-loaded writer scope keeps its four-tool
  surface (`brain_feedback`, `brain_apply_evidence`,
  `brain_note`, `brain_context`).
- Role enforcement is incremental in v0.10.16: enforced on
  `brain_apply_evidence` at the MCP boundary. Future releases
  may thread the role check through writer-side calls
  (`writeSignal`, `writePreference`).
- 2135 tests pass; typecheck and sync-version clean.

## [0.10.15] - 2026-05-25

Vault care bundle: eight related upstream-inspired metadata and
maintenance features ship together in one release. New per-page
frontmatter axes (`_lifecycle`, `tier`, `merged_into`), a Unicode-
aware dedup key, a heuristic tokenizer, a bounded-token context
pack, a self-healing lint pass, page-level deduplication, and a
ranked maintenance action list - all built on a layered
foundation so future maintenance features add a peer module
rather than re-cutting the schema.

### Added

- `_lifecycle` frontmatter axis (`draft`, `stable`, `verified`,
  `deprecated`, `archived`, `disputed`) on Brain pages. Default
  read-side fallback is `stable`. Helpers in
  `src/core/brain/page-meta/lifecycle.ts`: `readLifecycle`,
  `isStale`, `ageDaysFromIso`.
- Generalised `_confidence` read-helper in
  `src/core/brain/page-meta/confidence.ts` so non-preference pages
  can carry the existing `BRAIN_CONFIDENCE` triple.
- `tier` frontmatter axis (`core`, `supporting`, `peripheral`) on
  vault pages. Default `supporting` keeps the search ranker
  bit-identical on untagged vaults. Ranker accepts an optional
  `tierByDoc` input and applies a multiplicative weight to the
  relevance term only.
- `merged_into:` pointer + canonical resolver in
  `src/core/brain/page-meta/page-id.ts`. Cycle detection bounded
  at depth 5; dangling pointers fall through to the last reachable
  id.
- `src/core/brain/text/normalize.ts` (`normalizeForDedup`) -
  NFKC + Unicode case folding, the shared key normaliser used by
  dedup-hash and page-dedup.
- `src/core/brain/text/tokenizer.ts` (`estimateTokens`) -
  deterministic heuristic token counter: `ceil(utf8_bytes / 4)`.
  Language-agnostic; no script-specific branching so the formula
  works uniformly for any input.
- `src/core/brain/page-dedup.ts` - exact-normalised-key page
  dedup, secondary marking via `merged_into`, vault-wide wikilink
  patcher that preserves aliases and anchors.
- `o2b brain page-dedup [--apply]` CLI verb.
- `src/core/brain/token-footprint.ts` -
  `computeTokenFootprint(vault)` returning per-category counts
  (preferences, retired, inbox, processed, log, other) with a
  `BRAIN_TOKEN_WARN_THRESHOLD` env override.
- `o2b brain token-footprint [--json]` CLI verb.
- `src/core/brain/context-pack.ts` - tier-then-recency ordered
  vault slice under a strict token budget, optional substring
  query filter (Unicode + case insensitive).
- `o2b brain context-pack --max-tokens <n> [--query <q>]` CLI verb.
- `brain_context_pack` MCP tool exposing the same slice through
  the JSON-RPC surface.
- `src/core/brain/lint-consolidate.ts` -
  `lintConsolidate(vault, { apply })` performs two self-healing
  operations: `fix-merged-link` rewrites wikilinks pointing at a
  page that carries `merged_into:` to the canonical, and
  `demote-stale-stable` flags `_lifecycle: stable` preferences
  older than 180 days with no recent evidence for demotion to
  `draft`. Dry-run by default.
- `o2b brain lint --consolidate [--apply] [--yes] [--json]` CLI verb.
- `src/core/brain/maintenance/action-scorer.ts` -
  `scoreActions(inputs, { topN })` deterministic ranking of
  vault-maintenance actions by impact (dedup count × weight,
  staleness × age, broken-link count, token-footprint excess).
- `o2b brain actions [--top-n N] [--json]` CLI verb aggregating
  dedup, lint, and footprint inputs through the scorer.

### Changed

- `computeDedupHash` now passes topic, principle, and scope
  through `normalizeForDedup` before hashing so fullwidth /
  halfwidth, NFC / NFD, and case-only variants collapse into one
  signal. Previously only NFC normalisation applied to principle.
- `RankerInputs` gains an optional `tierByDoc` field; absent or
  `supporting` entries leave the ranker output bit-identical.
- `writePreference` accepts optional `lifecycle` and `tier` inputs
  and emits `_lifecycle` / `tier` frontmatter only when the
  caller supplies them. Existing callers (and fixtures) stay
  byte-identical.

### Notes

- The `tier` field is unprefixed (user-editable territory next to
  `pinned`); `_lifecycle` carries the Group-C `_` prefix because
  dream owns lifecycle transitions.
- `brain_context_pack` is registered in the full MCP scope only,
  not the always-loaded writer scope. The writer scope keeps its
  four-tool surface (`brain_feedback`, `brain_apply_evidence`,
  `brain_note`, `brain_context`).
- No migration runs for the new `_lifecycle` / `tier` fields:
  legacy preference and retired pages are left byte-identical.
  Readers apply documented defaults (`stable`, `supporting`)
  when the field is absent, so behaviour is consistent without
  rewriting existing files. New writes opt in by passing the
  fields to `writePreference`.

## [0.10.14] - 2026-05-25

Three independent quality-of-life improvements bundled into one
release: an indexer fastpath that skips reading unchanged files, a
broader secret redactor that catches PEM private-key blocks and
JWT-shaped tokens, and a new vault-level connection-health metric
that surfaces orphan ratio and backlink density in `brain_digest`.

### Added

- `Store.touchDocument(relPath, mtime, size)` - targeted stat update
  for re-arming the indexer fastpath without overwriting metadata.
- `DocumentSummary.size` - exposed alongside `mtime` and
  `contentHash` from `listDocuments()` so the indexer can compare
  size cheaply before falling back to a content hash.
- PEM private-key block redaction in `event-log.ts` - state-machine
  pass that replaces multi-line `-----BEGIN ... PRIVATE KEY-----`
  blocks with `[REDACTED PRIVATE KEY]`. Covers RSA, EC, DSA,
  OpenSSH, PGP, and encrypted variants.
- JWT-shaped token redaction in `event-log.ts` - conservative match
  on three base64url segments (each at least 4 characters) replaced
  with `***REDACTED_JWT_<last-4>`. Does not false-positive on
  semver-style version numbers like `1.2.3`.
- `DigestJsonConnectionHealth` in `brain_digest` JSON and markdown
  output - reports `total_nodes`, `linked_nodes`, `orphan_nodes`,
  `mean_backlinks`, `median_backlinks`, `link_density`. Computed
  once from the existing backlink index over all preferences and
  retired entries.

### Changed

- `indexer.ts` short-circuits SHA256 hashing when `mtime` and
  `size` both match the stored summary, falling back to hash
  comparison only when stats differ. On a hash-match-but-stat-drift
  case the indexer calls `touchDocument()` to re-arm the fastpath
  for the next run.

## [0.10.13] - 2026-05-24

Partner integration with [codegraph](https://github.com/colbymchenry/codegraph):
detection-only doctor check plus an agent-facing playbook. OSB stays
in the vault / prose / Brain lane; codegraph keeps its codebase
symbol-graph lane. No data is mirrored between them.

### Added

- `code_graph` check in `o2b doctor` - reports installed / not_indexed
  / missing / error for the current code-project scope. Scope is the
  current working directory plus top-level siblings of the vault's
  parent, capped at 50 inspected directories. Configurable through
  `DoctorOptions.partner.codegraph` (`disabled`, `scanExtraPaths`).
- `skills/codegraph-partner/SKILL.md` - agent-facing playbook with
  detection algorithm, branch-by-state behaviour, a hard rule to
  append `.codegraph/` to `.gitignore` after any `codegraph init`,
  and a `codegraph_*` vs `brain_*` disambiguation table.
- `src/core/partner/codegraph.ts` - module exposing `isCodeProject`,
  `findCodeProjects`, and `checkCodegraph` with dependency-injection
  hooks for testable `which` / `status -j` interactions.

### Notes

- OSB does not call `codegraph install`, `codegraph init`, or
  `codegraph index` automatically. The partner CLI is detected, never driven.
- `.codegraph/` is now in `.gitignore` so any local index inside the
  OSB repo itself does not land in commits.

## [0.10.12] - 2026-05-20

Operational friction reduction: one-command update across all
runtimes, weekly brain digest with agent quality summary, Cursor
SQLite deep parsing for accurate transcript activity, and Obsidian
deep-links in the live explorer. Companion design and impl plan at
`docs/brainstorm/operational-friction-reduction/{design.md,plan.md}`
and `docs/plans/2026-05-20-v0.10.12-impl.md`.

### Added

- `o2b update` — one-command update across all detected runtimes.
  Skips unchanged payloads via sidecar hash comparison. Supports
  `--target`, `--dry-run`, `--force`, `--json`. Post-update verify
  with drift detection.
- `o2b brain digest --window 7d` — arbitrary time windows for the
  digest. Accepts `Nd` or bare `N` format (e.g. `7d`, `14`, `30d`).
- Agent quality summary in digest — per-agent event counts, type
  breakdown (feedback / apply-evidence / note), and confirmed/retired
  attribution within the window.
- `o2b discipline install --weekly` — installs a weekly brain digest
  cron job (`osb-weekly-brain-digest`) defaulting to Monday 08:59 UTC.
  Uses `scripts/discipline-report.ts --window 7d`.
- Cursor SQLite deep parsing — discipline report reads `state.vscdb`
  for session count + message count, eliminating mtime false-positives.
  Falls back gracefully on any SQLite error.
- Obsidian deep-link in explorer — double-click a node in live mode
  to open the file in Obsidian via `obsidian://open?path=<absolute>`.
  Fallback copies path to clipboard.

### Changed

- `scripts/discipline-report.ts` now accepts `--window Nd` for
  digest mode, falling back to daily discipline report otherwise.

## [0.10.11] - 2026-05-20

Multi-runtime install orchestrator plus a configurable
`Most-applied (Nd)` block surfaced to operators alongside the
existing lifetime-top section. One PR delivers seven new install
targets, a wizard, a runtime-install health check, and a partial
uptake of session-transcript awareness in the discipline report.
Companion design and impl plan at
`docs/plans/2026-05-20-multi-runtime-install-design.md` and
`docs/plans/2026-05-20-multi-runtime-install-impl.md`.

### Added

- `o2b install --target <name>` for seven additional runtimes
  alongside the existing Hermes / OpenClaw / Codex / Claude Code
  paths: `cursor`, `aider`, `opencode`, `kiro`, `copilot-cli`,
  `gemini-cli`, `pi`, plus a `generic` printout target for the
  long tail. Default invocation (no `--target`) is detect-only;
  `--apply` is required for any file writes, `--dry-run` /
  `--check` cover the other read-only modes. JSON-merge runtimes
  preserve user-authored keys; Aider uses a marker-fenced managed
  block plus a sidecar context file; Pi uses a symlink; generic
  prints to stdout or `--out <path>`.
- `o2b uninstall --target <name>` paired with the new
  `<vault>/.open-second-brain/install.lock.json` sidecar manifest.
  Removes exactly what install wrote and never user-authored
  config; refuses without `--force-from-snippet` when no manifest
  entry exists.
- `o2b init --interactive` first-time-setup wizard. Composes
  `o2b init`, `o2b brain init`, and per-target `o2b install`
  behind a single linear flow. Stdin-driven; safe-by-default
  confirmation gate before any side effects.
- `o2b install --check [--target X]` runtime health check.
  Reports per-runtime status (`ok` / `drift` / `not-installed` /
  `mcp-unreachable`) and prints the exact repair command. Exit
  code 3 on drift, 0 otherwise.
- `o2b mcp --writer-only` flag — alias for `--scope writer`,
  used by every JSON-merge adapter when it writes the second of
  the two registered MCP servers.
- `o2b mcp --probe` flag — in-process MCP handshake used by
  `o2b install --check` to confirm the server starts cleanly.
- `_brain.yaml` block `active.{most_applied_window_days,
most_applied_limit}` (defaults 30 / 10; bounds 1..365 / 1..50).
  Both `Brain/active.md` and `brain_digest` honour the values;
  defaults unchanged from prior behaviour.
- `Most-applied (Nd)` section in `brain_digest` Markdown plus a
  mirrored `most_applied` field in the JSON form. Rendered only
  when the window contains at least one applied event; JSON form
  always carries the shape (with empty `entries` when applicable).
- Per-runtime session-transcript awareness in the daily discipline
  report. Resolvers for Claude Code, Codex, and Cursor surface a
  `transcript-confirmed` sub-reason on `alert` rows when the proxy
  signal lines up with runtime transcripts dated to the same day.
  Remaining runtimes (opencode / kiro / Copilot CLI / Gemini CLI /
  Aider / Pi) stay deferred.
- Bundled Aider context template
  `templates/install/aider-context.md.tmpl`.

### Notes

- Design closes `_summary.md` §4 second half (full installer with
  auto-detect + managed block + dry-run) and §15 second half
  (interactive `o2b init` wizard). Project-scope MCP config and
  Pi path auto-detect remain deferred.
- The `_brain.yaml` schema accepts the new `active:` block as flat
  keys (`most_applied_window_days`, `most_applied_limit`). The
  two-level YAML parser drove the choice; the in-memory
  `BrainActiveConfig.most_applied` still groups them so consumers
  pass one struct around.

## [0.10.10] - 2026-05-20

Pull channels for runtimes without `SessionStart`. Adds an MCP
`brain_context` tool, surfaces a `Most-applied (30d)` section in
`Brain/active.md`, ships the `o2b brain note` CLI verb, and prints
a semantic-search hint in `o2b status`. The always-loaded
`open-second-brain-writer` MCP server now also hosts one read
tool; the server name is preserved for backward compatibility and
a rename is deferred (see
`docs/plans/2026-05-20-v0.10.10-design.md` §12). Companion design
and impl plan at `docs/plans/2026-05-20-v0.10.10-design.md` and
`docs/plans/2026-05-20-v0.10.10-impl.md`.

### Added

- `brain_context` MCP tool — read-only pull-bootstrap of the
  current `Brain/active.md` body plus active-preference counts.
  Hosted in the always-loaded `open-second-brain-writer` MCP
  server so MCP clients without a `SessionStart` hook (Cursor,
  Aider, raw Claude API) can fetch the same shortcut card the
  hook-aware runtimes get injected automatically.
- `Most-applied (30d)` section in `Brain/active.md` — top ten
  `confirmed` / `quarantine` preferences ranked by
  `apply-evidence (result: applied)` events whose timestamp lies
  inside the trailing 30-day window. Section is omitted when the
  count is zero. The render is fully derived from `Brain/log/`;
  no new persistent state is introduced.
- `o2b brain note <text>` CLI verb — Brain-native milestone log
  for cron jobs and shell scripts. Same on-disk contract as the
  MCP `brain_note` tool: writes one `note` event to
  `Brain/log/<today>.md` plus the JSONL sidecar. Supports
  `--agent`, `--vault`, `--config`, and `--json`. Multi-line text
  collapses to one line (matches the MCP contract).
- `o2b status` semantic-search hint — when semantic search is
  enabled in config but unusable (key missing) and search is not
  disabled outright, the human output appends
  `semantic: off (run 'o2b search check' for setup steps)` after
  the `config_keys:` block. `--json` payload always carries the
  new keys `semantic_enabled`, `embedding_key_present`, and
  `semantic_hint` (last one is `null` when fully configured or
  when search is disabled).
- `appendBrainNote` core function in `src/core/brain/note.ts`.
  Single source of truth shared by the MCP `brain_note` handler
  and the new CLI verb so the on-disk shape cannot drift between
  surfaces.
- `computeMostApplied` core function in
  `src/core/brain/most-applied.ts`. Pure read; the caller passes
  the candidate preferences so retired rules never surface in
  the active digest.
- `resolveSemanticConfigState` helper in `src/cli/helpers.ts`.
  Single source of truth for `o2b status` and the `o2b init`
  search banner; collapses the duplicated truthy / key-present
  logic onto one function.

### Changed

- `RegenerateActiveResult.counts` gains a `most_applied_30d`
  field. Internal additive change; the existing
  `{confirmed, quarantine, retired_recent}` triple keeps its
  values and semantics.
- Hook detector (`hooks/lib/detect.ts`) recognises
  `o2b brain note` as a brain event needle, alongside
  `o2b brain feedback` and `o2b brain apply-evidence`. The stop
  guardrail clears for any of the three CLI verbs.
- The always-loaded MCP server tool table grows from three
  writers to four (three writers + `brain_context` reader). The
  server's exposed name (`open-second-brain-writer` in
  `.mcp.json`) is unchanged; renaming is deferred until a second
  reader joins the always-load scope.

## [0.10.9] - 2026-05-20

Closes the "Vault Scope" feature: a single declarative exclusion
policy in `Brain/_brain.yaml` (`vault.ignore_paths`) replaces the
per-walker rules that used to drift between the search indexer and
`scan-inline`. Operators get one-shot visibility through the new
`o2b vault status` and `o2b vault inspect` verbs and an additive
`vault` block on the MCP `second_brain_status` payload. `o2b brain
doctor` warns when a path-style ignore entry points at nothing on
disk. Companion design and impl plan at
`docs/plans/2026-05-19-vault-scope-design.md` and
`docs/plans/2026-05-19-vault-scope-impl.md`.

### Removed

- `search_ignore_paths` key from the flat plugin config
  (`~/.config/open-second-brain/config.yaml`).
- `OPEN_SECOND_BRAIN_SEARCH_IGNORE` environment variable.

  Both surfaces are dropped without a deprecation cycle: the project
  has no live users to protect, and a shim that silently changes
  walker behaviour would be a footgun. Configure exclusions in
  `Brain/_brain.yaml` under `vault.ignore_paths`.

### Added

- `vault.ignore_paths` block in `Brain/_brain.yaml`. Single source
  of truth for every vault walker (search indexer, `scan-inline`,
  future scanners). Entries without `/` match a directory name at
  any depth; entries with `/` are vault-relative POSIX paths
  matched exactly. The block is optional - absent means "use the
  built-in defaults"; an explicit empty list means "exclude
  nothing".
- Default exclusion set widens `.obsidian/cache` to `.obsidian` (the
  full directory) and adds `Brain/.snapshots` explicitly. New
  vaults created by `o2b brain init` get the populated block in
  `_brain.yaml`; pre-v0.10.9 vaults inherit the same defaults at
  runtime without a file change.
- `o2b vault status [--vault <path>] [--json]` - walks the vault
  under the active policy and reports inclusion counts plus a
  per-rule list of excluded directories. Subtree descendants
  inside an excluded directory are not enumerated again.
- `o2b vault inspect <relpath> [--vault <path>] [--json]` -
  point-check whether one vault-relative path is included by the
  active policy, with the matched rule and source.
- MCP `second_brain_status` payload gains an additive `vault`
  block: `ignore_source`, the classified `rules` list, and
  aggregate `included` / `excluded` counts. Per-path detail stays
  in the CLI.
- `o2b brain doctor` lint `vault-ignore-missing-path` - warning
  emitted when a path-style entry under `vault.ignore_paths` does
  not exist on disk. Only fires when the operator declared the
  block themselves (the built-in default set may list paths that
  legitimately don't exist in a given vault).

### Changed

- `src/core/vault-scope` is the new home of the shared exclusion
  policy: `DEFAULT_VAULT_IGNORE_PATHS`, `VaultIgnoreRule`,
  `matchIgnore`, `resolveVaultScope`, `walkVaultScope`,
  `inspectPath`. The search indexer (`src/core/search/walker.ts`)
  and `scan-inline` (`src/core/brain/inline-scan.ts`) both delegate
  ignore decisions to `matchIgnore`; previously each maintained
  its own list of skip-paths.
- `ResolvedSearchConfig.ignorePaths: ReadonlyArray<string>` is
  replaced by `ignoreRules: ReadonlyArray<VaultIgnoreRule>`. The
  string-array field is removed entirely (no internal caller other
  than the walker read it).
- `scan-inline` `--exclude` flag stays as narrowing on top of the
  shared set. The hardcoded `Brain` directory skip is preserved -
  scan-inline must never recurse into the derived layer regardless
  of operator policy; `Brain` is appended to the effective rule
  set in code, not in `_brain.yaml`.
- `resolveVaultScope` fails closed when `Brain/_brain.yaml` exists
  but is malformed or unreadable. Missing config still falls back to
  built-in defaults for older vaults, but a broken declared policy no
  longer silently drops custom exclusions.

### Migration

No vault-data migration is required. Vaults whose `Brain/_brain.yaml`
does not include a `vault:` block continue to use the built-in
default set on this release. Vaults that previously set
`search_ignore_paths` (in the flat plugin config) or
`OPEN_SECOND_BRAIN_SEARCH_IGNORE` (env) should copy the entries
into `vault.ignore_paths`; both legacy surfaces have no effect on
v0.10.9 onwards.

## [0.10.8] - 2026-05-19

Closes §32 (retire `event_log_append` from every agent-facing surface
in favor of `Brain/log/` as the single source of truth) and §23 (write
a JSONL sidecar `Brain/log/<date>.jsonl` next to every markdown log
day, with discipline-report switched to read JSONL when present and
fall back to markdown when not). Companion design and impl plan at
`docs/plans/2026-05-19-v0.10.8-design.md` and
`docs/plans/2026-05-19-v0.10.8-impl.md`.

### Added

- §32B - `brain_note` MCP tool in the always-loaded writer-server
  scope. Records one narrative-milestone line under event kind
  `note` in `Brain/log/<today>.md` (plus the JSONL sidecar). Text
  is run through `sanitiseTextField` (newline-collapse, secret
  redaction, 4096-char cap). The agent identity is resolved through
  the standard `resolveAgentName` chain so cron-jobs and runtime
  shims share the same identity rules.
- §32B - new `BRAIN_LOG_EVENT_KIND.note` constant and matching
  `BrainNoteLogEvent` member in the discriminated union.
  Discipline-report's `AgentCounts` gains a `note` counter that
  surfaces in the Telegram MarkdownV2 block alongside `feedback`
  and `apply-evidence`.
- §23 - JSONL sidecar `Brain/log/<date>.jsonl` written atomically
  next to each markdown event by `appendLogEvent`, under a single
  `proper-lockfile` lock that protects the markdown-plus-JSONL pair
  from interleaved concurrent writers. Each row is
  `{ts, kind, payload}`; the payload is a one-to-one projection of
  the markdown bullet body, with array bullets encoded as JSON
  arrays.
- §23 - new module `src/core/brain/log-jsonl.ts` exporting
  `readLogDay(vault, date) -> {entries, source, warnings}`. JSONL
  is preferred when present; falls back to `parseLogDay` for the
  markdown-only case (historical pre-v0.10.8 days). Malformed
  JSONL rows surface as warnings, not errors.

### Changed

- §32C - the Stop guardrail (`hooks/lib/messages.ts:stopGuardrailReason`)
  and the PostToolUse reminder (`postWriteReminder`) point at the
  three Brain writer tools (`brain_feedback`, `brain_apply_evidence`,
  `brain_note`). `event_log_append` is no longer named anywhere on
  the agent-facing surface.
- §32C - `hooks/lib/detect.ts:BRAIN_EVENT_NAME_SUFFIX` and
  `BRAIN_EVENT_BASH_NEEDLES` cover only the three Brain writer
  tools. The `o2b append-event` / `vault-log` bash needles are
  removed; those CLIs still work for human use but no longer
  suppress the Stop guardrail.
- §32D - all three identity-reminder templates
  (`templates/identity-reminder.txt`, `.hermes.txt`, `.openclaw.txt`)
  rewritten to direct agents to `brain_feedback` /
  `brain_apply_evidence` / `brain_note` and to mention the
  `Brain/log/<today>.md` (+ JSONL sidecar) destination. The
  byte-pinned fixtures and the Python parity test are regenerated.
- §32E - `hooks/README.md` rewritten to describe v0.10.8 semantics:
  Brain/log/ as the single agent-facing log surface, Daily/ as the
  human-CLI surface, and the JSONL sidecar contract.
- §32F - `o2b append-event` CLI verb (`cmdAppendEvent` in
  `src/cli/main.ts`) resolves the agent through `resolveAgentName`
  instead of the literal `"agent"` fallback. Cron-jobs that already
  set `VAULT_AGENT_NAME` are unaffected; cron-jobs that previously
  relied on the literal `"agent"` get the config-declared identity
  instead of a corrupted `@agent` Daily entry.
- §32G - `event_log_append` MCP tool removed from every runtime:
  the OpenClaw `registerTool` block, the `toolEventLogAppend`
  handler in `src/mcp/tools.ts`, and the Hermes docstring mention.
  The bare `appendEvent` function in `src/core/event-log.ts` stays
  for the CLI verb (§32F) and any future shell-side use.
- §23 - discipline-report (`src/core/discipline/log-counts.ts`)
  reads through `readLogDay`. Same return shape; counts now include
  the new `note` kind.

### Migration

No vault data migration is required. Historical `Brain/log/<date>.md`
files without a sidecar JSONL are served by the reader's
markdown-fallback path; the next write on any date produces both
files. No installer changes; no schema bump in `_brain.yaml`.

The Stop guardrail no longer clears on a bash `vault-log` /
`o2b append-event` invocation - the operator or agent must use one
of the three brain-event tools or finish the turn silently. Cron-jobs
that use `o2b append-event` keep working; they just no longer count
as a "brain event" for the guardrail.

### Release-checklist gate

Before shipping v0.10.8 from the working branch:

1. `bun test` - all suites pass.
2. `o2b discipline report` on `/root/vault` - status `ok` or
   `info`; every `known_agent` with activity since v0.10.7 has at
   least one brain event recorded (the lightweight §32A gate; see
   the design doc for the rationale on dropping the calendar gate).
3. Smoke: a `brain_note` MCP call produces both
   `Brain/log/<today>.md` and `Brain/log/<today>.jsonl`, describing
   the same event (same `ts`, `kind`, payload keys).
4. Manual MCP probe: `event_log_append` is absent from
   `bun src/mcp/main.ts` (full), `--scope writer`, the OpenClaw
   bundle, and the Hermes tool list.

## [0.10.7] - 2026-05-18

Closes the remaining §30 (Agent logging discipline) work from
`Projects/OpenSecondBrain/Features/_summary.md`. Three independent
tracks ship together under one release.

### Added

- §30 §B - Writer MCP server split. A second `.mcp.json` entry
  `open-second-brain-writer` exposes `brain_feedback` and
  `brain_apply_evidence` with Claude Code's `alwaysLoad: true`
  flag so the agent never pays the ToolSearch round-trip before
  recording a taste signal or evidence event. The full MCP
  surface stays deferred under the existing `open-second-brain`
  entry. `o2b mcp` gains `--scope writer|full` (default `full`).
- §30 §D - Daily discipline cron. New `bin/o2b-discipline-report`
  - `o2b discipline {report|install|uninstall}` build a
    deterministic Telegram MarkdownV2 block comparing brain-event
    counts per agent (parsed from `Brain/log/<date>.md`) against
    runtime-agnostic activity proxies: git activity on watched
    repos, mtime walk on watched non-repo paths, vault delta on
    `Brain/inbox/`, `Brain/preferences/`, `Brain/retired/`. Status
    `ok | info | alert` is binary; numeric ratios were rejected in
    design as noise-prone. Hermes cron job installable with
    `o2b discipline install [--telegram-target] [--at]` (job id
    derived from sha256(vault_path) so multiple vaults on one host
    do not collide). No LLM in the report path.
- §30 §E - Claude Code MEMORY to Brain bridge. New verb
  `o2b brain import-claude-memory [--memory <path>]
[--dry-run | --apply] [--yes] [--json]
[--allow-arbitrary-memory-path]` reads `metadata.type: feedback`
  entries from a Claude Code memory directory and writes them as
  confirmed Brain preferences with a sidecar manifest
  `Brain/.imports/claude-memory.json` for idempotency.
  UPDATE preserves accumulated evidence (`_applied_count`,
  `_violated_count`, `_evidenced_by`, `_last_evidence_at`,
  `_confirmed_at`, `unconfirmed_until`, `pinned`, `scope`).
  CONFLICT surfaces (preference exists without a manifest entry)
  require manual resolution - never silent overwrites. Pre-apply
  snapshot via the v0.10.6 manifest infrastructure; rollback via
  `o2b brain rollback import-claude-memory-<ts>`.
- New module `src/core/discipline/` (`report.ts`, `log-counts.ts`,
  `window.ts`, `activity-git.ts`, `activity-mtime.ts`,
  `vault-delta.ts`, `decision.ts`, `render.ts`, `telegram.ts`).
- New CLI module `src/cli/discipline.ts` + `src/cli/discipline-install.ts`.
- New entry `bin/o2b-discipline-report` + `scripts/discipline-report.ts`.
- New `BrainConfig.discipline_report` optional section
  (`enabled`, `timezone`, `watched_paths`, `known_agents`).
- New §E modules under `src/core/brain/`:
  `claude-memory-parser.ts`, `claude-memory-manifest.ts`,
  `claude-memory-plan.ts`, `claude-memory-render.ts`,
  `claude-memory-paths.ts`, `import-claude-memory.ts`.
- `BRAIN_LOG_EVENT_KIND.importClaudeMemory = "import-claude-memory"`.

### Changed

- `src/mcp/tools.ts:buildToolTable` accepts an optional
  `scope: "full" | "writer"` parameter; default unchanged.
- `MCPServer` ctor accepts an optional second `runtimeOpts`
  argument with `{ serverName, scope }`; defaults reproduce the
  v0.10.6 behavior.
- `serveStdio` / `serveStdioFromString` now build `MCPServer`
  internally and forward `runtimeOpts`.
- `buildInstructions` accepts the same `scope` field; the writer
  branch returns a short, focused instructions block naming only
  the two writer tools.
- `parseBrainYaml` (in `src/core/brain/policy.ts`) now handles
  block-style nested lists (`key:` followed by indented `- item`)
  so the new `discipline_report.watched_paths` / `known_agents`
  arrays parse correctly.

### Migration

No vault data migration is required. Existing vaults run §D
with the feature disabled (default) until the operator adds the
`discipline_report` section to `Brain/_brain.yaml` and runs
`o2b discipline install`. §E is opt-in (operator runs the verb);
the sidecar manifest `Brain/.imports/claude-memory.json` is
created on first `--apply`. Pre-v0.10.7 installations with a
single MCP server entry continue to work; the second
`open-second-brain-writer` entry does not appear until the new
`.mcp.json` is reinstalled.

## [0.10.6] - 2026-05-18

Five tracks from `Projects/OpenSecondBrain/Features/_summary` shipped
under one release: §30 §A+§C (agent logging discipline), §22 + §5-tail
(`o2b brain upgrade` and manifest-backed rollback drift detection),
§14 polish (keyboard-accessible Brain Explorer listbox plus
`localStorage` layout / filter persistence), §28
(`o2b brain export`), and §31 CR cleanup from PR #20.

No vault data migration is required. Snapshots taken before v0.10.6
keep working — `rollback` emits a stderr warning and falls back to the
legacy direct-restore path. New snapshots (taken by `dream`, `merge`,
`migrate-frontmatter`, or `upgrade`) ship with a `<run-id>.manifest.json`
sidecar that powers drift detection.

### Added

- §22 — `o2b brain upgrade [--dry-run] [--apply] [--yes] [--check]
[--json]` migrates the three release-owned files
  (`Brain/_brain.yaml`, `Brain/_BRAIN.md`,
  `AI Wiki/_OPEN_SECOND_BRAIN.md`) forward when the installed
  open-second-brain version changes them. `_brain.yaml` merge is
  purely additive — missing schema keys and sections are appended,
  user values stay. `_BRAIN.md` and `_OPEN_SECOND_BRAIN.md` are
  byte-compared against the rendered template and overwritten on
  apply. `--apply` always takes a pre-apply snapshot named
  `upgrade-<ts>` (rollback via run id). The new
  `BRAIN_LOG_EVENT_KIND.upgrade` records the run.
- §5-tail — `createSnapshot` writes a SHA-256 manifest sidecar
  `<vault>/Brain/.snapshots/<run-id>.manifest.json` alongside every
  archive. `o2b brain rollback` reads it back and exits 2 with a
  drift diff when the live `Brain/` tree differs from the snapshot
  moment. The new `--force-rollback` overrides the abort and the
  rollback log entry then records `drift_overridden: true`.
  Snapshots without a sidecar (legacy) skip the check with a stderr
  warning. `pruneSnapshots` removes the sidecar alongside the
  archive; `listSnapshots` surfaces `manifest_path`.
- §28 — `o2b brain export --format json|llms-txt [--out <path>]
[--force]` produces a read-only dump of active preferences
  (`confirmed | unconfirmed | quarantine`) from
  `Brain/preferences/`. Retired and signal artifacts are not
  included. Default sink is stdout; `--out` writes a file
  (atomically), refusing to overwrite without `--force`. The
  llms-txt output follows the [llmstxt.org](https://llmstxt.org)
  H1 + summary + H2-section shape.
- §14 polish — Brain Explorer template (`templates/brain-explorer.html`)
  ships a keyboard-accessible `<ul role="listbox">` mirror of the
  visible nodes alongside the canvas. ArrowUp / ArrowDown / Home /
  End / Enter / Escape navigate; `aria-activedescendant` tracks
  focus; pointer click on canvas keeps both surfaces in sync via a
  single `selectNode(id)` unifier. Layout + filter state persists to
  `localStorage` under `osb-explorer-layout:<vault_basename>` so
  positions, status filters, and the search box survive reloads. A
  "Reset layout" button clears the key.
- New module `src/core/brain/manifest.ts` (`buildManifest`,
  `diffManifests`, sidecar I/O, drift renderers).
- New module `src/core/brain/upgrade.ts` (`planUpgrade`,
  `applyUpgrade`, text-level `mergeBrainYaml`).
- New module `src/core/brain/export.ts` (JSON + llms-txt
  serialisers).
- New module `src/core/brain/templates.ts` — `init.ts` no longer
  owns template paths or rendering primitives; both `init` (first
  install) and `upgrade` (subsequent migrations) consume the same
  `renderBrainManual` / `renderLegacyOverview` helpers so the two
  paths cannot drift.

### Changed

- §30 §A — `hooks/lib/detect.ts` broadens the brain-event detection
  regex from `event_log_append` to any of `event_log_append`,
  `brain_feedback`, `brain_apply_evidence` (both MCP names and CLI
  bash invocations). `hooks/stop-log-guardrail.ts` now clears on any
  of the three. `TurnSummary.hadLog` was renamed to
  `hadBrainEvent`; `isLogToolName` was renamed to
  `isBrainEventToolName`. The stop-guardrail reason text lists all
  three tools explicitly.
- §30 §C — `skills/brain-memory/SKILL.md` description and "When NOT
  to call" section reformulate the trigger: when a preference
  plausibly applies but you are unsure, record with `note:
"speculative; <reason>"` instead of skipping. The dream pass
  filters single-event speculative entries that do not recur, so
  coverage costs less than missing the signal.
  `hooks/lib/messages.ts:postWriteReminder` mirrors the new wording.
- `o2b brain rollback` gains `--force-rollback`, drift detection,
  and updated help text. The rollback log payload optionally
  records `drift_overridden`.
- `_BRAIN.md` template (`src/core/brain/templates/_BRAIN.md.tpl`)
  lists `o2b brain upgrade` and `o2b brain export` under the
  Escape-hatches CLI surface, and mentions the v0.10.6 sidecar
  manifest behaviour on rollback. This is the canonical v0.10.6
  template change — pre-v0.10.6 vaults see the diff under
  `o2b brain upgrade --dry-run`.

### Internal

- `SnapshotInfo` gains `manifest_path: string | null`.
- `BRAIN_LOG_EVENT_KIND.upgrade = "upgrade"`,
  `BrainUpgradeLogEvent` joins the `BrainLogEvent` union.
- `init.ts` slimmed down — template rendering primitives moved to
  the dedicated `templates.ts` module (DRY across init and
  upgrade).

### Tests

- `tests/core/brain/manifest.test.ts`
- `tests/core/brain/upgrade.test.ts`
- `tests/core/brain/export.test.ts`
- `tests/core/brain.snapshot.test.ts` (extended for sidecar +
  legacy prune)
- `tests/cli/brain-upgrade.test.ts`
- `tests/cli/brain-export.test.ts`
- `tests/cli/brain.test.ts` (extended with rollback drift +
  legacy-snapshot scenarios)
- `tests/hooks/detect.test.ts` (extended for `brain_feedback` /
  `brain_apply_evidence` MCP names and bash needles)
- `tests/core/brain/explorer.test.ts` (extended with listbox /
  localStorage smoke checks)
- `tests/scripts/macos-sqlite-shim.test.ts` (one new case for
  `DYLD_LIBRARY_PATH=""`)

### Docs

- MD040 language tags added to
  `docs/plans/2026-05-18-brain-maturity-design.md`,
  `docs/plans/2026-05-18-brain-maturity-impl.md`,
  `skills/embeddings-setup/SKILL.md`.
- `docs/plans/2026-05-18-v0.10.6-design.md` and
  `docs/plans/2026-05-18-v0.10.6-impl.md` document the release.

## [0.10.5] - 2026-05-18

Brings the v0.10.5 "Brain maturity + embeddings activation"
cluster from `Projects/OpenSecondBrain/Features/_summary` and the
Hermes onboarding report at
`Projects/OpenSecondBrain/Features/embedding-provider-activation`:
§14 local HTML/web explorer, §12 merge-suggestions plus the
explicit `o2b brain merge` CLI, §4 completion of the deferred D5
from v0.10.4 (per-runtime cadence in `hooks/lib/messages.ts`), the
deferred D4 "good vs bad" examples in the `brain-memory` SKILL,
and a §E embeddings-activation cluster (macOS sqlite shim,
actionable `o2b search check` hints, `--cron-template`,
`embeddings-setup` SKILL).

No vault migration is required. Existing vaults stay valid:
`merge` introduces one new retired reason (`merged-into`) and one
new log event kind (`merge`); both surface only when the operator
runs `o2b brain merge`.

### Added

- §14 — `o2b brain explorer` launches a loopback HTTP server (default
  port `7777`, `--port <n>` to override) that renders preferences and
  retired entries as a force-directed graph. `o2b brain explorer
--export <path>` writes the same view as a single offline HTML file
  with inlined data; `--force` overwrites an existing file. Live and
  export modes share one template at `templates/brain-explorer.html`.
  Zero backend, no LLM, no network. Markdown is parsed in the browser
  by a vendored ~150-line mini physics engine.
- §12 — `o2b brain digest` gains a `## Merge suggestions` section
  surfacing confirmed/quarantine pairs in the same `(topic, scope)`
  whose `principle` tokens reach jaccard ≥ `0.6`. Pairs ≥ doctor's
  own duplicate threshold continue to trip the
  `duplicate-preferences` doctor lint. `o2b brain merge <keep>
<drop>` is the explicit resolver: `keep` retains its frontmatter,
  picks up the deduped union of `evidenced_by`, the summed
  `applied_count` and `violated_count`, and `max(last_evidence_at)`;
  `drop` retires under reason `merged-into` with a `superseded_by`
  wikilink to `keep`. The CLI prompts interactively unless `--force`
  is passed; `--dry-run` reports the plan and writes nothing.
- §4 (completes deferred D5 from v0.10.4) — `hooks/lib/messages.ts`
  emits a per-runtime cadence line above the
  `brain_feedback`/`brain_apply_evidence` block. Claude Code gets a
  "many turns ahead, capture now" hint; Codex gets a "one-shot exec,
  call before return" hint. Unknown runtime renders byte-identical
  to the v0.10.4 baseline. Detection lives in
  `hooks/lib/detect.ts:detectHookRuntime`, driven by hook-payload
  shape (`transcript_path` substring or Claude's
  `session_id`/`cwd`/`tool_use_id` triple). `stopGuardrailReason`
  follows the same pattern.
- §15 (completes deferred D4 from v0.10.4) — `skills/brain-memory/
SKILL.md` gains an `## Examples — good vs bad` section: four
  contrastive pairs covering weak vs strong `principle`,
  too-general vs precise `topic`, and `note` with versus without
  the "why" line.
- §E.1 — `scripts/_macos-sqlite.sh` shim, sourced from
  `scripts/o2b` after the Bun precheck. Detects Darwin + Homebrew
  SQLite and exports `DYLD_LIBRARY_PATH` so `bun:sqlite` picks up
  a build with `LOAD_EXTENSION` enabled. No-op on Linux and on
  macOS without `brew install sqlite`. Resolves the v0.10.4
  blocker where `sqlite-vec` failed to load against Apple's
  system SQLite (built with `SQLITE_OMIT_LOAD_EXTENSION`).
- §E.2 — `o2b search check` gains a `recommendations` field on
  both the human and JSON outputs. Rules surface concrete next
  commands when `embedding_key` is missing, when `vec_extension`
  fails to load (with a macOS-specific `brew install sqlite`
  hint), and when the install is wired but no embeddings have
  been computed yet.
- §E.3 — `o2b search reindex --cron-template [--interval <N>m|h|d]`
  prints a watchdog script, a native crontab line, and a
  `hermes cron create` invocation. Pure stdout — writes nothing.
  Default interval is 30 minutes; `--interval` accepts under
  60m / 24h / unlimited days.
- §E.4 — `skills/embeddings-setup/SKILL.md` describes the
  proactive activation flow: when to engage, decision tree based
  on `o2b search check` output, env-var setup, macOS Homebrew
  branch, first reindex, and the optional cron template.

### Changed

- `tokenise` and `jaccard` lifted from `src/core/brain/doctor.ts`
  into `src/core/brain/similarity.ts`. No behavioural change. The
  doctor lint `duplicate-preferences` and the new merge-candidate
  detector now share one implementation.
- `tests/helpers/run-cli.ts` accepts an optional `stdin` string so
  interactive CLI prompts (`o2b brain merge`) can be exercised
  end-to-end.

### Internal

- New constant `BRAIN_RETIRED_REASON.mergedInto = "merged-into"`.
- New log event kind `BRAIN_LOG_EVENT_KIND.merge = "merge"`.
- New typed error `BrainMergeError` with discriminated `code`
  values for each invariant guard.
- New typed error `CronTemplateError` for the `--cron-template`
  interval parser.
- `IndexCheckReport` gains an optional `recommendations` array
  (additive, JSON consumers reading by key are unaffected).

## [0.10.4] - 2026-05-17

Brings the v0.10.4 "Brain onboarding quality" cluster from
`Projects/OpenSecondBrain/Features/_summary`: §18 machine-enforced
write protection for `Brain/`, §4 partial (per-runtime identity
reminder templates for the two runtimes that actually call
`buildReminder` per-turn / per-action), and §15 partial (bundled
starter set behind `o2b brain init --starter`).

No vault migration is required. Existing vaults are unaffected
until the operator opts in by running `o2b brain protect`,
appending `--starter` to a fresh `o2b brain init`, or setting
`O2B_TARGET=hermes` or `O2B_TARGET=openclaw` in the MCP server's
env block. The common identity reminder template is unchanged.

### Added

- §18 — `o2b brain protect --target {claudecode|codex}` writes a
  managed, idempotent block into the runtime's native permissions
  config that denies writes to `Brain/preferences/`, `retired/`,
  `log/`, `.snapshots/`, and `_brain.yaml` while leaving
  `Brain/inbox/` writable. `--print` (default) emits the snippet
  to stdout; `--apply` writes the file and saves a `.bak.<ts>`
  beside it. Pair `o2b brain unprotect` removes only the OSB-owned
  entries (tracked via the sidecar manifest
  `<vault>/.open-second-brain/protect.lock.json`).
- §4 (partial) — per-runtime identity reminder templates at
  `templates/identity-reminder.{hermes,openclaw}.txt`. The resolver
  in `buildReminder` accepts an explicit `target`, falls back to
  `O2B_TARGET`, and finally to the common template. Hermes Python
  shim has byte-level parity with the TypeScript resolver through
  a shared fixture. The common `identity-reminder.txt` is
  unchanged. Claude Code and Codex steer through
  `hooks/lib/messages.ts`, which is a different mechanism not
  addressed here — tracked under design doc D5.
- §15 (partial) — `o2b brain init --starter` drops a bundled
  example set (8 preferences, 3 retired, 1 inbox signal, 6 log
  days) into a fresh Brain. The bundle is regenerated through the
  canonical writers (`writePreference`, `appendApplyEvidence`,
  `moveToRetired`, `dream`) so its shape never drifts from real
  vault output. Doctor-clean and a no-op under
  `o2b brain dream`. Refuses to run on a non-empty Brain.

### Deferred

Full multi-runtime `o2b install` orchestrator (§4 second half),
interactive `o2b init --interactive` wizard (§15 second half),
per-runtime steering text for Claude Code / Codex in
`hooks/lib/messages.ts`, and the `brain-memory` SKILL "good-vs-bad"
examples section. Triggers to revisit are recorded in the vault
summary's "Deferred work" section
(`Projects/OpenSecondBrain/Features/_summary.md`).

## [0.10.3] - 2026-05-17

Brings four Tier-A items from
`Projects/OpenSecondBrain/Features/_summary`: §5 snapshot diff and
rollback dry-run (without the deferred sha256-manifest drift abort),
§10 numeric confidence with derived band, §21 cross-project pointer
plus a `primary_agent` declaration, and §27 titled wikilinks for
preferences and retired rules across every Brain writer.

No vault migration is required. Existing preferences and retired
files parse unchanged; the writer emits the new `_confidence_value`
field on the first dream refresh that touches each file, and the
`Brain/_brain.yaml.primary_agent` key defaults to `null` so vaults
without an explicit declaration keep their current behaviour.

### Added

- **`o2b brain snapshot diff <run_id_a> [<run_id_b>]`** — read-only
  artifact diff between two snapshots or between a snapshot and the
  live `Brain/` tree. Output groups changes by artifact kind
  (preference / retired / signal / log / config / other); `--json`
  emits the structured `BrainTreeDiff` payload for scripting.
- **`o2b brain rollback <run_id> --dry-run`** — previews the
  would-be restore plan as a live → snapshot diff via the same
  renderer. Mutually exclusive with `--yes` so preview and execute
  never collide. Leaves the live tree untouched.
- **`extractSnapshotToTemp(vault, runId)`** — shared snapshot
  extraction primitive used by `restoreSnapshot`,
  `rollback --dry-run`, and `snapshot diff`. The tar / zstd / gzip
  decompression logic lives in one place.
- **`src/core/brain/snapshot-diff.ts`** — pure `diffBrainTrees`
  walker plus `BrainTreeEntry` / `BrainFieldChange` / `BrainTreeChange`
  / `BrainTreeDiff` types. No I/O beyond `readFileSync` /
  `readdirSync`; classifier maps every Brain file into one of six
  artifact kinds.
- **`src/core/brain/snapshot-diff-render.ts`** — pure renderers
  (`renderDiffMarkdown`, `renderDiffJson`) split out so the differ
  stays format-neutral.
- **`_confidence_value` field** on every preference and retired
  file. Wilson 95% lower bound on `applied / (applied + violated)`
  modulated by linear freshness decay over
  `retire.stale_evidence_days`. Stored alongside the existing
  `_confidence` band, which becomes a derived view (band is the
  max of the legacy step-function and a numeric-threshold view,
  so it can only lift, never demote).
- **`_brain.yaml.confidence.medium_min` (default 0.40) and
  `high_min` (default 0.75)** — derived-band thresholds on the
  numeric value. Validated to lie in `[0, 1]` with `medium_min <
high_min`.
- **`Brain/_brain.yaml.primary_agent`** declarative field. When set,
  dream runs invoked from a different agent emit a stderr warning,
  a `warnings` array entry on the MCP `brain_dream` response, and a
  `non_primary_agent: <caller>` row in the dream summary log.
- **`o2b brain set-primary <name>` / `o2b brain set-primary --clear`** —
  idempotent edit of the primary declaration without rewriting the
  rest of `_brain.yaml`.
- **`o2b brain init --primary-agent <name>`** — sets the value
  during the fresh bootstrap; on re-runs the flag is a no-op (use
  `set-primary` instead).
- **`src/core/brain/set-primary.ts`** — `setPrimaryAgent(vault,
name | null): SetPrimaryAgentResult`. Validates the rewritten
  YAML before persisting; surfaces a typed `BrainConfigError` when
  the on-disk file is malformed.
- **`renderPrefLink({ id, principle })`** in `src/core/brain/wikilink.ts`
  with `MAX_PREF_LINK_TITLE_LEN = 80`. Sanitises wikilink-breaking
  characters and truncates titles at a word boundary with an
  ellipsis. Empty titles fall back to bare `[[id]]`.
- **`docs/cross-project-pointer.md`** — agent-facing setup guide
  for projects whose coding work happens outside the vault root.
  Covers the canonical `CLAUDE.md` / `AGENTS.md` snippet, the
  `primary_agent` workflow, and the Syncthing multi-device case.
- **CLI tests:** `tests/cli/brain.snapshot-diff.test.ts`,
  `tests/cli/brain.test.ts` (new `set-primary` and
  `--primary-agent` sections).
- **Core tests:** `tests/core/brain.snapshot-diff.test.ts`
  (differ + renderer), `tests/core/brain.confidence-value.test.ts`
  (Wilson + freshness + hard floors + max-lift band derivation),
  `tests/core/brain.set-primary.test.ts`,
  `tests/core/brain.dream.non-primary.test.ts`.

### Changed

- **`computeConfidence`** returns `{ value, band }`. The band is the
  max of the legacy step-function (preserved verbatim) and a
  numeric-threshold view. Dream's refresh phase writes both
  `_confidence` and `_confidence_value` on every touched
  preference; legacy files migrate lazily on the next refresh.
- **`dream` summary log** carries a `confidence_shifts: [...]`
  payload whenever a band drop is detected during refresh — the
  digest's `## Confidence shifts` section picks them up through
  the existing tolerant parser. `non_primary_agent: <name>` payload
  row appears whenever the primary check triggers.
- **`brain_query` MCP response** carries `confidence_value` next to
  `confidence` on every preference and retired result row.
- **`brain_dream` MCP response** carries a `warnings: [{code,
message}]` array. CLI `o2b brain dream` writes the same warnings
  to `stderr`.
- **`brain_dream` MCP schema** accepts an optional `agent` argument
  for the primary-agent check.
- **`active.md`** appends `(0.NN)` after the band on confirmed
  bullets and `conf: 0.NN` to the Quarantine block when the file
  carries a numeric value.
- **Every Brain writer** that emits a preference or retired wikilink
  now uses `renderPrefLink`. Affected surfaces: dream log payloads
  (promote, retire, retain-pinned, noted-redundant,
  signal-suppressed, summary), apply-evidence log entry, pin / unpin
  log entries, digest sections (new-unconfirmed, confirmed,
  retired, top-applied, top-referenced, confidence-shifts,
  contradictions), reject log entry, force-confirmed log entry,
  retired body's `superseded_by` reference. Signals and external
  artifacts stay bare-id because they have no useful title source.
- **`BrainConfig`** widens with `primary_agent: string | null`.
  `BrainConfidenceConfig` gains `medium_min` and `high_min`.
  `BrainPreference` and `BrainRetired` gain
  `confidence_value: number | null` (`null` only on pre-v0.10.3
  files that have not been refreshed yet).
- **`Brain/log/<today>.md`** dream events optionally carry a
  `confidence_shifts` array and a `non_primary_agent` scalar — both
  forward-compat and surfaced through the digest renderer.
- **`DigestJson*` shapes** gain `principle: string` on every entry
  rendered with a wikilink, so the markdown renderer can build
  titled links without re-parsing the artifact files.
- **`scanBrain` retired record** carries `principle` so the dream
  log payloads can render titled wikilinks for the retired side
  without re-reading the file.
- **README** lists the new CLI verbs (`set-primary`, `snapshot diff`)
  and the `--dry-run` flag on `rollback`; documents the
  Cross-project setup subsection.
- **install.md branch A (Hermes)** recommends
  `--primary-agent <agent-name>` during the `o2b brain init` step,
  with guidance on the `set-primary` follow-up.
- **`docs/how-it-works.md`** documents the numeric `confidence_value`,
  the read-only snapshot inspectors, and the primary-agent
  observability contract.

### Notes

- Snapshot diff and `rollback --dry-run` are CLI-only. The MCP
  surface deliberately stays read-and-shape-only (`brain_query` +
  the new `warnings` array); operator-only mutations stay outside
  the agent loop, matching how `rollback`, `reject`, and
  `migrate-frontmatter` are handled today.
- The deferred §5 sub-features (sha256-manifest drift abort and
  post-dream integrity drill hook) remain out of scope — see
  `Projects/OpenSecondBrain/Features/_summary` for the rationale.

## [0.10.2] - 2026-05-16

Adds three Tier-A capture and hygiene items from
`Projects/OpenSecondBrain/Features/_summary`: §9 inline `@osb`
markers, §16 session-import, and §24 `_field` prefix convention
for derived frontmatter keys. The Brain layer now has three
capture surfaces (live, inline, session-import) and a derived /
identity split in the preference / retired schema.

No vault migration is required — the new schema parser accepts
both legacy (`status:`) and `_`-prefixed (`_status:`) shapes for
the entire v0.10.x line. The writer always emits the new shape;
existing files migrate lazily on the next dream rewrite, or
eagerly via `o2b brain migrate-frontmatter --apply --yes`.

### Added

- **`o2b brain scan-inline`** — capture `@osb` markers from any
  vault markdown file. Two shapes are recognised: a single line
  (`@osb feedback negative topic=... principle="..."`) and a
  fenced ` `osb ```block with YAML body. Markers create a
signal in`Brain/inbox/`via the same writer as`brain_feedback`,
with `source_type: inline`, the source-file wikilink in `source`,
and a `dedup_hash`over the normalised payload. After capture
the source line is annotated`@osb✓ [[sig-...]]`(inline form)
or the info-string flips to`osb-checked`with a`<!-- @osb✓
                              [[sig-...]] -->`comment line (block form), making re-runs
idempotent. Default ignore set covers`Brain/`, `.git`,
`node_modules`, `.obsidian`, `.trash`, `.stversions`,
`.open-second-brain`; additional excludes via `--exclude`,
scope narrowing via `--path`, dry-run via `--dry-run`.
- **`o2b brain import-session <path>`** — extract signals from a
  Claude Code / Codex CLI / Hermes session JSONL (or a directory
  of session files). Two extraction paths run in parallel:
  `@osb` markers in user / assistant message text (same parser
  as `scan-inline`), and replay of `brain_feedback` tool_use
  calls captured in the transcript. Each emitted signal carries
  `source_type: session` and a `session_ref: <path>#<turn-id>`
  for traceability. Autodetect runs on the first line; if it
  fails, exit 2 with a request to pass `--format`. The shared
  `dedup_hash` cross-deduplicates against signals already in the
  inbox (including those captured by `scan-inline`).
- **`o2b brain migrate-frontmatter`** — opt-in helper that walks
  `Brain/preferences/` and `Brain/retired/` and rewrites legacy
  Group C frontmatter keys (`status`, `applied_count`,
  `confirmed_at`, `last_evidence_at`, `violated_count`,
  `confidence`, `evidenced_by`, `contradicted_by`) to the
  `_`-prefixed form. Default is `--dry-run`; `--apply --yes`
  takes a pre-run snapshot under `Brain/.snapshots/migrate-...`,
  so rollback by run-id is the standard recovery path. Files
  carrying both shapes for the same field abort the migration
  with an actionable error.
- **`BrainSignal`** gains three optional frontmatter fields:
  `source_type` (`live` / `inline` / `session`; absent on
  legacy signals), `dedup_hash`, and `session_ref`. Non-live
  signals also get a `brain/source/<type>` tag for Obsidian
  filtering. Absence of `source_type` is interpreted as
  `live`; the parser never injects a default into the parsed
  object.
- **`src/core/brain/dedup-hash.ts`** — pure `computeDedupHash`
  shared between `scan-inline` and `import-session`. NFC
  normalisation + whitespace collapse on `principle`; `scope`
  defaults to empty string; SHA-256 over NUL-separated parts.
- **`src/core/brain/inline.ts`** — `discoverMarkers`,
  `parseInlineMarker`, `parseBlockMarker`. Single source of
  truth for `@osb` grammar.
- **`src/core/brain/sessions/`** — adapter registry plus three
  concrete adapters (`claude.ts`, `codex.ts`, `hermes.ts`) and
  the orchestrator (`import.ts`). Adding a fourth runtime is a
  new adapter file plus a registry entry, no other change.
- **`src/core/brain/sessions/validate-feedback.ts`** — extracted
  pure validator for the `brain_feedback` tool-use payload.
  Re-used by the MCP layer (`toolBrainFeedback`) and the
  session importer, so the contract cannot drift between
  surfaces.
- **Doctor `frontmatter-double-shape` warning** — surfaces a
  preference or retired file that carries both legacy and
  `_`-prefixed forms of the same Group C field (manual-edit
  corruption indicator).
- **Three new log-event kinds:** `scan-inline`, `import-session`,
  `migrate-frontmatter`. Each `o2b brain *` invocation appends
  one row to `Brain/log/<today>.md` (skipped on `--dry-run`).
- Test fixtures: `tests/fixtures/sessions/{claude,codex,hermes}-minimal.jsonl`.
  Anonymised five-line transcripts that lock the adapter
  detection + iteration contract.
- E2E scenario `tests/e2e/brain-capture-and-fields.test.ts`
  exercises the full chain: init → scan-inline → import-session
  → migrate-frontmatter → rollback.

### Changed

- **`parsePreference` / `parseRetired`** accept both the legacy
  (`status:`) and the new (`_status:`) shape for every Group C
  field. Files carrying both shapes for the same field raise a
  hard parse error (`frontmatter-double-shape` for doctor).
  Identity fields (`kind`, `id`, `created_at`,
  `unconfirmed_until`, `topic`, `principle`, `scope`, `tags`,
  `aliases`, `supersedes`, `pinned`) are not affected.
- **`writePreference`** emits Group C keys with the `_` prefix
  (`_status`, `_applied_count`, …). `moveToRetired` keeps
  `status: retired` un-prefixed on retired files (identity, not
  derived) and drops legacy keys from the inherited frontmatter
  before stamping retire metadata.
- **`writeSignal`** accepts the new optional fields and adds the
  `brain/source/<type>` tag when `source_type` is non-default.
  `parseSignal` round-trips them.
- **Backlinks collector** (`src/core/brain/backlinks.ts`) reads
  `evidenced_by` through the shared `normalizeDerivedKeys`
  helper so the index continues to resolve regardless of
  frontmatter shape.
- **`brain_doctor`** picks up the new `frontmatter-double-shape`
  warning. No existing lint codes change.
- **README** documents the three capture surfaces and lists the
  three new CLI verbs.
- **`skills/brain-memory/SKILL.md`** notes inline markers as the
  no-agent fallback path and points to `import-session` for
  back-filling sessions.

### Notes

- Hard removal of the legacy frontmatter shape is planned for
  a future minor release. The cutover is dependency-driven, not
  calendar-driven.
- `_brain.yaml: scan_inline.exclude:` is not yet honoured (the
  existing minimal YAML parser does not support inline arrays).
  Additional excludes go through the `--exclude` CLI flag in this
  release; YAML-config support is a follow-up.
- Three operator-only commands (`scan-inline`,
  `import-session`, `migrate-frontmatter`) are intentionally
  CLI-only — they don't appear in the MCP surface, consistent
  with how `init`, `reject`, `pin`, `unpin`, and `rollback` are
  kept off the agent loop.

## [0.10.1] - 2026-05-16

Closes the "preference body is dead weight" gap. Every active and
quarantined preference file now mirrors its log activity instead of
shipping a fixed placeholder body; signal files stop emitting the
`_(not provided)_` placeholder when no verbatim quote was passed; and
`o2b brain reject` requires a `--reason` so the next dream pass can
suppress new signals on the same topic. Tier-A item §6 of
`Projects/OpenSecondBrain/Features/_summary` (`reject --reason` +
signal suppression) is implemented in this patch.

No vault migration is required — the first post-upgrade dream pass
detects v0.9.x placeholder bodies and rewrites them to the new shape
in place.

### Added

- **`## Recent applications` / `## Recent violations`** sections on
  every preference and retired file. Dream collects the last 5
  applied + last 3 violated rows from `Brain/log/` on every pass and
  writes them as bulleted `[[artifact:lines]] — timestamp (agent)
[result] — note` entries. The data was already on disk in the
  daily log; v0.10.1 joins it back to the rule.
- **`src/core/brain/evidence.ts`** — read-only log scanner used by
  dream and `moveToRetired`. Returns newest-first slices for a given
  pref slug; sorts by timestamp; stops at `pref.created_at` so older
  log days are never opened in vain.
- **`o2b brain reject --reason "<text>"`** — `--reason` is now
  mandatory. The text is persisted on the retired file as
  `user_rejected_reason` and rendered in the `## Retired` body. CLI
  exits 1 when `--reason` is missing.
- **`signal-suppressed` log event + `signalSuppressed` event kind.**
  When a fresh signal lands on a topic that has a retired pref with
  `user_rejected_reason` set, dream drops the signal from the
  candidate-pref planner, moves it to `processed/`, and emits one
  audit row per signal linking back to the retired pref + the
  original user reason.
- **`wouldRewritePreference(vault, input)`** exported predicate —
  twin of `writePreference`'s content-equality short-circuit. Lets
  the dream pass decide whether a refresh entry is needed without
  doing the write twice.
- **`BrainEvidenceSummary`** type and `BrainSignalSuppressedLogEvent`
  variant added to the discriminated union of log events.
- Test file `tests/core/brain.body-hygiene.test.ts` — coverage for
  Raw-section omission, preference-body shape, retired re-render,
  signal suppression, and the v0.9.x → v0.10.1 body migration.

### Changed

- **`renderPreferenceBody`** drops the redundant `## Principle`
  duplicate and the `_(no evidence yet)_` / `_(not provided)_`
  placeholder lines. Sections are emitted only when they have real
  content; a brand-new pref with no log evidence yet has an empty
  body, which is the honest representation.
- **`renderSignalBody`** omits the `## Raw` section entirely when
  no verbatim quote was passed instead of shipping the
  `_(not provided)_` placeholder. Parsers stay tolerant of both
  shapes (old placeholder, new absent section).
- **`writePreference`** is now content-aware: when overwriting, it
  reads the existing file, compares to the would-be rendered bytes,
  and skips the rename if they match. Preserves the dream
  "no rewrite on a no-op rerun" invariant even though dream now
  recomputes the body on every pass.
- **`moveToRetired`** re-renders the body from scratch (current
  frontmatter + freshly collected log evidence) before appending
  the `## Retired` block. The source file's body shape no longer
  bleeds into the retired snapshot — a v0.9.x preference being
  retired produces a v0.10.1 retired file.
- **`dream`** plumbs the evidence slice through to every
  `writePreference` and `moveToRetired` call. A pref whose
  counters did not change is still considered for refresh if its
  on-disk body differs from the rendered output (this is what
  carries the v0.9.x body migration forward without a separate
  migrate command).
- **`brain-memory` skill** explicitly recommends passing `raw` with
  the verbatim user quote and documents the `--reason` requirement
  on `o2b brain reject`, with the warning that re-recording signals
  on a user-rejected topic will be suppressed by the next dream.

### Notes

- The schema version on `Brain/_brain.yaml` stays unchanged. All
  changes are additive at the data layer (`user_rejected_reason` is
  an optional frontmatter field; `BrainEvidenceSummary` is a derived
  render-time view, never persisted as its own file).
- The §6 implementation in this release covers suppression only.
  The follow-up "after 5 rejects of the same topic, auto-block" mode
  from the \_summary doc is deliberately out of scope — suppression
  - the explicit `--reason` audit trail is enough to break the
    reject → re-grow loop the user observed.

## [0.10.0] - 2026-05-16

Full-text search over the vault as a deterministic, filesystem-first
layer. Index lives at `<vault>/.open-second-brain/brain.sqlite`
(SQLite + FTS5, schema versioned). Optional semantic layer via
`sqlite-vec` plus any OpenAI-compatible `/v1/embeddings` provider
(OpenRouter, OpenAI, Together, Google's OpenAI-compat endpoint,
local Ollama, Hermes proxy). Closes design plan
`docs/plans/2026-05-16-brain-search-design.md`.

### Added

- **Core module `src/core/search/`** with isolated walker, chunker,
  store (the only SQL boundary), FTS query, links, ranker, indexer,
  search, and embedding providers (`null-provider`, `openai-compat`).
  Public surface: `resolveSearchConfig`, `indexVault`, `reindexVault`,
  `indexStatus`, `indexCheck`, `search`, plus typed `SearchError`
  codes.
- **CLI** namespace `o2b search` with verbs `query` (default),
  `index`, `reindex`, `status`, `check`. Human and `--json` output;
  `--auto-refresh` for read-time incremental indexing.
- **MCP tool** `brain_search` (read-only, agent-facing). Diagnostic
  score components (`keywordScore`, `semanticScore`, `linkBoost`,
  `recencyBoost`) are intentionally absent from the MCP shape; they
  live in CLI `--verbose` only. Content per chunk is truncated to
  600 characters. Index-management verbs are NOT exposed over MCP
  (operator business, never agent business — design §3 principle 5).
- **`second_brain_status`** gains a `search.*` block: index path,
  schema version, document/chunk/embedding counts, embedding model
  and dimension, sqlite-vec status, key presence (redacted),
  `last_indexed_at`, `last_full_index_at`. Reports
  `{ exists: false, hint }` when the index has not been built yet.
- **Ranking** combines min-max-normalised BM25, cosine similarity
  on unit-normalised vectors, in-result wikilink boost (capped at
  0.03), shared-tag boost (capped at 0.02), and recency steps
  (≤7d → 0.05, ≤30d → 0.025, ≤90d → 0.01). Tie-break on equal
  final score: keyword desc, mtime desc, chunk id asc.
- **Atomic reindex** via `brain.sqlite.new` + same-directory rename
  swap with `brain.sqlite.bak` retention. Auto-restore from `.bak`
  on open if the main file is missing.
- **Embedding-model fingerprint** stored in `index_state`. Changing
  `embedding_model` or `embedding_dimension` drops `embeddings`,
  `chunk_vec`, and `chunk_vec_map` on next open, logs one line, and
  preserves `chunks` + `chunk_fts`. The next
  `o2b search index --embeddings` repopulates vectors.
- **Concurrency guard** via `proper-lockfile` on the index path:
  three attempts, 1s backoff, then `INDEX_LOCKED`. Readers do not
  take the lock; WAL handles concurrent reads safely.
- **Semantic-unavailable policy** (design §7): implicit semantic
  (config default) warns and falls back to keyword-only; explicit
  `--semantic` / `semantic: true` throws a typed `SearchError` so
  the failure cannot hide. Data-state cases (no embeddings yet)
  warn and skip even when explicit — running
  `o2b search index --embeddings` is the right answer there, not a
  panic.

### Changed

- **`sqlite-vec`** added to `optionalDependencies`. The runtime
  detects whether the loadable extension is present on disk and
  records availability in `index_state.vec_extension_available`;
  no failure if the platform package is missing.

### Notes

- v0.10.0 ships schema version 1 only. Future migrations follow the
  same `MIGRATIONS[]` pattern in `src/core/search/schema.ts`.
- `o2b index` (the Markdown index generator at `AI Wiki/index.md`)
  is unchanged. The new system is `o2b search index`.

## [0.9.1] - 2026-05-15

Active-preferences digest, MCP Resources, and a visibility expansion
across status, digest, and backlinks. Closes `BRAIN-FUT-006`
(active-preference injection per turn) and ships the read-only
"visibility family" from the project's feature summary (§3 status,
§8 backlinks, §13 hot preferences). Adds a `quarantine` preference
status that catches rules whose recent evidence has turned dominantly
negative without yet crossing the rebuttal threshold.

### Added

- **`Brain/active.md`** — an auto-generated digest of every confirmed
  preference, every quarantined preference (with applied/violated
  counters), and the three most recently retired entries. Pure
  derivation, no LLM. Regenerated at the tail of every `dream` run
  and after `o2b brain pin`/`unpin`. The writer is idempotent: when
  the rendered body matches the existing file, no I/O happens.
- **SessionStart hook** (`hooks/active-inject.ts`) with matcher
  `startup|resume|clear`. Reads `Brain/active.md` and emits it as
  `additionalContext` so the agent sees current rules at the start
  of every session. Fails closed: any error path exits 0 with no
  output so the runtime proceeds unaffected.
- **PostCompact hook** with matcher `manual|auto`. Re-injects the
  same `Brain/active.md` body after `/compact` (manual or
  background), so the agent does not lose its preferences view
  partway through long sessions. Same script as SessionStart — the
  hook event name is taken from the payload so one script covers
  both surfaces.
- **MCP Resources** capability on the MCP server. Two concrete URIs:
  - `osb://preferences/active` — body of `Brain/active.md`. Auto-
    generated on first read if the file does not exist yet (fresh
    vault with prefs but no dream).
  - `osb://digest/latest` — `renderDigest({format: "markdown"})`
    output, same as the `brain_digest` tool's default window.

  Three URI templates:
  - `osb://preference/{id}` — body of `pref-{id}.md`, with fallback
    to `ret-{id}.md` when the active copy is gone. Accepts the bare
    slug or the prefixed id.
  - `osb://topic/{slug}` — synthesised markdown of every signal,
    the current preference (or retired), and the most recent log
    entries for the topic.
  - `osb://log/{date}` — body of `Brain/log/<date>.md`.

  The MCP initialize response advertises
  `capabilities.resources = { listChanged: false, subscribe: false }`.

- **`quarantine` preference status** (closes design summary §20).
  Entry: a `confirmed` preference whose recomputed counters satisfy
  `violated_count ≥ applied_count AND applied_count >
confidence.low_max_applied` transitions to `quarantine`. The rule
  is still listed in `Brain/active.md` (under its own section), but
  the digest surfaces it separately. Exit: a new `violated`
  evidence event since the last `dream` snapshot retires the rule
  with `retired_reason: quarantine-violated`; or a fresh
  `applied_count > violated_count` returns it to `confirmed`. Pinned
  quarantine preferences emit `retain-pinned` instead of retiring,
  consistent with other automatic retires.
- New `BRAIN_RETIRED_REASON.quarantineViolated = "quarantine-violated"`
  enum value distinct from `rebutted` (which counts opposite-sign
  signals, not evidence events).
- **Backlink index** (`src/core/brain/backlinks.ts`). A single read
  pass over `preferences/`, `retired/`, `inbox/`, `inbox/processed/`,
  and `log/` produces an inverted reference map: target id → list of
  sources that wikilink to it, with `field` and (for log entries) the
  event timestamp. Self-references and duplicate (source, target)
  pairs are deduplicated. Powers digest §13 and the `brain_backlinks`
  surfaces.
- **`brain_backlinks` MCP tool** + `o2b brain backlinks <id>` CLI verb.
  Returns the count plus a list of `{source, source_kind, field,
timestamp?}` records for any Brain artifact id (preference,
  retired, or signal).
- **`osb://backlinks/{id}` MCP resource template** — markdown render
  of inbound references grouped by source kind. Same data as the
  tool; the resource surface is for MCP hosts that prefer pull-style
  access.
- **Hot sections in `brain_digest`** (closes §13). Two new sections
  in both Markdown and JSON outputs:
  - **Top applied** — top-5 confirmed/quarantine preferences by
    `applied_count` desc (zero-applied excluded). JSON field:
    `top_applied`.
  - **Top referenced** — top-5 preferences by inbound backlink
    count (using the index above). JSON field: `top_referenced`.

  The sections render only on non-empty windows so `--silent-if-empty`
  exit semantics are preserved; JSON always emits the arrays so
  programmatic consumers can read them regardless of window state.

- **`broken-backlinks` lint** in `brain_doctor`. Walks the backlink
  index and reports any source that still references a `pref-*`,
  `ret-*`, or `sig-*` target whose file no longer exists. Warning
  severity (not error), since the underlying state isn't corrupted
  — the source artifact's pointer just went stale.
- **`brain` section in `second_brain_status`**. The existing MCP
  tool now includes a `brain: { present, counts, last_dream_at,
last_apply_evidence_at, sanity }` field. Counts cover
  inbox/preferences (split by status)/retired/log_days/snapshots.
  `sanity.signals_awaiting_dream` is non-zero when inbox signals
  predate the `unconfirmed_window_days` cutoff — a one-glance "you
  need to run `dream`" signal.
- **`osb://status` concrete MCP resource** — the same snapshot
  rendered as markdown for direct pull by MCP hosts.

### Changed

- `regenerateActive(vault)` is now called at the tail of every
  `dream` invocation (both `changed: false` and `changed: true`
  paths), gated on `dryRun: false`. Failure is logged to stderr and
  swallowed — the rest of `dream`'s work is independent.
- `setPinned` calls `regenerateActive` after a successful flip so
  the `pinned` flag visible in the digest matches the new state
  immediately. Same swallow-and-warn fallback as in `dream`.
- `renderDigest` JSON shape gains `top_applied` and `top_referenced`
  arrays. `schema_version` stays at `1` — both fields default to
  empty arrays, so existing readers that ignore unknown fields
  remain compatible.
- **Input sanitisation** for Brain writers. The Pay Memory redactor
  is promoted to `src/core/redactor.ts` (Pay Memory keeps the import
  path) and joined by a new `normaliseTextField` helper that strips
  C0 control characters (except `\t` / `\n`), folds `U+2028` /
  `U+2029` line separators to `\n`, NFC-normalises, and caps length.
  `writeSignal` runs `principle` (cap 512, single-line), `scope`
  (cap 128, single-line), `raw` (cap 4096), and `source[]` items
  (cap 512) through redact + normalise. `appendApplyEvidence`
  applies the same to `artifact` (cap 512, single-line) and `note`
  (cap 4096). Inputs that sanitise down to empty (e.g. pure C0
  bytes) raise the existing `missing field` error rather than
  smuggling into YAML.
- **`outdated` apply-evidence result** (`BRAIN_APPLY_RESULT.outdated`).
  Records that a preference's scope still matched the artifact but
  the rule itself is obsolete in this context (framework migration,
  convention change). Dream interprets any `outdated` event as a
  retire trigger with new reason
  `BRAIN_RETIRED_REASON.supersededByContext` =
  `"superseded-by-context"`. Pin protects against decay-driven
  retires only; an `outdated` event is an explicit context shift
  and bypasses the pin. CLI and MCP tool schema accept the new
  enum value.
- **Claim-level provenance in apply-evidence artifacts**. The
  `artifact` wikilink optionally carries an inclusive 1-based line
  range: `[[src/cli/main.ts:120-145]]` (range) or
  `[[src/cli/main.ts:42]]` (single line). New
  `parseArtifactRef(value)` helper in
  `src/core/brain/wikilink.ts` extracts `{target, range?,
malformedRange?}`. The writer accepts the syntax verbatim; the
  parser is used by downstream readers (lint, future fragment
  display).
- **`brain_doctor` hygiene lints** (closes the remaining §11 items
  from the project's feature summary):
  - `duplicate-preferences` — pairwise jaccard ≥ 0.7 on principle
    tokens within each `(topic, scope)` bucket of confirmed /
    quarantine preferences.
  - `low-evidence-confirmed` — confirmed pref with
    `applied_count ≤ low_max_applied` and `confirmed_at` older
    than `unconfirmed_window_days`.
  - `pinned-without-recent-evidence` — pinned pref with no
    `last_evidence_at` or with evidence older than
    `stale_evidence_days`.
  - `malformed-evidence-range` — apply-evidence artifact uses
    range syntax but the range fails validation (non-numeric,
    reversed, zero-based, dangling dash).
  - `orphan-evidence` — apply-evidence artifact wikilink doesn't
    resolve to any file in the vault (basename match via
    `listVaultPages`).
- `runDoctor` accepts an `opts.now` for deterministic age-based
  testing. CLI `--strict` semantics unchanged.

## [0.9.0] - 2026-05-15

Brain: a new top-level vault layer for observing, accreting memory.
Agents record taste signals from conversation and per-artifact
evidence of preference application; a deterministic `dream` pass
turns repeat signals into rules whose confidence grows from real use
and decays when nothing applies them. Filesystem-first, Obsidian-
native, no LLM inside the algorithm — counters, thresholds, atomic
file operations only. Conceptually mirrors Anthropic's _Dreaming_
research preview (2026-05-06) but stays runtime-agnostic and
deterministic.

The previous agent-facing write paths (`event_log_append` and
`second_brain_capture` MCP tools, the `agent-event-log` skill) are
soft-deprecated in v0.9.0: the handlers remain in the codebase and
the CLI counterparts (`o2b append-event`, `vault-log`) keep working
for humans on the shell, but agents through the plugin surface no
longer see them. Brain replaces them as the writable surface.

Pay Memory is **unchanged** in v0.9.0 — it remains agent-visible as
an orthogonal audit layer for paid actions.

### Added

- **Brain layer** at top-level `Brain/` directory in the vault.
  Subdirectories: `inbox/`, `preferences/`, `retired/`, `log/`,
  `.snapshots/`. Plus `_brain.yaml` (schema-versioned config with
  thresholds for `candidate_threshold`, `unconfirmed_window_days`,
  `contradiction_window_days`, `stale_evidence_days`,
  `high_freshness_factor`, `snapshots.retention_count`) and
  `_BRAIN.md` (agent-facing operating manual, rendered by `o2b
brain init`, kept under 200 lines).
- **CLI namespace `o2b brain *`** with 11 verbs: `init`,
  `feedback`, `dream`, `apply-evidence`, `digest`, `query`,
  `reject`, `pin`, `unpin`, `rollback`, `doctor`.
- **MCP tool namespace `brain_*`** with 6 tools: `brain_feedback`,
  `brain_dream`, `brain_apply_evidence`, `brain_digest`,
  `brain_query`, `brain_doctor`. `init`, `reject`, `pin`, `unpin`,
  `rollback` are intentionally CLI-only (admin / destructive
  operations are not exposed to autonomous agents).
- **Pre-run snapshots**: each `dream` run that mutates state writes
  `Brain/.snapshots/<run_id>.tar.zst` of the entire `Brain/` tree
  (excluding `.snapshots/` itself) before any mutation. Retention
  is configurable in `_brain.yaml` (default 10 most-recent).
  `o2b brain rollback <run_id>` restores from a snapshot.
- **Pin protection**: preferences marked `pinned: true` are exempt
  from automatic retirement (`stale-no-evidence`,
  `expired-unconfirmed`, `rebutted`). Only `o2b brain reject` can
  retire a pinned preference (with an extra warning). CLI verbs
  `o2b brain pin` and `o2b brain unpin` toggle the flag; both are
  CLI-only — the MCP surface intentionally does not expose them.
- **Skill `brain-memory`** (`skills/brain-memory/SKILL.md`):
  instructs agents when to call `brain_feedback` (taste signals
  from dialogue) and `brain_apply_evidence` (per durable artifact).
  Loaded automatically alongside the existing `open-second-brain`
  skill.
- **Brain digest**: `o2b brain digest` renders a Markdown or JSON
  summary of new unconfirmed preferences, confirmations,
  retirements, confidence shifts, and contradictions in a window.
  Exit code `2` when empty and `--silent-if-empty` is set — fits
  Hermes cron `--no-agent --script` jobs cleanly. Recipe in
  [`docs/hermes-cron.md`](docs/hermes-cron.md).

### Changed

- **`AI Wiki/_OPEN_SECOND_BRAIN.md`** is now overwritten by
  `o2b brain init` to a Brain-first operating manual; the file
  previously described agent-owned write conventions for
  `AI Wiki/` itself. With approximately zero non-author users at
  this stage no backup of the prior file is taken — by design.
- **`hooks/lib/messages.ts` PostToolUse reminder** rewritten:
  no longer references `event_log_append`. Points the agent at
  `brain_feedback` (when the turn contained a user preference)
  and `brain_apply_evidence` (when an active preference scopes
  to the artifact just produced).
- **`skills/open-second-brain/SKILL.md`** body rewritten to
  describe the three-layer model (`Brain/` writable, `AI Wiki/` +
  `Daily/` read-only, Pay Memory orthogonal). Cross-references
  the new `brain-memory` skill.

### Removed (from agent-facing surface; handlers retained in code)

- **`Stop` lifecycle hook** that previously blocked the turn once
  on missing `event_log_append`. The entry is removed from
  `hooks/hooks.json`; the handler file
  `hooks/stop-log-guardrail.ts` remains in the codebase. No
  Brain-specific Stop guardrail is added in v0.9.0 — the
  PostToolUse reminder is the only nudge.

### Deprecated (agent-facing only, code and CLI retained)

- **MCP tool `event_log_append`** — no longer in the advertised
  tool list returned by `src/mcp/tools.ts`. Handler stays on disk.
  The CLI counterparts `o2b append-event` and `vault-log` remain
  fully functional for human shell use.
- **MCP tool `second_brain_capture`** — same pattern: removed
  from advertisement, handler retained.
- **Skill `agent-event-log`** moved to `docs/legacy-skills/` so
  the runtime skill scanner stops loading it. The Markdown remains
  accessible as documentation.

### Notes

- Pay Memory is unchanged. All 11 Pay Memory CLI commands and
  8 MCP tools work exactly as in v0.8.1.
- `AI Wiki/` and `Daily/` remain on disk and stay readable for
  agents via `second_brain_query`. Agents do not write to them
  in v0.9.0+.
- OpenClaw native JavaScript parity for Brain tools is deferred
  to v0.9.1 (tracked as BRAIN-FUT-007 in
  [`docs/plans/2026-05-15-brain-roadmap.md`](docs/plans/2026-05-15-brain-roadmap.md)).
  v0.9.0 ships Brain through the TypeScript CLI + MCP path used by
  Hermes, Claude Code, and Codex.
- Hard removal of the deprecated v0.8.x agent-facing write code
  is deferred to v0.10 or later, gated on observed usage of Brain
  (BRAIN-FUT-009).
- Full design and implementation plan:
  [`docs/plans/2026-05-15-brain-observing-memory.md`](docs/plans/2026-05-15-brain-observing-memory.md).

## [0.8.1] - 2026-05-14

Plugin-bundled lifecycle hooks for Claude Code and Codex that close a
real silent-skip bug: the MCP server's `instructions` reminder to call
`event_log_append` after a durable artifact was being dropped under
load with no visible signal — agent finished the turn, the vault's
Daily log stayed empty, no stderr trail. This release moves the
reminder out of soft instructions and into a runtime-side guardrail.

Hermes and OpenClaw are unaffected: Hermes already injects the
equivalent reminder through its `pre_llm_call` shim, and OpenClaw's
native JS plugin format predates the hook schema. The new hooks are
loaded only by Claude Code and Codex.

### Added

- **Lifecycle hooks** (`hooks/`):
  - `PostToolUse` (matcher `Write|Edit|MultiEdit|apply_patch`) — emits
    a developer-context reminder right after the file-mutating tool
    returns. Skipped when `tool_response` reports `is_error: true` or
    `success: false` so failed edits do not generate noise.
  - `Stop` — parses the runtime's transcript JSONL, decides whether
    the turn produced a durable artifact AND whether
    `event_log_append` was called (recognising both the bare Codex
    name `event_log_append` and the Claude-decorated
    `mcp__plugin_open-second-brain_open-second-brain__event_log_append`,
    matched via `/(?:^|__)event_log_append$/` so future prefix
    renames keep working). Emits `{"decision":"block","reason":…}`
    once per turn; respects `stop_hook_active === true` so the next
    Stop passes unconditionally — the agent decides whether to log
    or just finish, no deadlocks.
  - Bash logging counts: if the agent ran `o2b append-event …` or
    `vault-log …` through `Bash` (Claude) or `exec_command` /
    `shell` (Codex), the parser pulls the command string out of the
    transcript and the guardrail treats it as a valid log call.
- **`scripts/o2b-hook`** — PATH-deployed shim that both runtimes
  invoke from `hooks/hooks.json`. Resolves its own location, runs
  the Bun precheck, and execs `hooks/<name>.ts`. `o2b install-cli`
  now symlinks `o2b-hook` alongside `o2b` and `vault-log`. One
  PATH-discoverable entry point works in both runtimes without a
  per-runtime `${PLUGIN_ROOT}` env var (Codex 0.129 exposes none).
- **Codex manifest wiring**: `"hooks": "./hooks/hooks.json"` added to
  both `.codex-plugin/plugin.json` and
  `plugins/codex/.codex-plugin/plugin.json`; `plugins/codex/hooks`
  symlinked to `../../hooks` (mirrors the existing
  `plugins/codex/skills` pattern).
- **Tests** (`tests/hooks/`): 52 new bun:test cases covering format
  detection, Claude / Codex transcript shapes, artifact / log
  classification (including the prefix-decorated MCP names),
  Bash-as-log paths, the trailing-newline JSON contract, malformed
  JSONL, empty transcripts, missing `transcript_path`,
  `stop_hook_active`, failed-edit suppression.
- **Documentation**:
  - `hooks/README.md` — full design notes (cross-runtime detection,
    PATH-based shim rationale, symlink caveat for Codex marketplace
    staging, cwd contract for test subprocesses).
  - `install.md` branches C (Codex) and D (Claude Code) — new
    `### 6b. Lifecycle hooks (auto-enabled)` sections; step 3 in
    every branch now mentions the `o2b-hook` symlink.
  - `install.md` readiness checklist — split the `VAULT_AGENT_NAME`
    line so it requires the env var for Hermes / Codex only;
    Claude Code derives identity from the persisted plugin config
    that `o2b init --agent-name` writes.
  - `README.md` rewritten to be runtime-neutral — removed Hermes-first
    framing and duplication with `install.md`, added a
    Supported-runtimes table and a Lifecycle-hooks section.

### Fixed

- Silent `event_log_append` skips after a durable artifact landed,
  visible in real Claude Code sessions where a Write or Edit was
  followed by no log call and no warning. The `Stop` guardrail now
  blocks the turn once with a clear reason; the agent must either
  log or explicitly skip by sending its final reply a second time.

### Changed

- `sync-version` now also updates `plugins/codex/.codex-plugin/plugin.json`
  (it was stuck at 0.7.0). All seven manifests stay in lockstep with
  `package.json`.
- `tsconfig.json` `include` extended to cover `hooks/**/*.ts`.

## [0.8.0] - 2026-05-10

Pay Memory: a memory and audit layer for paid agent actions. Hermes (or any
other supported runtime) makes a paid API call through `pay.sh`; Open Second
Brain saves the reason, the policy check, the receipt, the generated asset,
the spending policy decision, the human-approval state, and a per-task
report — all as plain Markdown inside the configured vault.

This release does not execute payments and does not hold wallet keys. The
payment still happens through the agent's local `pay` CLI; Open Second Brain
records what happened.

### Added

- **Core Pay Memory module** (`src/core/pay-memory/`):
  - filesystem helpers (`paymentsDateDir`, `receiptPath`, `assetPath`,
    `reportPath`) and `validateSlug` (defense-in-depth against path
    traversal in user-supplied slugs);
  - best-effort raw-output redactor for `api_key` / `token` / `secret` /
    `bearer` / `authorization` / `private_key` / `password` / `passwd` /
    `pwd` / `credential` / `session_token` in env, YAML, JSON, and
    HTTP-header shapes;
  - deterministic Markdown receipt / asset / report writers with
    frontmatter; bracket and backtick sanitisation in wikilinks /
    inline-code spans;
  - spending policy template renderer (`spending.md`) plus a separate,
    optional **machine-readable policy** (`spending.json`) with
    allowlist, single-call cap, daily budget cap, per-category receipt
    quotas, and "require approval above" threshold;
  - daily payment digest (`buildPaymentDigest` +
    `renderPaymentDigestTelegram`) for cron-friendly 4-line summaries;
  - **approval workflow** (`pending-payment-request` artifact under
    `AI Wiki/payments/_pending/`) with `pending → approved/rejected →
consumed` state machine.
- **Path-safety helpers** (`src/core/path-safety.ts`): `ensureInsideVault`
  and `vaultRelative` use `path.sep` so the prefix check works on Windows
  too; replaces the duplicated POSIX-only versions previously inlined in
  `src/mcp/tools.ts` and `src/core/pay-memory/paths.ts`.
- **Atomic / race-safe writers** (`atomicCreateFileSyncExclusive`,
  `writeFrontmatterAtomic`): Pay Memory artifacts are written via
  `link(2)` semantics so "refuse to overwrite" is enforced atomically
  even with concurrent CLI + MCP server processes.
- **CLI commands** (eleven new in this version):
  - `init-pay-memory` — bootstrap `AI Wiki/{policies,payments,assets,drafts,reports}/`
    and write `policies/spending.md`.
  - `append-payment-receipt` — save a Markdown receipt; `--raw-output-file`
    is redacted before persisting.
  - `capture-asset` — save a Markdown note for a generated asset.
  - `payment-report` — aggregate a date's receipts into a Markdown report.
  - `check-payment-policy` — evaluate a prospective paid call against
    `spending.json`; exit 0 / 1 / 3 = allowed / denied / approval_required.
  - `request-payment-approval` — create a pending request the user must
    sign off on before the agent runs `pay`.
  - `approve-payment-request`, `reject-payment-request`,
    `consume-payment-request`, `list-pending-payments` — human / agent
    sides of the approval workflow.
  - `payment-digest` — render a Telegram-friendly 4-line summary for a
    date (with `--empty-mode silent|empty|summary`).
- **MCP tools** (eight new in this version): `payment_memory_init`,
  `payment_receipt_append`, `asset_capture`, `payment_report_generate`,
  `payment_policy_check`, `payment_request_approval`,
  `payment_request_status`, `payment_request_consume`. Server
  `initialize.instructions` describes the suggested call chain.
- **Documentation**: `docs/hermes-cron.md` (wiring `payment-digest` into a
  Hermes cron `--script --no-agent` job for daily Telegram delivery),
  `examples/hermes-payment-digest.sh` reference wrapper,
  `docs/plans/2026-05-10-pay-memory.md` (implementation plan), and
  `tests/e2e/pay-memory-sandbox.sh` (manual end-to-end smoke test against
  the real `pay --sandbox` CLI).

### Changed

- The MCP tool server now advertises **thirteen** tools (the previous five
  plus eight Pay Memory tools).
- `core/vault.ts` exposes `formatFrontmatter` (pure renderer) and
  `writeFrontmatterAtomic` (race-safe writer used by Pay Memory). The
  legacy `writeFrontmatter` keeps its non-atomic semantics for non-critical
  callers (`init.ts`, the `o2b index` command, etc.).

### Out of scope

- On-chain anchoring of vault hashes (Solana memo, web3 RPC) is
  intentionally excluded from this project. Pay Memory continues to record
  `payment_proof` strings opaquely for whatever upstream system produced
  them; the audit trail lives in the vault, not on a blockchain.

## [0.7.0] - 2026-05-09

Single TypeScript source of truth on the [Bun](https://bun.sh) runtime.
Hermes, Claude Code, Codex, and OpenClaw all consume the same `src/core/`
modules; the duplicate JavaScript copy under `openclaw/*.js` and the
parallel Python implementation under `src/open_second_brain/*.py` are gone.

### Added

- TypeScript core (`src/core/`) for config, event-log, vault, init, doctor.
- `bun:test` suite (176 cases) + Python shim tests (13 cases). Includes a
  12-worker multi-process append-event lock test.
- Per-runtime install flows for local marketplaces (Claude `claude plugin
marketplace add <path>`, Codex `codex plugin marketplace add <path>`,
  Hermes via plugin-dir symlink, OpenClaw `openclaw plugins install <path>`).
- `agent-event-log` skill: stronger trigger description and a language
  policy that follows the user's session language.
- `scripts/sync-version.ts` and `bun run sync-version:check` to keep all
  manifests aligned with `package.json`.
- `bun.lock` for reproducible dependency resolution.

### Changed (BREAKING)

- **Runtime:** `o2b` CLI requires [Bun](https://bun.sh) (>=1.1.0). The
  wrapper script aborts with an install hint if `bun` is not on PATH.
- **Source layout:** Python `src/open_second_brain/*` replaced by TypeScript
  `src/core/*`, `src/cli/*`, `src/mcp/*`.
- **OpenClaw plugin:** `openclaw/index.js` is now a `bun build` bundle
  (target=node) of `src/openclaw/index.ts`; no more hand-translated JS.
  CI rebuilds and diffs the committed bundle.
- **Hermes plugin:** `plugins/hermes/__init__.py` slimmed to a thin shim
  (`pre_llm_call` + minimal health). Identity reminder template lives in
  `templates/identity-reminder.txt`, shared with the OpenClaw
  `before_prompt_build` hook.
- **Version source of truth:** `package.json`. `pyproject.toml` and the
  five plugin manifests carry synced copies.
- **CI:** `oven-sh/setup-bun@v2`, `bun test`, `bun run typecheck`,
  Python-shim tests, manifest + bundle freshness checks.

### Fixed

- **Security — path traversal in `event_log_append`:** `date` parameter is
  now validated against `^\d{4}\.\d{2}\.\d{2}$` and rejects non-existent
  calendar dates and `..` segments. Previously `date: "../AI Wiki/notes/pwn"`
  could write outside `Daily/`.
- **Identity hallucination:** placeholder blacklist extended to include
  `codex`, `codex-cli`, `codex-exec`, `claude-code`, `hermes`, `openclaw`.
  When the model echoes its runtime name as the `agent` argument the server
  now falls back to the persisted `agent_name` instead of writing
  `@codex` / `@hermes` / etc.
- **Cross-platform paths:** `fs-atomic`, `install-cli`, `uninstall` use
  `node:path` `basename` / `sep` instead of hard-coded `/`.
- **Test reliability:** `expect(Bun.file(...).text()).resolves` now awaited
  — assertion was silently dropped.
- **Hermes shim:** `__init__.py` tolerates both relative and absolute
  `plugins.hermes` import paths (Hermes loads it as a file directly).

### Removed (BREAKING)

- Python `open_second_brain` package and its pip entry points
  (`o2b`, `vault-log`, `o2b-mcp`).
- `openclaw/event-log.js` and `openclaw/vault.js` (rolled into the bundle).

### Migration

1. Install Bun (`curl -fsSL https://bun.sh/install | bash`).
2. `git pull` the plugin checkout.
3. Re-run `o2b install-cli` to refresh symlinks.
4. `o2b doctor --vault <path> --repo <repo>` to verify.

Hermes / Claude Code / Codex / OpenClaw configurations do not change.

## [0.6.2] - 2026-05-08

### Added

- install.md `## Verification — identity registry` block. Confirms
  the chosen agent name appears in
  `<vault>/AI Wiki/identity/agents.md` after `o2b init`. Multi-runtime
  installs grow the list incrementally.
- install.md prelude note: `o2b` CLI on PATH is a single shared
  symlink across runtimes — first-installed wins, subsequent
  `install-cli` refuses to overwrite. Manual repointing is allowed
  but unnecessary.

### Changed

- install.md "Agent name" subsection (branches A–D): installer agent
  **MUST** ask the user, **MUST** first check
  `~/.config/open-second-brain/config.yaml`,
  `<vault>/AI Wiki/identity/agents.md`, and `<vault>/Daily/*.md` for
  a previously-set identity and surface it as a reuse-or-change
  question. Defaults list only shown if no prior identity is found.
- install.md "no version pin" guidance: replaced the ambiguous
  "tracks `main`" framing with "**latest released version**" plus an
  explicit `v0.6.1` vs `v0.6.0` example, and a direct statement that
  manually appending `@v...` freezes the install at the literal tag
  you typed.
- install.md prelude: `o2b init` idempotency description updated to
  describe the new multi-agent append behavior on
  `AI Wiki/identity/agents.md`.

### Fixed

- Multi-agent registration in `AI Wiki/identity/agents.md`. Second and
  later `o2b init --agent-name <name>` runs now append under
  `## Registered agents` instead of being a silent no-op once the
  placeholder is gone. Idempotent for already-registered names.
- install.md Branch C steps 2–3: Codex CLI 0.129+ caches the
  marketplace under `~/.codex/.tmp/marketplaces/<name>/`, not the
  previously documented `~/.codex/plugins/cache/<marketplace>/<plugin>/<hash>/`.
  Step 3 now uses a `find` pattern that works on either layout.
- install.md Branch D step 3: Claude Code caches plugins under a
  `<version>` segment (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/scripts/o2b`).
  Same `find`-based fix as Branch C.

## [0.6.1] - 2026-05-08

### Added

- `pre_llm_call` hook in the Hermes-side adapter. Each turn the plugin
  injects a compact identity + workflow nudge into the user message —
  the LLM learns its `@agentName` and the contract for
  `event_log_append` (plain message text; the server prepends timestamp
  and identity). Skips injection silently when the agent identity is
  not configured, so the literal `@agent` placeholder never reaches
  the LLM.
- `.claude-plugin/marketplace.json` — single-plugin Claude Code
  marketplace manifest. Claude Code 2.x install flow is
  `claude plugin marketplace add` → `claude plugin install <plugin>@<marketplace>`,
  and the marketplace step expects this catalog file. Without it, the
  install fails with `Marketplace file not found`. Manifest declares
  the repository as a one-plugin marketplace pointing at itself
  (`source: "./"`), so the same Git URL works for every other runtime
  without restructuring.
- `.mcp.json` at the repo root — Claude auto-registers MCP servers
  declared here when the plugin is installed, so users never run
  `claude mcp add` manually. The entry uses `${CLAUDE_PLUGIN_ROOT}` to
  stay portable, and intentionally carries no `--vault` arg or env
  vars: the MCP server reads vault/agent/timezone from the persisted
  plugin config (see `vault` field below). Same `.mcp.json` works on
  every user's machine without per-host customization.
- `o2b init --vault <path>` now also persists the vault path into the
  plugin config (`vault` field, alongside `agent_name` and `timezone`).
  `o2b mcp` invoked without `--vault` (Claude `.mcp.json`
  auto-register, Hermes/Codex MCP entries that omit the flag) reads
  from this field — falling back to `VAULT_DIR` env, then to a clear
  error referencing `o2b init`.
- `config.resolve_vault(config_path)` — public helper, mirroring the
  existing `resolve_agent_name` and `resolve_timezone` shape.
- install.md Branch D is rewritten end-to-end against current Claude
  Code CLI (2.x): step 2 uses `claude plugin marketplace add` plus
  `claude plugin install <plugin>@<marketplace>` (the legacy
  `claude plugins install <git-ref>` form was removed in 2.x); step 5
  collapses to a no-op because Claude auto-registers MCP servers from
  the bundled `.mcp.json`; step 6 verifies via `claude plugin list` and
  `claude mcp list`; step 7 uses the marketplace + plugin update
  commands; step 8 uses the matching uninstall/remove pair.

- `.agents/plugins/marketplace.json` — single-plugin Codex marketplace
  manifest at the repo root. Codex 0.129+ has dropped the legacy
  `codex plugins install <git-ref>` command; the only documented install
  path is `codex plugin marketplace add <source>`, which validates a
  marketplace catalog at this exact location. Without this file the
  install fails with `marketplace root does not contain a supported
manifest`. The manifest declares the repository as a one-plugin
  marketplace pointing at itself (`path: "."`), so the same Git URL
  that worked for `hermes plugins install` works for the new Codex
  flow without restructuring the repo.
- install.md Branch C is rewritten end-to-end against current Codex CLI
  (0.129+): step 2 uses `codex plugin marketplace add` plus a manual
  `[plugins."open-second-brain@open-second-brain"] enabled = true`
  stanza in `~/.codex/config.toml` (Codex has no `plugin enable`
  subcommand); step 5 uses `codex mcp add ... -- o2b mcp --vault ...`
  with both `VAULT_AGENT_NAME` and `VAULT_TIMEZONE` env vars; step 7
  uses `codex plugin marketplace upgrade`; step 8 uses
  `codex mcp remove` + `codex plugin marketplace remove`. The previous
  text referenced commands (`codex plugins install/update/uninstall`)
  that simply do not exist on current Codex.
- Timezone support for Daily event log entries. The plugin now stamps
  `HH:MM` and the day-file selection in the user's local timezone
  instead of the host's clock — important when the host runs in UTC
  but the user lives in a different zone, or when Daily entries
  straddle midnight in the user's local time. Resolution order:
  `VAULT_TIMEZONE` env var → `timezone` field in the plugin config →
  fallback to system local. Invalid names are silently treated as not
  configured (entries still land, just stamped in server time) so a
  typo never breaks logging.
- `o2b init --timezone <iana-name>` validates the IANA name via stdlib
  `zoneinfo` and persists it to the plugin config alongside
  `agent_name`. Invalid input is rejected before any vault scaffolding
  is written, so a typo cannot leave the install in a half-configured
  state.
- `open_second_brain.config.resolve_agent_name()` and
  `resolve_timezone()` — public helpers used by both the MCP server
  and the Hermes hook so identity and timezone reads stay consistent
  across every runtime / CLI surface.
- `scripts/sync-version.py` — propagates the canonical version from
  `pyproject.toml` into every runtime manifest (`plugin.yaml` × 2,
  `package.json`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `openclaw.plugin.json`). Idempotent;
  ships a `--check` mode for CI drift detection.

### Changed

- `.claude-plugin/plugin.json` modernized to current Claude 2.x schema:
  `author` is now an object (`{ "name": "..." }`) per the docs (Claude
  2.1.x rejected the legacy string form with `author: Invalid input`),
  and the embedded `commands` array is removed (Claude no longer
  parses in-manifest slash command definitions; they are authored as
  Markdown files under `commands/` at the plugin root if needed).
- `o2b doctor` `claude_manifest` check rewritten to validate the new
  schema. It accepts the modern `author` object form and reports a
  clear error when an old-style `commands` array is present.
- OpenClaw native plugin entry brought to parity with the Python /
  MCP side for the features added in this release. `openclaw/index.js`
  now uses `resolveTimezone(api)` (reads `api.pluginConfig.timezone`,
  falls back to `VAULT_TIMEZONE` env) and a `normalizeAgentArgument`
  helper (strips leading `@`, treats common LLM self-name guesses
  like `agent` / `assistant` / `claude` / `gpt` as "no value" so the
  resolved default identity is used instead). `openclaw/event-log.js`
  `currentDate(tz)` / `currentTime(tz)` use `Intl.DateTimeFormat` so
  Daily entries are stamped in the user's local timezone instead of
  the host's clock — matching the Python `current_date(tz)` /
  `current_time(tz)` behavior. The `appendEvent(...)` signature gains
  a trailing optional `tz` argument; backward-compatible.
  `openclaw.plugin.json` `configSchema` and `uiHints` now declare a
  `timezone` field so OpenClaw users can set it via
  `openclaw config set plugins.entries.open-second-brain.config.timezone "..."`.
- install.md Branch B step 1 corrected: previously claimed the
  OpenClaw native plugin reads timezone from
  `~/.config/open-second-brain/config.yaml`. It does not — the JS
  plugin reads exclusively from `api.pluginConfig` (OpenClaw's own
  per-plugin store, populated by `openclaw config set`). Step 5 now
  includes a fourth `openclaw config set` line for the timezone, and
  the worked example JSON shows `timezone` alongside `agentName`.
- Removed the unused, drifting `PLUGIN_VERSION = "0.6.0"` constant
  from `openclaw/index.js`. The two unused local helpers
  `currentDate()` / `currentTime()` in the same file were also
  deleted (the active versions live in `openclaw/event-log.js` and
  are now timezone-aware).
- Hardened vault resolution across every write-mode CLI entry point.
  Previously `vault-log`, `o2b append-event`, `o2b doctor`,
  `o2b index`, `o2b tool-call`, and `o2b mcp` (the standalone
  `open_second_brain.mcp:main` console script) all fell back to the
  current working directory (`Path(os.environ.get("VAULT_DIR", "."))`)
  when neither `--vault` nor `VAULT_DIR` was set. That fallback was
  silent: an agent invoking `vault-log "..."` from `$HOME` would
  write `~/Daily/<date>.md` instead of the user's actual vault, and
  the success line `appended: Daily/...` gave no signal that the
  entry had landed in the wrong place. Now every one of these entry
  points resolves the vault via `--vault → VAULT_DIR → persisted
plugin config (vault field)`, and exits with a clear
  `error: no vault configured. Pass --vault ... or run o2b init ...`
  if none of those is set. The shared resolver lives in
  `cli._require_vault`; the `vault-log` and standalone-`o2b mcp`
  paths use the same logic inline because they don't share the cli
  module's argparse setup.
- `vault-log` and `o2b append-event` now print the **absolute** path
  of the appended Daily file (`appended: /abs/.../Daily/<date>.md`),
  not a relative `Daily/<date>.md`. The relative form was the visual
  disguise that hid the silent-cwd-fallback bug above.
- install.md step 1 in every branch is now "Collect installation
  parameters (vault path + agent name + timezone)" — three values
  instead of two. The new "Vault path" subsection tells the
  installer agent how to discover the user's Obsidian vault on the
  target machine: scan common roots (`~/`, `~/Documents/`,
  `~/Sync/`, iCloud paths, Syncthing mounts), look for the
  `.obsidian/` marker subdirectory, list candidates and ask the user
  to pick one, or ask for a path if none are found. The agent must
  confirm the resolved absolute path with the user before passing it
  to `o2b init`. No vault location is hard-coded in the docs — the
  example `/path/to/vault` placeholder remains generic.
- `docs/architecture.md` example config snippet no longer hard-codes
  `/root/vault` / `hermes-vps-agent` / `vps-techmeat`. Replaced with
  generic placeholders so the doc reads correctly on any machine.
- `set_config_value` (`config.py`) is now atomic and stricter:
  contents go through a sibling temp file with `fsync` + `os.replace`,
  so an interrupt during the write leaves either the previous config
  or the new one intact — never a half-written hybrid. Values
  containing characters that the simple parser cannot round-trip
  (`"`, `\\`, `\n`, `\r`) are rejected with a clear `ValueError`
  instead of being silently corrupted on the next read. The fields
  this helper persists (`vault` paths, IANA timezone names, agent
  identifiers) never legitimately contain those characters; the
  rejection is a guardrail against future callers passing arbitrary
  strings through. Surfaced by an autonomous CodeRabbit review pass.
- OpenClaw `resolveTimezone(api)` now validates the candidate against
  `Intl.DateTimeFormat` before returning it. An invalid IANA name in
  `api.pluginConfig.timezone` or `VAULT_TIMEZONE` would otherwise
  crash every `event_log_append` call inside `Intl.DateTimeFormat`
  with `RangeError`. The Python side already had this fallback
  (`config.resolve_timezone` swallows `ZoneInfoNotFoundError`); the
  JS side now matches.
- `o2b doctor`'s `claude_manifest` author check rejects an empty
  `name` (e.g. `{"author": {"name": ""}}`) with the same error
  message used for missing or wrong-typed `author`. Previously
  `isinstance(author.get("name"), str)` accepted the empty string.
- The two timezone-aware MCP tests now capture the local-tz wall
  clock **before** invoking the tool. The previous order computed
  `now_local` after the tool returned, which around midnight could
  flake: tool stamps day N, assertion looks for day N+1. Tightened.
- New install.md **Branch E — Generic adapter (other runtimes)**. For
  any runtime not covered by branches A–D (a new MCP-aware client, a
  different agent platform, or a supported runtime after a breaking
  CLI rename), Branch E describes the install **contract** the
  plugin needs — directory layout, `o2b` on PATH, `o2b mcp` registered
  as stdio MCP server, persisted plugin config — instead of literal
  commands. It instructs the installer agent to consult the target
  runtime's own plugin / MCP documentation and translate each step
  into the runtime-specific equivalent, asking the user before
  guessing on any step that has no obvious analogue. The document
  prelude was updated to list E as the fallback option alongside
  A–D.
- "When to log" criteria broadened in both surfaces the LLM sees:
  the per-turn `pre_llm_call` nudge and the MCP server's
  `serverInfo.instructions`. The previous wording only listed concrete
  artifacts (feature/fix/config/instruction-file/content) and instructed
  the LLM to skip "exploration, planning, or pure discussion". This
  caused agents to refuse logging substantial-but-non-tangible work —
  research findings, design decisions, investigations that surfaced
  facts worth recalling. The rules now treat any **durable artifact**
  as loggable, including research outcomes, design decisions, and
  external-fact discoveries (CLI behaviour change, API quirk, etc.),
  and end with a self-test prompt: _"would future-me want to find this
  in the log by searching for it later?"_. Skip-list is unchanged in
  spirit but reworded around "did not produce an artifact" rather
  than against specific activity types.
- `tests/test_cli.py` `run_cli` helper now isolates
  `OPEN_SECOND_BRAIN_CONFIG` per call by default. With `o2b init` now
  unconditionally persisting `vault` / `agent_name` / `timezone` into
  the config file, init-tests without explicit isolation were silently
  writing to the developer's real `~/.config/open-second-brain/config.yaml`.
  Tests that specifically exercise the default-config path can still
  pass `env={"OPEN_SECOND_BRAIN_CONFIG": ...}` to override the guard.
- The package version is now a single source of truth in
  `pyproject.toml`. `open_second_brain.__version__` reads it
  dynamically (live `pyproject.toml` first, `importlib.metadata`
  fallback) so a version bump shows up at runtime without a pip
  reinstall. `mcp.SERVER_VERSION` re-exports the same value.
- `event_log.append_event(..., tz=...)` accepts an optional
  `datetime.tzinfo` parameter; `current_date` and `current_time` are
  likewise tz-aware. Backward-compatible: omitting `tz` keeps the
  previous server-local behavior.
- install.md step 1 in every branch is now "Collect identity (agent
  name + timezone)" — a single up-front step that asks the user for
  both values before any commands run. The instructions tell the
  installer agent to accept free-form timezone input (city, country,
  abbreviation) and translate it to canonical IANA before passing to
  `o2b init`.
- `event_log_append` accepts and normalizes a wider set of LLM-supplied
  values for the optional `agent` argument: leading `@` is stripped
  (so `@hermes-vps-agent` no longer becomes `@@hermes-vps-agent`), and
  common placeholder/self-name guesses (`agent`, `assistant`, `claude`,
  `gpt`, …) fall back to the server-resolved default identity instead
  of being written verbatim into Daily.
- `event_log_append` and other tools that take optional string
  arguments now treat empty strings the same as omitted arguments.
  LLMs in tool-use mode frequently emit `""` for fields they want to
  skip; the previous behavior rejected `time=""` / `date=""` with a
  validator error.
- `o2b init --agent-name <name>` now also persists the chosen identity
  into the plugin config (`~/.config/open-second-brain/config.yaml` by
  default), not only into `AI Wiki/identity/agents.md`. Resolution
  order in `event_log_append` is unchanged
  (`VAULT_AGENT_NAME` env → plugin config → literal `agent`
  placeholder), but persistence now survives runtimes that do not
  propagate the env into the MCP subprocess.
- The MCP `initialize` response's `serverInfo.instructions` field now
  carries an identity + workflow block (you-are-@&lt;agent&gt;, when to
  call `event_log_append`, message format rules) rather than a plain
  list of tool names. Clients that surface MCP `instructions` to the
  LLM benefit immediately; clients that ignore the field are unaffected.

## [0.6.0] - 2026-05-08

### Added

- Daily-log agent identity workflow. Each runtime install now selects an
  agent name (e.g. `openclaw-main`, `hermes-vps-agent`, `<hostname>-codex`,
  …) that is used as the `@agent-name` prefix in `Daily/*.md` event log
  entries.
- `o2b init --agent-name <name>` writes the chosen identity into
  `AI Wiki/identity/agents.md` and replaces the template placeholder
  (`(add your agents here, …)`). Existing vaults are upgraded in place
  without `--force`: the placeholder line is rewritten.
- `agentName` field in `openclaw.plugin.json` `configSchema` and `uiHints`
  alongside `vault` / `instanceName`. The OpenClaw native plugin reads
  `api.pluginConfig.agentName` and uses it as the default agent for
  `event_log_append` calls that omit the `agent` argument.
- `event_log_append` (Python MCP) now resolves the default agent from
  `VAULT_AGENT_NAME`, then from `agent_name` / `agentName` in the
  discovered config file, then falls back to `agent`.
- New "Verification — daily identity" step in `install.md` and
  `after-install.md`. Calls `event_log_append` without an explicit
  `agent` and asserts the daily entry shows `@<chosen-agent-name>` rather
  than `@agent`.
- `install.md` now covers all four runtimes (Hermes, OpenClaw, Codex,
  Claude Code) with runtime-appropriate agent name defaults.
- Installation readiness criteria now require `agentName` to be configured
  (or `VAULT_AGENT_NAME` exported), the placeholder removed from
  `agents.md`, and the daily-identity check to pass.

### Changed

- Bumped package, plugin, MCP server, OpenClaw plugin, and Hermes adapter
  versions to 0.6.0.

## [0.5.5] - 2026-05-08

### Added

- `o2b install-cli` subcommand: creates symlinks for `o2b` and `vault-log`
  in `~/.local/bin` pointing to the wrapper scripts inside the plugin
  checkout. Run once after `hermes plugins install` to make bare `o2b`
  available on PATH. Symlinks survive `hermes plugins update` because they
  point into the git-managed checkout.
- `o2b uninstall --remove-cli` flag: removes the symlinks created by
  `install-cli` during uninstall.

### Fixed

- Installation instructions (`install.md`, `after-install.md`, `README.md`)
  now include the `install-cli` step between `hermes plugins install` and
  `o2b init`, closing the gap where bare `o2b` was not found on PATH after
  a clean plugin install.

## [0.5.4] - 2026-05-07

### Fixed

- Added `name` field inside each tool object passed to `api.registerTool()`.
  OpenClaw 2026.5.6 reads `tool.name` during normalization and calls `.trim()`
  on it — omitting it caused `TypeError: Cannot read properties of undefined`.

## [0.5.3] - 2026-05-07

### Fixed

- Changed `register(api)` from `async` to synchronous in `openclaw/index.js`.
  OpenClaw requires `register` to be synchronous — only `execute()` callbacks
  inside tools may be async.

## [0.5.2] - 2026-05-07

### Changed

- Rewrote OpenClaw runtime entry in pure JavaScript — all five tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) now operate directly on the vault
  filesystem using `node:fs/promises` and `node:path` instead of spawning
  a Python subprocess. This passes the OpenClaw security scanner which
  blocks `child_process` imports.
- Removed `openclaw/o2b-runner.js` subprocess helper (no longer needed).
- Added `openclaw/vault.js` and `openclaw/event-log.js` pure JS modules.
- Switched to `api.pluginConfig` for reading plugin configuration and
  two-arg `api.registerTool(tool, { name })` registration pattern to
  match bundled OpenClaw plugin conventions.

### Removed

- `openclaw/o2b-runner.js` — subprocess runner blocked by security scanner.

## [0.5.1] - 2026-05-07

### Added

- Root `package.json` with `openclaw.extensions` so OpenClaw can install the
  plugin via `git:` and `npm-pack:` resolvers without errors.
- `openclaw/index.js` runtime entry that registers five native OpenClaw tools
  (`second_brain_status`, `second_brain_query`, `second_brain_capture`,
  `event_log_append`, `vault_health`) through `definePluginEntry` and
  `api.registerTool`. Tool execution spawns `python3 -m open_second_brain.cli`
  with `PYTHONPATH` pointing at the plugin's `src/` directory.
- `openclaw/o2b-runner.js` subprocess helper for calling Python from the JS
  entry.
- `tool-call` CLI subcommand that bridges MCP tool handlers to the command
  line, enabling the JS entry to invoke tools like `second_brain_query` and
  `second_brain_capture` without running a full MCP server.
- `check_openclaw_installability` doctor checks that validate `package.json`
  exists, has `openclaw.extensions`, and each extension file is present.
- `uiHints` and `activation` fields in `openclaw.plugin.json`.
- OpenClaw packaging validation step in the CI release workflow.

### Changed

- Bumped package, plugin, and manifest versions to 0.5.1.
- `install.md` OpenClaw branch now uses `openclaw config set` for vault
  configuration instead of manual MCP registration — tools are registered
  natively by the plugin entry.
- `mcpEnabled` default changed to `false` in `openclaw.plugin.json` because
  native tool registration makes the MCP server unnecessary for most OpenClaw
  setups.
- `docs/architecture.md` OpenClaw adapter section now describes the JS entry +
  Python bridge pattern instead of the Bundle-only approach.

## [0.5.0] - 2026-05-07

### Added

- OpenClaw native plugin compatibility through `openclaw.plugin.json` manifest at
  the project root. OpenClaw discovers the plugin via the Bundle format
  (auto-detecting `.claude-plugin/` and `.codex-plugin/`) combined with the
  static manifest for cold discovery. The MCP server serves as the runtime tool
  bridge. See `docs/architecture.md` for the adapter layout.
- `check_openclaw_manifest` health check in `doctor.py` that validates
  `openclaw.plugin.json` has required fields (`id`, `configSchema`) and that the
  declared tool names match the MCP tool table.
- `openclaw_manifest` check in the Hermes adapter health report
  (`plugins/hermes/__init__.py`).
- OpenClaw installation and configuration section in `README.md`.
- OpenClaw post-install steps in `after-install.md`.
- OpenClaw adapter section in `docs/architecture.md`.
- Validation of `openclaw.plugin.json` in the CI release workflow
  (`.github/workflows/release.yml`).
- `tests/test_openclaw_plugin.py` covering manifest validity, required fields,
  tool name consistency with the MCP server, and installability invariants.

### Changed

- Bumped package, plugin, MCP server, and Claude/Codex manifest versions to 0.5.0.
- Updated `pyproject.toml` description to mention OpenClaw alongside Hermes,
  Claude Code, and Codex.
- Updated `.codex-plugin/plugin.json` description to mention OpenClaw.

## [0.4.2] - 2026-05-06

### Changed

- Reworded the `--args` guidance in `after-install.md` and `docs/mcp.md` so
  the docs no longer contain a literal copyable quoted-args anti-example.
  The corrected `hermes mcp add open-second-brain --command o2b --args mcp
--vault /path/to/vault` example stays; the negative case is now described
  in prose ("do not wrap all of those arguments into one quoted shell
  string and do not repeat `--args` per token") so a careless copy/paste
  cannot pick up the wrong form.
- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.2.

## [0.4.1] - 2026-05-06

### Added

- `o2b uninstall` CLI helper that prints a read-only uninstall plan, including
  the exact Hermes commands the user must run (`hermes mcp remove`,
  `hermes plugins remove`, `hermes gateway restart`) and the location of the
  machine-local config directory.
- `--apply-local` flag for `o2b uninstall` that may remove the machine-local
  config directory only (`~/.config/open-second-brain` or the parent of
  `$OPEN_SECOND_BRAIN_CONFIG`). Refuses to act on directories whose name is
  not a recognized Open Second Brain config dir, paths inside Hermes-owned
  trees, or directories that look like git repositories.
- `after-install.md` at the repository root so Hermes can show post-install
  guidance (init, MCP registration, update, uninstall) right after
  `hermes plugins install`.
- `uninstall` command entry in the Claude Code plugin manifest.
- README now documents an explicit Hermes CLI form for MCP registration
  (`hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault`)
  and adds dedicated **Updating** and **Uninstalling** sections that spell
  out the Hermes-owned vs. machine-local layers.
- `docs/mcp.md` now covers updating and removing the MCP registration, and
  warns against passing `--args` as a single quoted string.
- Dedicated `tests/test_uninstall.py` covering dry-run safety, vault and
  Hermes config preservation, the `--apply-local` allow-list, the
  `OPEN_SECOND_BRAIN_CONFIG` env override, and the help text invariants.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.1.

### Migration / Uninstall notes

- `o2b uninstall` is read-only by default. It **never** edits
  `~/.hermes/config.yaml`, removes the installed plugin directory, or
  touches the vault — including `Daily/`, `AI Wiki/`, or any Markdown.
- To deregister the MCP server and remove the plugin run the Hermes
  commands yourself (`hermes mcp remove open-second-brain`,
  `hermes plugins remove open-second-brain`, `hermes gateway restart`).
- `o2b uninstall --apply-local` only removes the machine-local
  Open Second Brain config directory; it refuses to delete anything else.
- Existing users do not need to re-register the MCP server after upgrading
  to 0.4.1; the plugin update flow keeps `~/.hermes/config.yaml` untouched.

## [0.4.0] - 2026-05-06

### Added

- Optional Model Context Protocol (MCP) tool server over stdio JSON-RPC 2.0 (`o2b mcp`, `o2b-mcp`).
- Five MCP tools backed by the existing core: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`.
- `docs/mcp.md` guide for Hermes `~/.hermes/config.yaml mcp_servers` registration, Claude Code, and Codex.
- `mcp_server` metadata in the top-level Hermes plugin manifest and `plugins/hermes/plugin.yaml`.
- `mcp` command entry in the Claude Code plugin manifest.
- 20 dedicated MCP tests covering handshake, tools listing, every tool, stdio loop, and CLI integration.

### Changed

- Bumped package, plugin, and Claude/Codex manifest versions to 0.4.0.
- Updated README and roadmap to mark v1 as implemented and link to the new MCP guide.

## [0.3.1] - 2026-05-06

### Added

- Top-level Hermes plugin manifest and entrypoint so the repository can be installed from a GitHub or Git URL through Hermes plugin installation.

### Changed

- Reworked README content for end users with a Hermes-first description and concise setup flow.
- Updated package and Hermes plugin metadata to version 0.3.1.

## [0.3.0] - 2026-05-06

### Added

- Deterministic `o2b` CLI foundation with status, init, doctor, append-event, export-config, and index commands.
- Append-only daily Markdown event log backend and `vault-log` compatibility wrapper.
- Vault profile bootstrap for the `AI Wiki` structure and Open Second Brain operating manual.
- Wiki helpers for frontmatter parsing, wikilink extraction, vault page listing, and index regeneration.
- Runtime adapter manifests for Hermes, Claude Code, and Codex.
- Hermes plugin health checks with safe best-effort registration.
- Plugin manifest validation through `o2b doctor --repo`.
- Sandbox vault and plugin manifest fixtures for tests.
- GitHub release workflow for tag-based and manually dispatched releases.

[1.32.0]: https://github.com/itechmeat/open-second-brain/compare/v1.31.0...v1.32.0
[1.31.0]: https://github.com/itechmeat/open-second-brain/compare/v1.30.1...v1.31.0
[1.30.1]: https://github.com/itechmeat/open-second-brain/compare/v1.30.0...v1.30.1
[1.30.0]: https://github.com/itechmeat/open-second-brain/compare/v1.29.0...v1.30.0
[1.29.0]: https://github.com/itechmeat/open-second-brain/compare/v1.28.0...v1.29.0
[1.28.0]: https://github.com/itechmeat/open-second-brain/compare/v1.27.1...v1.28.0
[1.27.1]: https://github.com/itechmeat/open-second-brain/compare/v1.27.0...v1.27.1
[1.27.0]: https://github.com/itechmeat/open-second-brain/compare/v1.26.1...v1.27.0
[1.24.0]: https://github.com/itechmeat/open-second-brain/compare/v1.23.1...v1.24.0
[1.23.1]: https://github.com/itechmeat/open-second-brain/compare/v1.23.0...v1.23.1
[1.23.0]: https://github.com/itechmeat/open-second-brain/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/itechmeat/open-second-brain/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/itechmeat/open-second-brain/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/itechmeat/open-second-brain/compare/v1.19.1...v1.20.0
[1.19.1]: https://github.com/itechmeat/open-second-brain/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/itechmeat/open-second-brain/compare/v1.18.1...v1.19.0
[1.18.1]: https://github.com/itechmeat/open-second-brain/compare/v1.18.0...v1.18.1
[1.18.0]: https://github.com/itechmeat/open-second-brain/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/itechmeat/open-second-brain/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/itechmeat/open-second-brain/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/itechmeat/open-second-brain/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/itechmeat/open-second-brain/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/itechmeat/open-second-brain/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/itechmeat/open-second-brain/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/itechmeat/open-second-brain/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/itechmeat/open-second-brain/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/itechmeat/open-second-brain/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/itechmeat/open-second-brain/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/itechmeat/open-second-brain/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/itechmeat/open-second-brain/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/itechmeat/open-second-brain/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/itechmeat/open-second-brain/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/itechmeat/open-second-brain/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/itechmeat/open-second-brain/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/itechmeat/open-second-brain/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/itechmeat/open-second-brain/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/itechmeat/open-second-brain/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/itechmeat/open-second-brain/compare/v0.45.0...v1.0.0
[0.45.0]: https://github.com/itechmeat/open-second-brain/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/itechmeat/open-second-brain/compare/v0.43.1...v0.44.0
[0.43.1]: https://github.com/itechmeat/open-second-brain/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/itechmeat/open-second-brain/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/itechmeat/open-second-brain/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/itechmeat/open-second-brain/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/itechmeat/open-second-brain/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/itechmeat/open-second-brain/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/itechmeat/open-second-brain/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/itechmeat/open-second-brain/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/itechmeat/open-second-brain/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/itechmeat/open-second-brain/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/itechmeat/open-second-brain/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/itechmeat/open-second-brain/compare/v0.32.1...v0.33.0
[0.32.1]: https://github.com/itechmeat/open-second-brain/compare/v0.32.0...v0.32.1
[0.32.0]: https://github.com/itechmeat/open-second-brain/compare/v0.31.2...v0.32.0
[0.31.2]: https://github.com/itechmeat/open-second-brain/compare/v0.31.1...v0.31.2
[0.31.1]: https://github.com/itechmeat/open-second-brain/compare/v0.31.0...v0.31.1
[0.30.0]: https://github.com/itechmeat/open-second-brain/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/itechmeat/open-second-brain/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/itechmeat/open-second-brain/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/itechmeat/open-second-brain/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/itechmeat/open-second-brain/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/itechmeat/open-second-brain/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/itechmeat/open-second-brain/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/itechmeat/open-second-brain/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/itechmeat/open-second-brain/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/itechmeat/open-second-brain/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/itechmeat/open-second-brain/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/itechmeat/open-second-brain/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/itechmeat/open-second-brain/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/itechmeat/open-second-brain/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/itechmeat/open-second-brain/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/itechmeat/open-second-brain/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/itechmeat/open-second-brain/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/itechmeat/open-second-brain/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/itechmeat/open-second-brain/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/itechmeat/open-second-brain/compare/v0.11.0...v0.12.0
[0.10.9]: https://github.com/itechmeat/open-second-brain/compare/v0.10.8...v0.10.9
[0.10.8]: https://github.com/itechmeat/open-second-brain/compare/v0.10.7...v0.10.8
[0.10.7]: https://github.com/itechmeat/open-second-brain/compare/v0.10.6...v0.10.7
[0.10.6]: https://github.com/itechmeat/open-second-brain/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/itechmeat/open-second-brain/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/itechmeat/open-second-brain/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/itechmeat/open-second-brain/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/itechmeat/open-second-brain/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/itechmeat/open-second-brain/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/itechmeat/open-second-brain/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/itechmeat/open-second-brain/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/itechmeat/open-second-brain/compare/v0.8.1...v0.9.0
[0.11.0]: https://github.com/itechmeat/open-second-brain/compare/v0.10.18...v0.11.0
[0.10.18]: https://github.com/itechmeat/open-second-brain/compare/v0.10.17...v0.10.18
[0.10.17]: https://github.com/itechmeat/open-second-brain/compare/v0.10.16...v0.10.17
[0.10.16]: https://github.com/itechmeat/open-second-brain/compare/v0.10.15...v0.10.16
[0.10.15]: https://github.com/itechmeat/open-second-brain/compare/v0.10.14...v0.10.15
[0.10.14]: https://github.com/itechmeat/open-second-brain/compare/v0.10.13...v0.10.14
[0.10.13]: https://github.com/itechmeat/open-second-brain/compare/v0.10.12...v0.10.13
[0.8.1]: https://github.com/itechmeat/open-second-brain/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/itechmeat/open-second-brain/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/itechmeat/open-second-brain/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/itechmeat/open-second-brain/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/itechmeat/open-second-brain/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/itechmeat/open-second-brain/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/itechmeat/open-second-brain/compare/v0.5.4...v0.5.5
[0.5.2]: https://github.com/itechmeat/open-second-brain/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/itechmeat/open-second-brain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/itechmeat/open-second-brain/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/itechmeat/open-second-brain/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/itechmeat/open-second-brain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/itechmeat/open-second-brain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/itechmeat/open-second-brain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itechmeat/open-second-brain/releases/tag/v0.3.0
