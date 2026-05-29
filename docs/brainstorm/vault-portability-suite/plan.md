# Vault portability + session economy - implementation plan

Foundation-first: pure primitives land before the surfaces that compose them.
Each task is RED -> GREEN -> REFACTOR with its own commit. Every task keeps a
default install (codec off, no vault-map, no profiles) byte-identical.

## Task 1: Deterministic session codec primitive
- **Files**: `src/core/brain/portability/codec.ts`, `tests/core/brain/portability/codec.test.ts`
- **Acceptance**: `compress(text)` / `expand(text)` are pure; `expand(compress(x)) === x` for fixtures containing code fences, inline code, URLs, filesystem paths, dotted/snake/camel identifiers, and semver version numbers (all preserved byte-for-byte); structural detection only (no language word lists); `CODEC_VERSION` exported; empty/whitespace inputs round-trip; never throws on malformed input.
- **Depends on**: none

## Task 2: Role-token resolver + vault-map loader
- **Files**: `src/core/brain/portability/role-tokens.ts`, `tests/core/brain/portability/role-tokens.test.ts`
- **Acceptance**: `resolveRoleToken(map, token)` resolves `{{inbox}}`-style tokens to folder names; `loadVaultMap(vault)` reads optional `Brain/_vault-map.yaml` and returns a token->folder map; an absent file or unknown token falls back to a built-in default; resolution is deterministic and rejects path traversal in mapped values.
- **Depends on**: none

## Task 3: Vault graph serializer (export)
- **Files**: `src/core/brain/portability/graph.ts`, `tests/core/brain/portability/graph-export.test.ts`
- **Acceptance**: `exportVaultGraph(vault)` walks all vault pages via `listVaultPages`, extracts wikilinks (`extractWikilinks`) and typed-relation frontmatter, and returns a stable, sorted graph (pages by id/path, links sorted); re-export is byte-identical; pure read-only.
- **Depends on**: none

## Task 4: Vault graph importer (conflict modes)
- **Files**: `src/core/brain/portability/graph.ts` (`importVaultGraph`), `tests/core/brain/portability/graph-import.test.ts`
- **Acceptance**: `importVaultGraph(vault, graph, {mode})` reconstructs page stubs (frontmatter + wikilinks) via the atomic writer; `skip` (default) never overwrites an existing page; `overwrite` replaces; `merge` unions wikilinks/relations; writes go through `ensureInsideVault`; idempotent under skip; never targets Brain machinery files.
- **Depends on**: Task 3

## Task 5: Sources dashboard projection
- **Files**: `src/core/brain/portability/sources.ts`, `tests/core/brain/portability/sources.test.ts`
- **Acceptance**: `aggregateSources(vault)` scans inbox + processed signals and groups by (agent, source_type, session_ref) with active/processed counts and distinct-topic counts; pure read-only; deterministic ordering.
- **Depends on**: none

## Task 6: Profile registry + vault resolution
- **Files**: `src/core/brain/portability/profiles.ts`, `src/core/config.ts` (`resolveVault` consults active profile), `tests/core/brain/portability/profiles.test.ts`, `tests/core/config.*`
- **Acceptance**: `listProfiles` / `createProfile` / `switchProfile` operate on a `profiles:` + `active_profile` config registry; `switch` rewrites only the pointer; `resolveVault` returns the active profile's vault when set, else the bare `vault` key (back-compat: no profiles -> unchanged); no symlinks.
- **Depends on**: none

## Task 7: Opt-in codec integration into session import + read
- **Files**: `src/core/brain/sessions/import.ts`, `src/core/brain/signal.ts`, `src/core/brain/policy.ts` / config (`signals.raw_codec`, default off), `tests/core/brain.sessions.codec.test.ts`
- **Acceptance**: with `signals.raw_codec` on, a session-imported signal's `raw` is stored compressed with a `_raw_codec: <version>` marker; `parseSignal` expands only when the marker is present; with the flag off (default) the import + parse paths are byte-identical to pre-suite; round-trip verified end-to-end.
- **Depends on**: Task 1

## Task 8: Vault-map wiring into content surfaces
- **Files**: scan-inline read-path resolution + graph-import target (`src/core/brain/inline-scan.ts` or callers, `portability/graph.ts`), `tests/core/brain/portability/role-tokens-wiring.test.ts`
- **Acceptance**: scan-inline read paths and the graph-import write target resolve `{{token}}` values via the shared resolver; absent map -> current behaviour unchanged; the FIXED Brain `*_REL` constants are not routed through the resolver.
- **Depends on**: Tasks 2, 4

## Task 9: CLI verbs
- **Files**: `src/cli/brain/verbs/{codec,sources,graph-export,graph-import}.ts`, `src/cli/vault/verbs/{profile,map}.ts`, `src/cli/brain.ts`, `src/cli/vault.ts`, help-text, `tests/cli/*`
- **Acceptance**: `o2b brain codec --compress|--expand`, `o2b brain sources [--json]`, `o2b brain graph-export`, `o2b brain graph-import --mode skip|overwrite|merge`, `o2b vault profile list|create|switch`, `o2b vault map [show]`; each read-only verb is side-effect-free; help-text added.
- **Depends on**: Tasks 1-6

## Task 10: MCP tools
- **Files**: `src/mcp/brain-tools.ts`, `src/mcp/instructions.ts`, `tests/mcp/mcp.test.ts` (count 44 -> 46)
- **Acceptance**: `brain_sources` (read-only) and `brain_switch_vault` tools registered; tool count 44 -> 46; instructions updated.
- **Depends on**: Tasks 5, 6

## Task 11: QA, docs, version bump, release prep
- **Files**: `README.md`, `docs/how-it-works.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json` + manifests (sync-version)
- **Acceptance**: full `bun run validate` green; default-install byte-identical asserted (codec off, no vault-map, no profiles); docs describe all 5 features; one `[0.22.0]` CHANGELOG entry; version synced across manifests.
- **Depends on**: Tasks 1-10
