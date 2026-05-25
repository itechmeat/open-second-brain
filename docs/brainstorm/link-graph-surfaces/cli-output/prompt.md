You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain v0.10.17 ships a bundle of seven related link-graph features. The thread tying them together: the vault is a connected graph, but Open Second Brain's link-graph layer (`src/core/brain/wikilink.ts`, `src/core/brain/backlinks.ts`) and search layer (`src/core/search/*`) currently throw away or never compute richer structure. Operators have to reconstruct that structure by hand.

The seven kanban tasks bundled:

1. **Frontmatter alias resolution for wikilink target index** - resolve Obsidian-style `aliases: [foo, bar]` frontmatter arrays when building the backlink index. Today, `[[foo]]` referring to an aliased note registers as a phantom node.

2. **Block-link and heading-link granularity preservation in backlink index** - keep `#heading` and `#^block-id` anchor suffixes on every `BacklinkRef` instead of stripping them at parse time. Today `stripBasenameDecoration` drops anchor info before backlinks land in the index.

3. **Unlinked-mentions surface for discovering missed connections** - for a target note, scan every other note for raw-text occurrences of the target's title (and any frontmatter alias) NOT inside `[[...]]` brackets. Return `(source, line, context)` tuples. Exposed as `o2b brain unlinked-mentions <id>` + `brain_unlinked_mentions` MCP. Depends on (1).

4. **Concept-scoped synthesis over a note and its full backlink cluster** - given a target note id, gather the note + all notes that wikilink to it (depth=1). Emit a JSON envelope with consistent-thread / tensions / emergent-insight slots. Pure read-only assembly (no LLM call in the helper; consumers can feed the envelope to an LLM later). Exposed as `o2b brain synthesise <id>` + `brain_concept_synthesis` MCP.

5. **Per-MOC topic-coverage gap analysis with fragile-vs-developed audit** - given a hub-note id whose outbound wikilinks form a cluster ("MOC"), classify each cluster member into well-covered / fragile / candidate-missing / suggested-next buckets. Heuristic MOC detection by link density. Exposed as `o2b brain moc-audit <id>` + `brain_moc_audit` MCP.

6. **Intelligent property-filtered search across vault files** - layer property filters (`type`, `status`, `tags`, frontmatter scalars) on top of the existing FTS5 + semantic search. Today `search()` only accepts a query string + path prefix. Extend `SearchOptions` with a property filter map and run the property filter as a post-FTS phase.

7. **Vault-root agent instruction file for session context** - read a configurable file at the vault root (e.g. `VAULT.md` - name TBD) at session start, alongside the existing active-preferences load. User-authored content; agents inject it into context. Distinct from `CLAUDE.md` / `AGENTS.md` which already exist as vault-root instruction files tracked by the v0.10.16 instruction-file-ceiling check - this one is OPEN-SECOND-BRAIN-specific and Brain-consumed.

The bundle's DAG: alias resolution (1) is the foundation; (2) is independent atom; (3) depends on (1); (4) depends on (3) + backlinks; (5) depends on backlinks + outbound links; (6) is independent extension to search; (7) is independent small addition.

# Project context

Project name: Open Second Brain (full name in public artifacts; OSB acronym only in private notes)
Language / runtime: TypeScript, Bun runtime
Most recent releases:
- v0.10.16 (just merged) - trust + operator surfaces: introduced `src/core/brain/trust/` subsystem (atoms / pure helpers / consumers DAG); language-agnostic preference quality gate; aggregate trust verdict; `brain_operator_summary` MCP + `o2b brain summary` CLI.
- v0.10.15 - vault care bundle: `src/core/brain/page-meta/` and `src/core/brain/maintenance/` subsystems following the same atoms / helpers / consumers DAG.
- v0.10.14 - index fastpath, redaction.
- v0.10.13 - codegraph-partner skill + doctor.

