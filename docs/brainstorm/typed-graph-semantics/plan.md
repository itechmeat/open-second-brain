# Typed graph semantics - implementation plan

Four atomic units on one feature branch (`feat/typed-graph-semantics`), each a separate conventional commit, each TDD (failing test first). Task 1 is the shared foundation and lands first; Tasks 2-4 depend on it.

## Tasks

### Task 1: Relation/visibility vocabulary + typed-edge column (foundation)
- **Maps to**: t_d3c017f2 (typed edge classification)
- **Files**:
  - new `src/core/graph/relation-vocab.ts` - default relation set (`related`, `extends`, `contradicts`, `superseded_by`) + visibility set, one `isKnownRelation` / `isKnownVisibility` / `normalizeRelation` validation function; vocabulary is a data constant + documented open-extension rule (unknown values preserved, not rejected).
  - `src/core/search/schema.ts` - migration `{version: 3, up}` adding nullable `relation TEXT` to `links`; bump `LATEST_SCHEMA_VERSION` to 3.
  - `src/core/search/store.ts` + `src/core/search/links.ts` - add `relation?: string | null` to `ExtractedLink`; `replaceLinks` writes the column.
  - new `tests/core/graph/relation-vocab.test.ts`, `tests/core/search/schema-migration-v3.test.ts`.
- **Acceptance**:
  - Vocabulary module: known/unknown relation + visibility classification, and a single exported boundary; no relation literal duplicated elsewhere (asserted by a wiring test).
  - Migration: a v2 index migrates to v3 with the new column present and existing rows intact; a fresh index builds at v3; reindex is idempotent.
  - `relation` round-trips through `replaceLinks` and back.
- **Depends on**: none

### Task 2: Typed frontmatter relationships (ingest + surface + dream)
- **Maps to**: t_812695ec (typed semantic relationships)
- **Files**:
  - `src/core/search/indexer.ts` - parse document frontmatter (the indexer already holds raw `content`) and emit typed edges from relation fields (`related`/`extends`/`contradicts`/`superseded_by`, each string or string[]) with `relation` set via the vocabulary module. Frontmatter edges attach at document level (first chunk).
  - `src/core/brain/backlinks.ts` - add `relation?` to `BacklinkRef`, derived from the known relation fields (generalizing the existing `supersedes`/`superseded_by`/`evidenced_by` field mapping to arbitrary pages).
  - `src/core/search/types.ts` + result builder - `BrainSearchResult.relations?` (computed per result page: inbound/outbound contradicts + superseded_by), never stored.
  - `src/mcp/brain-tools.ts` + `src/cli/brain/verbs/query-render.ts` - surface `relations` inline in `brain_search` / `brain_query` output (structured + human render).
  - tests: `tests/core/search/typed-relations.test.ts`, `tests/core/brain/backlinks-relation.test.ts`, `tests/mcp/search-relations.test.ts`.
- **Acceptance**:
  - A page with `contradicts: [[X]]` / `superseded_by: [[Y]]` produces typed edges and the relation surfaces in search/query results for the involved pages.
  - Backlink index reports the relation type per ref.
  - No public outputSchema broken: `relations` is additive/optional.
- **Explicitly NOT in this task**: dream / merge supersession writing - already implemented (`merge.ts:216`, `dream.ts:531`) and tracked by the backlink index. The dream algorithm is not touched (no LLM-free judgement extension to `contradicts:`).
- **Depends on**: Task 1

### Task 3: Content visibility scoping
- **Maps to**: t_acf962a8 (content visibility tag system)
- **Files**:
  - `src/core/graph/relation-vocab.ts` - visibility default + the single scoping rule: absent `visibility:` = visible everywhere; a `visibility:` value restricts the page to callers that opt into that value. One rule, data-driven.
  - `src/core/search/types.ts` + search pipeline - honor a reserved `visibility` key inside the existing `SearchOptions.properties` post-rank filter; default query excludes non-default-visibility pages unless `visibility` is explicitly requested.
  - `src/mcp/brain-tools.ts` / `src/mcp/tools.ts` - MCP read tools accept/forward the visibility scope; default-permissive.
  - tests: `tests/core/search/visibility-filter.test.ts`, `tests/mcp/visibility-scope.test.ts`.
- **Acceptance**:
  - A page with `visibility: [private]` is excluded from a default search and included only when the caller requests that visibility.
  - Pages with no `visibility:` behave exactly as today (zero regression - asserted).
  - The scoping rule lives in one place, consumed by both CLI and MCP.
- **Depends on**: Task 1

### Task 4: MCP-config extraction into the graph
- **Maps to**: t_711215c1 (MCP config file extraction into knowledge graph)
- **Files**:
  - new `src/core/graph/mcp-config.ts` - parse `.mcp.json` / `mcp.json` / `mcp_servers.json` / `claude_desktop_config.json` into typed edges: server, package (npm/pip ref), env-requirement (name only - values discarded). Synthetic-target convention reused from `tag` edges.
  - `src/core/search/indexer.ts` - discover those config files within the vault scope and feed their edges through the same typed-edge path (relation via vocabulary module).
  - `src/mcp/brain-tools.ts` / `src/mcp/tools.ts` - a read-only surface to query the MCP landscape (servers + their package/env requirements) from the graph.
  - tests: `tests/core/graph/mcp-config.test.ts` (incl. env-value-discard assertion), `tests/mcp/mcp-landscape.test.ts`.
- **Acceptance**:
  - Each supported config filename parses into the expected server/package/env edges.
  - Env *values* never appear in any edge (explicit test).
  - Discovery is vault-relative only (no filesystem-wide scan).
  - The read tool returns the configured MCP servers and their requirements.
- **Depends on**: Task 1
