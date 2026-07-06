You are a senior software architect consulting on an Open Second Brain hardening release.

# Project

**Open Second Brain** — an Obsidian-native memory layer for AI agents. Plain Markdown the user owns, in the vault they already use. The agent reads/writes a `Brain/` directory of `.md` files through deterministic CLI / MCP tools. No daemon, no hidden state outside the vault.

- **Runtime:** Bun + TypeScript (`"type": "module"`, ESM), targets Node. Tests run via `bun test` (script `scripts/test`).
- **Lint/format:** oxlint + oxfmt. Typecheck: `tsc --noEmit`. `bun run validate` = typecheck + lint + test.
- **Versioning:** SemVer with **frozen public contracts** since 1.0.0 (MCP tool surface: tool names + input schemas + response-field meanings; CLI verb tree; documented config keys/env mirrors). New optional params and new response fields are additive (minor); renaming/removing/restricting is breaking (major).
- **Stability policy:** search schema changes carry a `LATEST_SCHEMA_VERSION` bump and require a reindex. The kernel calls no LLM; embedding providers are pluggable.
- **Current version:** 1.23.0. This work targets a follow-up minor/patch release.

## Conventions (from prior suites, must be respected)

- TDD: failing test first, then implementation; characterization tests pin behavior before refactors.
- One feature branch, atomic conventional commits, full suite green between commits. Each unit independently revertable.
- SOLID / KISS / DRY. No misleading fallbacks (a degraded path must log that it degraded, never silently fake success). No hardcoding of paths, sizes, or magic numbers.
- All repo-facing strings (code, docs, commits, CHANGELOG, config) are **English-only**; logic is abstracted to be multi-language (CJK correctness matters — there are dedicated Han/kana tests).
- NUL-byte sentinel files exist in `src/core/search/` (e.g. `search.ts`); plain grep silently skips them — workers use `command grep -a` or codegraph.
- Existing patterns for file locks: a dedicated lockfile path (the in-flight fix for t_f27d80fe uses `acquireReindexLock`/`isReindexInProgress` — a separate lockfile from the per-`Store.open` writer lock).

# Git context (recent history)

```
67bcb71c refactor: DRY and decomposition (Phases 0-2) (#121)   <-- merge commit, branch base
b9bbcb16 feat(brain): semantic entity dedup and cross-encoder rerank (1.23.0) (#120)
b8d709ee fix: keep full MCP status output and normalize codegraph paths (#116)
a98bed1d feat(brain): retrieval precision and quality loop (v1.22.0) (#118)
42816058 feat(brain): integrity & safety hardening suite (1.21.0) (#115)
313d061e feat: configurable skills_dir + trigger-keyword auto-attach scoring (#114)
```

