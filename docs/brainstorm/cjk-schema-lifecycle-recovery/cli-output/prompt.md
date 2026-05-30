You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a multi-task Open Second Brain feature-release PR. The operator explicitly selected all four tasks for the same PR. The primary task is t_327f1876; the other three are additional required scope.

## t_327f1876 - [upstream:agentmemory] CJK tokenizer for vault search

**Source**: https://github.com/rohitg00/agentmemory/releases/tag/v0.9.13
**Repo**: rohitg00/agentmemory (9500\*)
**Released**: v0.9.13 (2026-05-15T09:15:55Z)

### What

agentmemory added CJK-aware BM25 tokenization: jieba for Chinese, tiny-segmenter for Japanese, rule-based syllable split for Korean. Mixed CJK+Latin runs preserve token order in a single pass. Segmenters are optionalDependencies so the base install stays lean.

### Why useful for OSB

OSB vault search uses FTS5 which does not segment CJK text - Chinese/Japanese/Korean content is indexed as individual Unicode codepoints rather than words, degrading recall and relevance. Porting the CJK segmentation approach (with the same soft-fail optionalDependencies pattern) would improve search quality for CJK vault content without bloating the default install.

### Status in OSB

- Verdict: not_in_osb_useful
- Code hints: src/core/search/schema.ts (FTS5 chunk_fts table), src/core/search/index.ts (search pipeline entry)

### Notes and comments

agentmemory uses @node-rs/jieba (native, no model download) and tiny-segmenter (~25 KB pure JS). OSB already ships native Node addons via Bun, so jieba would fit the same pattern. The segmenter-optional pattern (soft-fail with one-time hint) is also worth copying.

Also surfaced upstream in safishamsi/graphify v0.8.19. graphify uses jieba for Chinese query segmentation with character bigram fallback when jieba is not installed. Original compound tokens preserved alongside segments for exact-match. Corroborating signal: same CJK segmentation approach, different application (query-time vs indexing-time).

Validator: clean, priority 2. Caveat: CJK segmentation pulls in segmenter deps and conflicts with the dependency-free, language-agnostic-by-construction core; needs an ADR on whether to break that invariant.

## t_d6b5632b - [schema-packs] Schema mutation surface - primitives, pack-lock, MCP admin ops, CLI verbs, schema-author skill

