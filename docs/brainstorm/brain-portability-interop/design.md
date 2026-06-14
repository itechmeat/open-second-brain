# Brain Portability & Interop - portable, provenance-bearing, programmatically writable brain content

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain can export pieces of a brain (preferences via `export.ts`,
the page link-graph via `portability/graph.ts`) but has no single operation to
move a whole brain ("bank") between instances, no standardized per-page
interchange contract a downstream importer can rely on, no in-process SDK for
programmatic callers, and no MCP tool to create an actual vault note (only
`brain_note`, which appends one log line). This suite closes those four gaps
additively, reusing the existing portability infrastructure rather than forking
a parallel serialisation path.

## Scope

- **Unit B - Page interchange contract** (`portability/page-contract.ts`): a
  pure, read-only projection of every user vault page to a stable,
  schema-versioned record `{ path, kind, confidence, provenance, citations,
  aliases, freshness }`, decoupled from OSB internals so an external tool can
  consume it. Structural derivation only (frontmatter fields + wikilinks + file
  mtime); no LLM synthesis, no natural-language heuristics.
- **Unit D - `createNote` primitive + `brain_create_note` MCP tool**: a shared
  core primitive `createNote(vault, { path, frontmatter, content })` that writes
  a Markdown file atomically under `ensureInsideVault`, honouring vault-scope /
  ignore / private rules, and the thin MCP tool that wraps it. Reused by Unit C.
- **Unit A - Whole-vault (bank) export/import** (`portability/bundle.ts`): a
  deterministic, schema-versioned bank envelope composing the existing
  exporters (preferences + page graph + page-contract records + the read-only
  sources dashboard) plus an importer that restores the page graph (delegating
  to `importVaultGraph`) and preferences, under explicit conflict modes. CLI
  verbs `o2b brain bank-export` / `bank-import`.
- **Unit C - In-process SDK** (`sdk.ts`): `createBrain(vault)` returning a thin
  façade over existing core functions: bank export/import, graph export/import,
  preference export, source-backed operations (`ingestSource`, `listSources`,
  `getSource`, `deleteSource`), and `createNote`. No reimplementation - every
  method delegates to a core function.

## Out of scope

- PDF export (kanban t_64d65fb7): needs a heavy dependency (headless browser /
  PDF engine), against the no-new-heavy-deps rule. Left in triage.
- A source *status lifecycle*. OSB ingested sources (`kind: brain-source`
  pages) carry provenance and `created_at`/`updated_at` but no processing-status
  enum. The upstream `writeStatus` API maps to the existing `ingestSource`
  write (which stamps `updated_at` and rewrites idempotently); we do NOT invent
  a status field just to mirror the upstream name.
- Re-importing the sources dashboard. `aggregateSources` is a derived read-only
  projection over signals; it is carried in the export bundle as informational
  metadata, not restored on import. The import result reports this explicitly
  rather than silently pretending to restore it.
- Multi-target typed-relation fidelity on import: inherited from
  `importVaultGraph`'s documented frontmatter-parser limitation; unchanged here.

## Chosen approach

