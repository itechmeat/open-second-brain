You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Brain Portability & Interop" suite for Open Second Brain: a bundle of four small, related, additive units that make brain content portable in and out of a vault, with full provenance, and programmatically writable. The four units share one release and should reuse the existing portability infrastructure rather than introduce a new subsystem.

## Unit A - Whole-vault (bank) export/import for cross-instance migration (kanban t_7eff6f39)
Open Second Brain today has only piecemeal export: `exportPreferencesJson` / `exportPreferencesLlmsTxt` (preferences only) and `exportVaultGraph` / `importVaultGraph` (page link-graph stubs only). There is no single operation to export a whole brain ("bank") for migration to another instance, nor to import it back. Operators who want to migrate their brain, share a knowledge bank, or back up/restore portions have no tooling. Provide a deterministic, schema-versioned whole-vault export bundle (preferences + page graph + sources/provenance metadata) and a matching importer with conflict modes, reusing the existing exporters. "Bank" maps to OSB's vault.

## Unit B - JSON export-bridge contract for downstream importers (kanban t_3b07fdfb, child of Unit A)
Define a standardized, documented per-page JSON export contract that downstream memory importers can ingest: per page emit `path`, `kind`, advisory `confidence`/`provenance`, flattened `citations`, `aliases`, and `freshness`. This is the stable interchange schema the Unit A bundle carries for vault pages, decoupled from OSB internals so an external tool can consume it.

## Unit C - In-process SDK with source-backed write APIs (kanban t_e1f07d74)
Brain operations today are CLI-driven or MCP-tool-driven. Expose an in-process SDK (e.g. `createBrain(vault)`) returning a small façade over existing core functions, including source-backed write APIs: `writeStatus`, `listSources`, `getSource`, `deleteSource`. This lets other tools/scripts/agents manage brain content programmatically with full source provenance, complementing the existing MCP tools and CLI without duplicating their logic.

## Unit D - brain_create_note MCP tool (kanban t_a957bc48)
The MCP server exposes `brain_note` (appends one line to `Brain/log/<today>.md`) but no tool that creates an actual vault note file. Add a `brain_create_note` MCP tool accepting `path`, `frontmatter`, and `content`; it writes a Markdown file atomically, respects vault-scope / ignore / private rules and path-traversal guards (`ensureInsideVault`), and returns the created note's vault-relative path and metadata. Complements `brain_note` (log append) and `brain_feedback` (signal write).

# Project context

Open Second Brain: TypeScript on the Bun runtime, SQLite (bun:sqlite, FTS5 + sqlite-vec), an MCP stdio server, an `o2b` CLI, and an Obsidian/Markdown vault. The kernel is provider-agnostic - Open Second Brain never calls an LLM itself; any synthesis is delegated to the connected agent. Every opt-in feature must be byte-identical to prior behaviour when its flag is off.

Recent commits:
- 7cdbfc0 feat: Indexer Durability & Resilience Suite (v1.8.0)
- 8b679fe feat: Knowledge Provenance Suite (v1.7.0)
- 6e59a42 feat: Vault Integrity & Trust Suite (v1.6.0)
- e4df212 feat: Search & Recall Quality Suite (v1.5.0)

Related existing files (reuse, do not duplicate):
- src/core/brain/export.ts - `ExportFormat = "json" | "llms-txt"`, `BRAIN_EXPORT_SCHEMA_VERSION = 1`, `collectExportRows`, `exportPreferencesJson`, `exportPreferencesLlmsTxt` (preferences only; deterministic; sorted by id).
- src/core/brain/portability/graph.ts - `exportVaultGraph` / `importVaultGraph` (page link-graph; `GRAPH_VERSION = "1"`; conflict modes skip|overwrite|merge; per-node runtime guard; `ensureInsideVault`; `{{role}}` token resolution via vault-map).
- src/core/brain/portability/codec.ts - `compress` / `expand`.
- src/core/brain/portability/sources.ts - `aggregateSources` (read-only per-source dashboard over inbox+processed signals).
- src/core/brain/portability/origins.ts - `SearchOrigin`, `listSearchOrigins` (origin kinds: active|profile|source).
- src/core/vault.ts - `listVaultPages`, `parseFrontmatter`, `writeFrontmatterAtomic`, `extractWikilinks`, `EXCLUDED_DIRS`.
- src/core/brain/paths.ts - `ensureInsideVault`, `brainDirs`, `BRAIN_ROOT_REL`.
- src/mcp/brain/feedback-tools.ts - tool definitions array (`brain_note`, `brain_feedback`, ...), each `{ name, description, inputSchema, handler }`; handlers receive a context carrying `ctx.vault`; helpers `vaultRelativeSafe`, `appendLogEvent`.
- src/cli/brain/verbs/ - one file per `o2b brain <verb>`; existing `export.ts`, `graph-export.ts`, `graph-import.ts`.

Conventions:
- Deterministic, sorted, timestamp-free serialisation so re-export is byte-identical (see exportVaultGraph).
- Untrusted JSON on import is validated per-entry with a runtime guard; a malformed entry is rejected and the run continues, never throws mid-import.
- Schema-versioned export envelopes (`schema` field) so importers can detect drift.
- All writes guarded by `ensureInsideVault`; atomic writes via `writeFrontmatterAtomic` / `.new`-then-rename.

Constraints:
- No new external dependencies, especially no heavy ones (no headless browser, no PDF engine).
- Provider-agnostic: the kernel must not call an LLM. Any LLM-derived field (e.g. a summary) is supplied by the connected agent, not synthesised in-core.
- Language-agnostic: no hardcoded natural-language word lists (stop-words, keywords, greetings) in any language. Use structural signals, explicit frontmatter fields, or corpus frequency.
- No misleading fallbacks: a feature that cannot do its job must fail loudly (typed error), not silently no-op or return fabricated data.
- No TypeScript `as` cast crutches: build values with the correct type from the start (conditional spreads, narrowing functions).
- Byte-identical-when-flags-off: anything opt-in must not change existing output/ordering/shape when disabled.
- Reuse the existing exporters/importers and portability helpers; do not fork a parallel serialisation path.
- The SDK must be a thin façade over existing core functions, not a reimplementation.

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
