You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement the "Time-Aware Recall & Activation Suite" for Open Second Brain: six related kanban tasks shipping as one release. All six upgrade the recall ranking / temporal layer.

## Task 1 (t_2bc79017, p4): Access-reinforced, type-aware activation decay in recall ranking

Each memory should carry a retrieval activation that decays toward a floor with days-since-access and is bumped (capped) on every recall access (ACT-R reactivation), plus a content-type-specific half-life table (e.g. preferences/decisions never decay, projects ~120d, handoffs ~30d). Today OSB recency is a single Weibull curve over file mtime (src/core/search/ranker.ts recencyBoost + src/core/search/recency.ts): a constantly-useful preference and an untouched note of equal age rank identically. usedCount is recorded in procedural-memory but unused in ranking. The activation signal must be deterministic and explainable (a `reasons` entry).

## Task 2 (t_ee09a6ce, p4): Freshness-trend classification on preferences folded into recall

Tag every preference with a computed freshness trend (new / strengthening / stable / weakening / stale) derived from the time-distribution of its applied/violated/outdated evidence events (src/core/brain/temporal/belief-evolution.ts collectEvidence has runningApplied/Violated/Outdated; stale-watch.ts has only a binary ageDays threshold). The trend should be a first-class computed field surfaced on temporal/brain surfaces AND bias recall ranking (down-rank weakening/stale preference pages, slightly up-rank strengthening ones).

## Task 3 (t_b7191486, p4): Event-time vs storage-time discipline in time-aware recall

OSB stores bi-temporal fields (valid_from / valid_until / recorded_at exist in temporal event types and as documented frontmatter keys) but time-range recall filters on chunk mtime only (src/core/search/search.ts mtimeInRange(h.mtime, timeRange) at the hydrate stage; time-range.ts parses since/until). Make the validity window the authority for time-aware recall: a document whose frontmatter declares valid_from/valid_until should be in/out of a since/until window based on event time, falling back to mtime when no validity fields exist. Never infer event dates from storage timestamps when explicit ones exist.

## Task 4 (t_c5ef25a3, p2, child of Task 1): Co-access reinforcement edges between co-retrieved memories

Record a co-activation signal: documents frequently surfaced together in the same retrieval gain a pairwise reinforcement edge, so recalling one boosts its habitual companions. Edges form automatically at recall time, bounded and deterministic. Today each chunk ranks independently and only author-written wikilinks feed the link boost.

## Task 5 (t_c3871f0c, p2, child of Task 3): Causal-temporal traversal reconstructing event stories from a time window

A bounded BFS over wikilink + timeline-adjacency edges seeded from a temporal window so "what happened around X" recall pulls in causes and consequences, not just notes dated inside the window. OSB has link-graph traversal (src/core/search/traversal.ts expandByTraversal, seeded from ranked hits), a TimelineIndex (src/core/brain/temporal/types.ts), and Weibull recency - but graph traversal and temporal filtering never compose.

## Task 6 (t_ef92dfdc, p3): Self-correcting two-pass recall: re-query on insufficient evidence

When the first recall pass yields insufficient evidence (the existing evidence-pack coverage / abstention signal in src/core/search/evidence-pack.ts fires), run a second broader retrieval pass with a relaxed semantic threshold and fallback query terms, merge with the original candidate pool, and re-rank - instead of returning an empty/low-coverage result. Deterministic trigger, bounded retry (one extra pass).

# Project context

Open Second Brain: TypeScript on Bun, SQLite (bun:sqlite + sqlite-vec), Markdown/Obsidian vault as source of truth. CLI (`o2b`) + MCP server + OpenClaw/Hermes plugin surfaces. v0.41.0, ~3760 tests, strict tsc, oxlint.

Recent commits:
c3a2fcc feat: Agent Write Contract Suite - write sessions, decision panel, backend boundary, shared namespace (#72)
7733f20 feat: Project History Suite - git history memory, ADR mining, architecture notes, query telemetry (#71)
8e8c0bc feat: Memory Observability Suite - versioned continuity contract, lazy telemetry, ATOF/ATIF export, recall benchmark (#70)
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)

Related files:
- src/core/search/ranker.ts - pure ranking fn: normalized BM25 + cosine + link/tag boost + Weibull recency + tier multiplier + entity boost + session focus; explainable `reasons` array; weightProfile multipliers (intent x learned weights)
- src/core/search/recency.ts - pure weibullDecay(ageDays, {shape, scale, amplitude})
- src/core/search/search.ts - orchestrator: keyword+semantic lanes, hydrate, time-range filter (mtime), entity expansion, MMR, traversal, property/visibility filters, evidence pack, query cache (skipped when timeRange set)
- src/core/search/time-range.ts - parseTimePoint/resolveTimeRange/mtimeInRange (pure, injected clock)
- src/core/search/traversal.ts - pure expandByTraversal (hop decay, caps); search.ts applyTraversal fetches adjacency level-by-level
- src/core/search/feedback.ts - recall feedback events, one JSON file per event under Brain/search/feedback/, learned weights = pure fold, derived cache file
- src/core/search/evidence-pack.ts - coverage report, abstention, completeness verdict
- src/core/search/schema.ts - SQLite migrations v1-v5 (additive ALTER/CREATE, LATEST_SCHEMA_VERSION=5); store.ts owns the connection
- src/core/search/store.ts - all SQL; hydrateChunks, inboundLinkSources, outboundLinkTargets, chunkEntityMatches, semanticTopK
- src/core/search/property-filter.ts - post-FTS frontmatter filter via injected reader
- src/core/brain/temporal/types.ts - TemporalEvent (validFrom/validUntil/recordedAt), TimelineIndex, TimelineWindow
- src/core/brain/temporal/belief-evolution.ts - collectEvidence with runningApplied/Violated/Outdated per event
- src/core/brain/temporal/stale-watch.ts - binary ageDays threshold scan
- src/core/brain/page-meta/tier.ts - PageTier + tierWeight multiplier
- src/cli/brain/verbs/ + src/mcp/brain-tools.ts - CLI/MCP surfaces (65 MCP tools; registry guard caps tool count growth and description length <= 300 chars)

Conventions:
- Deterministic core: no LLM calls in src/core; injected clocks (nowMs / now options) for all time-dependent logic; pure functions preferred, I/O at orchestrator edges
- Conflict-free vault writes: one small JSON/md file per event (Brain/inbox/, Brain/search/feedback/ pattern); derived caches are replayable folds
- Backward compatibility: absent config/data must keep ranking bit-identical to prior behaviour (the "neutral default" rule seen in tier, entity, weightProfile, RRF layers)
- SQLite migrations are additive; new columns/tables default to inert until a reindex populates them
- Explainable recall: every scoring layer that fires must surface a `reasons` entry
- Every feature lands with bun tests; CLI verbs + MCP tools updated together; MCP tool budget guarded (prefer extending existing tools with ops over adding many new tools)

Constraints:
- Do not change existing public APIs incompatibly (CLI flags, MCP tool contracts, search result shape may gain optional fields only)
- No new external dependencies
- No LLM calls anywhere in the new code (deterministic suite)
- Keep the per-query hot path fast: activation/co-access lookups must be O(candidates), not O(vault)
- MCP tool count growth must stay minimal (0-1 new tools; prefer ops on existing tools / new CLI verbs)

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