**Follow-up to**: t_cbf4967f (foundation slice shipped in PR #52 / v0.25.0). This task carries the deferred mutation/admin surface that the foundation ADR explicitly parked.

**Builds on**: the runtime schema-packs foundation released in v0.25.0 - shared schema vocabulary (`src/core/brain/schema-vocab.ts`), `_brain.yaml schema:` parsing, inert `schema_type:` artifact metadata, and the read-only `o2b brain schema` report. ADR: `docs/brainstorm/runtime-schema-packs-foundation/adr.md`.

### What (deferred scope, not yet implemented)

The full "Schema Cathedral v3" surface from gbrain commit 3c1cc8a, on top of the now-shipped read-only foundation:

1. Mutation primitives - the 11 ops (`add_type`, `remove_type`, `update_type`, `add_alias`, `remove_alias`, `add_prefix`, `remove_prefix`, `add_link_type`, `remove_link_type`, `set_extractable`, `set_expert_routing`), each wrapped in an atomic `withMutation` (.tmp + fsync + rename) with a pre-write lint-validation gate.
2. Pack-lock - atomic file-level locking with stale detection (TTL + liveness probe) so concurrent writers cannot corrupt the schema.
3. MCP admin ops - the 9 operations for remote agents: `get_active_schema_pack`, `list_schema_packs`, `schema_stats`, `schema_lint`, `schema_graph`, `schema_explain_type`, `schema_review_orphans` (read scope), `schema_apply_mutations` (admin scope, batched), `reload_schema_pack`.
4. CLI verbs - the broader schema-management verb set beyond the read-only `o2b brain schema` report (stats with per-type counts / coverage / dead-prefix detection, chunked sync backfill, etc.).
5. schema-author skill - the discoverable 7-phase agent workflow (brain -> assess -> propose -> apply -> sync -> verify -> commit).
6. Mutate-audit - ISO-week JSONL audit log with privacy redaction.

### Why

The v0.25.0 foundation makes taxonomy declarable and inspectable but read-only. This task adds the safe write path so agents/operators can evolve the schema vocabulary at runtime with atomic guarantees, locking, and an audit trail - the production-grade authoring layer.

### Constraints / sequencing

- Gated by the foundation ADR; needs its own design pass before build.
- Must reuse the single validation boundary (`schema-vocab.ts`) rather than introduce a parallel vocabulary.
- Keep Markdown/YAML as the source of truth; mutations write through atomic file ops, no hidden registry DB.

### Status in OSB

- Verdict: foundation present (v0.25.0); mutation/admin surface absent.
- This is the explicitly-deferred remainder of t_cbf4967f.

## t_9eaebcad - [upstream:cavemem] Real-time session lifecycle hooks for memory capture

**Source**: https://github.com/JuliusBrussee/cavemem/releases/tag/v0.1.0
**Repo**: JuliusBrussee/cavemem (446\*)
**Released**: v0.1.0 (2026-04-18T00:48:33Z)

### What

cavemem hooks fire synchronously at session boundaries (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) to capture observations and write them to local SQLite storage in real-time. Hook handlers complete in under 150ms. A local worker auto-spawns on first hook to build embeddings and self-exits when idle.

### Why useful for OSB

OSB imports sessions post-hoc by parsing JSONL and rollout files (`src/core/brain/sessions/import.ts:117 importSession`) after they have been written by the IDE. Real-time lifecycle hooks would allow OSB to capture observations as they happen, enabling immediate memory availability during active sessions rather than waiting for the next import cycle. Particularly valuable for MCP search tool path where agents query memory mid-session.

### Status in OSB

- Verdict: not_in_osb_useful
- Code hints: `src/core/brain/sessions/import.ts`, `src/core/brain/sessions/claude.ts`, `src/core/brain/sessions/codex.ts`. No real-time hook system exists.

### Notes and comments

Five hook types map to natural OSB extension points: SessionStart (initialize context), UserPromptSubmit (capture intent), PostToolUse (capture tool outcomes), Stop/SessionEnd (finalize and compress). Auto-spawning worker pattern for embeddings could replace OSB current embedding strategy for session content.

Validator: clean, priority 2. Caveat: real-time lifecycle hooks are an architectural shift from post-hoc batch import; needs design.

## t_8d8ec450 - [upstream:TencentDB-Agent-Memory] Self-healing watchdog for brain gateway auto-recovery

**Source**: https://github.com/Tencent/TencentDB-Agent-Memory/releases/tag/v0.3.3
**Repo**: Tencent/TencentDB-Agent-Memory (3891\*)
**Released**: v0.3.3 (2026-05-08)

### What

TencentDB Agent Memory Hermes plugin includes a watchdog + lazy probe mechanism that detects gateway anomalies and automatically recovers without human intervention. The watchdog monitors plugin health and triggers lazy probe on failures, restoring connectivity and state automatically.

### Why useful for OSB

OSB has brain snapshot/restore (`src/core/brain/snapshot.ts:597 restoreSnapshot`) and rollback CLI (`src/cli/brain/verbs/rollback.ts:12 cmdBrainRollback`) but no continuous health monitoring or auto-recovery. A watchdog would detect vault corruption, MCP server disconnects, or search index degradation and attempt automatic remediation before requiring user intervention. This would improve reliability for always-on agent sessions.

### Status in OSB

- Verdict: not_in_osb_useful
- Code hints: `src/core/brain/snapshot.ts`, `src/cli/brain/verbs/rollback.ts`. Recovery is manual/CLI-driven, no background watchdog or health probe exists.

### Notes and comments

The watchdog pattern is lightweight - periodic health checks with exponential backoff retry. Could be implemented as a gateway background task that validates vault invariants (similar to brain_doctor) and triggers auto-restore from latest snapshot on critical failures.

Validator: clean, priority 2. Caveat: background watchdog / auto-recovery needs design on triggers and safety before any auto-restore from snapshot.

# Project context

Project: Open Second Brain, TypeScript/Bun runtime, Obsidian-compatible Markdown vaults, CLI + MCP server surfaces.

Recent commits:

- f62918c feat: runtime schema packs foundation - schema vocabulary, artifact taxonomy, schema inspection (#52)
- 14d1ee1 feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
- 3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2bd3f48 v0.17.0 - Brain Lifecycle Review Suite (#44)
- 9b87838 v0.16.0 - Agent boundary control surfaces (#43)
- 66980b2 ci: drop bun version floor, track latest only (#42)
- feca6a7 v0.15.0 - Cross-agent query foundation (#41)
- ffde4ac chore(release): v0.14.1 (#40)
- bc97b38 refactor: add validation toolchain and normalize project formatting (#39)
- b76199a v0.14.0 - Semantic Brain Health and Self-Maintenance (#38)
- 2147640 v0.13.0 - Hybrid Search and Recall Quality (#37)
- 84886d1 v0.12.0 - Brain Integrity Suite (#36)
- c002268 v0.11.0 - Brain-centric vault layout (#35)
- a8d4803 v0.10.18 - temporal axis (#34)
- d0598af v0.10.17 - link graph surfaces (#33)

Related files:

- `src/core/search/schema.ts`: FTS5 chunk_fts currently uses `tokenize='unicode61 remove_diacritics 2'`.
- `src/core/search/indexer.ts`: chunk content is read, chunked, and persisted through `Store.replaceChunks`; content currently goes to FTS unchanged.
- `src/core/search/search.ts`: query string goes directly into `runFtsQuery`; synonym/entity layers tokenize Latin-style terms only.
- `src/core/search/store.ts`: single SQL boundary and existing proper-lockfile pattern for index writer locking.
- `src/core/brain/schema-vocab.ts`: single validation boundary for built-in and `_brain.yaml schema:` vocabulary.
- `src/core/brain/schema-report.ts`: current read-only schema report with usage/finding logic.
- `src/cli/brain/verbs/schema.ts`: current `o2b brain schema [--json]` report command.
- `src/mcp/tools.ts` and `src/mcp/brain-tools.ts`: current MCP registry slices and scopes.
- `src/core/brain/sessions/import.ts`: post-hoc session import orchestrator writes signals via `writeSignal`.
- `src/core/brain/sessions/registry.ts`: adapter registry for Claude/Codex/Hermes import formats.
- `src/core/brain/snapshot.ts` and `src/cli/brain/verbs/rollback.ts`: manual snapshot extract/restore and rollback safety gate.
- `docs/brainstorm/runtime-schema-packs-foundation/adr.md`: accepted ADR says future mutation primitives should edit `_brain.yaml` atomically and keep no second store.

Conventions:

- Plain Markdown and `_brain.yaml` remain the source of truth; no hidden service or registry DB.
- New behavior should be default-off or byte-compatible when config is absent.
- CLI commands should support stable `--json` output where useful.
- MCP tools use a registry of `ToolDefinition` objects with scope filtering and small structured payloads.
- Search uses SQLite FTS5 plus optional embeddings. Optional native deps are already accepted for `sqlite-vec`; missing optional dependencies must degrade cleanly.
- Current package scripts: `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run typecheck`, `bun run test`, `bun run sync-version:check`.
- Active Brain preferences: no `Brain/active.md` exists in this repository workspace.

Constraints:

- Do not create a second schema registry DB.
- Do not make auto-restore from snapshots the default; recovery must be explicit/safe or plan-only unless the operator opts in.
- Do not break existing session import behavior.
- Do not require CJK segmenter packages for base installs; use optionalDependencies and soft failure / deterministic fallback.
- Keep changes SOLID/KISS/DRY and reuse existing boundaries.
- The final PR may be large, but it must stay below 10 feature themes.

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
