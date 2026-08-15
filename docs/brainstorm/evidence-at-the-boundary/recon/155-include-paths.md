# Recon: positive vault.include_paths (GitHub #155)

Read-only reconnaissance against `main` @ 29ea0099.

## The exclude pipeline is fully shared, which makes this small

Grammar and defaults live in the cycle-safe leaf `src/core/vault-scope/defaults.ts`
(`VaultIgnoreRule`, `DEFAULT_VAULT_IGNORE_PATHS:26`, `classifyVaultIgnoreRule:54`).
The file exists only to break a `policy.ts -> vault-scope -> policy.ts` cycle, and
`tests/core/architecture/import-cycles.test.ts` ratchets that.

Config to rules: `src/core/brain/policy/blocks/vault-ignore.ts:26` `parseVaultBlock`,
wired at `policy/validate.ts:101,129`, defaults injected at `policy/defaults.ts:62-64`.

Resolver and matcher: `src/core/vault-scope/index.ts` with `matchIgnore:55`,
`resolveVaultScope:106` (fails closed by letting `loadBrainConfig` throw),
`walkVaultScope:139`, `inspectPath:253`.

There are exactly six `matchIgnore` call sites and no re-implementation:
`search/walker.ts:92,114`, `notes/note-walk.ts:145`, `vault-scope/index.ts:172,205,266`.
Snapshot and the link-graph scanners walk `Brain/` internals through `brainDirs()`
and never touch vault scope. `src/core/fs/ignore.ts` is a separate gitignore-glob
engine used by hygiene repo-scan and source ingest; do not conflate the two.

So a second dimension has two threading points, `ResolvedSearchConfig.ignoreRules`
(`search/types.ts:1181`, set at `search/index.ts:451-452`) and
`walkMarkdownFiles(..., rules, ...)`, plus the three in-module functions.

## The design doc does not forbid this

`docs/plans/2026-05-19-vault-scope-design.md` never names include-mode as a
non-goal. What it does say:

- §3: no file-level glob patterns, and no new env variables.
- §4: "`ignore_paths` is the only field under `vault` for v0.10.9"; an empty list is
  a valid explicit include-everything toggle; unknown fields under `vault:` warn.
- §5: a missing config falls back to defaults silently so old vaults work, but a
  present-and-malformed config fails closed, because dropping custom exclusions can
  let search ingest paths the operator meant to hide.
- §6.2: the CLI `--path` narrowing "never re-includes something the shared set
  excludes", and an operator who needs that edits `_brain.yaml`.

The request respects the glob non-goal, the env-var non-goal and fail-closed. The
only thing it changes is a version-scoped fact, not a principle. Worth saying so
in the pull request body.

## The AND-composition precedent exists but is not extractable yet

`inline-scan.ts:132` resolves roots via `resolveNoteRoots(vault, opts.paths)`,
builds rules at `:158`, and walks at `:160`. Inside `notes/note-walk.ts` the
composition is an unnamed inline lambda at `:145` plus `:156`: exclusion gates
first, directories descend regardless of roots (deliberate, commented at `:148-149`),
and only files are gated on being under a root. Reusing it means extracting it.

## Config surface

`parseVaultBlock` reads only `ignore_paths`; `normaliseIgnorePath:44` enforces
string, non-empty, no YAML-unsafe characters, non-empty after normalisation and no
leading slash, all as hard `BrainConfigError`s. `warnUnknownKeys(ctx, rawMap,
["ignore_paths"], BLOCK)` at `:39` means `include_paths` today is accepted-looking
and silently ignored, pinned by `tests/core/brain.policy.test.ts:533-543`.

Template: `src/core/brain/config-template.ts:247-259` emits the `vault` block with
`ignore_paths` as `live`. `tests/core/brain/config-template-ratchet.test.ts`
requires every validator-known key to be templated or listed in
`BRAIN_CONFIG_TEMPLATE_OMISSIONS`, and asserts the live surface is byte-identical
to the frozen v1.38.0 template. So `include_paths` must be a
`commented-example`, which is also semantically right: it has no default and
writing it would change behaviour.

`_brain.yaml` has no JSON schema. Files that must learn the key:
`src/core/brain/types.ts:1345-1347`, the policy block, the template,
`docs/architecture.md:139`, `docs/how-it-works.md:31`, `docs/cli-reference.md:552-553`,
`src/cli/vault/help-text.ts:7-9,32-35`, `CHANGELOG.md`. `policy/defaults.ts` must
NOT gain it: absent means today's behaviour.

