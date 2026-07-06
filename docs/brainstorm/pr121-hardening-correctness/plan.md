# PR #121 hardening + correctness — implementation plan

One feature branch (`feat/pr121-hardening-correctness`), four cards driven **one at a time** in risk order, each a contiguous commit cluster with per-fix TDD (failing test first). Full suite green between cards. Each later card builds on the commits earlier cards landed — do not duplicate or conflict with siblings.

Drive order (matches `design.md` Chosen approach):
1. `t_f27d80fe` — index-swap hardening (stabilizes the base; the forced reindex from C.2 will exercise this path).
2. `t_2ba5f0c9` — validation/output hardening (low-risk correctness).
3. `t_3ccb1512` — Han-bigram tokenizer (low-risk CJK correctness; its tokenization change is absorbed by the C.2 reindex).
4. `t_1224c740` — hot-path performance, ending with C.2 (the schema bump + version bump, the release-defining commit).

---

## Task 1: Index-swap hardening — fix reindex/crash-restore data-loss races (kanban t_f27d80fe, P4)

Rebase the validated local fix `ec3bad27` (branch `fix/index-swap-hardening`) onto this release branch as the first commit cluster, then extend it with the `INDEX_UNREADABLE` self-heal as a separate follow-on commit.

**Files:**
- `src/core/search/store.ts` — `acquireReindexLock` / `isReindexInProgress` (a dedicated lockfile, separate from the per-`Store.open` writer lock); `Store.open` crash-restore preamble (~293-306) probes `isReindexInProgress` non-blocking and skips restoring while a reindex is actively running.
- `src/core/search/indexer.ts` — `reindexVault` acquires the reindex lock BEFORE touching `newPath` (the `tryUnlink(newPath)` + staging seed at ~659,664 move inside the lock); second concurrent `reindexVault` fails fast with the existing typed `INDEX_LOCKED`.
- `src/core/search/search.ts` (NUL-byte sentinel — use `command grep -a`) — `openReadOrSelfHeal` (~210-226) self-heal set extended to include `INDEX_UNREADABLE`.
- `tests/core/search/` — the 3 regression tests from `ec3bad27` (second `reindexVault` rejected while one in progress; `Store.open` does not restore `.bak` mid-reindex; genuine crash-restore still works) + a new self-heal test asserting `INDEX_UNREADABLE` is recovered.

