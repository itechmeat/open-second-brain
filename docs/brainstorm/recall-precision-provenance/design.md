# Design — Recall precision, coverage & provenance hardening

Branch: `feat/recall-precision-provenance`
Slug: `recall-precision-provenance`
Cards: D1 `t_8da11868`, D2 `t_0b83c97b`, D3 `t_468190f5`, D4 `t_23c1b929`, D5 `t_8eb5ca32`, D7 `t_122b2cbc`

## Problem

Open Second Brain's primary user-facing function is recall that is accurate, complete, and
auditable. Today the recall and observability substrate is rich (coverage engine, IDF-weighted
evidence packs, cross-vault search, query planning/caching, a retrieve-or-not surfacing gate,
session-recall expand, continuity records, generation tracing) but six concrete gaps leave recall
less precise, less complete, and less auditable than it can be:

1. **Provenance is split across surfaces.** Log events and context traces both exist but are read
   by separate readers; an operator cannot answer "why did the agent do this" from one surface.
2. **Citations are path + char-offset only.** A recalled note points at "somewhere in this file",
   not at an exact line span, blunting citation-depth/answer-containment signals.
3. **General recall is flat.** The session-recall surface already does compact-card → expand →
   raw-transcript disclosure, but the main vault search returns full content per hit, paying full
   token cost on every result regardless of whether the agent drills deeper.
4. **Multi-scope recall never short-circuits.** Cross-vault search always pays N searches even
   when the first vault already answers confidently.
5. **Self-correction only fires on zero candidates.** A first pass that returns results but leaves
   rare query terms uncovered (a partial miss) does not re-query for those terms.
6. **The chunker's min-token floor is hardcoded.** (max-tokens and overlap-tokens are already
   operator-tunable; only the packing floor is not.)

## Scope

All six cards ship in this release, driven one at a time on the shared branch:

- **D7** `t_122b2cbc` — expose the markdown chunker's `minTokens` floor as per-vault config.
- **D1** `t_8da11868` — a read-only correlation-join reader that attaches context traces to a
  logged event via its correlation IDs.
- **D2** `t_0b83c97b` — read-time virtual line numbering (`Lstart-Lend` pointers), introducing a
  shared `LinePointer` type reused by D5.
- **D3** `t_468190f5` — generalize progressive search→expand→transcript disclosure to all recall.
- **D4** `t_23c1b929` — normalized-confidence chain-stop for cross-vault early termination.
- **D5** `t_8eb5ca32` — coverage-driven targeted self-correcting recall on partial misses.

## Out of scope

- A web dashboard (o2b has none; provenance ships as CLI/MCP readers).
- Server-managed shared "Spaces", per-agent tokens, hosted control-planes (mem9 product direction
  o2b deliberately avoids — only the chain-stop transfers).
- An LLM inside any kernel logic. Every new decision (chain-stop threshold, coverage trigger,
  pointer resolution) is deterministic.
- HyDE-style generative query rewriting. D5 derives targeted follow-up queries from uncovered rare
  terms via the existing deterministic expansion machinery, not a model call.
- Migrating existing JSONL or stored Markdown. D2 is read-time-only; D1 reads existing records.

## Chosen approach

**Variant 1 — additive, independently-switched modules, ordered by file-collision.**

Each card lands as a self-contained module behind its own explicit switch whose off-branch is
provably bit-identical to today — the precondition o2b demands for any ranking or cost change (D4,
D5) and the easiest property to verify when integration is one guarded call site rather than a
shared pipeline. The cards are driven one at a time on the shared branch in an order that resolves
the only two real collision pairs:

- **D2 → D3** (both touch citation/evidence rendering): D2 introduces the `LinePointer` primitive
  and citation rendering seam; D3 extends result rendering with disclosure tiers over it.
- **D2 → D5** (shared pointer type): D2 introduces `LinePointer`; D5 reuses it to cite newly-found
  evidence in the targeted follow-up pass.
- **D4 → D5** (both touch `search.ts`/`cross-vault.ts`): D4 adds the chain-stop guard at its own
  call site; D5 adds the coverage-retry guard at a distinct site, building on the seam D4 left.

D1 (read-only correlation-join reader) and D7 (config-only `minTokens` exposure) are fully
orthogonal and slot in at the front of the order. Telemetry on every card routes through
`emitGatedTelemetry` and stays fail-open.

**Drive order:** D7 → D1 → D2 → D3 → D4 → D5.

## Design decisions

### D7 — expose `minTokens` (card premise partially corrected)
The card claims the sole caller passes nothing so chunk size is pinned to hardcoded constants.
Verified in the live tree this is **partially stale**: `indexer.ts:263-265` already passes
`{ maxTokens: config.chunkSize, overlapTokens: config.chunkOverlap }`, and `resolveSearchConfig`
already resolves both from `search_chunk_size`/`search_chunk_overlap` config + env with validation.
What is **not** yet configurable is `minTokens` (the chunk-packing floor, `DEFAULT_MIN_TOKENS`),
which has no config/env surface and is not threaded into the indexer call. D7 narrows to exposing
`minTokens` symmetrically. The default stays equal to the existing constant so chunk hashes are
unchanged when no config is set (honoring the Syncthing-peer determinism contract).

