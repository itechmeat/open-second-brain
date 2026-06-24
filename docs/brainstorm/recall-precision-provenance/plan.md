# Implementation plan — Recall precision, coverage & provenance hardening

Branch: `feat/recall-precision-provenance`. Cards are driven ONE AT A TIME on this shared branch.
Each worker MUST `git pull` / build on the commits previously-driven in-scope cards already landed,
and must not duplicate or conflict with sibling tasks. Follow TDD: write the failing test first.

Combined design: `docs/brainstorm/recall-precision-provenance/design.md`.
Drive order: **D7 → D1 → D2 → D3 → D4 → D5**.

---

## D7 — t_122b2cbc — Expose chunker `minTokens` as per-vault config

**Note:** `maxTokens` and `overlapTokens` are ALREADY operator-tunable
(`indexer.ts:263-265` passes `config.chunkSize`/`config.chunkOverlap`; `resolveSearchConfig` reads
`search_chunk_size`/`search_chunk_overlap` config + env with validation). D7 narrows to exposing
the **only** missing knob: the chunk-packing floor `minTokens` (`DEFAULT_MIN_TOKENS`). The default
MUST equal the existing constant so chunk hashes are unchanged when no config is set (Syncthing-peer
determinism contract).

### Files
- `src/core/search/index.ts` — add `minTokens` to `DEFAULTS` (== existing `DEFAULT_MIN_TOKENS`),
  resolve it from `search_chunk_min_tokens` config + `OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_TOKENS` env
  via `parseInteger`, with validation (`0 <= minTokens < chunkSize`), add to `ResolvedSearchConfig`
  return shape.
- `src/core/search/types.ts` — add `readonly chunkMinTokens: number;` to `ResolvedSearchConfig`.
- `src/core/search/indexer.ts:263-265` — thread `minTokens: config.chunkMinTokens` into the
  existing `chunkMarkdown(...)` call (alongside the already-present `maxTokens`/`overlapTokens`).
- `tests/core/search/config.test.ts` — new/extended cases.

### Acceptance (passing test)
A test in `tests/core/search/config.test.ts` that:
1. Resolves config with `search_chunk_min_tokens` set and asserts `chunkMinTokens` carries through;
2. Asserts the DEFAULT (no config) yields a value equal to `chunker.DEFAULT_MIN_TOKENS` (import the
   constant) so chunk hashes are byte-identical to pre-change — the bit-identity guard;
3. Asserts validation rejects `minTokens >= chunkSize`.

### Depends on
None. Orthogonal. (Driven first.)

---

## D1 — t_8da11868 — Context traces attached to logged events (provenance join)

A read-only correlation-join reader. Given a log event's correlation IDs, resolve the attached
`context_receipt` / `recall_telemetry` / `generation_report` via the existing continuity
read-model (`read-model.ts`, which already lifts `session_id`/`turn_id`/handoff fields to
first-class join keys). Missing records return empty, never throw (fail-open). Surfaced as
`brain_context_trace` (MCP) + `o2b brain context-trace` (CLI).

### Files
- `src/core/brain/provenance/context-trace.ts` (new) — pure join function
  `resolveContextTrace(vault, correlation)` returning a frozen shape `{ logEvent, receipts,
  recallTelemetry, generationReports }`. Join on the read-model's lifted first-class fields
  (`session_id`, `turn_id`, `handoffRef`, `timestamp`, `agent`, `sourceRefs`). No new writes.
- `src/core/brain/log.ts` — add a small read helper to load a single log event row by its JSONL
  sidecar id/timestamp if a join-by-id is needed (read-only; do not touch `appendLogEvent`).
- `src/mcp/brain/recall-tools.ts` — add `brain_context_trace` op (input: correlation fields or a
  log event id; output: the joined trace). Fail-open: missing → empty arrays.
- `src/cli/brain.ts` — add `context-trace` subcommand.
- `tests/core/brain/context-trace.test.ts` (new).

### Acceptance (passing test)
A test in `tests/core/brain/context-trace.test.ts` over a fixture vault with a log event and
matching + non-matching continuity records that asserts:
1. Given a log event's `session_id`+`turn_id`, the reader returns exactly the matching
   `context_receipt` / `recall_telemetry` / `generation_report`;
