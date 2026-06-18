# Path-safe vault writes design

## Problem

Open Second Brain writes Markdown and JSONL files inside an Obsidian vault, especially under the managed `Brain/` subtree. The in-scope card asks for defense-in-depth against path traversal when caller-derived identifiers become filenames or path segments, and for a containment backstop before vault writes happen.

The current code already contains `ensureInsideVault`, `src/core/brain/paths.ts` constructors, `validateSlug`, `slugify`, and a `brain_create_note` implementation that refuses traversal and absolute paths. The remaining risk is not that no guard exists, but that direct write call sites may bypass existing path constructors or lack regression tests proving the write target stays inside the configured vault root.

## Scope

- In-scope card: `t_7b1049bb` - Path-safe identifier sanitization and write-containment guard for vault writes.
- Branch: `feat/path-safe-vault-writes`.
- Release shape: one small patch-version hardening task. The implementation card should be driven under TDD and keep the change limited to the smallest proven write-containment gap.
- Preserve unrelated pre-existing working tree changes in `src/core/brain/morning-brief.ts` and `src/core/brain/time.ts`.

## Out of scope

- No release execution in this phase.
- No broad rewrite of all vault writers into a new abstraction unless the audit proves a specific unguarded write path needs it.
- No new natural-language wordlists or language-specific sanitization rules.
- No behavior change for unrelated CLI, MCP, search, or portability features.
- No manual version bump in this phase.

## Chosen approach

Chosen variant: Variant 3, audit-and-prove existing write containment.

The consultant recommended verifying every direct vault writer, routing only real stragglers through the existing `ensureInsideVault` or `paths.ts` constructors, and adding regression tests for traversal, sibling-prefix, absolute path, and symlink-ancestor escapes. I agree with this recommendation because the project already has mature path-safety primitives, and a small patch release should not introduce a competing sanitizer or a default-off writer option that callers can forget to use.

## Design decisions

1. Treat `ensureInsideVault` and `src/core/brain/paths.ts` as the primary containment boundary.
2. Audit direct writer call sites before changing code. A write is acceptable only if its target is built by a guarded path constructor, by `ensureInsideVault(join(vault, ...), vault)`, or by a component whose own tests prove equivalent containment.
3. If an unguarded Brain or vault write is found, harden that specific path by reusing the existing guard instead of adding a second path-safety model.
4. Add TDD regression coverage before implementation changes. Tests should exercise traversal (`..`), absolute paths, sibling-prefix paths, and symlink-ancestor escapes where filesystem semantics matter.
5. Do not add a broad optional `vault` parameter to `writeFrontmatter` or `writeFrontmatterAtomic` in this patch. Optional containment at the writer layer would be easy for callers to omit and is too broad for one low-priority card.
6. Do not add a new email-style identifier whitelist unless the audit identifies a concrete caller-supplied identifier that must preserve `@` or `+` and is not already handled by `validateSlug`, `slugify`, or `inspectPath`.

## File changes

Expected implementation areas:

- `src/core/path-safety.ts` if a small reusable helper is needed near the existing containment primitive.
- `src/core/brain/paths.ts` if a missing Brain path constructor needs to be added or an existing constructor needs stricter validation.
- Specific writer modules found by the audit, only when they construct write targets without the existing guard.
- `tests/core/path-safety.test.ts` and focused tests next to the affected writer module.
- `CHANGELOG.md` under `[Unreleased]` after implementation, describing the hardening in user-facing terms.

Do not touch the unrelated pre-existing changes in `src/core/brain/morning-brief.ts` and `src/core/brain/time.ts`.

## Risks

- The audit may find more scattered writers than expected. If that happens, keep this card to the highest-risk Brain/vault writer and file follow-up work instead of expanding scope.
- Some direct writes are intentionally outside the vault, such as local config, benchmarks, or repo metadata. Tests and code changes must distinguish vault-owned writes from non-vault files.
- Symlink tests are platform-sensitive. Follow the existing `tests/core/path-safety.test.ts` pattern and avoid assumptions that break Windows compatibility.
