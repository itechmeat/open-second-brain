# SOLID/DRY refactor - implementation plan

One feature branch (`feat/solid-dry-refactor`), six atomic units, each its own conventional commit with the full suite green. TDD: characterization or unit tests land before each move.

## Tasks

### Task 1: Canonical wikilink module (kanban t_c82bdae0)
- **Files**: new `src/core/brain/wikilink.ts`; new `tests/core/brain/wikilink.test.ts`; migrate `src/core/vault.ts`, `src/core/brain/lint-consolidate.ts`, `src/core/brain/link-graph/parse-wikilink.ts`, `src/core/brain/link-graph/format-wikilink.ts`, `src/core/search/links.ts`, `src/core/search/entities.ts`, `src/core/search/query-plan.ts`
- **Acceptance**: characterization tests pin each variant's contract (quoted/heading, strict, alias-capturing, minimal) and pass before and after migration; no regex literal for `[[...]]` remains outside the module; full suite green.
- **Depends on**: none

### Task 2: Unify atomic file writes (kanban t_82213b08)
- **Files**: `src/core/reliability/atomic.ts` (absorbs exclusive create), delete `src/core/fs-atomic.ts`, migrate its importers; new/extended tests in `tests/core/reliability/atomic.test.ts`
- **Acceptance**: one implementation of temp-name + fsync + rename; tests cover simple write, validated write, exclusive create (success and already-exists), mode override; full suite green.
- **Depends on**: none

### Task 3: Extract policy YAML parser and dream sub-modules (kanban t_3d9369d0)
- **Files**: new `src/core/brain/yaml-parse.ts` (from `policy.ts`), new `src/core/brain/dream-refresh.ts` and `src/core/brain/reconcile-outcomes.ts` (from `dream.ts`); unit tests for each new module
- **Acceptance**: `policy.ts` no longer contains parsing code; `dream.ts` shrinks by the extracted ranges; extracted modules unit-tested in isolation; existing policy/dream tests green unchanged.
- **Depends on**: none

### Task 4: Split brain-tools.ts into domain modules (kanban t_c567a35e)
- **Files**: new `src/mcp/brain/` domain modules (~13) plus shared helper module; `src/mcp/brain-tools.ts` becomes the aggregator; new parity test asserting the BRAIN_TOOLS name set is unchanged
- **Acceptance**: parity test green; no file in `src/mcp` over ~700 lines; `tools.ts` and existing test imports unchanged; full suite green.
- **Depends on**: Task 1 (wikilink), Task 2 (atomic) so moved code imports canonical modules once.

### Task 5: CLI brain-command wrapper migration (kanban t_6467b4af)
- **Files**: new `src/cli/brain/command.ts` (+ unit tests for context resolution and error formatting); migrate `src/cli/brain/verbs/*.ts`
- **Acceptance**: wrapper unit tests green; verb files contain no repeated vault/config/catch boilerplate; CLI output strings and exit codes unchanged (existing CLI tests); full suite green.
- **Depends on**: none (parallel-safe, but lands after Task 4 to avoid merge noise in shared helper files).

### Task 6: Cleanup and layering guard (kanban t_bee11d1a)
- **Files**: delete `scripts/sync-version.py`; new `tests/core/layering.test.ts`
- **Acceptance**: layering test fails on injected `process.exit` in a core fixture-style check and passes on the real tree; `bun run sync-version:check` still works; full suite green.
- **Depends on**: Tasks 1-5 (guard validates the final tree).

## QA gate (after all tasks)
`bun run validate` (typecheck + lint + test), `bun run fmt:check`, `bun run sync-version:check`, rebuild `openclaw/index.js` via `bun run build:openclaw` if bundled sources moved, smoke-test `o2b` CLI and MCP server startup.