2. A log event with NO matching records returns empty arrays (not an error) — the fail-open guard;
3. A partial-match (only `recall_telemetry` present) returns that one and empty for the rest.

### Depends on
None. Orthogonal.

---

## D2 — t_0b83c97b — Read-time virtual line numbering (`Lstart-Lend` pointers)

Pure read-time functions + a `LinePointer` type (introduced here, reused by D5). Deterministic
1-based numbering from file start; bytes on disk never mutated.

### Files
- `src/core/search/line-citation.ts` (new) — `LinePointer { path, lineStart, lineEnd }`, pure
  `renderWithLineNumbers(text, startLine?)`, `extractLineRange(text, lineStart, lineEnd)`,
  `parseLinePointer(str)` / `formatLinePointer(ptr)` for `path:Lstart-Lend` form.
- `src/core/search/evidence-pack.ts` — add `lineStart`/`lineEnd` to `EvidenceRecord` (additive;
  `buildEvidencePack` carries them over from `BrainSearchResult.startLine`/`endLine`, which it
  already receives). Render a `LinePointer` for each `EvidenceRecord` when line-citation is
  requested. NOTE: `EvidenceRecord` does not currently carry line spans — the source values live on
  `BrainSearchResult` (types.ts:84-85) and the `chunks` table (schema.ts:42-43); threading them in
  here is the additive change D2 makes.
- `src/core/brain/session-recall.ts` — plumb the `Lstart-Lend` form into the snippet/citation path
  (`snippet()` at ~510) as an alternative to char-offset.
- `tests/core/search/line-citation.test.ts` (new).

### Acceptance (passing test)
A test in `tests/core/search/line-citation.test.ts` that:
1. `renderWithLineNumbers` applies `[N]` markers 1-based and is a pure function (same input → same
   output, never mutates the input string);
2. `extractLineRange(text, 55, 72)` returns exactly lines 55-72 inclusive;
3. `parseLinePointer("note.md:L55-L72")` round-trips through `formatLinePointer`;
4. Re-running render on an unchanged file yields identical numbering (idempotent — the
   "pointers never invalidate" invariant).

### Depends on
None (introduces the `LinePointer` type D5 will import).

---

## D3 — t_468190f5 — Generalize progressive disclosure to all recall

Compact-card → expand → raw-transcript disclosure for the general search, mirroring
`searchSessionRecall`/`expandSessionRecall`. Reuse the existing store read for layer 2/3, NOT a new
index. Default behavior stays full-content (bit-identical); `disclosure: 'cards'` opts in. The
existing query-lane `expand` flag stays distinct.

### Files
- `src/core/search/types.ts` — add a `disclosure` option (`'full' | 'cards'`, default `'full'`) and
  a compact `SearchCard` result shape (path, title, score, reasons, snippet, pointer) for layer 1.
- `src/core/search/search.ts` — when `disclosure === 'cards'`, return compact cards (layer 1); add
  an `expandHit(vault, hitId)` returning layer 2 (fuller note) and a layer-3 raw chunk read via the
  existing store, reusing `expandSessionRecall`'s paginated-cursor pattern.
- `src/cli/search.ts` — add `--disclosure cards` flag + a `search expand` subcommand.
- `src/mcp/brain/recall-tools.ts` — add `disclosure` field to `brain_search` + a
  `brain_search_expand` op.
- `tests/core/search/disclosure.test.ts` (new).

### Acceptance (passing test)
A test in `tests/core/search/disclosure.test.ts` that:
1. `disclosure: 'cards'` returns compact cards (no full content) for layer 1;
2. `expandHit` on a card returns the fuller note (layer 2) and the raw chunk (layer 3);
3. Default (no `disclosure`) is bit-identical to pre-change output — the bit-identity guard;
4. The layer-2/3 expand reuses the existing store read (assert no new index file is created).

### Depends on
D2 (renders `LinePointer` citations in the compact cards / expanded note).

---

## D4 — t_23c1b929 — Normalized-confidence chain-stop for cross-vault recall

After each origin completes, if the top result's NORMALIZED [0,1] score >= threshold (default 0.8),
skip remaining origins and record which were skipped. Gates on normalized confidence, never raw
score. Distinct from the retrieve-or-not `surfacing-gate` and from `query-cache`. Default-off
(`chainStopEnabled`) → bit-identical.

