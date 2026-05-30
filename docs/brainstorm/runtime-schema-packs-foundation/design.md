# Runtime Schema Packs Foundation - schema vocabulary without a second store

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain currently has several closed vocabularies encoded as TypeScript `as const` objects: signal source types, preference lifecycle status, retired reasons, apply results, log event kinds, memory layers, and graph relations. The recent relation-vocabulary work proved that a single data-driven validation boundary can add meaning without migrations or duplicated token lists. Schema-pack tasks ask for the same extensibility for user/domain taxonomies, but the full upstream Schema Cathedral surface is too large for one safe release.

The root design challenge is separating taxonomy from behavior. Some existing tokens are lifecycle controls consumed by deterministic algorithms (`dream`, retire logic, audit readers). Opening them directly would make exhaustive state handling less trustworthy. This foundation should introduce runtime-declared schema vocabulary in a way that is useful now, keeps legacy behavior byte-compatible, and gives future mutation primitives a stable target.

## Scope

- Add an optional `_brain.yaml` `schema:` block as the single user-facing declaration surface for schema-pack taxonomy.
- Add a shared Brain schema vocabulary boundary, analogous to `relation-vocab.ts`, that merges built-in defaults with validated `schema:` declarations.
- Add optional schema metadata on Brain artifacts where it is safe and inert, starting with preference/retired and signal frontmatter fields that do not change core lifecycle behavior.
- Add a pure read-only schema report that can show the resolved vocabulary, scan declared-vs-used schema metadata, and report unknown or unused tokens.
- Add a small CLI read surface, `o2b brain schema`, with JSON output for show/lint/stats-style inspection.
- Add focused tests proving default installs and legacy fixtures remain unchanged when no `schema:` block or schema metadata exists.

## Out of scope

- The full `t_cbf4967f` mutation surface: 11 mutation primitives, 9 MCP operations, 14 CLI verbs, pack-lock, mutate-audit, and schema-author skill.
- Opening core lifecycle state machines (`preference.status`, `dream` transitions, retire reasons, apply-evidence results) to arbitrary user tokens in this PR.
- A dedicated `Brain/_schema/` registry or other second schema store.
- Remote/admin MCP schema mutation tools.
- Backfilling existing artifacts to add schema metadata.
- Search-ranking, `dream`, retention, or doctor behavior changes based on custom schema types beyond read-only lint/reporting.

## Chosen approach

Use Variant 1 from the consultant output: `_brain.yaml` gets a small optional `schema:` block, and core code resolves it through one shared vocabulary module. The module exposes built-in defaults, token normalization, pack validation, and predicates for known schema tokens. The implementation will stay read-first: operators can declare schema tokens and inspect/lint usage, while future PRs can add atomic mutation primitives against the same config block.

The key narrowing is that custom schema tokens are taxonomy metadata, not replacements for operational state. For example, a preference can carry a validated schema type/category, but its lifecycle `status` remains one of `unconfirmed | confirmed | quarantine` until a future design proves how custom lifecycle states interact with deterministic `dream`.

## Design decisions

- **Use `_brain.yaml` instead of `Brain/_schema/`.** The project already stores vault policy and optional feature knobs in `_brain.yaml`; a `schema:` block keeps the foundation visible, editable, and free of a second store lifecycle.
- **Keep the schema block flat enough for the existing parser.** Prefer arrays of string tokens under named keys, e.g. `schema.preference_types`, `schema.signal_types`, `schema.page_types`, and `schema.log_event_kinds`. Rich descriptions, aliases, routing hints, and mutation audit belong to later Schema Cathedral work.
- **Separate taxonomy from lifecycle state.** Do not widen `BrainPreferenceStatus` or `BRAIN_LOG_EVENT_KIND` call sites just to satisfy the upstream analogy. Instead, introduce explicit schema metadata fields whose behavior is inert unless a read-only report inspects them.
- **One validation boundary.** All schema-token validation flows through a new core module. Parsers and CLI reports must not copy token lists.
- **Legacy-safe writer behavior.** Optional schema metadata is emitted only when supplied. Existing preference/signal fixtures without schema metadata should remain byte-identical.
- **Read-only first.** The CLI should show resolved vocabulary and report unknown/unused token usage. It should not edit `_brain.yaml` or rewrite artifacts in this PR.

## File changes

Expected new files:

- `src/core/brain/schema-vocab.ts` - schema token normalization, defaults, resolver model, validation predicates.
- `src/core/brain/schema-report.ts` - pure read-only show/lint/stats report over resolved vocabulary and artifact usage.
- `src/cli/brain/verbs/schema.ts` - CLI read surface for resolved schema/report output.
- `tests/core/brain/schema-vocab.test.ts` - vocabulary and validation tests.
- `tests/core/brain/schema-report.test.ts` - read-only report/lint tests.
- `tests/cli/brain-schema-cli.test.ts` - CLI JSON and human output tests.

Expected modified files:

- `src/core/brain/types.ts` - optional config/artifact schema types.
- `src/core/brain/policy.ts` - `_brain.yaml` parser/validator support for optional `schema:` block.
- `src/core/brain/preference.ts` - optional schema metadata parse/write for preferences and retired artifacts.
- `src/core/brain/signal.ts` - optional schema metadata parse/write for signals.
- `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts` - CLI registration and discovery.
- `docs/cli-reference.md`, `README.md`, `CHANGELOG.md` - Phase 5 user-facing docs.
- Version manifests - Phase 5 version bump before push per operator override.

## Risks and constraints

- **YAML parser shape.** The current parser handles one nested block with scalar values and simple inline arrays. If multiline arrays are unsupported for schema blocks, implementation should either extend the parser minimally and test it, or require inline arrays for this release.
- **Field naming.** `schema_type` is explicit and avoids conflicting with existing `kind`, `status`, and graph `type` terms. The final implementation should choose names that are easy to grep and do not imply lifecycle mutation.
- **Log event support.** Existing log readers consume operational event kinds. The first report may need to scan raw log frontmatter defensively rather than widening every log consumer.
- **Scope pressure from child task.** Mutation primitives, locks, and MCP admin tools are tempting follow-ups but remain out of scope unless the foundation cannot be useful without them.