`src/core/brain/upgrade.ts:329-395` splices only real key lines into an existing
block, so a commented example will not appear in already-upgraded vaults. Acceptable,
but state it rather than let it be discovered.

## Recommended surface: change the type, do not add a field

The forcing function is that `VaultScope.rules` stops being an array:

```ts
// defaults.ts (leaf)
export interface VaultPathRule { readonly raw: string; readonly kind: "name" | "path" }
export function classifyVaultPathRule(raw: string): VaultPathRule
export function pathCovers(prefix: string, relPath: string): boolean
export interface VaultScopeRules {
  readonly ignore: ReadonlyArray<VaultPathRule>;
  /** null = no allowlist declared, exclude-only. Never an empty array. */
  readonly include: ReadonlyArray<VaultPathRule> | null;
}

// index.ts
export type OutOfScopeReason = "ignored" | "not-included";
export function matchScope(relPath: string, rules: VaultScopeRules): ScopeMatch
export function mayDescend(relDir: string, rules: VaultScopeRules): boolean
```

`matchIgnore` is deleted rather than aliased: a function named "ignore" that
answers half the scope question is exactly the misleading surface the quality rules
forbid. Every consumer breaks at compile time and must adopt `matchScope`.

Parser: rename the block file to `vault-scope.ts` (the old name will lie),
extract `normaliseVaultPathEntry` for both keys, add the new key to the known list,
and refuse `include_paths: []` with a `BrainConfigError`. The precedent and the
wording are at `write-binding.ts:55-63`: a list that admits no path is an off
switch rather than a boundary. `ignore_paths: []` keeps its documented
excludes-nothing meaning; that asymmetry belongs in the docblock.

Doctor: extend `vaultIgnoreCheck` (`doctor/config-checks.ts:123`) with a
`vault-include-missing-path` code at severity error, not warning. A dead exclude
entry costs nothing; a dead include root means nothing is indexed at all.

## The decision that must not fall out of the implementation

`create-note.ts:299-322` refuses writes to excluded paths. Under an allowlist,
uniform semantics means `brain_create_note` refuses every path outside the
included roots. Recommendation: keep it uniform, one policy every consumer obeys,
and make the message name the reason so it reads "outside vault.include_paths"
versus "excluded by vault.ignore_paths (.obsidian)".

## Free win to assert rather than assume

The indexer's deletion sweep (`src/core/search/indexer.ts:463-469`) removes any
document the walk no longer yields, so setting `include_paths` and reindexing
prunes previously indexed content with no migration code. Prove it in a test.

## Adjacent defects worth fixing in the same pass

1. Segment-wise prefix coverage is implemented five times:
   `write-binding/prefix.ts:59-63` (the only one with a docblock),
   `vault-scope/index-admission.ts:34-36`, `notes/note-walk.ts:156`,
   `search/indexer.ts:1270`, `brain/manifest.ts:254`. Adding a sixth for include
   would be the DRY violation this unit exists to avoid.
2. `walkVaultScope` and `inspectPath` do not apply `admitToIndex` while
   `walker.ts:95,118` does, so `o2b vault status` and `o2b vault inspect`
   over-report index coverage for paths the indexer refuses.
3. `matchIgnore` treats `relPath === ""` as a fast negative (`index.ts:56`).
   Harmless for exclusion; under an allowlist the vault root would read as not
   included. Root must be special-cased explicitly.
4. `classifyVaultIgnoreRule` cannot express "the top-level Brain only": a slashless
   entry is a name rule matching at any depth, and `note-walk.ts:109` sidesteps
   this by hand-building a shape the parser cannot produce. Document the
   depth-agnostic semantics; do not add syntax.
5. `vault-ignore.ts` inlines `"ignore_paths"` three times; `write-binding.ts:30-32`
   shows the constant idiom. Extract before adding a second key.

## Tests and fixtures

`tests/core/vault-scope.test.ts` is the primary suite (tmpdir per test, hand-written
`_brain.yaml`, literal rule arrays for the pure matcher). `tests/core/brain.policy.test.ts:520-585`
covers the parser cases. `tests/core/brain/note-walk.test.ts` writes
`DEFAULT_BRAIN_CONFIG_YAML + extra`. `tests/helpers/search-fixtures.ts` `makeConfig({ignorePaths})`
at `:49-60` is the single chokepoint every search test builds rules through.
Also touched: `search/walker.test.ts`, `search/config.test.ts:184-210`,
`search/index-admission.test.ts`, `brain.inline-scan.test.ts:306-370`,
`brain.doctor.test.ts:721-760`, `mcp/mcp.test.ts:415-470`, `cli/vault.test.ts`,
`config-template-ratchet.test.ts`.
