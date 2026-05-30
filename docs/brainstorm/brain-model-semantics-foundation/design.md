# Brain Model Semantics Foundation - typed preference semantics without a second graph

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain can already store preferences, retire superseded rules, detect contradictions in `dream`, and index typed relationships on arbitrary vault pages. The Brain preference model itself still lacks a small, explicit foundation for user-authored preference relationships, memory-layer labels, and future branch-aware operations. The selected upstream tasks are useful, but their full forms are architectural: typed memory edges, selective memory branch picks, and L0-L3 lifecycle policy should not be built as a destructive rewrite in one release.

## Scope

- Extend the existing relation vocabulary with preference-oriented relation types that can be authored in preference frontmatter and consumed by the current Brain backlink index.
- Project typed Brain preference edges through the explorer data model while keeping existing `supersedes` and wikilink behavior compatible.
- Add optional `memory_layer` (`L0`, `L1`, `L2`, `L3`) and `memory_branch` metadata to parsed/written preference files as inert labels, with absent fields preserving legacy byte output.
- Add a deterministic dry-run supersession backfill planner that proposes high-confidence typed-edge repairs from existing `supersedes` / `superseded_by` evidence without writing by default.
- Document the ADR decision for what is intentionally deferred from full branch and L0-L3 architecture.

## Out of scope

- Full copy-on-write Brain branches, branch storage roots, or isolated branch query semantics.
- A `pick` command that mutates one memory branch from another.
- Per-layer retention, confidence, dream, search-ranking, or lifecycle policy.
- A new REST service, SDK layer, background daemon, or non-MCP API surface.
- A parallel graph database or derived index separate from the existing relation vocabulary, backlink index, and explorer projection.
- Any LLM call inside `dream` or a deterministic core path.

## Chosen approach

Use the consultant's Variant 1: frontmatter-native vocabulary extension. Preference semantics stay in the Markdown source of truth, use the existing `relation-vocab.ts` validation boundary, and flow through the existing Brain backlink and explorer surfaces. Branch and layer support land only as validated labels that future ADR-backed work can consume.

## Design decisions

- **Reuse `relation-vocab.ts`.** New preference relation tokens are added to the same data-driven vocabulary used by vault-page typed graph semantics, so producers and consumers do not hardcode competing relation sets.
- **Keep relations as top-level frontmatter fields.** A preference can use fields such as `depends_on:` or `refines:` with wikilink targets, matching the existing `related:` / `extends:` / `contradicts:` / `superseded_by:` convention instead of adding a nested object shape that the simple frontmatter writer does not need.
- **Preserve default byte identity.** `writePreference` emits `memory_layer`, `memory_branch`, and typed relation fields only when callers supply them. Existing dream refreshes and legacy fixtures stay unchanged.
- **Model layers and branches as labels only.** `memory_layer` and `memory_branch` let future tooling identify intended semantics without silently changing retention, confidence, or query behavior in this release.
- **Backfill is a plan before a mutation.** The first deterministic backfill surface returns proposals and a stable JSON shape; applying those proposals can be added later once the operator-facing review workflow is clear.
- **Explorer exposes relation detail without breaking consumers.** Existing edge `kind` remains compatible (`supersedes` / `wikilink`), while a new optional `relation` field carries typed semantics for clients that know how to use it.
- **Branch pick remains ADR-only.** The selected task's branch idea is acknowledged through `memory_branch`, but real selective pick requires decisions about snapshots, conflicts, audit, and rollback that are larger than this foundation PR.

## File changes

New:

- `docs/brainstorm/brain-model-semantics-foundation/adr.md` - ADR for typed edges, layer labels, branch labels, and deferred full branch/layer behavior.
- `src/core/brain/semantics-backfill.ts` - pure deterministic planner for typed supersession-edge backfill proposals.
- `tests/core/brain/semantics-backfill.test.ts` - dry-run planner tests.

Modified:

- `src/core/graph/relation-vocab.ts` - add preference-oriented relation vocabulary tokens.
- `src/core/brain/types.ts` - add optional `memory_layer`, `memory_branch`, and typed relation metadata types.
- `src/core/brain/preference.ts` - parse and write optional preference semantics fields, preserving absent-field byte identity.
- `src/core/brain/backlinks.ts` - rely on the expanded vocabulary and cover the new relation tokens in tests.
- `src/core/brain/explorer.ts` - include optional edge `relation` and node memory metadata.
- `templates/brain-explorer.html` - render relation labels and memory metadata when present.
- `tests/core/brain/backlinks-relation.test.ts` - cover new relation vocabulary tokens.
- `tests/core/brain/explorer.test.ts` - cover relation projection and memory metadata.
- `README.md`, `CHANGELOG.md`, and CLI reference docs if a user-facing command or JSON surface is added.

## Risks and open questions

- **Relation vocabulary creep.** Adding `depends_on` and `refines` is useful, but every future token should still pass through the shared vocabulary boundary rather than appear ad hoc in callers.
- **Frontmatter parser limits.** The existing lightweight YAML parser can mangle wikilink arrays; tests must cover scalar and array forms for new relation fields.
- **Branch label expectations.** A `memory_branch` field could look like real branch isolation. Documentation must state clearly that it is metadata only until a later ADR-backed branch implementation ships.
- **Layer label expectations.** `memory_layer` is not a lifecycle policy in this release. It must not alter `dream`, active digest generation, retention, or search ranking yet.
- **Backfill apply semantics.** The first planner can be dry-run only. If implementation adds `--apply`, it must have snapshot/audit coverage before writing.
