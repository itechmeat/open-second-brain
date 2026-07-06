# PR #121 hardening + correctness — design

**Status:** draft
**Author:** product-tech-lead (via Phase 0 brainstorm)
**Audience:** implementation
**Branch:** `feat/pr121-hardening-correctness` (from `main` @ `67bcb71c`, PR #121 merge)
**Scope source:** three-lens discovery pass (correctness/security/performance) on PR #121, 2026-07-06

## Problem statement

PR #121 (`refactor: DRY and decomposition`) landed as a pure no-behavior-change refactor. A three-lens discovery pass over its diff surfaced 13 concrete fixes across four classes that were deliberately deferred so they would not block the refactor:

- **Silent data loss** — two interlocking races around the search-index rebuild (`reindexVault`): a concurrent run can swap an empty staging DB over the live index, and the crash-restore preamble can clobber a freshly built index with a stale `.bak`. Highest priority; realistic trigger is a schema-bump upgrade firing concurrent reindexes across every search surface.
- **Validation/output holes** — `created_at` accepted with only a `YYYY-MM` prefix (junk shards, mis-sorted records); card snippet truncation splitting a UTF-16 surrogate pair (lone U+FFFD on the MCP `cards` surface); `since`/`until` precision-inconsistent filtering dropping up to a second of records at each boundary; the secret-exec audit trail persisting a foreign bare credential in cleartext.
- **Hot-path regressions** — the entity index re-read from disk on every query; dangling-wikilink resolution doing full `documents` SUBSTR scans per link; unbounded backlink/heal/links-normalize/continuity recompute costs that scale with brain age.
- **CJK tokenizer noise** — the Han-bigram pass emits cross-script bigrams (`n实`) for mixed tokens, inflating term frequencies despite the docstring promising Han-only scope.

All four are independently implementable; none were meta/umbrella; none have unmet parent dependencies.

## Scope

Four cards driven one at a time on the shared branch, each as a contiguous, independently-revertable commit cluster with per-fix TDD:

- `t_f27d80fe` (P4) — index-swap hardening (2 fixes: concurrent-reindex race + crash-restore clobber). **Rebases the validated local fix `ec3bad27` (`acquireReindexLock`/`isReindexInProgress`) onto this branch, then extends it with the `INDEX_UNREADABLE`→self-heal change as a follow-on commit.**
- `t_2ba5f0c9` (P4) — validation/output hardening (4 fixes: B.1 `created_at` tightening, B.2 surrogate-safe snippet, B.3 since/until precision, B.4 secret-exec audit redaction).
- `t_1224c740` (P4) — hot-path performance (6 items: C.1 entity-index memo, C.2 `basename` column + schema bump, C.3 backlink memo, C.4 heal regex compile-once, C.5 links-normalize Map, C.6 continuity reverse-chron early exit).
- `t_3ccb1512` (P3) — Han-bigram tokenizer restricted to contiguous Han spans.

Release target: **1.24.0** (minor) — C.2 forces a `LATEST_SCHEMA_VERSION` bump + reindex, and B.1 is a contract tightening (previously-accepted garbage → `INVALID_PARAMS`).

## Out of scope

- Widening the CJK tokenizer beyond Han (kana / Hangul / CJK extensions) — separate enhancement, explicitly excluded by `t_3ccb1512`.
- The dependency-blocked high-value card `t_4678a91a` (blocked on out-of-scope `t_62363378`) — deliberately excluded from this release.
- Registry/manifest-driven command frameworks or any new public MCP tools / CLI verbs / config keys beyond the schema bump.
- Auto-merging of semantic entity dedup (1.23.0's proposal-only surface stays proposal-only).
- Any change to the `o2b search reindex` trigger semantics; the reindex requirement itself is unchanged, only ridden once at release.

## Chosen approach

**Consultant Variant 1 — Card-sequential single minor (1.24.0), risk-ordered.** Ship all 13 fixes as one minor on the shared branch, committed one card at a time in risk order:

1. `t_f27d80fe` first — rebase `ec3bad27` (reindex-level lock) in as-is, then extend with the `INDEX_UNREADABLE` self-heal as a follow-on commit.
2. The low-risk correctness cluster — `t_2ba5f0c9` (B.1–B.4) and `t_3ccb1512` (Han-bigram tokenizer).
3. Contract-neutral perf items — C.1, C.3, C.4, C.5, C.6 of `t_1224c740`.
4. `t_1224c740` C.2 last — the release-defining commit: `LATEST_SCHEMA_VERSION` bump, `basename` column + index, version + CHANGELOG bump. One reindex at release absorbs both C.2 and the tokenizer's re-tokenization.

It is the only shaping that honors every stated convention simultaneously: cards land one at a time as contiguous, independently-revertable commit clusters with per-fix TDD; the P4 data-loss fix stabilizes the base before perf work rebases onto it; and the single unavoidable reindex is anchored to C.2 as its own auditable schema commit without fusing unrelated fixes or coupling the self-heal safety change to the reindex.

## Design decisions

- **Reconcile `ec3bad27`, don't redo it.** The local fix branch already implements `acquireReindexLock`/`isReindexInProgress` (a separate lockfile from the per-`Store.open` writer lock) with 3 regression tests. The implementation phase rebases/merges it onto this release branch rather than reimplementing. The self-heal expansion (`INDEX_UNREADABLE` joining `INDEX_MISSING`/`SCHEMA_MISMATCH` in `openReadOrSelfHeal`) is a *separate follow-on commit* on top, gated on the swap being safe — so the safety change stays decoupled from the lock and independently revertable.
- **Self-heal expansion stays decoupled from the schema bump.** `INDEX_UNREADABLE`→self-heal rides with `t_f27d80fe` (its natural home, reviewable as a safety fix), NOT bundled into C.2's reindex-forcing commit. A rollback of the schema bump must not drag the self-heal safety change with it.
- **One reindex, anchored to C.2.** C.2 is the only item that bumps `LATEST_SCHEMA_VERSION` (forcing a reindex). The Han-bigram tokenizer (`t_3ccb1512`) changes tokenization but does not bump the schema — its effect on already-indexed content is absorbed by the single C.2-triggered reindex at release, so users pay one reindex, not two.
- **B.1 (`created_at`) is the contract-tightening gate for minor vs patch.** Previously-accepted garbage timestamps become `INVALID_PARAMS` — a behavior change that belongs behind a minor, which is why this release is 1.24.0 and not 1.23.1. The other correctness fixes (B.2/B.3/B.4) are byte-changing but not contract-breaking and could in principle patch; they ride the minor because splitting the card across releases would violate card atomicity (Variant 2 rejected).
- **Staleness-window memos (C.1, C.3) are opt-in by construction, not config.** mtime/generation-keyed memoization introduces a bounded staleness window (a write within mtime granularity can serve one stale read). This is a *deliberate behavior trade-off*, documented at the call site, not a hidden flag — matching the project's "no misleading fallbacks" rule (a memo hit must not silently lie about freshness; invalidation tests pin write→read-visibility).
- **C.5 output is pinned byte-identical before optimization.** The `links normalize --mode short` rewrite (basename→paths Map) must not change user-facing output; a fixture captures current output first, then the optimization must reproduce it exactly.
- **B.2 snippet truncation changes output bytes for affected inputs — by design.** Truncating on code points (`[...collapsed]` or `Intl.Segmenter`) fixes a lone-surrogate defect; the new bytes are correct where the old were corrupt. This is a fix, not a regression, and is covered by an emoji-at-boundary fixture.
- **No new dependencies.** All fixes use stdlib (`Array` spread, `Intl.Segmenter` where available, SQLite column + index, `Map`). The schema bump uses the existing migration path.
- **NUL-byte sentinel files respected.** `search.ts` and `index-builder.ts` contain NUL bytes; workers use `command grep -a` or codegraph, never plain grep (which silently skips matches).

## File changes

**`t_f27d80fe` (rebase `ec3bad27` + extend):**
- `src/core/search/store.ts` — `acquireReindexLock`/`isReindexInProgress` (separate lockfile from per-`Store.open` writer lock); crash-restore preamble probes `isReindexInProgress` non-blocking.
- `src/core/search/indexer.ts` — `reindexVault` acquires the reindex lock before touching `newPath` (unlink + seed move inside the lock).
- `src/core/search/search.ts` (NUL file) — `openReadOrSelfHeal` self-heal set extended to include `INDEX_UNREADABLE`.
- `tests/core/search/` — 3 regression tests from `ec3bad27` (second reindex rejected mid-flight; `Store.open` does not restore `.bak` mid-reindex; genuine crash-restore still works) + self-heal test for `INDEX_UNREADABLE`.

**`t_2ba5f0c9` (4 fixes):**
- `src/core/brain/continuity/store.ts` — full timestamp validation at the boundary (canonical UTC `Z`, real calendar date); reject with structured `INVALID_PARAMS`.
- `src/core/search/search.ts` (NUL file) — `cardSnippet` truncates on code points.
- `src/core/brain/query-demand.ts` — filter bounds run through `normalizeDemandTimestamp` before lexical compare.
- `src/core/brain/secrets/exec.ts` — logged `command` redacted with `redactRawOutput`/`redactInfra` and/or a high-entropy-token pass before it is handed to `appendAuditRecord`. The audit sink itself (`src/core/reliability/audit.ts`, imported via `../../reliability/audit.ts`) is unchanged; the fix lives at the call site in `exec.ts`, not in the audit module.
- `tests/` — table-driven accept/reject for `created_at`; emoji-at-boundary snippet fixture; ms- vs second-precision since/until fixture; bare-`sk-` audit-redaction fixture.

**`t_1224c740` (6 items):**
- `src/core/brain/entities/index-builder.ts` (NUL file) + `src/core/search/entity-alias.ts` / `query-expansion.ts` — mtime-keyed memo of `buildEntityIndex` (dir mtime probe per query).
- `src/core/search/store.ts` — `documents.basename` column + index (populated at index time); `resolvedDocLinkPairs` rewritten as equality joins; `LATEST_SCHEMA_VERSION` bump.
- `src/core/brain/backlinks.ts` — mtime/generation-keyed memo or incremental log cursor for `buildBacklinkIndex`.
- `src/core/brain/heal-run.ts` + `heal-enrich.ts` — sort-once/compile-once regex; drop duplicate frontmatter parse.
- `src/cli/brain/verbs/links.ts` + `src/core/brain/link-graph/format-wikilink.ts` — basename→paths Map (byte-identical output pinned first).
- `src/core/brain/continuity/store.ts` — `since`-aware file skip + reverse-chron early exit for latest-record queries.
- `tests/` — entity invalidation; link-resolution + synthetic 5k-doc scale smoke; backlink memo freshness; heal regex compile-count; links-normalize byte-identity fixture; continuity latest-record early-exit.

**`t_3ccb1512` (1 fix):**
- `src/core/surface/lexical-score.ts` — `tokenize` extracts bigrams only from maximal contiguous Han spans.
- `tests/core/surface/lexical-score.test.ts` — `gbrain实现`→`实现`+full (no `n实`); `ab实现cd`→`实现`; pure-Han/pure-ASCII unchanged; standalone 2-char `实现` no duplicate.

**Release-wide:**
- `package.json` + `CHANGELOG.md` — version bump to 1.24.0 (lands with C.2, the schema-bump commit).

## Risks

- **Schema bump + reindex on upgrade.** C.2 bumps `LATEST_SCHEMA_VERSION`; every existing install reindexes on next open. Mitigated by `t_f27d80fe` landing first (the reindex path is now race-safe), and by the single-reindex anchor (users pay once). Risk: the race fix and the schema bump are in the same release — if the race fix regressed, the forced reindex would exercise it under load. Mitigation: the 3 regression tests + the integration overlap test pin the path before C.2 lands.
- **Staleness-window memos (C.1, C.3) can serve one stale read after a write.** Deliberate trade-off, pinned by invalidation tests (write → next query sees the new entity / backlinks). Documented at the call site; not hidden behind a flag.
- **C.5 byte-identity regression.** The links-normalize rewrite must reproduce current output exactly. Mitigated by a characterization fixture captured before the rewrite.
- **B.2 / B.1 change observable bytes / accepted inputs.** B.2 fixes a corrupt lone surrogate (new bytes are correct); B.1 rejects previously-accepted garbage (the minor-version gate). Both covered by fixtures; neither is a silent regression.
- **`ec3bad27` rebase onto the release branch.** The fix was validated on `fix/index-swap-hardening` off an earlier base; rebasing onto `feat/pr121-hardening-correctness` (post-#121 merge) may surface context drift. Mitigation: rebased as the first commit cluster with the full suite green before any other card lands.
