# Brain Model Semantics Foundation - implementation plan

## Tasks

### Task 1: Preference relation vocabulary and backlink projection

- **Files**: `src/core/graph/relation-vocab.ts`, `src/core/brain/backlinks.ts`, `tests/core/brain/backlinks-relation.test.ts`
- **Acceptance**: A Bun test proves `depends_on:` and `refines:` preference frontmatter fields are accepted by the shared vocabulary and appear as `BacklinkRef.relation` values; an unknown field remains untyped.
- **Depends on**: none

### Task 2: Preference memory metadata parse/write

- **Files**: `src/core/brain/types.ts`, `src/core/brain/preference.ts`, focused preference parser/writer tests
- **Acceptance**: Tests prove `writePreference` emits `memory_layer` and `memory_branch` only when supplied, `parsePreference` and `parseRetired` round-trip them, invalid `memory_layer` is rejected, and legacy preferences without those fields remain byte-identical.
- **Depends on**: none

### Task 3: Explorer typed semantics projection

- **Files**: `src/core/brain/explorer.ts`, `templates/brain-explorer.html`, `tests/core/brain/explorer.test.ts`
- **Acceptance**: A Bun test proves explorer nodes expose `memory_layer` / `memory_branch`, typed relation edges include `relation`, existing `kind` values remain compatible, and the static template renders relation labels without changing graph JSON schema version unless required.
- **Depends on**: Task 1, Task 2

### Task 4: Deterministic supersession backfill planner

- **Files**: `src/core/brain/semantics-backfill.ts`, `tests/core/brain/semantics-backfill.test.ts`
- **Acceptance**: Tests prove the planner returns a stable dry-run proposal when an active preference `supersedes` a retired preference that lacks the inverse `superseded_by`, returns no proposal when the inverse already exists, and makes no writes.
- **Depends on**: Task 1

### Task 5: CLI or documented read surface for backfill preview

- **Files**: `src/cli/main.ts` and adjacent CLI helpers if a command is added; otherwise `docs/cli-reference.md`
- **Acceptance**: Either `o2b brain semantics-backfill --json` returns the dry-run plan in a stable machine-readable shape, or the implementation explicitly documents that the planner remains internal for this PR and no CLI surface ships.
- **Depends on**: Task 4

### Task 6: Documentation and release metadata

- **Files**: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md` if CLI changed, `package.json`, lock/version mirrors if version sync requires them
- **Acceptance**: User-facing docs describe typed preference semantics, memory metadata labels, and dry-run backfill accurately; changelog has one new version entry; `bun run sync-version:check` passes after the version bump.
- **Depends on**: Tasks 1-5

## Validation plan

- Focused tests after each atomic unit, starting with failing tests.
- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run sync-version:check`
- `code_checker` after code edits, per project instructions.
