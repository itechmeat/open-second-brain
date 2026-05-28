# Typed graph semantics - typed edges, frontmatter relationships, visibility, MCP-config nodes

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's graph records only link *syntax* (`LinkType = wikilink | markdown_link | tag`) and has no notion of what a link *means*. Pages cannot declare typed relationships (`related`, `extends`, `contradicts`, `superseded_by`), there is no content-visibility scoping (every note is equally visible to every agent), and the MCP/tool landscape configured around a vault is invisible to the brain. Agents therefore cannot ask "what supersedes this?", "what contradicts this?", "show only content visible to me", or "which MCP servers does this project configure?".

## Scope

- A single, data-driven **relation/visibility vocabulary** module validated at exactly one boundary (the foundation shared by every other unit).
- A **typed edge** dimension (`relation`) on the existing search `links` table (schema migration v3), orthogonal to the existing `link_type` syntax dimension.
- **Typed frontmatter relationships** (`related` / `extends` / `contradicts` / `superseded_by`) on *arbitrary vault pages* ingested as typed edges in the search graph, recorded with a relation type in the Brain-layer backlink index, and surfaced inline by `brain_search` / `brain_query`. (Note: preference-domain supersession is already a typed relation written deterministically by `merge.ts` / `dream.ts` and tracked by the backlink index per `field` - this unit generalizes typed relations to *any* page and makes them first-class graph edges; it does not re-implement preference supersession.)
- **Content visibility** (`visibility:` frontmatter) honored as a reserved key in the existing post-rank `properties` filter and respected by the MCP read surface.
- **MCP-config extraction**: parse `.mcp.json` / `mcp.json` / `mcp_servers.json` / `claude_desktop_config.json` found in the vault into typed edges (server / package / env-requirement), discarding env *values*.

## Out of scope

- A new parallel graph subsystem (separate `graph_nodes` / `graph_edges` tables). Rejected variant 3 - OSB deliberately extends existing surfaces.
- Any LLM call inside the deterministic `dream` algorithm. Auto-population is derived from supersession decisions dream already computes deterministically.
- AST-level typed-edge extraction from code blocks (the upstream graphify origin of unit 1). Adapted to a Markdown vault: relation types come from frontmatter and the vocabulary module, not from parsing code.
- Cross-machine / per-agent identity enforcement of visibility (visibility is a scoping *filter*, not an auth boundary).
- Migrating the Brain-layer backlink index into the search `links` table. The two graph surfaces stay separate and both read the one vocabulary module.

## Chosen approach

Variant 2 (unified edge-semantics over the existing `links` table), refined for OSB's two-surface reality.

A single module owns the open/extensible relation and visibility vocabularies and the one `classify` / validate function. Every edge producer (frontmatter relations in the indexer, MCP-config extractor) and every consumer (search traversal, result surfacing, dream, backlink index) reads relation/visibility names from this one module - no relation string is hardcoded across call sites, and validation happens at one boundary.

The search `links` table gains a nullable `relation` column (migration to schema v3). Typed frontmatter relationships and MCP-config edges are written there; MCP server/package/env entities reuse the synthetic-target convention already established by `tag` edges (no first-class node table needed). The Brain-layer backlink index - which already records a `field` per reference and already tracks `supersedes` / `superseded_by` / `evidenced_by` - is generalized to map known relation fields to a relation type, so preference-domain typed relations surface through the existing on-demand index without being forced into the derived search cache.

Visibility is a document-scoped axis, not an edge property. It is honored through the existing `SearchOptions.properties` post-rank filter as a reserved `visibility` key plus a default scoping rule, and respected by the MCP read tools.

## Design decisions

- **One vocabulary module, two graph surfaces.** The single-validation-boundary win of variant 2 is preserved by a shared vocabulary module, *not* by collapsing the two existing graph representations into one table. Collapsing them was variant 3's main risk.
- **`relation` is orthogonal to `link_type`.** `link_type` stays the syntax dimension (wikilink/markdown_link/tag) with its existing CHECK; `relation` is a new nullable dimension validated in the application layer against the vocabulary module (not a SQL CHECK, so the vocabulary stays open/extensible without a migration per new relation).
- **Vocabulary is data-driven.** A default relation/visibility set lives in the module; adding a relation type is a one-line change there, never a schema migration (the `relation` column carries no SQL CHECK). The frontmatter ingest path only emits relations whose field name is in the vocabulary, so an unrecognised key is simply not treated as a relation. No closed enum baked into many call sites.
- **MCP entities as synthetic targets.** Reuse the `tag` precedent (`targetPath = null`, identity in `link_text`, or a `mcp:server/<name>` synthetic path) rather than a new node table - smallest migration, reindex-safe.
- **Env values discarded at parse time.** The MCP-config extractor records env-var *names* (requirement edges) only; values never enter the graph, matching the no-secrets-in-vault rule and the redaction posture.
- **No new dream behaviour.** Preference-domain supersession is already written deterministically (`merge.ts`, `dream.ts:531`) and tracked by the backlink index. This release does not touch the dream algorithm; extending deterministic auto-population to `contradicts:` would require judgement that does not belong in the LLM-free dream, so it is explicitly out of scope.
- **Visibility default is permissive.** Absent `visibility:` = visible everywhere (current behaviour preserved). A scoping rule excludes non-default visibility unless the caller opts in, layered onto the existing property filter - zero behaviour change for vaults that never set the field.
- **No hardcoded natural-language strings.** Relation/visibility identifiers are English tokens (data, not prose); any human-facing rendering is templated from the token, never a per-language literal.

## File changes

New:
- `src/core/graph/relation-vocab.ts` - the single relation/visibility vocabulary + validation boundary.
- `src/core/graph/mcp-config.ts` - MCP-config file parser → typed edges (env values discarded).
- tests under `tests/core/graph/` and `tests/mcp/` for each unit.

Modified:
- `src/core/search/schema.ts` - migration v3: nullable `relation` column on `links`; `LATEST_SCHEMA_VERSION = 3`.
- `src/core/search/links.ts` / `src/core/search/store.ts` - carry `relation` through `ExtractedLink` and `replaceLinks`; relation-aware traversal.
- `src/core/search/indexer.ts` - emit typed edges from frontmatter relation fields and from discovered MCP-config files.
- `src/core/search/types.ts` - `BrainSearchResult.relations?` (computed, never stored); reserved `visibility` handling in `SearchOptions.properties`.
- `src/core/brain/backlinks.ts` - record a `relation` per `BacklinkRef` derived from the known relation fields.
- `src/mcp/brain-tools.ts` / `src/mcp/tools.ts` - surface relations + visibility scoping; expose the MCP-config landscape (read-only).
- `src/cli/brain/verbs/query-render.ts` and related CLI verbs - render typed relations / visibility in human output.
- `README.md`, `CHANGELOG.md`, `docs/` - user-facing docs.

## Risks and open questions

- **Reindex coherence.** Adding the `relation` column must round-trip cleanly: a vault reindex from scratch must reproduce identical typed edges. Mitigated by treating the index as derived and testing reindex idempotency.
- **Vocabulary creep.** Keeping the vocabulary open risks divergent ad-hoc relations. Mitigated by a `brain_doctor` check that lists unknown relations rather than failing.
- **Visibility semantics.** The exact default scoping rule (what "private"/non-default visibility excludes, and how a caller opts in) needs to be pinned in the plan so it is one rule, not per-tool. Resolved in plan Task 3.
- **MCP-config discovery scope.** Which paths under the vault are scanned (avoid scanning the whole filesystem). Resolved in plan Task 4 - vault-relative discovery only.
