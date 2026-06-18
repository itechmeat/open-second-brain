# Path-safe vault writes implementation plan

## Release scope

This patch release scope contains exactly one driven card:

- `t_7b1049bb` - Path-safe identifier sanitization and write-containment guard for vault writes.

All work happens on branch `feat/path-safe-vault-writes`. Workers must build on commits already landed on this branch and must not duplicate or conflict with sibling tasks. There are no sibling cards in this release scope.

## t_7b1049bb - Path-safe identifier sanitization and write-containment guard for vault writes

### Files

Primary files to inspect:

- `src/core/path-safety.ts`
- `src/core/brain/paths.ts`
- `src/core/vault.ts`
- `src/core/brain/notes/create-note.ts`
- Every `src/**` call site from a grep for `writeFrontmatter`, `writeFileSync`, `appendFileSync`, `mkdirSync`, `atomicWriteFileSync`, and `atomicWriteText`

Likely test files:

- `tests/core/path-safety.test.ts`
- `tests/core/brain/notes/create-note.test.ts`
- A focused test file near any specific writer hardened by the audit

Docs or release notes after implementation:

- `CHANGELOG.md` under `[Unreleased]`

### Acceptance

A passing implementation must include TDD evidence:

1. Add or extend failing tests first that prove the selected vault write path rejects traversal, absolute escapes, sibling-prefix escapes, and symlink-ancestor escapes where applicable.
2. Implement the smallest code change that makes those tests pass by reusing `ensureInsideVault`, `src/core/brain/paths.ts`, `validateSlug`, `slugify`, or `inspectPath` as appropriate.
3. Run at minimum:
   - `bun test tests/core/path-safety.test.ts`
   - the focused test for the hardened writer
   - `bun run typecheck`
4. Before handoff, run the project validation command if feasible: `bun run validate`.
5. The diff must not modify the pre-existing unrelated working-tree files `src/core/brain/morning-brief.ts` or `src/core/brain/time.ts`.

### Depends on

- `docs/brainstorm/path-safe-vault-writes/design.md`
- This plan section
- The branch `feat/path-safe-vault-writes` being current before the worker starts

### Implementation notes

Start with an audit table in the worker notes or card comment: writer call site, target root, guard mechanism, action needed. Change only call sites that write into the vault or Brain and lack a guard. If the audit finds no missing guard, ship regression tests that pin the existing containment invariant and document the finding in the handoff.
