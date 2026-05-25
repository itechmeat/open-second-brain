### Variant 1: Single `link-graph` subsystem (strict precedent match)
- **Approach**: Mint one new subsystem `src/core/brain/link-graph/` that hosts every pure helper for features 1-5 (alias resolver, anchor extractor, unlinked-mention scanner, concept-cluster assembler, MOC classifier). Atoms extend `BacklinkRef` (anchor + alias-source fields) in place under `backlinks.ts` and add `aliases` to the in-memory note record from `vault.ts`; consumers are new CLI verbs / MCP tools that import from `link-graph/`. Feature 6 lands as `src/core/search/property-filter.ts` inside the existing search layer, and feature 7 lands as a small extension to whichever loader already injects `active.md` into session context.
- **Trade-offs**:
  - Pro: Mirrors v0.10.15 / v0.10.16 exactly - one themed subdir, atoms/helpers/consumers DAG, predictable for reviewers.
  - Pro: Helpers are co-located, so `synthesise` and `moc-audit` can re-use the alias / anchor / unlinked-mention helpers without cross-subsystem imports.
  - Pro: Search and session-context changes stay in their natural layers instead of being dragged into a `brain/` subdir where they don't belong.
  - Con: `link-graph/` becomes a relatively large bag (5 helpers) compared to the tighter v0.10.16 trust/ tree.
  - Con: Two of seven features (property search, VAULT.md) sit outside the named release subsystem, so the release headline isn't quite "everything under one roof."
- **Complexity**: medium
- **Risk**: low

### Variant 2: Three small co-equal subsystems (one per concern)
- **Approach**: Carve the release into three named subsystems - `src/core/brain/graph/` for link / backlink helpers (1-5), `src/core/brain/property-filter/` for the FTS-post property-filter phase (6), and `src/core/brain/vault-context/` for the VAULT.md loader (7). Each follows its own atoms/helpers/consumers DAG; the CHANGELOG groups them under one v0.10.17 header but the code tree is unambiguous about which file belongs to which feature cluster.
- **Trade-offs**:
  - Pro: Clean one-feature-cluster-per-subdir mapping; each subdir is small and individually testable.
  - Pro: Property filter and VAULT.md are first-class members of the release, not "miscellaneous additions."
  - Pro: Future bundles can grow any of the three without touching the others.
  - Con: Breaks the "one new subsystem per release" precedent set by v0.10.15 and v0.10.16; three new subdirs in one PR is a noticeable convention drift.
  - Con: `property-filter/` under `brain/` is awkward because the actual code is search-layer (FTS + chunks), not brain-layer; pulling it under `brain/` muddies the layering.
  - Con: VAULT.md is a tiny addition that doesn't deserve its own subsystem; padding it out to atoms/helpers/consumers is ceremony for ~1 file of logic.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: In-place enrichment, single small subsystem only for read-views
- **Approach**: Extend existing files directly for the structural plumbing: `wikilink.ts` keeps anchors instead of stripping them, `backlinks.ts` learns to resolve aliases when collecting refs, `search.ts` grows a property-filter post-phase, and the existing session-context loader learns about VAULT.md. Mint one small subsystem `src/core/brain/graph-views/` that only contains the higher-level read-only assemblers (unlinked-mentions scanner, concept-synthesis envelope builder, MOC audit classifier) - the things that genuinely need shared helpers and dedicated tests.
- **Trade-offs**:
  - Pro: Smallest blast radius - file count is well under 70, structural changes live next to the code they enrich, no orphan one-file subsystems.
  - Pro: The new subdir holds only the genuinely novel logic (the three "views"), so its scope is crisp and its test directory is well-bounded.
  - Pro: Property filter living inside `src/core/search/` matches the actual layer ownership, no awkward cross-tree imports.
  - Con: Diverges from the recent two-release precedent where ALL new helpers landed inside the new subdir; reviewers used to that pattern may need orientation.
  - Con: Atom-level extensions are scattered across `wikilink.ts`, `backlinks.ts`, and `search.ts` rather than visible in one diff stack, so the "what's the v0.10.17 shape change?" question takes more reading.
  - Con: `graph-views/` doesn't capture the alias/anchor work in its name, so the release theme is split between "view helpers" and "graph plumbing upgrades."
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 1
**Rationale**: It is the only variant that holds the line on the project's established two-release precedent (one named subsystem with the atoms / helpers / consumers DAG), which keeps reviewer mental model, test-directory layout, and CHANGELOG framing identical to v0.10.15 / v0.10.16. The two features that genuinely don't belong under `brain/link-graph/` (property search is search-layer, VAULT.md is session-context-layer) land in their natural layers without inventing ceremonial subsystems for them, avoiding Variant 2's drift while still keeping the headline "link-graph subsystem" intact - and unlike Variant 3, the foundational alias/anchor atoms remain visible as part of the new subsystem's shape rather than scattered across pre-existing files.
