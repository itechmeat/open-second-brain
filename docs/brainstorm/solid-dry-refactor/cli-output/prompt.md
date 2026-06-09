You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## Goal
One release-scoped refactor pass over the Open Second Brain TypeScript codebase: decompose god modules, remove DRY violations, unify duplicated helpers, and clean superseded files. No behavior changes; the public CLI/MCP surface stays identical.

## Scope (six refactor units, one PR)
1. Split src/mcp/brain-tools.ts (5614 lines, 52 tool handlers) into per-domain tool modules behind a thin aggregator. Sibling files (search-tools.ts, schema-tools.ts, watchdog-tools.ts, skill-tools.ts) already follow a per-domain split; tests and src/mcp/tools.ts import only the BRAIN_TOOLS array and one helper.
2. Introduce a shared CLI brain-command context wrapper: ~89 files in src/cli/brain/verbs/ repeat parse flags + defaultConfigPath() + resolveBrainVault() + try/catch with ad-hoc fail() formatting (~600 duplicated lines).
3. Unify the two atomic file-write implementations: src/core/fs-atomic.ts (atomicWriteFileSync, atomicCreateFileSyncExclusive) vs src/core/reliability/atomic.ts (atomicWriteText with validate hook and configurable mode). Identical temp-file naming, fsync, rename logic.
4. Centralize wikilink regex parsing: seven divergent WIKILINK regex definitions (vault.ts, lint-consolidate.ts, link-graph/parse-wikilink.ts, link-graph/format-wikilink.ts, search/links.ts, search/entities.ts, search/query-plan.ts); two exact duplicates, the rest drift in edge-case handling.
5. Extract the 230-line hand-rolled YAML subset parser from src/core/brain/policy.ts (1871 lines) into its own module; extract evidence-refresh (~340 lines) and reconcile-outcomes sub-modules from src/core/brain/dream.ts (2239 lines) with explicit input/output interfaces.
6. Cleanup: delete superseded scripts/sync-version.py (replaced by sync-version.ts); add an automated layering guard so src/core never calls process.exit/process.stdout/console directly.

# Project context

Open Second Brain - TypeScript on Bun runtime, ~500 source files, ~95k LOC. Markdown/Obsidian vault second brain for AI agents (Hermes, Claude Code, Codex, OpenClaw). Strict tsconfig (strict, noUncheckedIndexedAccess), oxlint + oxfmt, 541 tests via bun test.

Recent commits:
6651228 refactor: language-agnostic fact extraction + README slim (v1.1.0) (#85)
9886d9a refactor: make search and classification language-agnostic (#84)
618870e refactor!: remove the pay.sh integration and the Pay Memory layer (#83)
72bac52 fix(hermes): advertise static tool schemas so the provider registers with its full tool set (#81)
ff43abd fix(ci): treat an existing release as success in the release workflow (#80)
957a403 feat!: Stability & Trust - 1.0.0 API freeze, deprecation sweep, safeguard, staged dream, timezone, report deltas (#79)

Related files:
src/mcp/brain-tools.ts, src/mcp/tools.ts, src/cli/brain/verbs/*.ts (89 files), src/cli/brain/helpers.ts, src/core/fs-atomic.ts, src/core/reliability/atomic.ts, src/core/vault.ts, src/core/brain/policy.ts, src/core/brain/dream.ts, src/core/brain/link-graph/*.ts, src/core/search/links.ts, scripts/sync-version.py

Conventions:
- v1.0.0 froze the public API: MCP tool names, CLI verbs, and file formats must not change.
- Established per-domain split pattern in src/mcp/ (search-tools.ts, schema-tools.ts, watchdog-tools.ts, skill-tools.ts).
- Core layer never calls process.exit or writes to stdout; CLI owns exit codes and formatting.
- Conventional commits; one PR = one CHANGELOG version.
- Some duplication is documented as intentional (e.g. log-jsonl.ts ISO regex comment says writer/reader must not share a constant).

Constraints:
- Pure refactor: zero behavior change, existing 541 tests must stay green after every atomic unit.
- No new external dependencies.
- Do not change public exports that tests, plugins/hermes, hooks/, or openclaw bundle import.
- No language-specific regexes or hardcoded natural-language phrases.
- Each unit lands as a separate conventional commit on one feature branch; units must be independently revertable.

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