Variant 2 from the brainstorm (consultant-recommended): **Layered core with thin
peer adapters.** Each portability concern is a discrete core module beside the
existing helpers; every surface (CLI verb, MCP tool, SDK method) is an
independent thin adapter over those core functions, and no surface depends on
another surface. This keeps the SDK a genuine façade (re-export, not
orchestrate), keeps Unit B's contract decoupled in its own projection module,
and lets the four units land additively in one release. The two rejected
variants either centralised orchestration in the SDK (Variant 1, breaking the
"thin façade" constraint and serialising the units) or overloaded the link-graph
exporter with non-graph bank content (Variant 3, muddying `GRAPH_VERSION` and
working against Unit B's "decoupled, stable interchange schema" requirement).

## Design decisions

- **Separate version constants per envelope.** The bank bundle gets its own
  `BANK_BUNDLE_SCHEMA_VERSION`; the page contract gets `PAGE_CONTRACT_VERSION`.
  Neither reuses `GRAPH_VERSION` or `BRAIN_EXPORT_SCHEMA_VERSION`, so each format
  evolves independently and an importer can detect drift per section.
- **Compose, never fork.** `exportBankBundle` calls `collectExportRows`,
  `exportVaultGraph`, `projectPageContracts`, and `aggregateSources`;
  `importBankBundle` delegates page reconstruction to `importVaultGraph`. No new
  serialisation of pages/preferences is written from scratch.
- **Structural, language-agnostic page `kind`.** `kind` reads the frontmatter
  `kind:` field when present (e.g. `brain-source`), else a structural default
  (`note`). No keyword/title heuristics in any language.
- **Provenance/confidence are advisory and read-only.** Read from frontmatter
  if present, else `null`. The provider-agnostic kernel never synthesises them.
- **Citations are derived structurally.** Flattened, sorted-unique union of body
  wikilink targets and typed-relation targets - the same extraction the graph
  exporter already uses - so the contract stays decoupled from any NL parsing.
- **Per-entry runtime validation on import.** Mirrors `importVaultGraph`: every
  untrusted JSON entry is shape-guarded; a malformed entry is rejected into a
  `rejected[]` list and the run continues, never throws mid-import. No `as`
  casts - guards narrow `unknown` to the input type.
- **Honest import result.** `importBankBundle` returns a structured result with
  per-section counts (graph created/skipped/overwritten/merged/rejected,
  preferences restored/skipped, and `sourcesCarriedNotRestored`) so the caller
  sees exactly what happened. No "fully restored" claim where only part is.
- **`createNote` is the single write primitive.** Both the MCP tool and the SDK
  method call it; it enforces `ensureInsideVault`, atomic write, and vault-scope
  / ignore / private rejection with a typed error (no silent skip).
- **Byte-identical-when-off.** All four units are additive new surfaces. No
  existing exporter, importer, CLI verb, MCP tool, or default path changes
  behaviour; with none of the new verbs/tools/SDK invoked, output is identical.

## File changes

New core modules:
- `src/core/brain/portability/page-contract.ts` - `PageContract`,
  `PAGE_CONTRACT_VERSION`, `projectPageContracts(vault)`.
- `src/core/brain/portability/bundle.ts` - `BankBundle`,
  `BANK_BUNDLE_SCHEMA_VERSION`, `exportBankBundle(vault)`,
  `importBankBundle(vault, bundle, { mode })`, per-entry guards.
- `src/core/brain/notes/create-note.ts` - `CreateNoteInput`, `CreateNoteResult`,
  `createNote(vault, input)`, typed `CreateNoteError`.
- `src/core/brain/sdk.ts` - `createBrain(vault)` façade + its return type.

New / modified surfaces:
- `src/cli/brain/verbs/bank-export.ts`, `src/cli/brain/verbs/bank-import.ts` -
  new CLI verbs; registered in the brain verb dispatcher.
- `src/mcp/brain/notes-tools.ts` (or an addition to `feedback-tools.ts`) -
  `brain_create_note` tool definition + handler; registered in the tools array,
  `registry-guard.ts`, and `profiles.ts`.

Modified docs / manifests:
- `README.md`, `CHANGELOG.md` (one new version entry + link-ref).
- `package.json` version bump + `bun run scripts/sync-version.ts` (inside this PR
  per `CLAUDE.md`).

Tests (TDD, one suite per unit):
- `tests/core/brain/portability/page-contract.test.ts`
- `tests/core/brain/portability/bundle.test.ts`
- `tests/core/brain/notes/create-note.test.ts`
- `tests/core/brain/sdk.test.ts`
- `tests/mcp/brain-create-note.test.ts`
- CLI verb coverage for `bank-export` / `bank-import` following the existing
  graph-export/graph-import test pattern.

## Risks and open questions

- **Preference restore semantics.** Restoring preferences must reuse the
  existing preference writer and respect the chosen conflict mode; resolve the
  exact writer + idempotency contract during Task 3 (verify `writePreference`'s
  overwrite behaviour before wiring). If a clean reusable writer does not exist,
  scope preference *restore* out of import (still exported) rather than forking
  a parallel writer - and say so in the result object.
- **Registry-completeness tests.** Adding an MCP tool likely trips a
  registry/profile completeness test; update `registry-guard.ts` and
  `profiles.ts` in the same task so the suite stays green.
- **Sources dashboard in the bundle.** Carried as informational metadata only;
  the import result names it as not-restored so the bundle cannot be read as a
  full round-trip of signals.
