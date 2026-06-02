You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One multi-task PR ("Recall Trust Suite") bundling five kanban tasks that all extend the Open Second Brain search/recall stack. The theme: recall an agent can trust — relation-aware ranking, auditable learned weights, verified multi-record evidence, time-scoped queries, and completeness guards.

## Feature A — Relation-aware recall for typed memory edges (t_d8571bf0, P3)

Open Second Brain already has typed graph relations (`related`, `extends`, `depends_on`, `refines`, `contradicts`, `superseded_by`) declared in page frontmatter and surfaced in search results, but they do not participate in ranking. Add a relation-polarity layer:

- `superseded_by` is a stale-predecessor signal: when the predecessor matches, pull in and boost the successor; demote the predecessor unless the query explicitly asks for history.
- `contradicts` is relevant-but-not-endorsing: surface the contradicting artifact with warning-style explanation, no positive graph halo.
- `depends_on`, `extends`, `refines` are directional positive relevance with weaker weights than direct text match.
- `why_retrieved` gains reasons like `superseded by <id>`, `contradicted by <id>`, `refines matched memory`.
- History-oriented flows must still be able to include predecessors without demotion.
- Deterministic, transparent, conservative defaults, no LLM dependency. Default behavior stays stable for vaults without typed relations.

## Feature B — Retrieval feedback loop for learned recall weights (t_68e1b774, P3)

Search weights (keyword, semantic, link, entity, recency, intent) are currently configured statically. Add optional recall-feedback capture and a deterministic learned-weight update path:

- Lightweight feedback artifact or JSONL sidecar for recall events: query hash, selected/dismissed result IDs, explicit thumbs-up/down, scoring contributions at retrieval time.
- CLI (`o2b search feedback`) and MCP (`brain_recall_feedback`) surfaces for explicit feedback.
- Deterministic, bounded per-layer adjustments; learned weights stored separately from configured defaults; both visible in diagnostics.
- Reset/freeze controls; operator config remains base policy; learned weights cannot drift outside documented limits.
- No reinforcement learning, no opaque training, opt-in only.

## Feature C — Full verified multi-record recall (t_407a3477, P2, follow-up of merged PR #54)

PR #54 shipped evidence packs (matched/missing terms, support coverage, abstention field, per-record `why_retrieved`, terminal-state downrank, CLI `--evidence-pack`, MCP `evidence_pack`). The remaining upstream scope:

- Per-token multi-record recall union — gather records covering each significant query token, not just the top-ranked set, so evidence can span multiple records.
- IDF verifier — weight term coverage by inverse document frequency when judging support.
- Rare-term gate — require rare/high-signal terms to be covered before answering, else abstain (populate the existing abstention field).

## Feature D — Time-aware recall with natural-language time ranges (t_9dfbaa76, P2)

Recall queries cannot be scoped by time today. Add since/until parameters accepting ISO timestamps, relative phrases (yesterday, last week), and duration shorthand (7d, 24h, 2w):

- Wire through CLI search flags and the MCP brain_search tool schema.
- Filter or constrain candidates by document mtime/frontmatter date during ranking.
- There is no existing natural-language date parsing utility in the repo; one must be added (deterministic, no external dependency preferred).

## Feature E — Search-completeness guard (t_854b8e5f, P1)

No guard verifies that retrieval adequately covered the query. Add a deterministic search-completeness check: audit whether top-N results cover the significant query terms, expose a completeness verdict/metric in search output (and evidence pack), so downstream summarizers can detect false-absence claims and incomplete retrieval. No LLM verification — deterministic coverage auditing only.

# Project context

Open Second Brain — TypeScript on Bun. Obsidian-compatible Markdown vault as memory store; SQLite FTS5 search index with optional semantic embeddings; CLI (`o2b`) + MCP server surfaces for connected agents (Claude Code, Codex, Hermes).

Recent commits:
23ff4fb refactor(hermes): single intentional self-bootstrap for the plugin entrypoint (#63)
0952dfc feat: become a native Hermes memory provider (#62)
6fbab0b feat: hands-off post-upgrade migration (v0.31.2) (#61)
496dd2d fix: make plugin updates self-healing (v0.31.1) (#60)
09c0592 chore(release): v0.31.0 (#59)
b81335c Feat/procedural attention suite (#58)
1f3a218 Feat/self learning skill proposals (#57)
0162d13 feat(brain): add context continuity and receipts suite (#56)
3b7b3a5 feat(brain): add safety governance foundations (#55)
794ee45 feat(search): ship recall control and trust surfaces (#54)
40d4e2b feat: cjk schema lifecycle recovery (#53)

Related files:
- src/core/search/search.ts (orchestrator: FTS -> semantic -> hydrate -> rank -> MMR -> traversal -> property filter -> evidence pack; config fingerprint for query cache at :61)
- src/core/search/ranker.ts (RankerInputs/RankerOptions; layered score: keyword+semantic*tier + entity + link + recency + sessionFocus; buildReasons -> why_retrieved)
- src/core/search/evidence-pack.ts (EvidenceRecord/EvidencePack: matchedTerms, missingTerms, supportCoverage, terminalState, abstention)
- src/core/search/traversal.ts (link-graph BFS expansion with hop decay)
- src/core/search/recency.ts (Weibull decay: shape/scale/amplitude)
- src/core/search/query-plan.ts (intent classification -> WeightProfile multipliers)
- src/core/search/types.ts (SearchOptions, BrainSearchResult.relations, ResolvedRecallConfig)
- src/core/search/index.ts (resolveSearchConfig: env + config.yaml + _brain.yaml)
- src/core/graph/relation-vocab.ts (DEFAULT_RELATION_TYPES), src/core/graph/frontmatter-relations.ts (frontmatter extraction)
- src/core/search/schema.ts (SQLite schema; links table has no relation column — frontmatter relations computed at query time)
- src/cli/search.ts (o2b search query|index|reindex|status|check|focus)
- src/mcp/search-tools.ts (brain_search MCP tool schema; recall telemetry wiring)
- src/core/brain/recall-telemetry.ts (emitRecallTelemetry -> continuity JSONL store; precedent for feedback capture)
- tests/core/search/*.test.ts (bun:test; createTempVault/writeMd/makeConfig fixtures)

Conventions:
- Bun runtime; bun test; oxlint + oxfmt; `bun run validate` = typecheck + lint + test.
- Conventional commits; one PR = one CHANGELOG version (may bundle several features).
- Deterministic core: brain features avoid LLM calls in the core path; everything auditable and explainable (why_retrieved pattern).
- Search config resolved from env > config.yaml > defaults; static recall config is fingerprinted into the query cache key.
- MCP tools are read-only on the search surface; index management is CLI-only.
- Prior suites shipped as multi-feature PRs: search-recall-suite (#46-ish), recall-ranking-suite (#47), recall-control-trust-suite (#54).

Constraints:
- Do not change existing public API shapes (BrainSearchResult fields may gain optional fields, not change existing ones).
- No new external runtime dependencies.
- Default search behavior must remain stable for users who do not opt in (feedback loop, time filters, completeness guard are additive; relation-aware ranking needs conservative defaults).
- All five features in one PR on one branch, implemented sequentially via TDD, atomic commits per feature.
- SQLite schema changes must come with index-version bump / rebuild path (existing pattern).

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