### Files
- `src/core/search/types.ts` — add `chainStopEnabled: boolean` and `chainStopScore: number` to
  `ResolvedRecallConfig`; add a `chainStop?` field to the cross-vault outcome recording
  `{ triggered: true, stoppedAfter: <label>, skipped: [<labels>] }`.
- `src/core/search/index.ts` — resolve `chain_stop_enabled` (config + env, default false) and
  `chain_stop_score` (default 0.8) with `[0,1]` range validation.
- `src/core/search/cross-vault.ts` — in the per-origin loop, after pushing results, if
  `chainStopEnabled && merged.length && topNormalizedScore >= chainStopScore`, break and record
  `skipped` = remaining origin labels. Top score is the normalized result `score` (already [0,1]).
- `tests/core/search/cross-vault.test.ts` — new cases.

### Acceptance (passing test)
A test in `tests/core/search/cross-vault.test.ts` with a multi-origin fixture that:
1. With `chainStopEnabled` on and the first origin's top normalized score >= 0.8, later origins are
   NOT searched and `chainStop.skipped` lists them;
2. A high RAW score on a tiny-corpus origin that yields a low NORMALIZED score does NOT trigger the
   stop (the normalized-not-raw guard);
3. `chainStopEnabled` off (default) runs all origins, bit-identical to today, and `chainStop` is
   absent — the bit-identity guard.

### Depends on
None for logic; drives before D5 so D5 builds on a settled `search.ts`/`cross-vault.ts` seam.

---

## D5 — t_8eb5ca32 — Coverage-driven targeted self-correcting recall on partial misses

After the first evidence-pack pass, if `uncoveredRareTerms` is non-empty AND results exist (partial
miss, coverage below `COMPLETENESS_COMPLETE_THRESHOLD`), run exactly ONE targeted follow-up pass:
derive queries from the uncovered rare terms via existing `query-expansion.ts`/`synonyms.ts`,
re-query, merge. Distinct from the existing zero-candidate broadened-OR `secondPass`. Deterministic
trigger, no LLM, capped at one pass. Default-off (`coverageRetryEnabled`) → bit-identical. Reuses
D2's `LinePointer` to cite newly-found evidence.

### Files
- `src/core/search/types.ts` — add `coverageRetryEnabled: boolean` to `ResolvedRecallConfig`; add a
  `coverageRetry?` field to `SearchOutcome` recording `{ triggered: true, uncoveredTerms:
  [...], added: <n> }`.
- `src/core/search/index.ts` — resolve `coverage_retry_enabled` (config + env, default false).
- `src/core/search/search.ts` — after the existing zero-candidate `secondPass` block, add a distinct
  branch: when `evidencePack && coverageRetryEnabled && results.length > 0 &&
  evidencePack.uncoveredRareTerms?.length` , build ONE targeted query from the uncovered rare terms
  via `deriveExpansionTerms`/`tokenizeForExpansion`, re-query (`runFtsQueryDetailed`), merge any new
  hits, update the evidence pack, record `coverageRetry`. Hard cap: one pass. NOTE:
  `deriveExpansionTerms` lives in **`synonyms.ts`** (not `query-expansion.ts`); `tokenizeForExpansion`
  is also in `synonyms.ts`. `query-expansion.ts` imports it for internal use only (no re-export), so
  import both helpers directly from `synonyms.ts`.
- `tests/core/search/coverage-retry.test.ts` (new).

### Acceptance (passing test)
A test in `tests/core/search/coverage-retry.test.ts` over a fixture vault where the first pass
returns results but leaves a rare term uncovered that:
1. With `coverageRetryEnabled` on, the targeted follow-up re-queries for the uncovered rare term and
   merges newly-found evidence, recording `coverageRetry.triggered` with the uncovered terms;
2. The retry runs exactly ONCE (a second uncovered term after the retry does not trigger a third
   pass) — the cap guard;
3. `coverageRetryEnabled` off (default) is bit-identical to today and `coverageRetry` is absent —
   the bit-identity guard;
4. A ZERO-candidate first pass still uses the existing `secondPass` (not this path) — the
   distinctness guard.

### Depends on
D2 (`LinePointer` import for citing new evidence) and D4 (settled `search.ts` seam to extend).
