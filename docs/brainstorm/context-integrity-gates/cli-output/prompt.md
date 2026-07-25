You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release wave called "context integrity gates" across ten units of work in Open Second Brain. The unifying thesis: **every silent failure in the read and delivery path becomes an explicit, named one.** Today each of these ten defects degrades quietly - recall gets thinner, a pack gets staler, a note disappears from the index - and neither the agent nor the operator can distinguish a genuine miss from a broken mechanism.

The ten units, with reconnaissance already completed against the live codebase:

## A. Owner-scope isolation across every context-delivery surface

`isOwnerVisible(owner, scope)` (`src/core/graph/agent-scope.ts:59`) is the single isolation rule. It has exactly two callers: `applyAgentScope` (`src/core/search/result-filters.ts:253`, reached only from `search()` at `src/core/search/search.ts:988` when `SearchOptions.agentScope` is non-null) and `isPreferenceVisible` (`src/core/brain/owner-scoped-facts.ts:30`, used by `brain_query` but gated behind the `guardrails.owner_scoped_facts` flag, default false).

Every other content-returning surface bypasses it: `brain_context_pack`, `brain_anticipatory_context`, `brain_retrieval_plan`, `brain_pre_compress_pack`, `brain_brief`, `brain_file_context`, `brain_search_expand`, `brain_deep_synthesis`, and `brain_context` (the documented session-bootstrap surface, whose input schema is `{properties:{}, additionalProperties:false}` - it takes no arguments at all). `ContextPackOptions` (`src/core/brain/context-pack.ts:136`) has no owner field. `brain_search_expand` reaches full note bodies through `expandHit` (`src/core/search/cards.ts:67`) keyed on a sequential integer `chunk_id`, with no frontmatter check - an enumeration surface. `refreshAnticipatoryCache` (`src/core/brain/anticipatory-cache.ts:186`) persists an unfiltered pack to a disk file whose path is keyed only on the session-lineage root.

Structural obstacle: there is no shared preference collector. Roughly ten independent `readdirSync(dirs.preferences)` loops exist (`active.ts:199`, `context-pack.ts:262`, `pre-compress-pack.ts:88`, `morning-brief.ts:74`, `digest.ts:703`, `dream.ts:1010`, `doctor.ts:1067`, `explorer.ts:95`, `vitals.ts:71`, `attention-flows.ts:196`). There is also no agent identity on `ServerContext` (`src/mcp/tool-contract.ts:34`), though `resolveAgentName(configPath)` exists at `src/core/config.ts:191`.

Mitigating fact: no writer sets `owner` today - `writePreference` accepts `input.owner` (`src/core/brain/preference.ts:421`) but no MCP handler or CLI verb passes it. The leak is latent: it activates for the operator who hand-tags `owner:` in note frontmatter and reasonably assumes isolation holds everywhere.

Tension: every module here documents a "null scope is byte-identical to today" contract. Defaulting a surface's scope from `resolveAgentName` would silently narrow existing vaults.

## B. Context packs bound to a source generation and a validity window

`ContextPackReport` (`src/core/brain/context-pack.ts:118`) carries no timestamp, no generation, no expiry. The one place a pack is serialized is the anticipatory cache: `CacheFile` (`src/core/brain/anticipatory-cache.ts:79`) has `schema`, `generated_at`, `max_tokens`, and the context. On a stale read, `readAnticipatoryContext` (`:199`) silently rebuilds live and reports `cache_state: "stale"` - never an error.

The best existing generation source is `Store.corpusGeneration()` (`src/core/search/store.ts:567`), formatted by `computeCorpusGeneration` (`src/core/search/corpus-generation.ts:29`) as `model|dim|schemaVersion|indexRevision`, where `indexRevision` bumps only when an index run changed something. It is already proven as a fail-closed serving gate: `queryCacheSweep` (`store.ts:604`) deletes cache rows whose generation differs.

