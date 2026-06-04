# Time-Aware Recall & Activation Suite - usage-aware, event-time-correct recall

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain ranks every candidate with a single Weibull curve over file mtime: a constantly-recalled preference and an untouched note of equal age rank identically, a confirmed rule decays at the same rate as throwaway prose, and `since`/`until` filters confuse storage time with event time - the largest LongMemEval failure category. Recall also treats each chunk independently (no notion that two memories are habitually used together) and dead-ends on low-coverage queries instead of broadening once and retrying.

## Scope

- **Activation kernel** (`src/core/search/activation/`): pure ACT-R-style decay math with a content-type half-life table (preferences/decisions never decay; projects ~120d; handoffs/sessions ~30d; notes 60d), access-event recording, a replayable fold into a derived activation state, and a bounded sweep. (t_2bc79017)
- **Activation ranking layer**: bounded `activation` boost in the ranker, surfaced as a `reasons` entry; access recording happens at the CLI/MCP orchestrator edge, never inside the pure core by default. (t_2bc79017)
- **Co-access reinforcement**: pairwise co-retrieval counts derived from the same access events; companions of a strong hit gain a bounded `co_access` boost. (t_c5ef25a3)
- **Freshness-trend classifier** (`src/core/brain/temporal/freshness-trend.ts`): pure classification of every preference into `new | strengthening | stable | weakening | stale` from the time distribution of its evidence events; surfaced in the belief-evolution envelope, stamped into preference frontmatter by the dream refresh pass. (t_ee09a6ce)
- **Trend ranking bias**: preference pages carrying a stamped `freshness_trend` get a bounded multiplier (strengthening 1.05, weakening 0.93, stale 0.85) on the relevance portion, with a `reasons` entry. (t_ee09a6ce)
- **Event-time discipline** (`src/core/search/validity.ts`): when a document declares `valid_from` / `valid_until` frontmatter, the `since`/`until` filter tests the validity window (interval overlap); mtime stays the fallback for documents without validity fields. (t_b7191486)
- **Temporal-bridge traversal**: when a time range is active, traversal expansion docs are kept only within a padded event-time neighbourhood of the window and scored with temporal-proximity decay, labelled `temporal_bridge` - causes and consequences, not arbitrary leakage. (t_c3871f0c)
- **Two-pass recall**: in evidence-pack mode, an abstention/low-IDF-coverage verdict triggers exactly one broader second pass (uncovered rare terms OR'd onto the query, larger overfetch), merged and re-ranked, reported in the envelope. (t_ef92dfdc)
- **Surfaces**: `o2b brain activation status|sweep` CLI verb; `--no-record-access` search flag; optional `record_access` arg on the `brain_search` MCP tool. MCP tool count stays at 66.

## Out of scope

- LLM-based anything: the whole suite is deterministic (no model calls, injected clocks).
- SQLite schema changes: activation/co-access state lives in vault files (conflict-free one-file-per-event + replayable fold), not in the search index.
- Per-memory importance/valence fields (YantrikDB-style) - only access reinforcement and type half-life ship now.
- Spreading-activation scoring inside the timeline index; temporal-bridge traversal composes the existing wikilink adjacency only.
- Note-level contradiction detection, claim slots, and the rest of the entity-truth cluster (separate suite).
- Changing `select-events` filtering semantics in brain/temporal (documented as a known boundary; search-side discipline is the contract here).

## Chosen approach

Consultant Variant 2 (unified temporal-recall engine) with two containment refinements:

1. **Recording stays at the orchestrator edge.** The pure `search()` core never writes by default; CLI/MCP surfaces pass `recordAccess: true` explicitly. A cached query result does not record. This keeps the read path deterministic and tests hermetic.
2. **The freshness-trend classifier lives in `src/core/brain/temporal/`**, not in the search module: it is a preference-evidence concept consumed by belief-evolution and the dream refresh. Search consumes only the stamped frontmatter field through the existing injected-reader pattern - no brain->search import cycle.

Everything time-and-usage shaped in the search layer (half-life table, decay, activation fold, co-access graph, validity resolver, temporal-bridge math) lives under `src/core/search/activation/` + two sibling pure modules, with one storage convention: one JSON file per access event under `Brain/search/activation/`, a derived `Brain/search/activation-state.json` cache that is a pure fold of the retained events, and a deterministic sweep.

## Design decisions

- **Activation math (plur/ACT-R approximation):** per path, `strength` += 0.1 per access (capped 1.0); effective activation = `strength * 2^(-daysSinceLastAccess / halfLife(type))`. Infinite half-life types (preference, decision, antipattern) never decay. Type resolves from frontmatter `kind:` with path-prefix fallbacks (`Brain/preferences/` -> preference) and default `note`.
- **Bounded boosts, neutral defaults:** activation boost caps at 0.04, co-access at 0.03 - re-rankers, never floaters. A vault with no activation events ranks bit-identically to v0.41.0 (the tier/entity/RRF precedent). Kill switch: `recall.activationEnabled` (default true; boost is zero without data anyway).
- **Access event shape:** one file `<ts>-<hash>.json` per recorded search: query hash (FNV-1a, never raw text), top surfaced doc paths (cap 10). Co-access pairs derive from the same files - no second event stream.
- **Sweep semantics are part of the model:** events older than 90 days or beyond the 5000 most recent are dropped by sweep; because activation decays toward the type floor anyway, dropping old events approximates the limit rather than corrupting it. The derived state file is a cache - deleting it loses nothing.
- **Trend windows:** recent 30d vs prior 30d evidence counts; `stale` when last evidence is older than 60d; `new` when the preference is younger than 14d with no prior-window evidence; strengthening/weakening compare windowed applied/violated; else stable. Pure function over `(events, nowMs)`.
- **Trend is stamped, not recomputed per query:** the dream refresh pass writes `freshness_trend` into preference frontmatter (Hindsight's "refreshed on each consolidation" contract); ranking reads it via the injected frontmatter reader (O(candidates)); belief-evolution computes it live for its envelope. One classifier, two call sites.
- **Validity overlap semantics:** a document with `valid_from`/`valid_until` passes a `since`/`until` filter iff the validity interval intersects the query window; a document with only one bound treats the other side as open. Bare ISO dates resolve in UTC via the existing `time-range.ts` rules. Storage time is never consulted when explicit event time exists.
- **Temporal bridge pad:** expansion docs must carry an event time (validity start, else mtime) within `windowPad` (default 7d) of the query window; score multiplies by `hopDecay^hop * proximityDecay(deltaDays)`. Off when no time range is active - plain traversal is untouched.
- **Two-pass trigger is the existing signal:** `abstention !== null` or `idfWeightedCoverage < 0.5` from the evidence pack. The second pass ORs uncovered rare terms onto the FTS query, doubles the overfetch, merges pools (first-pass score wins on dupes), re-ranks once, and reports `secondPass: { triggered, reason, added }`. Exactly one retry, config kill switch `recall.twoPassEnabled` (default true; only fires in evidence-pack mode where the trigger exists).
- **No new MCP tool:** `brain_search` gains the optional `record_access` boolean; activation maintenance is CLI-only (`o2b brain activation`). The registry-guard budget stays at 66 tools.

## File changes

New:
- `src/core/search/activation/types.ts`, `decay.ts`, `store.ts` (events + fold + sweep), `index.ts`
- `src/core/search/validity.ts`
- `src/core/search/temporal-bridge.ts`
- `src/core/brain/temporal/freshness-trend.ts`
- `src/cli/brain/verbs/activation.ts`
- tests: `tests/core/search/activation-*.test.ts`, `tests/core/search/validity.test.ts`, `tests/core/search/temporal-bridge.test.ts`, `tests/core/search/two-pass.test.ts`, `tests/core/brain/freshness-trend.test.ts`, `tests/cli/brain-activation.test.ts`, `tests/e2e/time-aware-recall.integration.test.ts`

Modified:
- `src/core/search/ranker.ts` (activation + co-access + trend inputs, reasons)
- `src/core/search/search.ts` (activation lookup, recordAccess, validity filter, temporal bridge, two-pass controller)
- `src/core/search/types.ts` (ResolvedRecallConfig + envelope fields)
- `src/core/search/index.ts` (`resolveSearchConfig`: new recall keys `search_activation_enabled`, `search_two_pass_enabled`)
- `src/core/brain/temporal/belief-evolution.ts` (trend in envelope)
- `src/core/brain/dream.ts` (stamp freshness_trend during refresh)
- `src/cli/brain/verbs/index.ts`, `brain.ts`, `help-text.ts`, `command-manifest.ts` (activation verb)
- CLI search surface (record-access flag), `src/mcp/brain-tools.ts` (record_access arg)
- docs: README, CHANGELOG, docs/cli-reference.md, docs/how-it-works.md

## Risks and open questions

- **Hot-path file reads:** the derived activation state is one JSON read per query (cached per call); co-access lookups are map hits. Validity/trend reads reuse the per-query frontmatter reader cache the property filter already uses - verify it is shared, not re-parsed.
- **Query cache interaction:** activation changes over time, so cached results could go stale; mitigated because the cache key already includes a learned-weights fingerprint - add an activation-state fingerprint the same way.
- **Trend stamping touches dream:** keep the stamp additive (absent field = neutral) so old vaults and dry runs stay byte-identical.
- **Traversal leakage today:** current behaviour may already let out-of-window expansion docs in; the temporal bridge makes that explicit and bounded - regression-test both modes.
- **Two-pass result shape:** merging pools must preserve determinism (stable tie-breaks) and never exceed the configured limit.