**Acceptance (a passing test):**
- Integration test that starts two overlapping `reindexVault` runs (the second entering during the first's build phase) and asserts the surviving index is complete and readable — NOT an empty DB, NOT `INDEX_UNREADABLE`.
- `Store.open` does not restore `.bak` during an in-flight reindex (interleaved open-during-swap test).
- Genuine crash-restore path still green (the existing crash-restore test stays green).
- `INDEX_UNREADABLE` is now self-healed by `openReadOrSelfHeal` (new test).

**Depends on:** none (first card; stabilizes the base for the rest).

---

## Task 2: Validation/output hardening — four independent fixes (kanban t_2ba5f0c9, P4)

Land as up to four commits (one per fix), each TDD. B.1 is the contract-tightening gate (previously-accepted garbage → `INVALID_PARAMS`) — it is why the release is a minor.

**B.1 — `created_at` full-timestamp validation**
- **Files:** `src/core/brain/continuity/store.ts` (boundary ~42-45,176; lexical compare at 213,222-223); possibly a shared validator extracted from `normalizeDemandTimestamp` (DRY — see B.3).
- **Acceptance:** table-driven accept/reject at the store boundary — `"2026-13-01T00:00:00Z"` rejected (invalid month), `"2026-07-06T15:00:00+03:00"` rejected or canonicalized to `Z` (reject is simpler and matches the contract tightening); valid canonical `Z` timestamps accepted; one MCP-level case per exposed tool (`generation-tools.ts`, `host-memory-write.ts`, `session-summary.ts`).

**B.2 — surrogate-safe card snippet**
- **Files:** `src/core/search/search.ts` (NUL file) — `cardSnippet` (~1121-1126, `CARD_SNIPPET_CHARS=240`) truncates on code points (`[...collapsed].slice(0, N).join("")` or `Intl.Segmenter`).
- **Acceptance:** snippet fixture with an emoji astral char at the truncation boundary asserts no lone surrogate / no U+FFFD; the snippet ends on a complete code point followed by `...`.

**B.3 — `since`/`until` precision-consistent filtering**
- **Files:** `src/core/brain/query-demand.ts` — filter bounds (~238-239) run through `normalizeDemandTimestamp` (~448-453) before the lexical compare. Consider extracting a shared canonical-UTC normalizer reused by B.1 (DRY).
- **Acceptance:** boundary fixture — a second-precision `--since 2026-07-01T00:00:00Z` does NOT exclude ms-precision records in `[00:00:00.000Z, 00:00:00.999Z]`.

**B.4 — secret-exec audit redaction**
- **Files:** `src/core/brain/secrets/exec.ts` (~88,96-108) — the logged `command = argv.join(" ")` is redacted (`redactInfra: true` and/or a high-entropy-token pass) before `appendAuditRecord` persists it.
- **Acceptance:** audit fixture asserting a bare `sk-`-shaped token passed as a positional argument is masked in `Brain/log/secret-custody/*.jsonl`.

**Depends on:** Task 1 (build on the stabilized base).

---

## Task 3: Han-bigram tokenizer — restrict bigrams to contiguous Han spans (kanban t_3ccb1512, P3)

TDD-first per the card's acceptance. Its tokenization change is absorbed by the single C.2 reindex at release (no separate schema bump here).

**Files:**
- `src/core/surface/lexical-score.ts` — `tokenize` extracts bigrams only from maximal contiguous Han spans within each token, leaving non-Han segments untouched; the full token is still emitted as today.
- `tests/core/surface/lexical-score.test.ts` — the four acceptance cases below.

**Acceptance (a passing test):**
- `tokenize("gbrain实现")` emits the Han bigram `实现` and the full token, and NO cross-boundary bigram (`n实`).
- `tokenize("ab实现cd")` emits `实现`.
- Pure-Han and pure-ASCII tokenization unchanged (existing tests stay green).
- No duplicate emission for a standalone 2-char Han token (`tokenize("实现")` stays `["实现"]`).

**Depends on:** Task 2 (lands before the perf card; its tokenization change rides the C.2 reindex).

---

## Task 4: Hot-path performance — six items (kanban t_1224c740, P4)

Land the five contract-neutral items first (C.1, C.3, C.4, C.5, C.6), then C.2 as the release-defining commit (schema bump + version bump). Each item carries a before/after measurement on a synthetic large vault where the card calls for it.

**C.1 — entity-index mtime memo (biggest per-query win)**
- **Files:** `src/core/brain/entities/index-builder.ts` (NUL file, ~80-106); consumers `src/core/search/entity-alias.ts:45` and `src/core/search/query-expansion.ts:106`.
- **Acceptance:** an invalidation test — write a new entity → the next query that names an entity sees it (mtime probe triggers rebuild). Existing entity suites green. Documented staleness-window trade-off at the call site.

**C.2 — `documents.basename` column (schema bump; release-defining commit)**
- **Files:** `src/core/search/store.ts` — add `basename` column + index (populated at index time); `resolvedDocLinkPairs` (~1064-1086) rewritten as equality joins (no `SUBSTR` full scan); bump `LATEST_SCHEMA_VERSION`; `package.json` + `CHANGELOG.md` → 1.24.0.
- **Acceptance:** link-resolution suites green; a scale smoke test on a synthetic 5k-doc / multi-k-dangling-link fixture shows the suffix scans eliminated (equality joins). The single release reindex absorbs C.2 and the Task 3 tokenizer change.

**C.3 — `buildBacklinkIndex` cross-call memo**
- **Files:** `src/core/brain/backlinks.ts` (~268-272); callers `query-tools.ts:250`, `resources.ts:369`, `doctor.ts:930`, `explorer.ts:88`, moc-audit, concept-cluster.
- **Acceptance:** mtime/generation-keyed memo (or incremental log cursor) with a freshness test; full-history re-read eliminated on repeat calls within the same generation. "Recompute on demand" revisited deliberately, documented.

**C.4 — heal-enrich compile-once regex**
- **Files:** `src/core/brain/heal-run.ts` (~76-88) + `src/core/brain/heal-enrich.ts` (~42-58). Sort once, compile once, post-filter self-matches per page; drop the duplicate frontmatter parse at `heal-run:80`.
- **Acceptance:** existing heal tests green; a test asserting the alternation regex is compiled once per run, not once per page (compile-count assertion or equivalent).

**C.5 — `links normalize --mode short` Map-based resolution**
- **Files:** `src/cli/brain/verbs/links.ts` (~72-86) + `src/core/brain/link-graph/format-wikilink.ts` (~60-90).
- **Acceptance:** a characterization fixture captures current output BEFORE the rewrite; after the rewrite the output is byte-identical. Build a basename→paths Map once per run; resolve+disambiguate against it.

**C.6 — continuity reverse-chron early exit**
- **Files:** `src/core/brain/continuity/store.ts` (~190-215, `readAllRecords`); consumers `session-summary.ts:182`, `pre-compact-extract.ts:148`, recall-telemetry/memory-cost/context-receipts.
- **Acceptance:** a `since`-aware file-skip test (shards outside the window are not parsed) and a latest-record reverse-chron early-exit test (stops at the first match, not after parsing all shards).

**Depends on:** Tasks 1–3 (builds on the stabilized, correctness-fixed base; C.2's forced reindex exercises Task 1's race-safe reindex).