### D2 — read-time-only `Lstart-Lend`, no storage mutation
Two pure functions (`renderWithLineNumbers`, `extractLineRange`) plus a `LinePointer` type and
parse/format helpers for `path:Lstart-Lend`. Numbering is deterministic (1-based from file start),
computed at read time only; bytes on disk are never mutated, so existing pointers never invalidate
and idempotent re-mining never shifts numbering. D2 owns the `LinePointer` type so D5 can import it
rather than re-defining it.

Line-span provenance for an evidence record comes from `BrainSearchResult.startLine`/`endLine`
(types.ts:84-85), which are persisted in the `chunks` table (`start_line`/`end_line`,
schema.ts:42-43). `EvidenceRecord` (evidence-pack.ts:10-20) does NOT currently carry them —
`buildEvidencePack` drops them when projecting `BrainSearchResult` → `EvidenceRecord`. D2 threads
`lineStart`/`lineEnd` into `EvidenceRecord` (additive, defaulting to the source result's values) so a
`LinePointer` can be rendered per record without a chunk-table lookup.

### D3 — disclosure tiers over the existing store read
The session-recall expand machinery (`searchSessionRecall` / `expandSessionRecall`) is the proven
blueprint. D3 adds a compact-card result form and an `expandHit` step to the general search that
reuses the existing store read for layer 2 (fuller note) and layer 3 (raw chunk), **not** a new
index. Default behavior stays full-content (bit-identical); `disclosure: 'cards'` opts into the
tiered contract. The `expand` flag already in `search/types.ts` is query-lane expansion and stays
distinct.

### D4 — normalized-confidence chain-stop, distinct from the surfacing gate and cache
After each origin's cross-vault search completes, if the top result's **normalized** [0,1] score is
>= the configured threshold (default 0.8), remaining origins are skipped and the outcome records
which were skipped. The stop gates on normalized confidence, never raw score (a high raw score on a
tiny corpus must not trigger it). It stays distinct from the retrieve-or-not `surfacing-gate`
(whether to retrieve at all) and from `query-cache` (per-request, not cross-scope chain order).
Default-off (`chainStopEnabled`) → bit-identical to today.

### D5 — partial-coverage targeted follow-up, capped at one pass
After the first evidence-pack pass, if `uncoveredRareTerms` is non-empty and results exist (partial
miss, coverage below `COMPLETENESS_COMPLETE_THRESHOLD`), run exactly **one** targeted follow-up
pass: derive queries from the uncovered rare terms via existing `query-expansion.ts`/`synonyms.ts`,
re-query, merge. This is distinct from the existing zero-candidate broadened-OR `secondPass`.
Deterministic trigger, no LLM, capped at one pass (matching the existing single-retry discipline).
Default-off (`coverageRetryEnabled`) → bit-identical. Reuses D2's `LinePointer` to cite the
newly-found evidence.

### D1 — read-only correlation join, fail-open
A join function resolves, for a given log event's correlation IDs (`session_id`, `turn_id`,
`handoffRef`, `timestamp`, `agent`, `sourceRefs`), the attached `context_receipt` /
`recall_telemetry` / `generation_report` via the existing continuity read-model
(`read-model.ts`, which already lifts session/handoff fields to first-class join keys). Surfaced as
`brain_context_trace` (MCP) + `o2b brain context-trace` (CLI). Missing records return empty, never
throw (fail-open).

## File changes (summary; per-card detail in plan.md)

- D7: `src/core/search/index.ts`, `src/core/search/types.ts`, `src/core/search/indexer.ts`; test
  `tests/core/search/config.test.ts`.
- D2: `src/core/search/line-citation.ts` (new), `src/core/search/evidence-pack.ts`,
  `src/core/brain/session-recall.ts`; test `tests/core/search/line-citation.test.ts` (new).
- D3: `src/core/search/types.ts`, `src/core/search/search.ts`, `src/cli/search.ts`,
  `src/mcp/brain/recall-tools.ts`; test `tests/core/search/disclosure.test.ts` (new).
- D4: `src/core/search/cross-vault.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`;
  test `tests/core/search/cross-vault.test.ts`.
- D5: `src/core/search/search.ts`, `src/core/search/types.ts`; test
  `tests/core/search/coverage-retry.test.ts` (new).
- D1: `src/core/brain/provenance/context-trace.ts` (new), `src/core/brain/log.ts`,
  `src/mcp/brain/recall-tools.ts`, `src/cli/brain.ts`; test
  `tests/core/brain/context-trace.test.ts` (new).

## Risks

- **Shared-branch ordering discipline.** D2-before-D3/D5 and D4-before-D5 are enforced by drive
  order, not the compiler. Mitigation: the plan records `Depends on` per card; a worker starting a
  card before its dependency lands must `git pull`/rebase first.
- **Default-off bit-identity for D4/D5.** The hot recall path is the most-tested in the repo.
  Mitigation: each card's acceptance test asserts the off-branch is bit-identical to current
  output (golden/snapshot), not just "runs without error".
- **D7 determinism contract.** A per-vault `minTokens` that differs across Syncthing peers churns
  chunk hashes. Mitigation: default == existing constant; document that per-vault deviation must be
  set identically on all peers (mirrors the existing chunkSize/overlap guidance).
- **D1 join correctness.** Correlation IDs span several fields; a too-loose join could attach the
  wrong trace. Mitigation: join on the read-model's lifted first-class fields with explicit
  match semantics; tests cover the no-match (empty) and partial-match cases.
- **D5 follow-up cost.** An unbounded retry loop would defeat the purpose. Mitigation: hard cap at
  one targeted follow-up pass, deterministic trigger from the existing completeness threshold.