A validated local fix for **t_f27d80fe** already exists on branch `fix/index-swap-hardening` (commit `ec3bad27`, not yet pushed/PR'd) — a dedicated reindex-level lock. The implementation phase may rebase/merge that onto this release branch rather than redo it.

# Scope: 4 tasks shipping together in one release

These four cards are driven **one at a time on a shared branch** `feat/pr121-hardening-correctness`. Each later card's worker must build on the commits the earlier cards landed and must not duplicate or conflict with siblings.

---

## TASK t_f27d80fe — Index-swap hardening: fix reindex/crash-restore data-loss races (P4)

Two interlocking races around the search-index rebuild. **Silent data-loss class — highest priority.**

**A.1 Concurrent `reindexVault` runs leave the live index unreadable.**
- Where: `src/core/search/indexer.ts:659,664` (pre-lock `tryUnlink(newPath)` + staging-db seed) and `src/core/search/store.ts:356-359`.
- Failure: run B deletes run A's in-progress staging DB before any lock, seeds a fresh empty staging DB at the same path. A finishes into the orphaned inode and its final `renameSync(newPath, dbPath)` renames B's EMPTY seed over the live index. An empty DB has no `index_state` table → every subsequent open throws `INDEX_UNREADABLE`, which `openReadOrSelfHeal` (search.ts:210-226) deliberately does NOT self-heal. Search broken until manual `o2b search reindex`.
- Trigger: a schema-bump upgrade bumps `LATEST_SCHEMA_VERSION`; every concurrent search surface (CLI + long-lived MCP server) hits `SCHEMA_MISMATCH` at once and each invokes `reindexVault`.
- Fix direction: acquire the writer lock BEFORE touching `newPath` (unlink + seed move inside the lock); second contender waits-or-bails. Consider `INDEX_UNREADABLE` joining the self-heal set once the swap is safe.

**A.2 Crash-restore can clobber a freshly built index with a stale copy.**
- Where: `src/core/search/indexer.ts:680-682` (swap: `tryUnlink(bak); tryRename(db->bak); renameSync(new->db)`) vs `src/core/search/store.ts:295-306` (every `Store.open` runs a lockless crash-restore preamble: `existsSync(db)==false && existsSync(bak) -> renameSync(bak, db)`).
- Failure: a concurrent open in the window between `rename(db->bak)` and `rename(new->db)` restores the STALE pre-reindex snapshot, silently discarding the whole rebuild (incl. paid embeddings), with a misleading "restored" note.
- Fix direction: hold the writer lock across the swap AND make the crash-restore preamble probe the same lock; alternatively gate the restore on a marker file the swap removes last. Must keep genuine crash-recovery working (pin with a test).

**In-flight validated fix (commit ec3bad27):** dedicated reindex-level lock (`acquireReindexLock`/`isReindexInProgress` in store.ts, separate lockfile from per-Store.open writer lock) held across the entire reindexVault sequence — staging build through final rename. Second concurrent reindexVault fails fast with existing typed `INDEX_LOCKED`. `Store.open`'s crash-restore preamble checks `isReindexInProgress` (non-blocking) and skips restoring while a reindex is actively running. 3 new regression tests: second reindexVault rejected while one in progress; Store.open does not restore `.bak` mid-reindex; genuine crash-restore still works.

## TASK t_2ba5f0c9 — Validation/output hardening (P4): four small independent fixes

**B.1 `created_at` accepted with only a `YYYY-MM` prefix check.**
- Where: `src/mcp/brain/generation-tools.ts:88-90` → `src/core/brain/generation-reports.ts:88,106-111` → `src/core/brain/continuity/store.ts:42-45,176`. Latent hole via `host-memory-write.ts:103` and `session-summary.ts:95`.
- Failure: `"2026-13-01T00:00:00Z"` passes (junk `2026-13.jsonl` shard); `"2026-07-06T15:00:00+03:00"` passes then mis-sorts/mis-filters vs the fleet of `Z` timestamps (lexical compare at store.ts:213,222-223), shards into local-time month across boundaries.
- Fix: validate full timestamp at the continuity-store boundary (canonical UTC `Z` form, real calendar date), reject with structured error. Contract tightening: previously-accepted garbage → INVALID_PARAMS.

**B.2 Card snippet truncation can split a surrogate pair.**
- Where: `src/core/search/search.ts:1121-1126` (`cardSnippet`: `collapsed.slice(0, CARD_SNIPPET_CHARS)`, `CARD_SNIPPET_CHARS=240`). File has a NUL-byte sentinel.
- Failure: UTF-16 units 239/240 straddling an astral char (emoji, rare CJK) → lone surrogate rendered as U+FFFD, then "...". Flows into MCP `cards` disclosure surface.
- Fix: truncate on code points (`[...collapsed]` or `Intl.Segmenter`). Changes output bytes for affected inputs.

**B.3 Query-demand `since`/`until` precision-inconsistent filtering.**
- Where: `src/core/brain/query-demand.ts:238-239` (lexical compare) vs `:448-453` (`normalizeDemandTimestamp`, exists to fix this class); raw filter strings from `knowledge-gaps.ts:23` and `recall-tools.ts:291`.
- Failure: second-precision `--since 2026-07-01T00:00:00Z` lexically excludes every stored ms-precision record in `[00:00:00.000Z, 00:00:00.999Z]` because `.` sorts before `Z` — up to one second of records wrongly dropped at each boundary.
- Fix: run filter bounds through `normalizeDemandTimestamp` before comparing.

**B.4 Secret-exec audit trail can persist a foreign bare secret.**
- Where: `src/core/brain/secrets/exec.ts:88,96-108` — audit records log `command = argv.join(" ")`; `appendAuditRecord` (`reliability/audit.ts:22`) redacts with default key=value-shaped patterns only.
- Failure: agent passing some OTHER plaintext credential as a bare positional (`["mytool", "sk-abc123"]`) lands it in `Brain/log/secret-custody/*.jsonl` in cleartext; shaped patterns don't match bare tokens. Severity low but audit file is long-lived.
- Fix: redact the logged `command` with `redactInfra: true` and/or a high-entropy-token pass before persisting.

## TASK t_1224c740 — Hot-path performance (P4): six items, each reviewable

**C.1 Entity registry re-read from disk on every search query.**
- Where: `src/core/search/entity-alias.ts:45` → `src/core/brain/entities/index-builder.ts:80-106` (NUL file); second payer `src/core/search/query-expansion.ts:106`. Per-write rebuilds in `entities/registry.ts` are tolerable; per-QUERY rebuild is not.
- Cost: `readdirSync` + `readFileSync` + frontmatter parse of every file under `Brain/entities/` per query that names an entity. At 500-2000 entities that dwarfs the FTS/vector lookup.
- Fix: mtime-keyed memo (dir mtime probe per query, full rebuild on change). Staleness-window trade-off (write within mtime granularity → one stale read).
- Test: invalidation test (write → next query sees the new entity).

**C.2 `documents.basename` column to kill SUBSTR full scans.**
- Where: `src/core/search/store.ts:1064-1086` (`resolvedDocLinkPairs`) — per unresolved link a COALESCE falls through to a `SUBSTR(d.path, ...)` suffix match plus an identical COUNT(*) uniqueness scan; neither can use `idx_documents_path`.
- Cost: dangling wikilinks never materialize, so every `brain_bridges`/cluster call re-pays 2 full `documents` scans per dangling link — at 5k docs / 2-5k dangling links, tens of millions of row visits per call.
- Fix: add a `basename` column (populated at index time) with an index; rewrite suffix matches as equality joins. **Schema version bump + reindex required.**

**C.3 `buildBacklinkIndex` cross-call cost model.**
- Where: `src/core/brain/backlinks.ts:268-272` and per-tool-call callers (`query-tools.ts:250`, `resources.ts:369`, `doctor.ts:930`, `explorer.ts:88`, moc-audit, concept-cluster). Every call reads+parses the ENTIRE log history; grows unboundedly with brain age. Per-date dir rescan and digest double-build were fixed in PR #121 (no-behavior-change); this is the remaining cross-call recompute.
- Fix: mtime/generation-keyed memo (staleness trade-off, like C.1) OR incremental log cursor. "Recompute on demand" is a documented design choice — revisit deliberately, not drive-by.

**C.4 Heal-enrich per-page regex rebuild.**
- Where: `src/core/brain/heal-run.ts:76-88` + `src/core/brain/heal-enrich.ts:42-58`. Per page, re-sorts all K known phrases and recompiles a K-branch alternation regex; at 5k pages × 5k phrases = 5k compiles of a ~100-500KB pattern per dream heal run. Opt-in flag + dream-time-only already mitigate.
- Fix: sort once, compile once, post-filter self-matches per page. Also drop the duplicate frontmatter parse at heal-run:80.

**C.5 `links normalize --mode short` quadratic resolution.**
- Where: `src/cli/brain/verbs/links.ts:72-86`, `format-wikilink.ts:60-69,76-90`. O(files × links × pages) `endsWith` scans + fresh P-sized array allocation per link; minutes of wall clock at 5k pages / 100k links.
- Fix: build a basename→paths Map once per run; resolve+disambiguate against it. **Output must stay byte-identical — pin with a fixture before optimizing.**

**C.6 Continuity store full-history reads for "find latest".**
- Where: `src/core/brain/continuity/store.ts:190-215` (`readAllRecords` parses every shard then filters); "latest"-seeking consumers at `session-summary.ts:182`, `pre-compact-extract.ts:148`, recall-telemetry/memory-cost/context-receipts full reads per call.
- Fix: date-named shards allow a `since`-aware file skip and reverse-chronological early exit for latest-record queries.

Sequencing note from the card: C.1 + C.2 are the biggest per-query wins; C.2 rides a schema bump which pairs naturally with a minor release. Remaining items opportunistic, each with a before/after measurement on a synthetic large vault.

## TASK t_3ccb1512 — Han-bigram tokenizer: restrict bigrams to contiguous Han spans (P3)

- `tokenize()` in `src/core/surface/lexical-score.ts` emits overlapping 2-char bigrams for any token containing a Han char with length > 2. For a *mixed* token (`gbrain实现`, no separator) windows span the ASCII/Han boundary → bigrams like `n实`: inert noise (match nothing real) but inflate term frequency/document length.
- A Han run of exactly 2 chars in a longer mixed token (`ab实现cd`) is gated by total length not run length → inconsistent vs a standalone 2-char Han token.
- Desired: extract bigrams only from maximal contiguous Han spans, leaving non-Han segments untouched; full token still emitted. Removes cross-script noise; makes "Han" scope precise (docstring already says Han-only).
- Acceptance (TDD): `tokenize("gbrain实现")` emits `实现` + full token, NO `n实`; `tokenize("ab实现cd")` emits `实现`; pure-Han and pure-ASCII unchanged; no duplicate emission for standalone 2-char `实现`.
- Out of scope: widening beyond Han (kana/Hangul/CJK extensions).

# Related source files (already inspected)

- `src/core/search/indexer.ts` (reindex swap sequence ~659-682), `src/core/search/store.ts` (crash-restore preamble ~293-306, schema-version gate ~340, `resolvedDocLinkPairs` ~1064-1086)
- `src/core/search/search.ts` (`cardSnippet` ~1121-1126, `openReadOrSelfHeal` ~210-226) — NUL-byte sentinel
- `src/core/brain/continuity/store.ts` (created_at handling ~42-45,176,213,222-223; `readAllRecords` ~190-215)
- `src/core/brain/query-demand.ts` (since/until ~238-239, `normalizeDemandTimestamp` ~448-453)
- `src/core/brain/secrets/exec.ts` (~84-112), `src/core/brain/reliability/audit.ts` (~22)
- `src/core/brain/entities/index-builder.ts` (~80-106, NUL file), `src/core/search/entity-alias.ts:45`, `src/core/search/query-expansion.ts:106`
- `src/core/brain/backlinks.ts` (~268-272), `src/core/brain/heal-run.ts` (~76-88), `src/core/brain/heal-enrich.ts` (~42-58)
- `src/cli/brain/verbs/links.ts` (~72-86), `src/core/brain/link-graph/format-wikilink.ts` (~60-90)
- `src/core/surface/lexical-score.ts` (`tokenize`)

# Your task

Produce exactly THREE distinct architectural variants for delivering this four-task hardening+correctness+performance release on a single shared branch, then exactly one recommendation.

A "variant" is a *release-shaping* decision: how the 13 atomic fixes (2 in t_f27d80fe, 4 in t_2ba5f0c9, 6 in t_1224c740, 1 in t_3ccb1512) are grouped/sequenced/committed, how the schema-bump items (C.2) interact with the frozen search schema contract and the reindex requirement, how the in-flight validated fix (ec3bad27) is reconciled with a fresh implementation on the release branch, how staleness-window memoization (C.1, C.3) is exposed/contained, and how the output-byte-changing fixes (B.2, C.5 byte-identical pin) are de-risked. Consider: should everything ship as one minor, or split? Should the schema bump ride with t_f27d80fe's self-heal change or stay independent? Are the low-risk correctness fixes (B.1-B.4, t_3ccb1512) better landed first to stabilize, or last to avoid merge churn against the bigger perf work?

For EACH variant give:
- **Approach** (2-3 sentences)
- **Trade-offs** (bullets)
- **Complexity** (small | medium | large)
- **Risk** (low | medium | high)

Then exactly one line: **Recommended: Variant N** followed by a concise rationale (why it best fits the project's frozen-contract stability bar, TDD discipline, and reviewability).

Variants and recommendation ONLY. No code. No sections outside the three variants + the recommendation.
