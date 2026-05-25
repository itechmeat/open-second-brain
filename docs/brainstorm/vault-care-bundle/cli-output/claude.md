### Variant 1: Layered foundation (schema → utilities → consumers)
- **Approach**: Build three horizontal layers bottom-up: a `page-meta/` layer owning the new frontmatter atoms (lifecycle, tier, merged-pointer), a `text/` layer owning the deterministic helpers (NFKC+casefold normaliser, heuristic tokenizer, action-impact scorer), and the consumer layer that wires those into the ranker, digest, doctor, lint, context-pack, and footprint verbs. Strict DAG: consumers depend on layers, never on each other; one extended `migrate-frontmatter` pass covers all schema additions.
- **Shared building blocks**:
  - `src/core/brain/page-meta/lifecycle.ts` — `Lifecycle` enum, default resolver, staleness predicate (F1, F4, F8).
  - `src/core/brain/page-meta/confidence.ts` — generalises today's `_confidence` to non-preference pages (F1).
  - `src/core/brain/page-meta/tier.ts` — `Tier` enum, default `supporting`, tier-weight table (F2, F6, F8).
  - `src/core/brain/page-meta/page-id.ts` — `merged_into` pointer + canonical resolver (F3, F4).
  - `src/core/brain/text/normalize.ts` — NFKC + casefold dedup key (F7, F3).
  - `src/core/brain/text/tokenizer.ts` — single heuristic token counter (F5, F6, F8).
  - `src/core/brain/maintenance/action-scorer.ts` — impact-weighted action item builder (F8).
  - Extension of the existing `migrate-frontmatter` verb to cover the new fields idempotently.
- **Implementation order**:
  1. F7 — pure refactor of `dedup-hash.ts` to NFKC+casefold; unblocks F3 without schema churn.
  2. F1 — confidence + lifecycle frontmatter via `page-meta/` and `migrate-frontmatter`.
  3. F2 — tier frontmatter + ranker hook in `src/core/search/ranker.ts`.
  4. F3 — page dedup, consuming F7 normalisation, F1 lifecycle (skip deprecated/archived), and the `merged_into` pointer.
  5. F5 — token footprint verb + digest section, introducing the shared tokenizer.
  6. F6 — `brain_context_pack` MCP tool + CLI verb, composing tier + lifecycle + tokenizer.
  7. F4 — `o2b brain lint --consolidate` with dry-run, using lifecycle for demotion and page-id for orphan-merge hints.
  8. F8 — ranked action list, composing every prior layer through `action-scorer.ts` and surfacing in digest + doctor.
- **Trade-offs**:
  - Pros: Every shared concept has one owner file; future maintenance features add a peer module instead of recutting an abstraction.
  - Pros: Tests mirror layers (`tests/core/brain/page-meta/*`, `tests/core/brain/text/*`), so per-tool tests stay small.
  - Pros: One migration sweep covers F1+F2+F3 pointer; old pages keep parsing with default values.
  - Cons: Touches more consumer files in one PR (ranker, digest, doctor, dream, inline-scan, sessions/import), so the diff feels wide even though each touch is small.
  - Cons: Some readers have to chase logic across `page-meta/` and the consumer, instead of seeing it inline.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Single maintenance index (one scan, many views)
- **Approach**: Introduce a `MaintenanceIndex` that walks the vault once (reusing `inline-scan` + `backlinks` + `explorer` outputs) and exposes typed views — `byTier`, `byLifecycle`, `tokenByCategory`, `dedupCandidates`, `orphans`, `staleForDemotion`. Every consumer (digest, doctor, lint, context-pack, footprint, action-list) reads from this index instead of re-scanning. The schema additions and normalisation helper feed the index; the eight features become "another view + thin verb" on top.
- **Shared building blocks**:
  - `src/core/brain/maintenance-index/types.ts` — `Lifecycle`, `Tier`, `PageMeta`, `TokenCount`, `DedupCandidate`, `ActionItem` (one schema home).
  - `src/core/brain/maintenance-index/builder.ts` — single-pass scanner producing the cached index.
  - `src/core/brain/maintenance-index/views.ts` — typed accessors per concern (F2, F3, F4, F5, F6, F8 all consume this).
  - `src/core/brain/text/normalize.ts` — NFKC + casefold helper (F7, also feeds dedup-hash + index).
  - Action-scorer is a function over the index, not its own module.
