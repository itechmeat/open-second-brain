# v0.10.9 — Vault Scope

Closes the "Vault Scope" gap: data the plugin owns still lives only in
`Brain/`, but everything else under the vault is walked through a single
shared exclusion policy. One source of truth in `Brain/_brain.yaml`,
two CLI verbs for visibility (`o2b vault status`, `o2b vault inspect`),
one `o2b brain doctor` check for stale entries. Closed in one release.

## 1. Problem

Two vault walkers exist today, each with its own private rules:

- `src/core/search/walker.ts` reads ignore paths from
  `search_ignore_paths` (flat `config.yaml`) or the env variable
  `OPEN_SECOND_BRAIN_SEARCH_IGNORE`. Default set includes
  `.obsidian/cache` but not the whole `.obsidian` directory.
- `src/core/brain/inline-scan.ts` has its own hard-coded
  `HARD_SKIP_DIRS` constant. It excludes the whole `.obsidian`
  directory, plus `Brain` (so inline markers cannot self-reference).

The two lists drift. `.obsidian/cache` vs `.obsidian` is the visible
example; future scanners will reinvent the same list a third time.
There is also no way for the operator to ask the system "which files
do you actually look at, and which are excluded and why" without
reading source.

The plugin already has a nested-YAML config file at
`Brain/_brain.yaml` (handled by `src/core/brain/policy.ts`). It is
the natural home for a vault-wide exclusion policy.

## 2. Goals

1. One declarative source of truth: `Brain/_brain.yaml` field
   `vault.ignore_paths`. All vault walkers (search indexer,
   `scan-inline`, any future scanner) read the same list.
2. Updated default set: `.obsidian` (full directory, not just
   `.obsidian/cache`) and `Brain/.snapshots` explicitly listed.
3. Operator visibility: `o2b vault status` shows counts of included
   files/directories and which exclusion rules fired; `o2b vault
   inspect <relpath>` answers the same question for one specific
   path with the matched rule.
4. `scan-inline` also honours `vault.ignore_paths`. Its existing
   `--path` and `--exclude` flags remain as narrowing on top of the
   shared set; they never re-include something the shared set
   excludes.
5. `o2b brain doctor` warns when `vault.ignore_paths` contains a
   path-style entry that does not exist in the vault.
6. No vault-data migration. No public MCP-contract change (the
   `second_brain_status` JSON gains a new `vault` field; existing
   fields are untouched). All in v0.10.9.

## 3. Non-goals

- No backward-compatibility for `search_ignore_paths` /
  `OPEN_SECOND_BRAIN_SEARCH_IGNORE`. The project has no live users to
  protect; both surfaces are deleted in this release, no
  deprecation period.
- No GUI / dashboard / web view. Status is CLI + MCP JSON only.
- No file-level glob patterns (`*.tmp`, `**/foo.md`). Today's two
  walkers only need directory-name and exact-path semantics; we
  match that exactly.
- No new env variables. Path of last resort for tweaking exclusions
  is editing `Brain/_brain.yaml`.

## 4. `_brain.yaml`: new optional `vault` block

```yaml
vault:
  ignore_paths:
    - .git
    - node_modules
    - .open-second-brain
    - .obsidian
    - .trash
    - .stversions
    - Brain/.snapshots
```

Same shape as the existing `discipline_report.watched_paths` list,
so `parseBrainYaml` handles it without a parser change.

Rule semantics (lifted verbatim from the current
`src/core/search/walker.ts:parseIgnore`):

- Entry without `/` (e.g. `node_modules`): bare directory name.
  Matched against any directory at any depth in the vault tree.
- Entry containing `/` (e.g. `Brain/.snapshots`): vault-relative
  exact path. Matched when the directory's relative path equals
  this entry.

`ignore_paths` is the only field under `vault` for v0.10.9. The
block itself is optional. Three cases:

| `vault` block | `ignore_paths` | Effective rules |
|---|---|---|
| absent | n/a | built-in default set |
| present, `ignore_paths` absent | n/a | built-in default set |
| present, `ignore_paths` empty list | `[]` | empty (excludes nothing) |
| present, populated | `[a, b, ...]` | exactly that list |

Empty list is a valid explicit "include everything" toggle; we do
not silently substitute defaults when the operator has stated an
intent.

Validation rules:

