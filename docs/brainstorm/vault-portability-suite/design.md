# Vault portability + session economy - deterministic primitives and opt-in seams

**Status:** draft
**Author:** feature-release-playbook
**Audience:** implementation

## Problem statement

Open Second Brain operates on a single, fixed-layout vault and imports agent
sessions sequentially with no compression, no per-source visibility, and no way
to move a whole knowledge graph between vaults or adapt to a non-standard folder
layout. This suite adds five deterministic, language-agnostic capabilities -
behind a shared `portability/` subsystem - that make the brain portable and its
session intake economical, while keeping a default install byte-identical.

## Scope

Five features (chosen set; implemented one-by-one via TDD), built on a shared
`src/core/brain/portability/` subsystem so folder-resolution and serialization
logic exist once:

1. **Deterministic session codec** - pure `compress` / `expand` with a
   protected-span scanner that preserves code fences, inline code, URLs, paths,
   identifiers, and version numbers byte-for-byte; `expand(compress(x)) === x`.
   Ships as a module + `o2b brain codec` CLI utility, AND as an opt-in
   `signals.raw_codec` transform on the session-imported signal `raw` body
   (compressed on write, expanded on read, gated by a stored `_raw_codec`
   marker). Default off -> byte-identical.
2. **`o2b brain sources` dashboard** - read-only aggregation of signals by
   agent / `source_type` / session origin (`session_ref`), with active-inbox vs
   processed counts and distinct-topic counts. `--json`; also a `brain_sources`
   MCP tool. The parallel worker-pool + connection-budget warning from the
   upstream inspiration are OUT of scope.
3. **Vault-map role-token resolution** - `resolveRoleToken(map, token)` over an
   optional map file resolving `{{inbox}}`-style tokens to USER content folder
   names, with built-in defaults when absent. Scoped to user content surfaces
   (scan-inline read paths, graph-import write target); the FIXED Brain `*_REL`
   constants and the one-agent-owned-root design are untouched.
4. **Named multi-vault profiles** - a profile registry (name -> vault path +
   optional settings) with list / create / switch, activated by a
   pointer-in-config key (NO symlinks - they sync inconsistently under
   Syncthing). CLI `o2b vault profile ...` + a `brain_switch_vault` MCP tool.
5. **Vault graph export/import** - a graph serializer over all vault pages
   (`listVaultPages`) + `extractWikilinks` + typed-relation frontmatter
   (`related`/`extends`/`contradicts`/`superseded_by`) producing `graph.json`, and an importer
   that reconstructs page stubs with frontmatter + wikilinks under three
   conflict modes: skip (default) / overwrite / merge. Deterministic; idempotent
   on re-import with skip.

## Out of scope

- Copilot / Pi session adapters (deferred; not in this PR).
- Parallel multi-source sync worker pool + connection-budget warning (the
  read-only sources dashboard ships; the concurrency engine does not).
- Relocating the Brain internal layout (`Brain/inbox` etc. stay fixed); vault-map
  addresses user content folders only.
- Symlink-based profile activation (pointer-in-config only).
- Rewriting the proven session-import or dream internals.

## Chosen approach

**Variant 2 - shared portability subsystem, foundation-first.** A new
`src/core/brain/portability/` holds the pure primitives (codec, graph
serializer, role-token resolver, profile registry); the user-visible features
compose them. Pure, deterministic code is front-loaded and unit-tested under
TDD; anything that touches existing on-disk output is a gated, reversible seam.

## Design decisions

- **Codec is pure + opt-in for storage.** The codec module guarantees
  round-trip on structured content. Its only on-disk effect is gated behind
  `signals.raw_codec` (default off); a compressed signal body carries a
  `_raw_codec: <algoVersion>` frontmatter marker, so `parseSignal` only routes
  through `expand` when the marker is present. Every signal written by a default
  install lacks the marker and takes the unchanged read path -> byte-identical.
- **Protected spans, not language rules.** The codec compresses only inter-token
  whitespace/prose structure; code fences, inline code, URLs, filesystem paths,
  dotted/snake/camel identifiers, and semver-like version numbers are detected
  structurally (regex over shape, never word lists) and copied verbatim.
- **Vault-map addresses user content only.** `paths.ts` `*_REL` constants are
  NOT rerouted. The resolver reads an optional `Brain/_vault-map.yaml`
  (token -> folder); absent or unknown token -> built-in default. The same
  resolver is reused by scan-inline read paths and the graph-import target so
  the three never drift.
- **Profiles are a pointer in config.** A `profiles:` registry in config
  (name -> {vault, ...}) plus an `active_profile` pointer; `switch` rewrites the
  pointer only. `resolveVault` consults the active profile before the bare
  `vault` key (back-compat: no profiles -> existing behaviour). No symlinks.
- **Graph format is additive + deterministic.** `graph.json` is a sorted,
  stable serialization (pages sorted by id, links sorted) so re-export is
  byte-identical. Import writes page stubs via the existing atomic frontmatter
  writer; skip mode never overwrites, merge unions wikilinks/relations, overwrite
  replaces. Importer never touches Brain machinery files.
- **Sources dashboard is a pure projection.** It scans inbox + processed signals
  (already on disk) and groups by (agent, source_type, session_ref); no new
  store, no writes.

## File changes

New subsystem `src/core/brain/portability/`:
- `codec.ts` - `compress`, `expand`, `CODEC_VERSION`, protected-span scanner.
- `role-tokens.ts` - `resolveRoleToken`, `loadVaultMap`, default token table.
- `graph.ts` - `exportVaultGraph` (over `listVaultPages` + `extractWikilinks` + typed-relation frontmatter), `importVaultGraph` (+ conflict modes), types.
- `profiles.ts` - profile registry load/save, `switchProfile`, `listProfiles`.
- `sources.ts` - `aggregateSources` pure projection over scanned signals.

Modified:
- `src/core/brain/signal.ts` - opt-in codec expand-on-read gated by `_raw_codec`.
- `src/core/brain/sessions/import.ts` - opt-in codec compress on raw write.
- `src/core/config.ts` - `resolveVault` consults active profile; profile keys.
- `src/core/brain/policy.ts` / config - `signals.raw_codec` flag (default off).
- CLI: `src/cli/brain/verbs/{codec,sources,graph-export,graph-import}.ts`,
  `src/cli/vault/verbs/{profile,map}.ts` (or `src/cli/brain/verbs/`), wired in
  `src/cli/brain.ts` / `src/cli/vault.ts` + help-text.
- MCP: `src/mcp/brain-tools.ts` - `brain_sources`, `brain_switch_vault`
  (tool count 44 -> 46) + `instructions.ts`.
- Docs: `README.md`, `docs/how-it-works.md`, `docs/cli-reference.md`,
  `docs/mcp.md`, `CHANGELOG.md`.

## Risks and open questions

- **Codec round-trip correctness.** A codec bug would corrupt opt-in-compressed
  signal bodies. Mitigation: exhaustive round-trip property tests on structured
  fixtures; gated by `_raw_codec` marker so only opt-in writes are affected; the
  default read path is untouched.
- **Profile switch + config writes.** `switch` rewrites an operator-owned config
  key only; never moves vault data. `resolveVault` stays backward-compatible
  when no profiles are defined.
- **Byte-identical default.** Codec off, no vault-map file, no profiles, graph
  import not run -> every existing surface is byte-identical. The QA phase must
  assert a no-op default run produces no new files and unchanged signal bytes.
- **Graph import safety.** Import writes only under the resolved content target,
  via `ensureInsideVault`; skip mode is the default; Brain machinery files are
  never targeted.
