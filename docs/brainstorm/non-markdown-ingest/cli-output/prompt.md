You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release that lets Open Second Brain ingest its first non-Markdown sources honestly, plus small fold-ins.

1. Source artifact ingest, first slice. Ingest is text-only today: `DEFAULT_INGESTIBLE_EXTENSIONS` (src/core/brain/ingest/batch-plan.ts:78-85) is `.md .markdown .txt .text .rst .org`; HTML, PDF, Office files and images are only counted per extension as `unclassifiable`. The closed skip-reason vocabulary `SKIPPED_PAGE_REASON` (extractable-gate.ts:34-45) has one member, `schema-type-not-extractable`. The ingest pipeline never reads the source for the agent: the calling agent writes the summary page under `Brain/sources`; the only in-kernel read is the opt-in code-structure pre-extract pass (bounded read, 1 MiB). The search walker indexes `.md` only, so a part of an HTML file is searchable only if it is rendered onto the Markdown summary page. Wanted: HTML becomes text with heading-derived structural parts (no source body copied into the page), PDF, Office and images are named as unsupported instead of dropped silently, OCR stays caller-side, no new runtime dependency (Bun 1.4.0 has the `HTMLRewriter` global; it does not decode entities, misses document-level text in element handlers and throws on `onEndTag` for void elements; part of src/ is bundled for Node).

2. CSV and TSV as plain-text table notes. Nothing in src parses tables. A table ingested without its rows is the gap. The summary page is the only indexed place where rows could live; the chunker splits oversize tables line by line so a GFM table loses its header in later chunks; `[[x]]` and `#tag` in table cells would become graph facts unless inside a code fence. The redactor has a key-name predicate and a raw-output redaction pass.

3. Fold-ins: (a) `readSourceBounded` allocates the full cap for every source; (b) the recall verdict's root coverage counts a root as reached when it holds only pages the caller cannot read; (c) the daily and weekly brief views name preference ids from log events at remote reach; (d) the architect module-dependencies region says "no edges" when every declared edge touches a module a wikilink cannot carry; (e) the Hermes plugin sends `turn_id` to `brain_recall_gate`, whose closed input schema refuses it; (f) a dead newline branch in the surfacing gate's shell-only test.

# Project context

Open Second Brain, TypeScript on Bun 1.4.0 (also a Node-bundled OpenClaw build from part of src/), MCP server plus `o2b` CLI over an Obsidian-compatible Markdown vault.
Recent commits:
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0)
Related files:
src/core/brain/ingest/batch-plan.ts, src/core/brain/ingest/extractable-gate.ts, src/core/brain/ingest/ingest.ts, src/core/brain/ingest/pre-extract.ts, src/core/brain/intake/source-trust.ts, src/core/brain/provenance/capture-scope.ts, src/core/brain/research/extract.ts, src/core/search/chunker.ts, src/core/redactor.ts, src/mcp/brain/ingest-tools.ts, src/cli/brain/verbs/pre-extract.ts, src/core/search/indexer.ts, src/mcp/brain/brief-tools.ts, src/core/brain/architect/generate.ts, src/core/search/surfacing-gate.ts, src/mcp/search-tools.ts
Conventions:
- Closed reason vocabularies use a four-piece idiom (frozen object, derived union, member list, unknown guard) and are registered in a census test.
- Errors surface by name; no silent fallbacks; "could not do it" is data with a reason.
- Deterministic output, codepoint sort order, no natural-language word lists.
- At remote reach a page withheld by visibility is treated as absent; every new reader gets an A/B test.
- MCP tool descriptions are capped at 300 characters; `brain_ingest_source` is at 299.
Constraints:
- No new runtime dependency. Text sources and existing pages stay byte-identical.
- No new MCP tool unless unavoidable. External extractor commands and OCR are out of scope.

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
