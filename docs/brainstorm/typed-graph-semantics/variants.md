# Typed graph semantics - brainstorm audit trail

Primary consultant: Claude Code (`claude -p`), exit 0, three parseable variants returned. Fallback (Codex) not invoked - primary succeeded. Raw output in `cli-output/claude.md`; prompt in `cli-output/prompt.md`.

## Variants (verbatim from the consultant)

### Variant 1: Layered extension of existing surfaces
- **Approach**: Each of the four units extends its nearest existing surface independently. Add a `relation` column to the `links` table (migration → schema v3); generalize the backlink index's existing per-field tracking (which already handles `supersedes`/`superseded_by`/`evidenced_by`) to cover `related`/`extends`/`contradicts`/`superseded_by` for arbitrary pages; treat `visibility:` as a reserved key inside the existing post-rank `properties` filter with a scoping rule; and add a standalone MCP-config extractor that emits server/package/env edges into the `links` table with a node-kind tag.
- **Trade-offs**: Pro: smallest blast radius, KISS, reindex-safe; additive (low contract risk); independently testable. Con: relation/visibility vocabulary validated in several places (violates single-boundary constraint); no unified "all semantic edges" query path.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Unified edge-semantics layer over the links table
- **Approach**: One `relation` column (plus visibility convention) on the existing `links` table, with every edge source routed through one data-driven relation/visibility vocabulary module that classifies and validates at a single ingestion boundary. Non-file entities (MCP servers/packages/env) reuse the synthetic-target pattern that `tag` edges already use. Search/query/dream read relation + visibility from this one column set.
- **Trade-offs**: Pro: open/extensible vocabulary validated at exactly one boundary; maximally DRY; one read-path for surfacing + dream auto-population. Con: overloads `links` with heterogeneous edges (queries must filter by relation/kind); synthetic MCP "nodes" have no first-class attributes.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Dedicated typed graph subsystem (nodes + semantic edges tables)
- **Approach**: New `graph_nodes` + `graph_edges` tables carrying `relation` and `visibility`, alongside `links` (which becomes a feeder). Central vocabulary registry validates at ingestion. All edge sources normalize into one node/edge model.
- **Trade-offs**: Pro: cleanest model, first-class non-file nodes, most future-proof. Con: violates "extend existing surfaces, don't add parallel subsystems"; two graph representations to keep coherent; largest migration + highest reindex risk; most code for richness the four units don't yet need.
- **Complexity**: large
- **Risk**: high

### Consultant recommendation: Variant 2
Rationale (verbatim): the only variant that fully honors the binding constraints - open, data-driven vocabulary validated at a *single* boundary (V1 scatters it) while extending the existing `links` table rather than a parallel subsystem (V3's violation/risk). The synthetic-target convention from `tag` edges gives MCP entities a home without new tables, keeping the schema change to one appended migration and giving search/query/dream a single relation read-path.

## Final decision: Variant 2, refined

Agree with the consultant's choice of Variant 2 over 1 and 3, with two project-grounded refinements that the consultant could not know from outside:

1. **Two graph surfaces stay separate; one vocabulary module unifies them.** OSB already has two graph representations by design - the search `links` table (a derived, reindexable SQLite cache) and the Brain-layer backlink index (`src/core/brain/backlinks.ts`, recomputed on demand over preferences/retired/signals/log, no cache). Variant 2's "one table" would force preference-domain relations into the derived cache, which is exactly the representation-merging risk that made Variant 3 dangerous. The single-validation-boundary value of Variant 2 is preserved instead by a shared `relation-vocab` module consumed by both surfaces - DRY at the vocabulary, not at the storage.

2. **Visibility is a document axis, not an edge column.** The consultant suggested a `visibility` column on `links`. Visibility scopes a *page*, not a *relationship*, so it belongs in the existing `SearchOptions.properties` post-rank frontmatter filter as a reserved key plus one default scoping rule, honored identically by CLI and MCP - not on the edge row.

These refinements keep the spirit of Variant 2 (extend existing surfaces, one open vocabulary, one validation boundary, synthetic targets for MCP entities) while fitting OSB's actual architecture. Variant 1 was rejected for scattering validation; Variant 3 for standing up a parallel subsystem against the project's explicit "extend, don't fork" convention and its reindex-risk.
