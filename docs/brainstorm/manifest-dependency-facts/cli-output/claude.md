### Variant 1: Inline extension of the existing files
- **Approach**: Grow `readManifest` in scan.ts into a per-ecosystem switch (package.json, pyproject.toml via `Bun.TOML.parse`, go.mod and Cargo.toml by line grammar) that returns a status instead of `null`, and add a `dependencies` region to each module note and the overview. Inter-module `depends_on` edges are written into module-note frontmatter under a narrow exception to the write-once rule. Terraform becomes one more branch inside pre-extract.ts, and each of the three remote readers filters Brain/active.md lines itself; health and doctor gain a `reachView` AND beside the owner view.
- **Trade-offs**:
  - Pro: smallest diff, no new modules, every change lands next to the code it replaces.
  - Pro: the codegraph.ts detection list can stay untouched; the scanner only needs its own four readers.
  - Con: scan.ts absorbs four parsers plus status handling and stops being a tree walker; the Bun-only TOML call sits in a file other builds might one day bundle.
  - Con: line-filtering a compiled digest is lossy and fragile; three readers re-implement the same filter and the A/B tests must cover each.
  - Con: a frontmatter rewrite exception weakens an invariant generate.ts documents at length; byte identity depends on the key merge being perfectly stable.
  - Con: Terraform module `source` redaction becomes a one-off in the new branch, leaving TypeScript specifiers on the older redaction unless changed separately.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Manifest registry, fact-bearing module edges, reach-rendered digest
- **Approach**: Add `src/core/brain/architect/manifests/` with one reader per ecosystem returning a `ManifestReport` (ecosystem, closed status vocabulary `ok | malformed | unsupported` in the four-piece idiom, dependency names grouped by kind), and move the ecosystem filename table into a Node-safe shared module that both the scanner and codegraph.ts import, parsers staying Bun-side. The scanner resolves declared names against sibling module manifests into `ModuleFact.dependsOn`; module notes render a per-ecosystem `dependencies` region, and only the `depends_on` frontmatter key is merged by a dedicated key-level merge, so unchanged edges leave bytes untouched and the index picks the edges up through the existing frontmatter path. Pre-extract gains a family registry entry for Terraform with a shared specifier step that runs the redactor's URL-credential pass for every family; the active digest becomes a pure `renderActiveDigest(prefs)` that remote readers call over a reach-filtered preference set while Brain/active.md stays the owner's full compile; health and doctor AND `reachView` into findings and repair.
- **Trade-offs**:
  - Pro: every requirement maps to one home: readers, statuses, edges, families, digest; each is unit-testable and census-registered.
  - Pro: the shared filename table removes the private duplicate in codegraph.ts without touching MODULE_BASES or module detection.
  - Pro: the TS credential pass-through is fixed by the same shared step that protects Terraform; one test covers both.
  - Pro: byte identity holds by construction: the renderer is one function, so a vault with nothing withheld renders the same bytes at every reach, and an unchanged project yields unchanged regions and an unchanged `depends_on` key.
  - Con: the key-level frontmatter merge is a deliberate, narrow relaxation of "frontmatter once" and must be documented as the only moving key.
  - Con: more files and a larger PR than Variant 1; the registry must stay out of the Node bundle since it reaches `Bun.TOML`.
  - Con: a first run after upgrade rewrites existing notes once to add the new region and key.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Body-sourced typed relations as a new index contract
- **Approach**: Keep frontmatter strictly write-once by teaching the indexer a second relation source: a sentinel-delimited `relations` region whose inline fields (`depends_on:: [[module]]`, Obsidian-compatible) become typed edges, with a registered guard that only known relation names bind. The architect writes module edges into that region through `mergeRegions` like every other fact, and the manifest registry, Terraform family and reach-rendered digest are done as in Variant 2.
- **Trade-offs**:
  - Pro: no exception to the frontmatter invariant at all; edges travel through the same region merge as every other changing fact.
  - Pro: a general mechanism any future generator can reuse for typed edges from generated bodies.
  - Con: a new indexer semantic touches search, graph, and visibility behaviour vault-wide; every note with a stray `relations` sentinel now emits edges, which needs its own visibility A/B coverage.
  - Con: two sources of truth for typed edges (frontmatter and body) raise precedence and dedup questions the release must settle.
  - Con: largest test surface and the longest path to a byte-identical, reviewable PR.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It satisfies all three parts with one home per concern, fixes the existing TS credential pass-through through the same shared step that Terraform needs, and keeps byte identity by making the digest a pure renderer and limiting frontmatter movement to a single key. Variant 1 scatters duplicated filtering and parsing into files that already document the invariants it bends, and Variant 3 buys purity with a vault-wide indexer change that the release does not need and that enlarges the visibility surface for every note.
