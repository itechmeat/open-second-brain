# SOLID/DRY refactor - decompose god modules and unify duplicated helpers

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The codebase has grown to ~500 TypeScript files and ~95k lines through 20+ feature suites, and several hotspots now violate single-responsibility and DRY principles. `src/mcp/brain-tools.ts` is a 5614-line god module holding 52 tool handlers across 13+ domains while its siblings follow a per-domain split. Eighty-nine CLI verb files repeat the same context-resolution and error-handling boilerplate. Atomic file writes, wikilink parsing, YAML config parsing, and dream sub-phases each exist in duplicated or entangled form. Nothing enforces the layering rule that core modules never talk to the process directly.

## Scope

- Split `src/mcp/brain-tools.ts` into per-domain tool modules; `brain-tools.ts` remains only as the aggregation point exporting `BRAIN_TOOLS` (the registration seam that `tools.ts` and tests already import - not a compatibility shim).
- Add `withBrainCommand` context wrapper in `src/cli/brain/` and migrate the verb files onto it, deleting the repeated vault/config/try-catch boilerplate.
- Unify atomic writes on `src/core/reliability/atomic.ts` (the richer API); migrate `fs-atomic.ts` call sites and delete the duplicate implementation.
- Create one canonical wikilink module; migrate all seven regex sites onto named, purpose-documented variants. Characterization tests pin current behavior per site before migration.
- Extract the YAML subset parser out of `policy.ts`; extract evidence-refresh and reconcile-outcomes out of `dream.ts` with explicit input/output interfaces.
- Delete `scripts/sync-version.py`; add a layering-guard test that scans `src/core` for `process.exit` / `process.stdout` / `console.*` usage.

## Out of scope

- Any behavior, output-format, or public-surface change (v1.0.0 froze MCP tool names, CLI verbs, file formats).
- Registry/manifest-driven command frameworks (consultant variant 3) - rejected as scope creep.
- ISO-8601 regex consolidation in `log-jsonl.ts` / `truth/store.ts` - the in-code comments document that writer/reader pairs intentionally do not share constants; respected as-is.
- `.toISOString()` to `isoSecond()` codemod - would change stored timestamp precision; not a pure refactor.
- New external dependencies.

## Chosen approach

Consultant variant 2: canonical modules with direct call-site migration. For every duplication pick one winning implementation, migrate all call sites in the same commit, and delete the loser. No alias re-export shims; the only surviving indirection is `brain-tools.ts` as the existing aggregation seam. Each unit is one conventional commit with the full suite green, so units stay independently revertable.

## Design decisions

- **brain-tools.ts stays as aggregator, not shim**: `tools.ts` and six test files import `BRAIN_TOOLS` from it; keeping that one seam gives a zero-churn registration point and matches how `ALL_TOOLS` already concatenates domain arrays.
- **Domain split by tool cohesion, ~13 modules**: feedback/dream writes, review lifecycle, context packing, queries, health, briefs, analytics, entities, knowledge graph, admin, recall/benchmark, procedural, landscape - mirrors the dispatcher groups already present inside the file. A parity test asserts the before/after tool-name set is identical.
- **`reliability/atomic.ts` wins over `fs-atomic.ts`**: it is the newer API with the validate hook and configurable mode; the exclusive-create primitive from `fs-atomic.ts` moves into it so one module owns temp-file naming + fsync + rename.
- **Wikilink variants are named, not merged into one regex**: the seven sites have three genuinely different contracts (quoted/heading-aware, strict no-newline, alias-capturing). Forcing one regex would change behavior; instead one module exports documented named variants and the two exact duplicates collapse.
- **Wrapper does not own flag schemas**: `withBrainCommand` resolves context (vault, config, json mode) and uniform error formatting only; each verb keeps its own `parse()` schema so output strings and exit codes stay byte-identical.
- **Layering guard is a bun test, not an AST walk**: a source scan over `src/core/**` for `process.exit` / `process.stdout` / `console.` with an explicit allowlist is sufficient, dependency-free, and runs in the normal test suite.

## File changes

New files:
- `src/mcp/brain/` domain modules (~13 files) plus shared helpers module for coercion/serialization used by several domains.
- `src/cli/brain/command.ts` - `withBrainCommand` wrapper and `CommandContext` type.
- `src/core/brain/wikilink.ts` - named regex variants and parse helpers.
- `src/core/brain/yaml-parse.ts` - YAML subset parser moved from `policy.ts`.
- `src/core/brain/dream-refresh.ts`, `src/core/brain/reconcile-outcomes.ts` - extracted from `dream.ts`.
- `tests/core/layering.test.ts` - layering guard.
- Characterization/unit tests for wikilink variants, atomic write paths, extracted modules, tool-set parity.

Modified files:
- `src/mcp/brain-tools.ts` (becomes aggregator), `src/mcp/tools.ts` (unchanged imports, verify only).
- `src/cli/brain/verbs/*.ts` (~89 files migrate to wrapper).
- `src/core/reliability/atomic.ts` (absorbs exclusive create), all `fs-atomic.ts` importers.
- `src/core/vault.ts`, `lint-consolidate.ts`, `link-graph/parse-wikilink.ts`, `link-graph/format-wikilink.ts`, `search/links.ts`, `search/entities.ts`, `search/query-plan.ts` (wikilink imports).
- `src/core/brain/policy.ts`, `src/core/brain/dream.ts` (shrink via extraction).

Deleted files:
- `src/core/fs-atomic.ts`, `scripts/sync-version.py`.

## Risks and open questions

- **Wikilink unification could surface latent edge-case differences** - mitigated by writing characterization tests against the current behavior of each site before touching imports.
- **CLI wrapper migration touches ~89 files in one commit** - mitigated by keeping the wrapper minimal (context + catch) and relying on the existing CLI tests that assert output strings and exit codes.
- **openclaw bundle (`openclaw/index.js`) is a committed build artifact** - must be rebuilt via `bun run build:openclaw` if anything it bundles changes, and verified in QA.
- **plugins/hermes and hooks/ may import moved symbols** - grep before each move; anything externally imported keeps its export path through the canonical module.
