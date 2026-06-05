You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release epic "Link & Recall Intelligence Suite" - six kanban tasks shipping as one PR. The graph self-organizes, recall quality becomes measurable, and every feature publishes metrics for an upcoming dashboard plugin.

## Task 1 (t_ab540afe, p3) - Bridge discovery: propose links between embedding-near unconnected notes

Upstream (mazemaker REM phase): sample isolated/under-connected memories, run batched semantic recall to find related memories not already linked, write bridge edges weighted by similarity. Connects clusters that share no wikilink or textual mention - pure embedding adjacency.

OSB today: traversal only follows EXISTING links (applyTraversal walks outbound edges); findUnlinkedMentions only flags TEXTUAL occurrences of a known title. Nothing proposes a connection between two notes that are embedding-near but never name each other. A second discovery signal from an article: rank notes by inbound-link count and prioritize orphans (low backlink count).

## Task 2 (t_d6660a83, p3) - Frontmatter alias resolution for wikilinks

Upstream (llm-wiki-compiler): when a page declares `aliases: [...]` in frontmatter, wikilinks pointing to any alias resolve to that page.

OSB today: `src/core/brain/link-graph/alias-index.ts` exists but only scans `Brain/preferences/` + `Brain/retired/` (used by backlinks/unlinked-mentions for Brain artifacts). The SEARCH INDEX materialization (`src/core/search/store.ts` resolveLinkTargets + basename SUBSTR fallback joins) knows nothing about aliases: a wikilink `[[PA]]` to a note titled "Project Alpha" with `aliases: [PA]` stays unresolved in the links table, so traversal/backlinks/link-constraints miss it.

## Task 3 (t_e2215d49, p3, re-scoped) - Reproducible recall benchmark with fixed dataset and regression tests

Upstream (yantrikdb-hermes-plugin): benchmark runner + fixed query/expected-result dataset + tests asserting recall quality thresholds in CI.

OSB re-scope (the miner referenced a nonexistent src/core/brain/yantrikdb/ dir): benchmark OSB's OWN hybrid search (FTS5 + sqlite-vec + fusion + ranker, src/core/search/). Fixed vault fixture + fixed query set with expected results, metrics (hit@k, MRR), thresholds asserted in bun tests so ranking regressions fail CI deterministically (deterministic local embedding provider exists for tests).

## Task 4 (t_4ba927ec, p2) - Community detection materializing synthesized cluster summary notes

Upstream (mazemaker Insight phase): Louvain community detection over the consolidated link graph; for each community of size >= 4, materialize a synthetic derived-cluster summary note capturing the cluster; derived notes participate in later recall.

OSB today: buildConceptCluster only assembles depth-1 backlinks for ONE explicitly-named target; concept-gap detects uncovered entities. No graph-wide community discovery, no synthesized per-cluster note. The links table in the search index is the natural input graph.

## Task 5 (t_2fa95db1, p2) - Local query expansion into structured lex/vec/hyde lanes

Upstream (flowstate-qmd): a local model turns a raw query like "auth config" into structured expansions: lex: keyword lines for BM25, vec: natural-language lines for vector search, hyde: hypothetical-document passage.

OSB today: `src/core/search/structured-query.ts` PARSES a structured lex/vec/hyde query document (consumer exists), but lanes must be authored upstream by the caller. No producer. Constraint: deterministic expansion contract preferred (no GGUF/local-model dependency, no paid calls) - synonym table, entity registry, heuristics are available building blocks (`src/core/search/synonyms.ts`, entity registry, CJK tokenizer).

## Task 6 (t_ae973491, p2) - Opt-in self-tuning recall with persisted feedback

Upstream (yantrikdb-hermes-plugin): env-flag-gated adaptive recall parameter tuning (k, score thresholds), feedback persisted across sessions, closed-loop improvement from recall outcomes.

OSB today: `src/core/search/feedback.ts` ALREADY implements explicit up/down recall feedback events (one JSON file per event under Brain/search/feedback/) folded deterministically into bounded per-layer weight multipliers (learned-weights.json, [0.8, 1.2]). The gap: nothing tunes retrieval PARAMETERS (top-k, score thresholds, traversal depth); the fold only adjusts layer weights. Self-tuning must stay opt-in, deterministic, bounded, and replayable - same philosophy as the existing fold. The recall benchmark (Task 3) is the natural objective function / guardrail.

