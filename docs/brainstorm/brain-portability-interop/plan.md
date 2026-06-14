# Brain Portability & Interop - implementation plan

Implemented one atomic unit at a time via TDD on `feat/brain-portability-interop`.
Order is dependency-driven: the pure projection first, then the shared write
primitive, then the bundle that composes them, then the SDK façade over all.

## Tasks

### Task 1: Page interchange contract (Unit B)
- **Files**: `src/core/brain/portability/page-contract.ts` (new);
  `tests/core/brain/portability/page-contract.test.ts` (new).
- **Surface**: `PAGE_CONTRACT_VERSION`, `PageContract`,
  `projectPageContracts(vault): ReadonlyArray<PageContract>` - pure, read-only.
- **Behaviour**: one record per user vault page (Brain machinery + ignored dirs
  excluded, same exclusion set as `exportVaultGraph`): `path` (vault-relative
  POSIX), `kind` (frontmatter `kind:` else `"note"`), `confidence`
  (frontmatter, else null), `provenance` (frontmatter, else null), `citations`
  (sorted-unique union of body wikilinks + typed-relation targets), `aliases`
  (frontmatter, else empty), `freshness` (frontmatter `updated_at`/`updated`
  else file mtime as ISO second). Sorted by `path` for determinism.
- **Acceptance**: tests cover field derivation, structural `kind` default,
  null confidence/provenance when absent, citation flattening + sort, alias
  passthrough, freshness fallback to mtime, deterministic ordering, and Brain-
  root/ignored-dir exclusion. No NL heuristics; no `as` casts.
- **Depends on**: none.

### Task 2: createNote primitive + brain_create_note MCP tool (Unit D)
- **Files**: `src/core/brain/notes/create-note.ts` (new);
  `src/mcp/brain/notes-tools.ts` (new) wired into the MCP tools array;
  `src/mcp/registry-guard.ts`, `src/mcp/profiles.ts` (register the tool);
  `tests/core/brain/notes/create-note.test.ts` (new);
  `tests/mcp/brain-create-note.test.ts` (new).
- **Surface**: `createNote(vault, { path, frontmatter, content })` ->
  `{ path, created }`; typed `CreateNoteError` for guard failures.
- **Behaviour**: resolve the target via `ensureInsideVault`; reject (typed
  throw, not silent) a path that escapes the vault, lands in the Brain root, or
  matches a vault-scope ignore/private rule; write atomically via
  `writeFrontmatterAtomic`; return the vault-relative path. The MCP tool is a
  thin handler returning a small fixed-shape ack via `vaultRelativeSafe`.
- **Acceptance**: tests cover happy-path create with frontmatter+body,
  path-traversal rejection, Brain-root rejection, ignore/private rejection,
  atomic overwrite semantics, and the MCP tool happy-path + error-code mapping.
  Registry/profile completeness tests stay green.
- **Depends on**: none (but shares the primitive Unit C reuses).

### Task 3: Bank export/import + CLI verbs (Unit A)
- **Files**: `src/core/brain/portability/bundle.ts` (new);
  `src/cli/brain/verbs/bank-export.ts`, `src/cli/brain/verbs/bank-import.ts`
  (new) + dispatcher registration;
  `tests/core/brain/portability/bundle.test.ts` (new) + CLI verb tests
  following the graph-export/graph-import pattern.
- **Surface**: `BANK_BUNDLE_SCHEMA_VERSION`, `BankBundle`,
  `exportBankBundle(vault): BankBundle`,
  `importBankBundle(vault, bundle, { mode }): BankImportResult`.
- **Behaviour**: export composes `exportPreferencesJson`'s rows,
  `exportVaultGraph`, `projectPageContracts`, and `aggregateSources` into one
  schema-versioned envelope (deterministic, sorted). Import validates the
  envelope shape, delegates page reconstruction to `importVaultGraph` under the
  chosen conflict mode, restores preferences via the existing preference writer
  (or scopes restore out with an explicit result flag if no clean writer
  exists), and reports the sources dashboard as carried-not-restored. Per-entry
  guards; malformed entries collected, never thrown.
- **Acceptance**: tests cover round-trip export->import, schema version on the
  envelope, conflict modes (skip/overwrite/merge) via the delegated importer,
  per-entry rejection of malformed input, and the honest result object
  (per-section counts + sources-not-restored flag).
- **Depends on**: Task 1 (page contract).

### Task 4: In-process SDK (Unit C)
- **Files**: `src/core/brain/sdk.ts` (new); `tests/core/brain/sdk.test.ts`
  (new).
- **Surface**: `createBrain(vault)` returning a façade:
  `exportBank()`, `importBank(bundle, opts)`, `exportGraph()`,
  `importGraph(graph, opts)`, `exportPreferences(format)`,
  `ingestSource(input, opts)`, `listSources()`, `getSource(id)`,
  `deleteSource(id)`, `createNote(input)`.
- **Behaviour**: every method is a one-line delegation to the corresponding core
  function (`exportBankBundle`, `importBankBundle`, `exportVaultGraph`,
  `importVaultGraph`, `exportPreferencesJson`/`exportPreferencesLlmsTxt`,
  `ingestSource`, a `kind: brain-source` page enumeration for list/get,
  `ensureInsideVault`-guarded delete, and `createNote`). The upstream
  `writeStatus` maps to `ingestSource` (documented); no fabricated status field.
- **Acceptance**: tests assert each façade method delegates and returns the core
  result (export round-trip through the SDK, source create/list/get/delete
  lifecycle, createNote via the SDK), and that the SDK adds no behaviour beyond
  delegation.
- **Depends on**: Task 1, Task 2, Task 3, and existing `ingestSource`.

## Cross-cutting (Phase 4-5, after all tasks)

- Full suite (`bun test`), `bun run typecheck`, `bun run lint`,
  `bun run scripts/sync-version.ts --check`.
- README capability paragraph + CHANGELOG entry under the new version heading
  with its compare link-ref.
- `package.json` version bump + `bun run scripts/sync-version.ts` (inside this
  PR per `CLAUDE.md`).
