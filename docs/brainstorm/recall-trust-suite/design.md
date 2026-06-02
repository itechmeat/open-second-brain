# Recall Trust Suite — recall an agent can trust

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** epic t_e9aebbc8; children t_d8571bf0, t_68e1b774, t_407a3477, t_9dfbaa76, t_854b8e5f
**Chosen variant:** Variant 3 — two-phase layering (see `variants.md`)

## Problem statement

Open Second Brain search explains *why* a result surfaced (`why_retrieved`)
but cannot yet be *trusted* on four axes: typed relations
(`superseded_by`, `contradicts`) are surfaced but do not affect ranking, so a
stale superseded memory can outrank its successor; ranking weights are static
and cannot learn from operator feedback; evidence packs (PR #54) judge term
support without frequency weighting, so a result matching only common words
looks as supported as one matching the rare, high-signal term; and recall
cannot be scoped by time, nor can a downstream summarizer detect that
retrieval failed to cover the query. The suite closes all four gaps with
deterministic, auditable mechanics — no LLM in the core path.

## Scope

Five features, two pipeline groups (Variant 3):

**Pre-rank signal group**

- **A. Relation-aware recall** (t_d8571bf0): typed relation edges get recall
  polarity. `superseded_by` demotes the matched predecessor and pulls in /
  boosts its successor; `contradicts` surfaces with a warning-style reason and
  no positive halo; `depends_on` / `extends` / `refines` / `related` give a
  small bounded directional boost between co-retrieved candidates. New
  `why_retrieved` reasons. Opt-out for history-oriented queries.
- **B. Retrieval feedback loop** (t_68e1b774): explicit per-result feedback
  events (CLI `o2b search feedback`, MCP `brain_recall_feedback`) recorded as
  one JSON file per event under `Brain/search/feedback/` (the conflict-free
  inbox pattern). A deterministic, bounded computation derives per-layer
  learned multipliers from accumulated events into
  `Brain/search/learned-weights.json`. Opt-in via config; reset and freeze
  controls; weights and provenance visible via `o2b search weights`.
- **D. Time-aware recall** (t_9dfbaa76): `since` / `until` query parameters
  accepting ISO dates, relative phrases (`yesterday`, `last week`), and
  duration shorthand (`24h`, `7d`, `2w`). Deterministic parser module; filter
  on indexed document mtime; CLI flags and MCP schema fields.

**Post-rank verification group**

- **C. Verified multi-record recall** (t_407a3477, follow-up of PR #54): a
  shared coverage engine (`coverage.ts`) computing per-term postings over the
  result set and corpus document frequency (IDF) from the FTS index. On top of
  it: per-token recall union (fetch a bounded number of extra records for
  significant terms the ranked set left uncovered), IDF-weighted support
  coverage, and a rare-term gate that populates the existing `abstention`
  field when a rare, high-signal term is uncovered. All scoped under the
  existing opt-in `evidence_pack` mode.
- **E. Search-completeness guard** (t_854b8e5f): a deterministic completeness
  verdict (`complete` / `partial` / `sparse`) over the returned results,
  computed from the same coverage engine, plus a false-absence guard: when
  results are empty (or a term is uncovered) but the corpus *does* contain
  matches for it, the pack says so explicitly. Shipped inside the evidence
  pack (the trust surface added by PR #54).

## Out of scope

- LLM-based verification of summaries against sources (the upstream
  obsidian-second-brain guard idea is reduced to its deterministic core).
- Frontmatter date fields as the time-filter source (mtime only; frontmatter
  dates can extend later without schema changes).
- Implicit feedback capture (only explicit feedback events in this PR;
  downstream tools may call the same MCP tool later).
- Reinforcement learning or any non-deterministic weight training.
- SQLite schema changes (IDF and relation edges are computed from existing
  tables at query time; no index-version bump).
- Cross-vault recall, entity registry, log sharding (other kanban tasks).

## Chosen approach

Variant 3 (two-phase layering). The pre-rank group injects signals at the
seams `search.ts` already exposes: relation polarity runs as a bounded
post-rank adjustment pass over the assembled candidate pool (it needs the
ranked set to know which predecessors matched); learned weights resolve into
the existing `WeightProfile` multiplier contract; the time filter prunes
hydrated candidates before ranking. The post-rank group extends the
`evidencePack === true` post-pass: `coverage.ts` is the single source of truth
for significant terms, per-term postings, and IDF; both the C verifier and the
E verdict read it, so they can never disagree on what "covered" means.

Pipeline after the change (additions in brackets):

```
FTS → semantic → hydrate → [D: time filter] → rank ([B: learned multipliers])
    → traversal → MMR → property/visibility
    → [A: relation polarity adjust] → slice → relations attach
    → evidence pack ([C: union + IDF + rare-term gate] → [E: completeness])
```

## Design decisions

- **A runs post-rank, pre-slice, not inside `rankResults`.** The ranker is a
  pure function with no I/O; relation edges need a store query
  (`typedRelationEdgesForDocuments`, new). Running the polarity pass over the
  assembled pool (before the final `limit` slice; the existing
  relations-attach step for output stays after the slice) keeps the ranker
  pure and lets a pulled-in successor compete for the final window while a
  demoted predecessor can fall out of it. Demotion is a
  bounded multiplier (`0.6`) on the predecessor's score unless
  `includeSuperseded` is set; successor pull-in reuses the traversal
  representative-chunk mechanism with `searchType: "link"`.
- **A is on by default with conservative constants.** Vaults without typed
  relations are bit-identical (the pass no-ops on zero edges) — that satisfies
  the stability acceptance criterion. `search_relation_polarity_enabled`
  config (default `true`) provides the kill switch, folded into the config
  fingerprint so the query cache invalidates.
- **A reasons vocabulary:** `superseded_by: <target>` (on the demoted
  predecessor), `supersedes_matched: <path>` (on the boosted/pulled successor),
  `contradicts: <target>` / `contradicted_by: <path>` (warning-style, score
  untouched), `relation_boost: <relation> <path>` (positive relations).
- **B stores feedback as one file per event** under
  `Brain/search/feedback/<ts>-<hash>.json` — mirrors the `Brain/inbox/`
  conflict-free pattern (a per-day shared JSONL would recreate the Syncthing
  conflict bug t_6d52641f documents). Learned weights are a pure fold over the
  event set: per layer, `multiplier = clamp(1 + step * netSignal /
  totalEvents, 0.8, 1.2)` with `step = 0.5`; documented bounds, deterministic
  replay, `o2b search weights --reset` deletes the derived file (events stay),
  config `search_learned_weights_enabled` (default `false`, opt-in per task)
  freezes/unfreezes. The learned multipliers compose with the intent
  `WeightProfile` by multiplication and are clamped after composition.
- **B cache integration:** the learned-weights file hash joins the config
  fingerprint, so feedback-driven changes invalidate cached outcomes.
- **B explanation:** when active and non-neutral, every result gains one
  reason `learned_weights: kw=<x> sem=<x> ent=<x> rec=<x>` (only non-1.0
  entries listed); `o2b search weights` prints base config, learned
  multipliers, event counts, and bounds.
- **C/E live entirely under `evidence_pack: true`.** PR #54 made the evidence
  pack the opt-in trust surface; the union fetch and IDF queries cost extra
  store reads, so they stay off the default path. `EvidencePack` gains only
  optional fields (`idfWeightedCoverage`, `rareTerms`, `uncoveredRareTerms`,
  `unionRecords`, `completeness`) — additive, no field changes.
- **IDF from the live FTS index, no schema change:** document frequency per
  significant term via one FTS query per term (bounded by the significant-term
  cap), `idf = ln(1 + N / (1 + df))`. Rare-term threshold: `df <= max(1,
  0.02 * N)` — a term in at most 2% of documents is high-signal.
- **C union fetch is bounded:** at most 2 extra records per uncovered
  significant term, at most 8 total, fetched with a single-term FTS query and
  appended to the pack's `unionRecords` (not into `results` — the primary
  result contract stays untouched; agents consume the pack).
- **E verdict thresholds:** `complete` when IDF-weighted coverage ≥ 0.8,
  `partial` ≥ 0.4, else `sparse`. False-absence guard: any uncovered term with
  corpus `df > 0` is reported as `uncovered_but_present_in_corpus` so a
  downstream summarizer cannot honestly claim "the vault has nothing on X".
- **D parser is a pure module** (`time-range.ts`) taking an injected `nowMs`;
  unparseable input throws `SearchError("INVALID_INPUT")` — explicit, not
  silent. Time-filtered queries bypass the query cache (a relative range
  resolves to a different absolute window every call; caching would serve
  stale windows).
- **D filters hydrated candidates by `mtime` before ranking**, so every later
  phase (traversal seeds, MMR, relations) sees only in-range candidates.

## File changes

New modules:

- `src/core/search/relation-polarity.ts` (A: polarity pass, constants, reasons)
- `src/core/search/feedback.ts` (B: event shape, file store, learned-weight fold)
- `src/core/search/coverage.ts` (C+E: significant terms, postings, IDF, union, verdict)
- `src/core/search/time-range.ts` (D: since/until parser)

Modified:

- `src/core/search/search.ts` (wire A/B/D phases, C/E pack assembly, cache fingerprint)
- `src/core/search/types.ts` (SearchOptions: `since`, `until`, `includeSuperseded`; ResolvedRecallConfig: relation polarity + learned weights toggles; EvidencePack import type)
- `src/core/search/evidence-pack.ts` (optional pack fields, delegate coverage math to `coverage.ts`)
- `src/core/search/store.ts` (new: `typedRelationEdgesForDocuments`, `documentFrequency`, `documentCount`)
- `src/core/search/index.ts` (config keys + re-exports)
- `src/cli/search.ts` (flags: `--since`, `--until`, `--include-superseded`; verbs: `feedback`, `weights`)
- `src/mcp/search-tools.ts` (brain_search schema: `since`, `until`, `include_superseded`; new tool `brain_recall_feedback`)

Tests (bun:test, `tests/core/search/`): new `relation-polarity.test.ts`,
`feedback.test.ts`, `coverage.test.ts`, `time-range.test.ts`,
`completeness.test.ts`, plus integration cases in `search.test.ts`,
`evidence-pack.test.ts`, CLI/MCP surface tests.

Docs: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/mcp.md`.

## Risks and open questions

- **Relation targets may be unresolved** (`target_document_id` NULL when the
  target page does not exist). The polarity pass must treat unresolved edges
  as inert (reason-only, no pull-in). Covered by a test.
- **Pulled-in successors compete with genuine hits** for the final window;
  the boost is derived from the predecessor's score (×0.9) and capped so a
  successor never outranks a direct strong match on its own merits alone.
- **IDF query cost**: one FTS query per significant term, only in evidence-pack
  mode; significant terms are bounded by query length. Acceptable; measured in
  QA.
- **Learned-weight gaming/drift**: bounds [0.8, 1.2] and pure-fold determinism
  keep worst-case drift small and reproducible; the operator can freeze or
  reset at any time.
- **Feedback file growth**: one small JSON per explicit event; low volume by
  construction. A future compaction command is deliberately deferred.