## Cross-cutting constraint - Dashboard-ready metrics layer

A dashboard plugin showing project metrics ships in a near-future cycle. EVERY feature above must publish its run metrics (bridge proposals generated/accepted, alias resolutions, benchmark scores over time, community count/sizes, expansion usage, tuning state) into ONE uniform, machine-readable, append-friendly metrics layer the dashboard can read without scraping logs. Today metrics are scattered: recall-telemetry.ts, gate-telemetry.ts, IndexStats, Brain/log JSONL sidecars. Decide: where the uniform layer lives (Brain/metrics/ JSONL? a metrics table in the search SQLite? both?), its schema (surface, run_at, payload), and how existing telemetry relates to it.

# Project context

Open Second Brain - TypeScript/Bun CLI + MCP server managing an Obsidian-compatible markdown vault with a hybrid search index (SQLite: FTS5 + sqlite-vec + link graph), a deterministic learning loop (dream), entity registry, schema packs (write-time ontology governance since v0.44.0), and 73 MCP tools.

Recent commits:
789e3e3 feat: Write-Time Integrity & Governance Suite - schema ontology, tier guard, secret custody, maintenance lane (#76)
c03d569 fix(hermes): root cli.py shim completes the upstream CLI discovery contract (#75)
a0054dd feat: Entity Truth & Self-Improving Dream Suite - claim ledger, outcome-aware dream, foresight (#74)
b16c37d feat: Time-Aware Recall & Activation Suite - usage-aware ranking, event-time recall, two-pass recovery (#73)
c3a2fcc feat: Agent Write Contract Suite - write sessions, decision panel, backend boundary, shared namespace (#72)

Related files:
- src/core/search/store.ts (links table, resolveLinkTargets, typed-relation readers, schema v6)
- src/core/search/indexer.ts (incremental pass, post-passes: relation constraints, tier guard)
- src/core/search/schema.ts (migrations v1-v6, LATEST_SCHEMA_VERSION=6)
- src/core/search/search.ts (hybrid pipeline: fts, vec, fusion, ranker, traversal, property filters)
- src/core/search/feedback.ts (explicit feedback events -> bounded learned weights fold)
- src/core/search/structured-query.ts (lex/vec/hyde document parser - consumer side)
- src/core/search/embeddings/{provider,registry,local-provider,null-provider,openai-compat}.ts
- src/core/search/synonyms.ts, src/core/search/entities.ts, src/core/search/traversal.ts
- src/core/brain/link-graph/{alias-index,unlinked-mentions,concept-cluster,moc-audit}.ts
- src/core/brain/recall-telemetry.ts, src/core/brain/gate-telemetry.ts
- src/core/brain/maintenance/lane.ts (leased maintenance lane, v0.44.0 - natural host for periodic passes)
- src/cli/brain/verbs/, src/mcp/brain-tools.ts (verb + MCP tool registration patterns)

Conventions:
- TDD, atomic conventional commits, oxlint + oxfmt before every commit, bun test (4091 tests / 526 files)
- Schema migrations are versioned (v6 latest); new tables ship as one migration with LATEST_SCHEMA_VERSION bump
- Deterministic-first: pure folds, replayable derivations, no wall-clock/randomness in core logic (clock injected via opts)
- Fail-soft on missing index/providers; fail-closed on vocabulary/write validation
- New CLI verbs register in 5 places (brain.ts, verbs/index.ts, help-text.ts x2, command-manifest.ts); MCP tool descriptions capped at 300 chars; tool count pinned in tests
- Heavy periodic work belongs in the maintenance lane (window + busy gate + lease)
- Proposals/derived artifacts must be reviewable before they mutate canonical notes (cf. dream dry-run, staged tier-drift repair)

Constraints:
- No new external runtime dependencies (no GGUF models, no paid API calls in core paths; embedding provider abstraction already exists and tests use the deterministic local provider)
- Bridge/community output must NOT silently mutate user notes: proposals must be reviewable artifacts (the operator or an agent accepts them)
- Self-tuning must be opt-in, bounded, deterministic, replayable - mirroring the existing learned-weights fold contract
- Do not break existing public APIs (search(), Store, MCP tool contracts); additive schema migration v7 is acceptable
- The metrics layer must be readable by a future dashboard plugin without importing OSB internals (stable on-disk contract)
- All six tasks ship in ONE PR (~50-70 files), each as its own atomic commit sequence

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