- Each entry is a non-empty string.
- Same character allow-list as `primary_agent`
  (`formatPrimaryAgentYamlValue`): reject C0 control characters and
  the unquoted-YAML hazards `"`, `\`, `\n`, `\r`. A bad entry fails
  config load with a `BrainConfigError` field
  `vault.ignore_paths[<n>]`.
- Unknown top-level fields under `vault:` produce a warning (same
  forward-compat pattern as `discipline_report`).

Validator and writer (`DEFAULT_BRAIN_CONFIG_YAML`) both ship with
the default list. New vaults created by `o2b brain init` see the
block in the file; existing vaults without the block get the same
defaults at runtime without anyone touching their file.

## 5. `vault-scope`: single resolver, single matcher

New module `src/core/vault-scope/index.ts`. Pure functions, no I/O
other than reading `Brain/_brain.yaml` once via the existing loader.

```ts
export interface VaultIgnoreRule {
  readonly raw: string;            // exactly as written in _brain.yaml
  readonly kind: "name" | "path";  // bare name vs vault-relative
}

export interface VaultScope {
  readonly ignorePaths: ReadonlyArray<string>;
  readonly rules: ReadonlyArray<VaultIgnoreRule>;
  readonly source: "_brain.yaml" | "defaults";
}

export function resolveVaultScope(vault: string): VaultScope;
```

`resolveVaultScope` reads `Brain/_brain.yaml`; if the file is
missing, falls back to defaults silently so pre-v0.10.9 vaults keep
working. If the file exists but is malformed or unreadable, the
resolver fails closed instead of silently defaulting, because dropping
custom exclusions can cause search / scan-inline to ingest paths the
operator meant to hide. If `vault.ignore_paths` is set, returns those
rules with `source: "_brain.yaml"`. Otherwise returns the defaults
with `source: "defaults"`.

Matching:

```ts
export interface IgnoreMatch {
  readonly excluded: boolean;
  readonly rule: VaultIgnoreRule | null;
  readonly matchedAt: string | null;   // POSIX rel-path of the
                                       // segment that triggered
                                       // the match
}

export function matchIgnore(
  relPath: string,                     // POSIX, vault-relative,
                                       // empty string == vault root
  rules: ReadonlyArray<VaultIgnoreRule>,
): IgnoreMatch;
```

Semantics: walk `relPath` segment by segment. For each prefix:

- if any rule of kind `name` matches the segment name, exclude;
- if any rule of kind `path` matches the prefix exactly, exclude;
- otherwise the prefix is fine, continue.

`matchedAt` is the shortest prefix that triggered the match. For
`.obsidian/plugins/foo/note.md` it would be `.obsidian`.

### 5.1 Default rule set

```ts
export const DEFAULT_VAULT_IGNORE_PATHS: ReadonlyArray<string> =
  Object.freeze([
    ".git",
    "node_modules",
    ".open-second-brain",
    ".obsidian",
    ".trash",
    ".stversions",
    "Brain/.snapshots",
  ]);
```

This constant lives in `vault-scope` and is the sole owner of the
default list. `src/core/search/index.ts:DEFAULT_IGNORE_PATHS` and
`src/core/brain/inline-scan.ts:HARD_SKIP_DIRS` are deleted.

### 5.2 Vault walker

A single fs walker for the status verb:

```ts
export interface VaultScopeWalk {
  readonly includedFiles: number;
  readonly includedDirs: number;
  readonly excludedDirs:
    ReadonlyArray<{ relPath: string; rule: VaultIgnoreRule }>;
  readonly excludedFiles:
    ReadonlyArray<{ relPath: string; rule: VaultIgnoreRule }>;
}

