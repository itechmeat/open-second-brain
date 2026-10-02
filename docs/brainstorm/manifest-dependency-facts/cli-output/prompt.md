You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release that adds deterministic dependency facts to Open Second Brain, in three parts.

1. Package-manifest dependency facts in the architecture scanner (`o2b brain architect`). Today `readManifest` (src/core/brain/architect/scan.ts:297-318) reads only the root `package.json`, only its `dependencies` key, and swallows a malformed file (`catch { return null; }`). pyproject.toml, go.mod and Cargo.toml are read nowhere; pom.xml, build.gradle, Gemfile and composer.json are in a private project-detection list in src/core/partner/codegraph.ts:26-36 that is bundled into a Node build. The relation vocabulary already has `depends_on` (src/core/graph/relation-vocab.ts), and typed graph edges enter the search index only through frontmatter fields named after a relation (src/core/search/indexer.ts:613-627). Architect notes write their frontmatter once at creation and never again (generate.ts:33-35); every changing fact lives in a sentinel region merged by `mergeRegions`; an unchanged project regenerates byte-identically. The overview's `module-map` region claims "Containment only: the scan records no import edges". Bun 1.4.0 ships `Bun.TOML.parse` (throws SyntaxError). Wanted: read the four dependency-bearing ecosystems, surface malformed and unsupported manifests instead of hiding them, render dependencies per ecosystem, and emit inter-module `depends_on` facts when a module's manifest declares a dependency on another module of the same project.

2. A Terraform (HCL) family in the deterministic line-grammar pre-extractor (src/core/brain/ingest/pre-extract.ts; today TS/JS/Python only, `.tf` reports `extracted: false`). Seeds are never persisted; they reach `o2b brain pre-extract` and `brain_ingest_source {pre_extract: true}`. Names only, never attribute values. A module `source` string can carry URL credentials; the existing TS import specifiers already pass such credentials through unredacted, and the redactor has a URL-credential pass.

3. A small fold-in of reach left-overs from the previous release: the compiled active-preferences digest (Brain/active.md) is read verbatim by three remote readers (brain_context, the osb://preferences/active resource, brain_pre_compress_pack) and can carry a private preference's principle; brain_health findings and brain_doctor repair are bounded by the owner scope but not by the caller's reach.

# Project context

Open Second Brain, TypeScript on Bun 1.4.0 (also a Node-bundled OpenClaw build from part of src/), MCP server plus `o2b` CLI over an Obsidian-compatible Markdown vault.
Recent commits:
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0)
Related files:
src/core/brain/architect/scan.ts, src/core/brain/architect/generate.ts, src/cli/brain/verbs/architect.ts, src/core/partner/codegraph.ts, src/core/graph/relation-vocab.ts, src/core/graph/frontmatter-relations.ts, src/core/search/indexer.ts, src/core/brain/ingest/pre-extract.ts, src/core/redactor.ts, src/core/brain/active.ts, src/mcp/brain/context-tools.ts, src/mcp/resources.ts, src/core/brain/pre-compress-pack.ts, src/mcp/brain/health-tools.ts, src/core/brain/diagnostics.ts, src/core/search/visibility-surface-registry.ts
Conventions:
- Closed reason vocabularies use a four-piece idiom (frozen object, derived union, member list, unknown guard) and are registered in a census test.
- Errors surface by name; no silent fallbacks; refusals are data with a reason.
- Deterministic output, codepoint sort order, no natural-language word lists.
- At remote reach a page withheld by visibility is treated as absent; every listing tool gets an A/B test.
Constraints:
- No new runtime dependency. Do not change module detection (MODULE_BASES) or existing note paths.
- Keep the module-map containment claim true. Keep byte identity for unchanged projects and for vaults with nothing withheld.
- No partner-tool graph: Open Second Brain stores no code graph.

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