- **Implementation order**:
  1. F1 + F2 together — lifecycle + tier added to `FrontmatterMap` and `migrate-frontmatter`; both are pure schema bumps.
  2. F7 — NFKC + casefold in `text/normalize.ts`, called from `dedup-hash.ts`.
  3. Maintenance-index skeleton — scanner + empty views.
  4. F5 — first view (`tokenByCategory`) wired to a CLI verb + digest section.
  5. F3 — `dedupCandidates` view, `merged_into` writer, wikilink patcher.
  6. F4 — `lint --consolidate` composing `orphans` + `staleForDemotion` + `dedupCandidates` with `--dry-run`/`--apply`.
  7. F6 — `context_pack` over the index, ordered by tier then recency under a token budget.
  8. F8 — pure function over the index, replacing the vague "Recommendation" string in digest + doctor.
- **Trade-offs**:
  - Pros: One canonical scan per command — measurable perf win for larger vaults and fewer race-windows against the watcher.
  - Pros: Tests concentrate on one well-typed module plus thin per-feature wrappers; views are easy to snapshot.
  - Pros: Future maintenance features cost "one new view + one new action term".
  - Cons: God-module risk — `maintenance-index/` accumulates concerns and needs strict sub-file discipline.
  - Cons: Forces every feature through the same abstraction even where (F7) it is overkill, making early commits read as scaffolding.
  - Cons: Sequential ordering — F3-F8 all wait on the index being non-trivial, so parallelisation inside the PR is limited.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Per-feature modules with minimal shared atoms
- **Approach**: Each feature ships as a focused module under `src/core/brain/<feature>.ts` plus its CLI verb file; the only shared surface is a tiny `page-meta/types.ts` (Lifecycle, Tier enums), one normaliser, and one tokenizer helper. Feature files compose existing primitives (`inline-scan`, `backlinks`, `explorer`) directly rather than through a new index or scorer module.
- **Shared building blocks**:
  - `src/core/brain/page-meta/types.ts` — `Lifecycle`, `Tier` enums + default/parse helpers (F1, F2, F3, F4, F8).
  - `src/core/brain/text/normalize.ts` — NFKC + casefold helper (F7, used by F3).
  - `src/core/brain/text/tokenizer.ts` — heuristic token counter (F5, F6, F8 each call directly).
  - Per-feature modules: `lifecycle-confidence.ts`, `tier.ts`, `page-dedup.ts`, `lint-consolidate.ts`, `token-footprint.ts`, `context-pack.ts`, `maintenance-actions.ts`.
  - No central maintenance index; no central action-scorer module.
- **Implementation order**:
  1. F7 — refactor `dedup-hash.ts` to NFKC + casefold; isolated.
  2. F1 — confidence + lifecycle frontmatter + migrate-frontmatter.
  3. F2 — tier frontmatter + ranker hook.
  4. F5 — token footprint verb + digest section.
  5. F3 — page dedup using F7 normalisation and F1 lifecycle gating.
  6. F6 — context-pack using F2 tier + tokenizer.
  7. F4 — lint --consolidate using F1 lifecycle and F3 dedup hints.
  8. F8 — action list re-deriving inputs from each feature module.
- **Trade-offs**:
  - Pros: Smallest, most local diffs per feature; reviewers can read one file per feature; reverts stay surgical.
  - Pros: Steps 1-5 are largely independent — subagent dispatch is straightforward.
  - Pros: Lowest cognitive load to land the first few features quickly.
  - Cons: Tokenization, lifecycle classification, tier scoring get inlined into multiple callers — future schema changes touch many files.
  - Cons: F8 becomes a fat module that re-walks data prior features already computed; wasted vault walks per invocation.
  - Cons: Test surface fragments; no single canonical maintenance view to snapshot-test, so coverage relies on disciplined per-verb tests.
- **Complexity**: small per file, medium overall
- **Risk**: medium (drift risk across future releases)

### Recommended: Variant 1
**Rationale**: The eight features cleanly split into two horizontal concerns (frontmatter atoms, deterministic text/scoring helpers) feeding a vertical layer of mostly-additive consumer changes — a layered shape captures that without paying for the god-index of Variant 2 or accepting the duplication and drift risk of Variant 3. It also matches established OSB conventions: per-concern files alongside `backlinks.ts` and `explorer.ts`, one `migrate-frontmatter` sweep for the new fields, additive MCP surface, and consumer hooks (`ranker.ts`, `digest.ts`, `doctor.ts`) edited in narrow ways. Crucially, it keeps the door open for future maintenance features (freshness signal, tag taxonomy, vault-size policies) by adding a peer file under `page-meta/` or `text/` instead of re-cutting the schema.