export function walkVaultScope(
  vault: string,
  scope: VaultScope,
): VaultScopeWalk;
```

Lifts the acyclic-symlink guard from `src/core/search/walker.ts`
(realpath + `seenDirs` set, refuses to leave the vault root). The
search walker keeps its existing generator surface; the
`walkVaultScope` here is a separate, status-oriented call - it
collects counts and the excluded list, it does not yield files,
and it does not care about file extension (status counts every
file, not only `.md`, because exclusions apply uniformly).

Reporting semantics: when a directory is excluded, the walker
records that directory in `excludedDirs` and stops recursing
into it. Files and subdirectories inside an excluded subtree are
NOT counted separately in `excludedFiles` / `excludedDirs` - one
entry at the root of the excluded subtree is the whole report.
This keeps both the CLI text output and the JSON shape stable
regardless of how deep the excluded subtree is.

## 6. Walker rewrites

### 6.1 search walker

`src/core/search/walker.ts`:

- Remove the local `parseIgnore(...)` helper.
- `walkVault(config)` accepts `config.ignoreRules: ReadonlyArray<VaultIgnoreRule>`
  in addition to (or instead of) `config.ignorePaths`. Implementation
  uses `matchIgnore` from `vault-scope` for directory- and file-
  level decisions.
- All other invariants stay: deterministic sorted traversal,
  symlink loop protection, `*.md`-only file filter.

`src/core/search/index.ts`:

- Delete `DEFAULT_IGNORE_PATHS`.
- Delete `parseIgnorePaths`.
- Replace
  `ignorePaths = parseIgnorePaths(envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_IGNORE", "search_ignore_paths"))`
  with
  `const scope = resolveVaultScope(opts.vault); const ignoreRules = scope.rules;`.

`src/core/search/types.ts`:

- `ResolvedSearchConfig.ignorePaths` is replaced by
  `readonly ignoreRules: ReadonlyArray<VaultIgnoreRule>`.
  The string-array field is removed entirely - no internal caller
  outside the walker reads it today (grep confirms only
  `walker.ts` reads `config.ignorePaths`), so the rule list is
  the simpler shape.
- Test helper `tests/helpers/search-fixtures.ts:makeConfig` keeps
  its convenience `ignorePaths?: ReadonlyArray<string>` parameter
  for terse fixtures, but builds `ignoreRules` internally before
  freezing the config. Tests that read the field for assertions
  (`tests/core/search/config.test.ts`) switch to
  `cfg.ignoreRules.map((r) => r.raw)`.

### 6.2 scan-inline walker

`src/core/brain/inline-scan.ts`:

- Delete the hard-coded `HARD_SKIP_DIRS` array.
- Inside `scanInline(vault, opts)`:
  1. `const scope = resolveVaultScope(vault);`
  2. Build the effective rule set:
     `const rules = [...scope.rules, { raw: "Brain", kind: "name" }, ...userExcludeRules];`
     The `Brain` rule is appended unconditionally - inline markers
     inside `Brain/` would self-reference the derived layer, and
     this invariant is too important to depend on `_brain.yaml`
     not having been edited away.
  3. Use `matchIgnore` for directory- and file-level decisions.
- `opts.exclude` becomes a list of `VaultIgnoreRule`s (kind `path`
  for everything, since CLI semantics today require an exact
  prefix match - we preserve that).
- `opts.paths` (the include-narrowing) remains as-is, untouched.

`--exclude` is purely narrowing on top of the shared set. There is
no flag to re-include something the shared set excluded; the
operator who needs that edits `_brain.yaml` (rare enough that a
flag would be premature).

## 7. CLI: `o2b vault status` and `o2b vault inspect`

New top-level subcommand `vault`. Dispatcher mirrors the existing
`o2b brain` and `o2b search` pattern: tiny `src/cli/vault.ts` that
routes to per-verb files under `src/cli/vault/verbs/`.

### 7.1 `o2b vault status`

```
o2b vault status [--vault <path>] [--json]
```

Text output:

```
vault:         /root/vault
ignore source: _brain.yaml

included: 1247 files, 89 directories
excluded: 3 directories, 0 files

excluded directories:
  .obsidian                rule .obsidian (name)
  Brain/.snapshots         rule Brain/.snapshots (path)
  Notes/.trash             rule .trash (name)
```

JSON output:

```json
{
  "vault": "/root/vault",
  "ignore_source": "_brain.yaml",
  "rules": [
    {"raw": ".git", "kind": "name"},
    ...
  ],
  "included": {"files": 1247, "dirs": 89},
  "excluded": {
    "dirs": [
      {"rel_path": ".obsidian", "rule": ".obsidian", "kind": "name"},
      ...
    ],
    "files": []
  }
}
```

Failure modes:

- Vault path missing: exit 1, single-line stderr error
  (matches existing `o2b brain doctor` convention).
- `_brain.yaml` unreadable / malformed: status fails closed
  (§5) — single-line stderr error from the propagated
  `BrainConfigError` and exit 1. Walkers cannot silently drop
  the operator's policy, so the CLI surface refuses to render
  partial counts.

### 7.2 `o2b vault inspect <relpath>`

```
o2b vault inspect <relpath> [--vault <path>] [--json]
```

Reads `relpath` as vault-relative POSIX. Resolves the vault scope
(no fs walk), runs `matchIgnore`, prints the result.

Text output - included case:

```
relpath: Notes/idea.md
status:  included
```

Text output - excluded case:

```
relpath:      .obsidian/plugins/foo/note.md
status:       excluded
matched rule: .obsidian (name)
matched at:   .obsidian
source:       _brain.yaml
```

JSON output:

```json
{
  "relpath": ".obsidian/plugins/foo/note.md",
  "status": "excluded",
  "matched_rule": {"raw": ".obsidian", "kind": "name"},
  "matched_at": ".obsidian",
  "source": "_brain.yaml"
}
```

Failure modes:

- `relpath` absent or empty: exit 2, usage hint.
- Path traverses outside the vault (`..`): exit 2, error.
- Path does not exist on disk: still reports the rule decision
  (because the question "would the walker include this if it
  existed" is meaningful), but adds `status: excluded (not found
  on disk)` or `status: included (not found on disk)` so the
  operator knows.

## 8. MCP `second_brain_status`: new `vault` field

Existing payload gains one block. No existing keys change.

```jsonc
{
  "config_path": "...",
  "config_exists": true,
  "config_keys": [...],
  "config": {...},
  "vault_path": "...",
  "vault_exists": true,
  "vault": {
    "ignore_source": "_brain.yaml",
    "rules": [
      {"raw": ".obsidian", "kind": "name"},
      ...
    ],
    "included": {"files": 1247, "dirs": 89},
    "excluded": {"dirs": 3, "files": 0}
  },
  "brain": {...},
  "search": {...}
}
```

Only aggregate counts under `excluded` (no per-path list). MCP
payloads should stay small; the per-path detail lives in the CLI
verb. If the vault path is missing, the `vault` block is omitted
entirely - same convention `brain` and `search` already use.

The resolver itself fails closed on a malformed `_brain.yaml`
(§5), but `second_brain_status` is a read-only diagnostic, not a
walker — failing the whole response would hide the brain / config /
search blocks that the operator needs to triage the same problem.
The tool therefore catches the resolver error and degrades the
`vault` block to `{"error": "<message>"}`. The other blocks stay
intact. The `search` block already has this shape (`{exists: false,
error: ...}`) for the same reason. Callers reading the JSON should
treat both shapes as "block is present but currently unreadable".

## 9. `o2b brain doctor`: new check

New check `checkVaultIgnore` runs after `checkConfig`. Logic:

```
scope = resolveVaultScope(vault)
if scope.source != "_brain.yaml":
    return  // defaults can list paths that don't exist
            // in this particular vault, that's fine
for rule in scope.rules where rule.kind == "path":
    if not existsSync(join(vault, rule.raw)):
        emit warning {
            code: "vault-ignore-missing-path",
            message: f"vault.ignore_paths entry {rule.raw!r} "
                     "does not exist in this vault",
        }
```

Bare-name rules (`kind: "name"`) are not checked - the absence of
a `.git` or `node_modules` directory is not an error. Path-style
entries are explicit declarations of "this specific path exists
and I want it excluded", so a missing entry is more often a typo
than a deliberate forward-declaration.

## 10. Breaking changes

Removed in v0.10.9 (no deprecation cycle):

- `search_ignore_paths` key in `~/.config/open-second-brain/config.yaml`.
- `OPEN_SECOND_BRAIN_SEARCH_IGNORE` environment variable.

Default exclusion set changes:

- `.obsidian/cache` widened to `.obsidian` (the whole directory).
  Effect: `.md` files inside Obsidian plugin folders no longer
  appear in `o2b search` results. Operators who rely on indexing
  Obsidian plugin notes (rare) can opt back in by setting
  `vault.ignore_paths` explicitly without `.obsidian`.
- `Brain/.snapshots` added explicitly. The directory contains only
  `.tar.zst` archives today, so practical effect is zero; the
  entry makes the policy self-documenting.

CHANGELOG entry under `[0.10.9]`:

```
### Removed
- `search_ignore_paths` config key and
  `OPEN_SECOND_BRAIN_SEARCH_IGNORE` environment variable.
  Configure exclusions in `Brain/_brain.yaml` under
  `vault.ignore_paths`.

### Added
- `vault.ignore_paths` field in `Brain/_brain.yaml`. Single source
  of truth for vault walkers (search indexer, scan-inline, future
  scanners). Default set widens `.obsidian/cache` to `.obsidian`
  and adds `Brain/.snapshots` explicitly.
- `o2b vault status` - one-shot view of how many files/directories
  the current policy would include, and which exclusion rules
  fired.
- `o2b vault inspect <relpath>` - point-check for one path with
  the matched rule.
- `second_brain_status` MCP payload gains a `vault` block
  mirroring the CLI status counts.
- `o2b brain doctor` warns when a path-style `vault.ignore_paths`
  entry does not exist in the vault
  (`vault-ignore-missing-path`).
```

## 11. Test plan

TDD order: write failing tests, then implementation.

### 11.1 New test files

- `tests/core/vault-scope.test.ts`
  - `matchIgnore` against a representative set of paths.
  - `resolveVaultScope` reads `_brain.yaml` when present.
  - `resolveVaultScope` falls back to defaults when block absent.
  - Empty `ignore_paths: []` is honoured (excludes nothing).
  - Character allow-list rejects entries with control chars / quotes.
  - `walkVaultScope` correctly counts a small fixture with two
    excluded directories.

- `tests/cli/vault.test.ts`
  - `o2b vault status` text output on a fixture.
  - `o2b vault status --json` shape stable.
  - `o2b vault inspect` for included path, excluded by name rule,
    excluded by path rule, not found on disk, path traversal.

### 11.2 Existing test files - updates

- `tests/core/search/config.test.ts` - drop tests that exercised
  `search_ignore_paths` / `OPEN_SECOND_BRAIN_SEARCH_IGNORE`. Add
  test that confirms env / config has no effect on ignore set.
- `tests/core/search/walker.test.ts` - fixtures now pass `ignoreRules`
  instead of (or alongside) `ignorePaths`. The `makeConfig` helper
  in `tests/helpers/search-fixtures.ts` builds rules from the
  default list.
- `tests/core/brain.inline-scan.test.ts` - add cases:
  - `.obsidian/plugins/foo/note.md` is skipped even though the
    container is a plain directory with `.md` inside.
  - `Brain/` always skipped regardless of `_brain.yaml`.
  - User `--exclude foo` excludes `foo/` even when foo is not in
    `_brain.yaml`.
- `tests/core/brain.policy.test.ts` - parser accepts `vault:` block,
  rejects bad characters in entries, treats missing block as
  defaults.
- `tests/core/brain.doctor.test.ts` - new case for
  `vault-ignore-missing-path` warning.
- `tests/mcp/tools.test.ts` - assert `second_brain_status` payload
  contains the new `vault` block on a populated vault.

### 11.3 e2e

`tests/e2e/brain-capture-and-fields.test.ts` already exercises
`scan-inline` end-to-end. Extend with a step that places an
`@osb` marker inside `.obsidian/plugins/x/note.md` and confirms
`scan-inline` does NOT pick it up.

## 12. Out of scope / deferred

- File-glob patterns (`*.tmp`, `**/*.draft.md`) in
  `vault.ignore_paths`. Today's two walkers do not need them.
  Trigger to revisit: a real operator request with a pattern that
  cannot be expressed as a directory name or vault-relative path.
- Per-walker overrides (e.g. "scan-inline should also skip
  `Drafts/` but search should not"). Both walkers currently use
  identical exclusions plus per-call narrowing; if asymmetry is
  ever needed, add a `walker_overrides` sub-block under `vault:`
  at that time, not preemptively.
- Auto-rewrite of legacy `search_ignore_paths` into
  `vault.ignore_paths`. The project has no live users; one-shot
  migration tooling is dead weight.

## 13. Implementation order

1. `tests/core/vault-scope.test.ts` (failing) + skeleton module.
2. `src/core/vault-scope/index.ts` implementation.
3. `src/core/brain/types.ts` + `policy.ts` for `vault:` block;
   `tests/core/brain.policy.test.ts` updates.
4. Walker rewrites:
   1. `src/core/search/walker.ts` + `index.ts`, with
      `tests/core/search/walker.test.ts` and `config.test.ts`
      updates.
   2. `src/core/brain/inline-scan.ts`, with
      `tests/core/brain.inline-scan.test.ts` updates.
5. New CLI verbs:
   1. `src/cli/vault.ts` + verb files.
   2. `src/cli/main.ts` dispatcher entry.
   3. `tests/cli/vault.test.ts`.
6. MCP payload extension:
   1. `src/mcp/tools.ts:toolStatus`.
   2. `tests/mcp/tools.test.ts`.
7. Doctor check:
   1. `src/core/brain/doctor.ts:checkVaultIgnore`.
   2. `tests/core/brain.doctor.test.ts`.
8. CHANGELOG + bumps + final `bun test` + manual `o2b vault status`
   on `/root/vault`.
