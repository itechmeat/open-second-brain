You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship "typed graph semantics" for Open Second Brain: the brain's link/backlink graph and page frontmatter gain typed, machine-readable semantic meaning that the search, query, and dream layers honor. Four atomic units share one release:

1. **Typed edge classification.** Today `LinkType = "wikilink" | "markdown_link" | "tag"` (src/core/search/links.ts:15) and the `links` SQLite table constrains `link_type` to those three (src/core/search/schema.ts:84-91). There is no way to record WHAT KIND of relationship a link represents. Add a semantic relation dimension to edges so the graph is queryable by relationship meaning, not just by link syntax.

2. **Typed frontmatter relationships.** Pages/preferences should be able to declare typed relationships in frontmatter: `related:`, `extends:`, `contradicts:`, `superseded_by:`. These become typed edges in the graph. `brain_search` / `brain_query` should surface contradictions and supersession inline in results, and `brain_dream` could auto-populate `superseded_by:` / `contradicts:` during consolidation. Note: the preference domain already tracks `supersedes` / `superseded_by` / `evidenced_by` as backlink fields (src/core/brain/backlinks.ts:194-207) — this generalizes typed relations to arbitrary pages.

3. **Content visibility tags.** A typed frontmatter field (e.g. `visibility:`) that scopes which content is reachable by which consumer/agent. The search layer already has a post-rank `properties` frontmatter filter (SearchOptions.properties, v0.10.17, src/core/search/types.ts:116-130) — visibility is an orthogonal scoping axis layered over that. No content-visibility control exists today; all notes/preferences are equally visible to any agent via MCP.

4. **MCP config extraction into the graph.** Parse `.mcp.json`, `mcp.json`, `mcp_servers.json`, `claude_desktop_config.json` found in the vault into typed graph nodes/edges: server nodes, npm/pip package references, env-var requirements. Env VALUES are discarded to prevent secret leakage. This lets agents reason about the MCP/tool landscape of a project from the brain graph.

# Project context

Open Second Brain: TypeScript, Bun runtime. An Obsidian-native plain-Markdown memory layer for AI agents. MCP server (JSON-RPC 2.0) + `o2b` CLI. Plain `.md` files under `Brain/` in the user's vault. No daemon, no vector black box, no hidden state outside the vault.

Recent shipped releases (most recent first):
- v0.18.0 MCP context economy (preview budget + artifact fetch + recall hint)
- v0.17.0 Brain Lifecycle Review Suite (intent review, retention, monthly synthesis)
- v0.16.0 Agent boundary control (pinned context, Markdown links, MCP output contracts)
- v0.13.0 Hybrid Search and Recall Quality (explainable recall, MMR, link traversal, entity boost, header anchoring)
- v0.11.0 Brain-centric vault layout: one agent-owned `Brain/` root, opt-in user notes
- v0.10.17 link graph surfaces (aliases, anchors, mentions, synthesis, MOC audit, property filter)

Related files:
- src/core/search/links.ts (LinkType, extractLinks — strips code fences, extracts wikilink/markdown_link/tag)
- src/core/search/schema.ts (DDL + versioned MIGRATIONS array, LATEST_SCHEMA_VERSION=2, links table with link_type CHECK constraint)
- src/core/search/store.ts (replaceLinks INSERT into links; link traversal queries filter `link_type IN ('wikilink','markdown_link')`)
- src/core/search/types.ts (SearchOptions.properties post-rank frontmatter filter; BrainSearchResult shape)
- src/core/brain/backlinks.ts (buildBacklinkIndex — inverts the reference graph; already records `field` per ref incl. supersedes/superseded_by/evidenced_by)
- src/core/brain/explorer.ts (ExplorerNode, backlink_count)
- src/core/brain/dream.ts (deterministic consolidation pass — clusters signals, promotes/retires preferences; NO LLM inside the algorithm)
- src/core/types.ts (FrontmatterValue = string|number|boolean|ReadonlyArray<string>; FrontmatterMap)
- src/mcp/brain-tools.ts, src/mcp/tools.ts, src/mcp/server.ts (MCP tool table; OSB's own MCP server)
- src/cli/brain/verbs/ (57 CLI verb files)

Conventions:
- Plain Markdown is the source of truth. Frontmatter is YAML; FrontmatterMap supports string arrays already.
- The search index (SQLite) is a derived cache — it can be reindexed from the vault at any time (`o2b search reindex`). Schema changes ship as an appended migration that bumps LATEST_SCHEMA_VERSION; a stale index errors and asks the user to reindex.
- `dream` is strictly deterministic — no LLM calls inside the consolidation algorithm.
- Read-only graph builders recompute on demand (no on-disk backlink cache); they skip unparseable files rather than throwing (doctor flags malformed files).
- MCP tools have machine-readable `structuredContent` + an `outputSchema` contract; large tools carry a preview budget (v0.18.0).
- TDD is mandatory (bun:test). oxlint + oxfmt + tsc --noEmit must stay green. `bun run validate` = typecheck && lint && test.

Constraints:
- Do NOT hardcode natural-language phrases in any specific human language. All identifiers/templates are English; if any text must vary by language, keep it abstract/data-driven, never a hardcoded per-language string.
- Do NOT break existing public MCP tool output contracts or outputSchemas.
- Do NOT add an LLM call inside the deterministic `dream` algorithm.
- Prefer extending existing surfaces (links table, backlink index, properties filter, frontmatter conventions) over new parallel subsystems. SOLID/KISS/DRY.
- No new heavyweight external dependencies without strong justification.
- The vocabulary of relation types and visibility values must be open/extensible, not a closed hardcoded enum baked into many call sites — but validated at a single boundary.

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