Central correctness tension: `packContext` does not read the search index at all - it walks the filesystem directly (`readdirSync` over `brainDirs(vault)`, `context-pack.ts:258`). So `corpusGeneration()` is a lagging proxy: a hand-edited note changes the pack but does not bump `index_revision` until a reindex runs. Alternatives found: `buildManifest` (`src/core/brain/manifest.ts:58`, sha256 per file - byte-accurate but hashes the whole tree per call) and `computeSourceStamp` (`src/core/brain/freshness.ts:89`, the repo's existing "stamp what you were derived from, verify on read" idiom, per-source rather than global, with explicit `missing`/`unreadable` sentinels).

## C. Session continuation, fail-closed

Continuity is selected at exactly one point: `resolveCrutchLineage` (`src/core/brain/lineage/crutch.ts:40`), reached from `resolveSessionLineage` (`lineage/resolve.ts:68`). It matches on a conjunction of: session not already in the ledger, exact string equality on `cwd`, predecessor's latest event carries compression evidence, and age within `CRUTCH_LINK_WINDOW_MS = 900_000` (`lineage/ledger.ts:34`).

Two defects. First, the multi-candidate tie-break is **most-recent-wins** (`crutch.ts:64`), not abstain - two concurrent sessions in the same directory inside the window silently stitch. Second, the return type is `SessionLineage | null`, so four distinct null causes (no candidate / self already known / no cwd / several candidates) are indistinguishable to every caller.

No repo, branch, or commit is captured for a session anywhere. The hook payload carries only `cwd`. `git rev-parse` appears once in the entire repo (`src/core/brain/git/reader.ts:159`); there is no `symbolic-ref`, no `rev-parse HEAD`, no `remote get-url`. There is no git-remote credential normalization: `BASIC_AUTH_URL_RE` (`src/core/redactor.ts:152`) redacts `scheme://user:pass@` but is opt-in (`redactInfra`, default off) and produces a redaction, not a canonical identity key.

Consequence of a mis-stitch: the anticipatory cache path is derived purely from the lineage root (`anticipatory-cache.ts:102`), so a wrong stitch redirects one conversation's cache into another's file.

## D. Session-lineage ledger hardening

`src/core/brain/lineage/ledger.ts` is an append-only JSONL with no sequence numbers, no hash chain, no writer lock, and no startup verification. `recordLineageObservation` (`:173`) wraps its entire body in `try {} catch {}` - fail-soft by explicit contract.

Compaction (`:180-210`) is lossy in four ways: 512 lines collapse to at most 256, one summary line per session; per-session event history is destroyed; `firstSeenMs` is dropped entirely (the compacted line carries only `lastSeenMs`); sessions ranked 257+ by recency are deleted. The re-serializer hard-codes its field list, so any field added to the writer but not mirrored there is silently lost at the next compaction.

The compaction branch is a read-modify-write with no mutual exclusion: two concurrent hooks crossing the cap both read 512 lines, both compact, and the second write clobbers the first.

Design tension recorded during triage: this ledger is *deliberately* fail-soft, because continuity is a best-effort crutch and not a security boundary. A fully fail-closed ledger that refuses to start on a corrupt line could break crutch resolution rather than degrade gracefully.

## E. Embedding-store ABI and dimension mismatch

`index_state` (`src/core/search/schema.ts:173`) already stamps `embedding_model` and `embedding_dimension` (`store.ts:1033`). The sqlite-vec version is stamped nowhere - `SELECT vec_version()` is executed at three sites (`store.ts:221`, `indexer.ts:968`, a test helper) and the row is discarded every time.

The existing compare (`ensureEmbeddingModel`, `store.ts:984`) runs **only on a write-mode open** (`store.ts:470`). A read-only consumer - which is every MCP query - never reaches it, so `semanticTopK` (`store.ts:1712`) runs `WHERE v.embedding MATCH ?` against a `chunk_vec` of unknown declared width with no model or dimension check. That is the silent-garbage path.

Self-heal is `openReadOrSelfHeal` (`src/core/search/search.ts:166`), triggering on exactly `INDEX_MISSING | SCHEMA_MISMATCH | INDEX_UNREADABLE`. Critical trap: it calls `reindexVault(config)` with no options (`search.ts:176`), so `opts.embeddings` is undefined and the rebuild is keyword-only - **routing a vector mismatch into the existing self-heal as-is would not rebuild the vectors.**

Precedent to mirror: the embedding prefix pair (`EMBEDDING_PREFIX_QUERY_STATE_KEY`, `store.ts:47`) is exactly this mechanism - a compat token stamped at build time, compared later, surfaced as a reindex-required warning rather than a hard heal.

Risk: `vec_version()` is not stable across environments. Two Syncthing peers on different sqlite-vec builds would each see a mismatch and each trigger a full rebuild - a possible rebuild loop.

## F. Malformed frontmatter reported instead of silently dropped

The premise recorded in the tracker was wrong and the reality is worse. `parseFrontmatterText` (`src/core/vault.ts:78`) is a line-based `key: value` scanner, not a YAML parser. It **cannot throw**. Its documented contract (`vault.ts:58`) is "lines that don't match are silently skipped" - the drop is at `vault.ts:113`, `if (!kv) continue`. A note is therefore never dropped from the index; instead individual frontmatter fields vanish, leaving the page untyped, unaliased, or undated with zero trace in `IndexStats` (`src/core/search/types.ts:264`, which has no `scanned` and no `skipped` field).

Commit 426d06f8 was exactly this class of bug found in the field: block-style YAML lists were silently dropped and produced spurious "missing field" errors in `o2b brain doctor`. The fix added a grammar branch but no diagnostic channel, so the next unsupported grammar fails the same silent way.

About fifteen call sites additionally swallow the reader with bare `catch { continue }` (`query.ts:330`, `context-pack.ts:269`, `heal-run.ts:86`, `claim-graph.ts:124`, `procedural-graph.ts:189`, `source-cleanup.ts:250`, `idea-discovery.ts:180`, and others), several with comments deferring to "the doctor's concern". Two sites do it right and are the precedent: `dead-ends.ts:183` (pushes a warning with the path) and `dream.ts:974` (accumulates `corrupted` entries and emits a `skip-corrupted-frontmatter` log event).

One malformed case is already reported: an unterminated block yields a chunker warning (`src/core/search/chunker.ts:137`) forwarded into `IndexStats.errors` (`indexer.ts:397`).

Reporting surfaces are split: `runDoctor`/`DoctorIssue` (`src/core/brain/doctor.ts:206`, `src/core/brain/types.ts:1665`) is CLI-only and already has an `uncertain: DoctorUncertainEntry[]` extension point for "attempted but cannot claim completed cleanly"; `vault_health`/`CheckResult` (`src/mcp/tools.ts:176`, `src/core/types.ts:17`) is a different core entry point for install and manifest checks.

## G. Vault-wide broken-link ratchet gate

The premise here was also wrong: **no vault-wide broken or dangling link count exists anywhere in the codebase.** The tracker's anchors point at graph-degree filter machinery. The ratchet needs both a counter and a ceiling.

Primitives that exist: `links.target_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL` (`src/core/search/schema.ts:164`) - a dangling link is exactly `target_document_id IS NULL AND target_path IS NOT NULL`; two resolution passes run per index run (`store.ts:1088`, `store.ts:1141`); `extractWikilinks` (`src/core/vault.ts:297`). A Brain-scoped, deliberately narrow counter exists in the doctor (`checkBrokenBacklinks`, `doctor.ts:1016`), which skips anything not matching `^(pref|ret|sig)-` because "wikilinks pointing outside the Brain layer are user prose and not our concern".

Definition hazard: read-time link resolution applies a further conservative ladder (materialized id, then `<target>.md` exact, then unambiguous basename suffix) at `store.ts:1193` and siblings. A link can be `target_document_id IS NULL` in SQL yet resolvable at read time. The design must pick one definition and state it. Second hazard: `resolveAliasTargets` only populates aliases for documents changed in that run, so a count taken after an incremental run can differ from one taken after a forced full run.

The precedent to copy exactly is `scripts/sync-version.ts`: a committed invariant plus a `--check` form that is the same code path with writing disabled (`updateFile(rel, regex, version, !check)`), returning 1 on drift, wired into CI as a named npm script (`sync-version:check`) in both `ci.yml` and `release.yml`. There is no committed baseline or ceiling data file in this repository yet, so this unit establishes that convention.

## H. Injection-size meter for the SessionStart eager layer

`hooks/active-inject.ts` composes the eager layer in `assembleActiveContext` (`:161`) from exactly two parts: rendered runtime notices, and an active body that is itself `Brain/active.md` plus `Brain/lessons.md`, each budgeted separately against the same `inject_budget_chars` value (so the effective ceiling is twice the configured one - itself a finding). The three sub-bodies exist as separate strings only inside that function; `parts.join("\n\n")` at `:172` discards the split.

Nothing measures the emitted string. No `estimateTokens` call and no length accounting exists anywhere in `hooks/`. The canonical estimator already exists (`estimateTokens`, `src/core/brain/text/tokenizer.ts:35`), as do `computeTokenFootprint` (per-category token attribution over the vault) and `computeActiveBudgetPressure` (per-section byte breakdown of active.md, currently a doctor probe only).

The natural sink is `emitContextReceipt` (`src/core/brain/context-receipts.ts:85`), but its trigger enum is `"context_pack" | "pre_compress"` and its only two callers are the two pack builders - no hook emits a receipt today.

Hard constraint: the hook path is fail-soft by absolute contract (the wrapper script always exits 0) and runs under a process ceiling. `emitContextReceipt` writes to the continuity store under `acquireLockSync`, so a lock contention throw would be new failure surface on the SessionStart path. Also `active-inject` fires on PostCompact too, so it will record two events per compacted session.

Two triage claims were verified false and must not be carried into the design: `inject-governor.ts` is the belief-lifecycle recall governor and is not on the injection path at all; and pinned context is not part of the eager layer (it rides only the `brain_context` pull path).

## I. Session-scoped retrieval receipt

Reconnaissance verdict: REDUCE. All primitives exist and are durable - `context_receipt` records carry per-item id, path, tokens, tier, trimmed, safety_filtered, epistemic, evidence refs and text hashes; `recall_telemetry` carries `topArtifacts` with scores; `recall_observed_use` carries per-artifact USED/IGNORED/CONTRADICTED with a lifetime `observedReuseRates` fold. What is missing is only the fold: nothing joins receipts across a session, `listContextReceipts` has four callers and all of them map one summary per record, and `observedReuseRates` takes no session or time filter. Receipt emission is also opt-in (`receipt: true`), so a session where no caller asked for one produces nothing.

## J. Guard against writes to an unexpected memory-store location

Verdict: BUILD. `resolveVault` (`src/core/config.ts:161`) has five branches; four return a path with zero existence validation (env `VAULT_DIR`, active profile, config `vault:` key), and the fifth (the pointer file) stats but fails soft. No vault-identity marker exists anywhere. Every Brain write funnels through `brainDirs(vault)` (`src/core/brain/paths.ts:161`, containment check only) and lands in `withTempFile`, which calls `mkdirSync(dir, {recursive: true})` (`src/core/fs-atomic.ts:156`) - so a mis-resolved root is materialized by the first write.

The diagnostic that should catch this actively masks it: `runDoctor` returns `{errors: [], trust_verdict: "clean"}` when `Brain/` is absent (`src/core/brain/doctor.ts:210-222`). `vault_health` catches only a missing root and stops catching anything once the first write creates it. `brain_switch_vault` can activate a profile pointing at a non-existent directory (`profiles.ts:109`), failing in a later process. The OpenClaw entry point silently defaults to the current working directory (`src/openclaw/index.ts:31`).

The desired shape already exists in the codebase and has simply never been applied to the vault root: `json-source.ts:139` throws `noDefaultDirMessage` rather than guessing.

# Project context

Open Second Brain - TypeScript on the Bun runtime, an agent-owned second brain over an Obsidian-compatible Markdown vault, exposed as a CLI (`o2b`) and an MCP server (108 tools). The kernel is deterministic and calls no LLM. Current version 1.38.0; this wave targets 1.39.0.

Recent commits:

```
c31a2574 feat: semantic-health baseline watermark (v1.38.0) (#148)
b0c37977 feat: retrieval quality and context delivery (v1.37.0) (#146)
842d690f feat: knowledge intake and consolidation (v1.36.0) (#145)
95dc8577 feat: trusted recall and memory write surface (v1.35.0) (#144)
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
```

The house release shape is a multi-unit wave: 1.37.0 shipped nine units, 1.36.0 shipped eight, each with one or two shared seams named explicitly in the changelog as carrying the wave.

Related files: as cited inline above.

Conventions (all verified against the codebase):

- Exit codes: 0 success or fail-soft skip, 1 operational failure, 2 usage error. `okJson` emits `{ok: true, ...payload}`; the failure idiom is `okJson({ok: false, message})` then return 1.
- Config: `_brain.yaml` parsed by a hand-written subset parser (max two levels of nesting). An invalid value must raise `BrainConfigError` at load; the file states "clamping silently would mask the operator's intent". New optional blocks use the `DEFAULTS` constant plus a `resolve*()` twin rather than parse-time merging.
- Writes: `withFileLock(target, {staleMs: 30_000, retries: 3}, cb)` around a read-modify-write, then `atomicWriteText(path, text, {validate: candidate => reparse(candidate)})` so an unparseable file can never land.
- MCP: an additive field on an existing tool's response changes no pinned count, provided the tool declares no `outputSchema`. Convention is a conditional spread (key absent, never null, when inapplicable) and camelCase core to snake_case wire.
- Every new surface must be byte-identical to the previous release when its flag, parameter, or config key is absent. This contract is stated in module docblocks throughout and enforced by tests.
- The repository draws a deliberate line: capture and injection paths swallow all errors, while serving gates fail closed.

Constraints:

- No stub implementations and no do-nothing fallbacks. A fallback that silently returns an empty or default result where an error occurred is the specific anti-pattern this wave exists to remove; do not introduce new instances of it.
- No hardcoded natural-language word lists in any language. Classification and gating must be structural (explicit frontmatter fields, corpus frequency, typed vocabulary), never keyword matching against a fixed set of words.
- No new external dependencies.
- The kernel calls no LLM. Everything here must be deterministic.
- SOLID, KISS, DRY. Extract shared logic rather than repeating a predicate across ten call sites.
- Implementation proceeds unit by unit under test-driven development on one branch, shipped as one pull request and one release.

# Required output format

Produce exactly 3 distinct architectural variants for how to structure this wave as a whole - how the ten units decompose, what shared seams (if any) carry them, what lands in this release versus what is deliberately deferred, and how the fail-closed and fail-soft boundary is drawn. Variants must differ in structure, not merely in ordering.

For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
