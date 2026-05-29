### Variant 1: Layered extension of existing surfaces
- **Approach**: Each of the four units extends its nearest existing surface independently. Add a `relation` column to the `links` table (migration → schema v3); generalize the backlink index's existing per-field tracking (which already handles `supersedes`/`superseded_by`/`evidenced_by`) to cover `related`/`extends`/`contradicts`/`superseded_by` for arbitrary pages; treat `visibility:` as a reserved key inside the existing post-rank `properties` filter with a scoping rule; and add a standalone MCP-config extractor that emits server/package/env edges into the `links` table with a node-kind tag.
- **Trade-offs**:
  - Pro: smallest blast radius — every unit lands on code that already exists (links table, backlink index, property filter), maximizing KISS and reindex-safety.
  - Pro: low risk to public MCP output contracts since each change is additive and local.
  - Pro: ships incrementally; units are independently testable.
  - Con: the relation/visibility vocabulary gets validated in several places (link parse, frontmatter parse, MCP extractor), violating the "single validation boundary" constraint.
  - Con: no unified way to query "all semantic edges regardless of origin"; relation meaning is spread across links + backlink index.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Unified edge-semantics layer over the links table
- **Approach**: Add a single `relation` column (plus a `visibility` column or reserved target convention) to the existing `links` table, and route every edge source — wikilinks, markdown links, tags, typed frontmatter fields, and MCP config — through one data-driven relation/visibility vocabulary module that classifies and validates at a single ingestion boundary. Non-file entities (MCP servers, npm/pip packages, env-var requirements) reuse the same synthetic-target pattern that `tag` edges already use, so they live as edges in the one table. Search/query/dream read relation + visibility from this one column set.
- **Trade-offs**:
  - Pro: satisfies "open/extensible vocabulary validated at exactly one boundary" cleanly — one registry, one classify function, one migration.
  - Pro: maximally DRY; reuses the established "target need not be a file" precedent (tags) for MCP nodes.
  - Pro: one place for search/dream to consume relations, so contradiction/supersession surfacing and dream auto-population share a single read path.
  - Con: overloads the `links` table with semantically heterogeneous edges (syntactic links + frontmatter relations + MCP infra), so queries must always filter by relation/kind.
  - Con: MCP server/package "nodes" as synthetic link targets is workable but slightly awkward — no first-class node attributes beyond the target string.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Dedicated typed graph subsystem (nodes + semantic edges tables)
- **Approach**: Introduce a new typed-graph store — a `graph_nodes` table (files, preferences, MCP servers, packages, env requirements) and a `graph_edges` table carrying `relation` and `visibility` columns — alongside the existing `links` table, with `links` becoming one feeder into it. A central vocabulary registry validates relation/visibility at ingestion. Frontmatter relations, MCP config, and wikilinks all normalize into this uniform node/edge model that search, query, and dream traverse.
- **Trade-offs**:
  - Pro: cleanest conceptual model — first-class non-file nodes (MCP servers/packages) with real attributes, clean split between syntactic links and semantic edges.
  - Pro: most future-proof for arbitrary typed-graph reasoning and cross-entity queries.
  - Con: directly violates "prefer extending existing surfaces over new parallel subsystems" — two graph representations to keep synchronized and reindex coherently.
  - Con: largest migration and highest risk to reindex correctness and to existing link-traversal queries that target the `links` table.
  - Con: most code to test for a release whose four units don't yet demand full node-attribute richness.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It is the only variant that fully honors the binding constraints — an open, data-driven relation/visibility vocabulary validated at a *single* boundary (Variant 1 scatters that validation) while still extending the existing `links` table rather than standing up a parallel graph subsystem (Variant 3's main violation and risk). The synthetic-target convention that `tag` edges already established gives MCP server/package/env edges a home without new tables, keeping the schema change to one appended migration and giving search/query/dream a single relation read-path for surfacing contradictions, supersession, and dream auto-population.
