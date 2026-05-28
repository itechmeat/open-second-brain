# Cross-agent query foundation - variants audit trail

## Consultant output (Claude Code)

### Variant 1: Provenance-filter extension on existing surfaces

- **Approach**: Treat agent identity as just another filter dimension. Add an optional `agent` parameter to `brain_search`/`brain_query` (indexing the existing per-signal `agent` frontmatter), and add an `agent` grouping mode to `brain_digest` that buckets signals/preferences/log entries by source and reports per-agent counts plus a set-difference of topics. No new tools, no new core module; the agent universe is derived at query time from distinct `agent` values already present in the vault.
- **Trade-offs**:
  - Pro: smallest possible change; reuses the index, the search pipeline, and the digest renderer already in place.
  - Pro: automatically universal — any agent that ever wrote a signal becomes filterable/diffable with zero registration, satisfying the no-hardcoded-matrix constraint for free.
  - Pro: fully deterministic and structured; no synthesis layer to govern.
  - Con: does not deliver a real "cross-agent query" — it filters vault content, never touches raw session history, and produces no synthesized answer, so it under-serves `t_51c827e7`'s intent.
  - Con: diff is shallow (topic set-difference inside one tool's output), with no stable foundation for richer comparison/map modes later.
  - Con: stretches two general-purpose tools with a niche dimension, risking parameter bloat and weaker separation of concerns.
- **Complexity**: small
- **Risk**: low

### Variant 2: Dedicated agent-source query foundation + two comparison tools

- **Approach**: Introduce a `core/brain/agent-source/` module defining an `AgentSourceProvider` abstraction and a registry that enumerates the agent universe dynamically (vault provenance today; session adapters and future runtimes register the same way). Expose `brain_agent_query` (agent-scoped retrieval with deterministic, structured synthesis over matched signals/preferences/log entries) and `brain_agent_diff` (browse/search/diff/map modes comparing contributions and surfacing per-agent knowledge gaps). The query layer is the shared foundation; the diff tool consumes it, matching the dependency the tasks describe.
- **Trade-offs**:
  - Pro: directly realizes the operator's framing — a universal agent-source query _foundation_ with a first comparison surface, rather than a one-off.
  - Pro: registry-based provider model means new agents require a registration, not a query-layer rewrite; reuses the proven `SESSION_ADAPTERS` pattern.
  - Pro: clean SOLID boundaries — synthesis, provenance resolution, and comparison are separable and independently testable (good fit for TDD-first).
  - Pro: keeps outputs structured/deterministic while still offering a synthesized answer surface.
  - Con: largest design surface of the three; more new files, schemas, and tests to land in one PR.
  - Con: the `AgentSourceProvider` abstraction risks over-engineering if only the vault-provenance provider ships initially.
  - Con: requires careful idempotency-key design so query results are stable and the diff layer can build on them.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Raw session-history index with ingest-and-synthesize query

- **Approach**: Build a persistent session-history store/index over imported transcripts so cross-agent queries run against raw agent history (mirroring upstream's "query one tool's session history"), including a no-query form that ingests the last N unprocessed sessions on demand and synthesizes immediately. The diff tool then compares per-agent history coverage. Agent universe comes from the session adapter registry plus whatever the store has indexed.
- **Trade-offs**:
  - Pro: closest fidelity to the upstream feature being ported, including freshness-on-query ingestion.
  - Pro: can answer questions about things never distilled into signals/preferences, the richest possible recall.
  - Con: heaviest build — a new history store, indexing, freshness/ingestion orchestration, and synthesis governance all at once.
  - Con: diverges from OSB's vault-centric, deterministic model; raw-history synthesis is the most "opaque LLM-only" of the options, cutting against project conventions.
  - Con: storage/index duplication with the existing search index and import pipeline raises DRY and maintenance concerns.
  - Con: high test surface and the largest blast radius for one playbook PR.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2

**Rationale**: It is the only option that satisfies the operator's explicit ask — a universal agent-source query _foundation_ with a first comparison surface, where new agents register rather than force a rewrite — while keeping the two tasks' query→diff dependency clean. It reuses the existing registry/provenance patterns and stays deterministic and structured (unlike Variant 3's raw-history synthesis), yet delivers a real cross-agent query layer that Variant 1's filter-only approach cannot. The scope fits one feature-release-playbook PR if the provider abstraction starts with a single vault-provenance implementation and grows by registration later.

## Orchestrator decision

Choose Variant 2.

The decisive factor is not feature richness but durability: the operator explicitly asked for a universal foundation that remains valid when new agents arrive. Variant 2 is the narrowest option that creates a reusable agent-source boundary now, keeps query and comparison as separate read-only layers, and avoids prematurely committing the project to a raw transcript store. It also leaves the currently blocked Copilot and Pi adapter tasks as later registrations instead of forcing them into this PR.