Recent commits (origin/main last 10):
3b7dfe9 v0.10.16: trust and operator surfaces - verification, verdict, dashboard (#32)
d045ea1 chore: bump version to 0.10.15 (#31)
5755200 v0.10.15: vault care bundle - metadata, dedup, lint, context-pack, actions (#30)
9d9636b feat: index fastpath, PEM/JWT redaction, vault connection health (v0.10.14) (#29)
7d81f0b feat: codegraph-partner skill + o2b doctor check (v0.10.13) (#28)

Related files:
- `src/core/brain/wikilink.ts` - parsers: `normaliseWikilinkTarget`, `parseWikilink`, `stripBasenameDecoration`, `parseArtifactRef`. Anchor info dropped at line 64 (`s.slice(0, hash).trim()`).
- `src/core/brain/backlinks.ts` - `BacklinkRef` interface (line 45); `buildBacklinkIndex` (line 68); collectors `collectPreferences`, `collectSignals`, `collectLog`.
- `src/core/vault.ts` - `parseFrontmatter`, `extractWikilinks`. Frontmatter parser handles inline arrays (`[a, b]`).
- `src/core/search/search.ts` - `search()` orchestrator (line 51).
- `src/core/search/types.ts` - `SearchOptions` (line 109), `BrainSearchResult` (line 35).
- `src/core/search/store.ts` - FTS5 store + chunk index.
- `src/cli/brain/verbs/*.ts` - existing CLI verb structure: one file per verb, each implements `runVerb(args)`. 30 verbs today.
- `src/mcp/brain-tools.ts` - MCP tool registry. Full scope vs writer scope split. After v0.10.16: 11 brain tools.
- `src/core/brain/trust/` - precedent for "named subsystem per release" pattern. Atoms = data-shape additions on existing types; helpers = pure functions; consumers = existing tools call helpers.
- `src/core/brain/page-meta/`, `src/core/brain/maintenance/` - same precedent, v0.10.15.

Conventions:
- Three-layer DAG per release: atoms (data-shape additions on existing summary types) → helpers (pure functions in a named subdir) → consumers (existing brain tools call helpers but keep public contract).
- Each release ships ONE new subsystem subdirectory under `src/core/brain/<theme>/`.
- All public surfaces (CLI verbs + MCP tools) are thin wrappers over pure helpers.
- Atomic file writes everywhere - vault state must survive concurrent agents and crashes.
- `vault-relative` paths in every public output (no leaked host absolute paths).
- TDD: failing test first, then implementation, then commit per atomic unit.
- One PR = one CHANGELOG version (may bundle several features under one version header).
- Language-agnostic everywhere: no hardcoded vocabulary lists, no per-language regex tables, no stopword sets. If language differences must be handled, use codepoint-shape detection (Unicode property classes `\p{L}`, `\p{N}`, `\p{Script=...}`) only.
- README is a flat capability description, not a migration story.
- No `[Unreleased]` placeholder in CHANGELOG.
- No AI authorship markers in public artifacts.
- Backward compatibility by construction: new fields default to legacy behaviour; defaults strictly looser than every existing gate so existing tests stay byte-identical.

Constraints:
- Do NOT change any existing public API signature - extend with optional fields only.
- Do NOT introduce new external dependencies. The project ships only `bun:sqlite`, `node:crypto`, `node:fs`, etc.
- Do NOT hardcode any language-specific vocabulary in detectors. Anchor parsing is structural (the `#` sigil exists in the Obsidian link grammar, not in any natural language).
- Do NOT add LLM calls inside core helpers. The concept-scoped synthesis helper assembles a deterministic JSON envelope; if a downstream tool wants LLM synthesis, it calls the LLM externally.
- Each new feature must have its own dedicated tests under `tests/core/brain/<subsystem>/` or `tests/mcp/` or `tests/cli/`.
- Each new MCP tool must be wired into the `full` scope only (not `writer`) unless it's a pure read with no quality-gate semantics.
- Variant should fit in roughly 50-70 changed files total (precedent: v0.10.16 was 57 files).

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
