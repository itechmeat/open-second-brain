You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release of Open Second Brain composed of nine units. Reconnaissance against the real source has already been done and is summarised below as fact, not conjecture; do not re-litigate whether these findings are true.

The nine units share one property, which is the release's argument: in every case the capability already exists in the codebase, exported and working, and the defect is that nothing calls it.

**A1 - the third write path has no trust classification.**
`src/core/brain/distill/distill-source.ts` writes claims from a caller-supplied `source_path` under `provenance: stated` (the top authority tier) and performs no trust classification. `classifySourceOrigin` and `normalizeSourceIdentity` are exported from `src/core/brain/intake/source-trust.ts` for exactly this reuse and the other two write paths (`brain_intake_entities`, `brain_ingest_source`) both call them. Additionally: `join(vault, canonicalNotePath(sourcePath))` at `:161` passes through no shape gate, so `../../etc/passwd` is stat-ed and hashed, making the tool an existence oracle and leaking a raw errno through the MCP boundary; and a source with no bytes records the literal string `"missing"` as its hash and proceeds.

**B1 - the destructive-operation gate is called by 2 of about 25 destructive operations.**
`src/core/brain/snapshot-gate.ts` exports `withDestructiveSnapshot(vault, reason, op)` and its header states the guarantee: "no destructive brain mutation runs without a recovery point on disk first." Exactly two call sites use it (`source-cleanup.ts:591`, `entities/label-hygiene.ts:222`). The dream pass takes its own inline `createSnapshot` instead, which that same header names as the anti-pattern. `restoreSnapshot` (`o2b brain rollback`) deletes every live top-level entry under `Brain/` and takes no snapshot of the pre-rollback state. `pruneSnapshots` destroys recovery points automatically on every snapshot and every dream, with no gate, and its own comment calls it "the most destructive operation in the module". `deleteBySource --include-originals` deletes files outside `Brain/`, which no snapshot ever covers, while still reporting a snapshot path. The gate throws untyped `Error`; there is no way to express "recoverability could not be proved" as data. `BRAIN_SNAPSHOT_REASON.manual` is declared and has no producer.

**B2 - no note-file lifecycle verbs exist.**
`brain_create_note` / `brain_update_note` / `brain_append_note` exist; there is no rename, move, delete, or archive on any surface. The primitives all exist: `resolveNoteTarget` (the nine-step path envelope), `withDestructiveSnapshot`, `patchWikilinks` (inbound `[[link]]` rewriting, currently Brain-scoped and id-keyed), `store.deleteDocument(path)`, and the `noteWriteResult` lint envelope. Complication: the backlink index is Brain-only and the vault-wide `links` table is only as fresh as the last index pass, so a rename cannot honestly claim it fixed every inbound reference.

**B3 - the dangling-link loop is never closed.**
`repair-lane.ts:236-239` decides `skip-missing-target` when a link target file does not exist. `deep-synthesis.ts:706` emits the advice string "Write the missing note or fix the dangling link". The doctor emits `broken-backlinks` with structured `target` + `sources[]`. `renderStub` already exists in `portability/graph.ts:162`. Nothing materialises a target. The search index reports dangling links as a COUNT only; no `listDangling()` query exists, though the resolution SQL is already factored for reuse.

**C1 - five of six export paths never call the redactor.**
`src/core/redactor.ts` is a mature structural redactor (credential field identifiers, vendor key prefixes, a pure character-class high-entropy detector, infra topology, fail-closed truncation over 1 MiB) with 18 importers and no natural-language word list. Of the six paths that write vault content outside the vault - `bank-export`, `graph-export`, `okf-export`, `brain export`, `export-config`, `continuity export` - only `continuity export` redacts. `export-config` uses a weaker private copy in `config.ts:1133` that matches five substrings against key NAMES and never inspects a value. A third copy lives in `cli/json-helpers.ts:1-3`. `bank-export` is the widest: it composes preferences, the page graph, page contracts and the sources dashboard into one file.

**D1 - the ranker has the authoring instant in hand and ranks on storage mtime.**
`ranker.ts:502` calls `recencyBoost(c.mtime, ...)`. Nine lines later, `ranker.ts:597` reads `hyd.authoredAt` off the same hydrated record for a tie-break. Both are unix seconds. A batch of historical conversations imported today therefore all receive maximum freshness. `representativeChunks` does not project `authored_at`, so link-expansion candidates would still fall back. `authored_at` is stamped only by session import and the inbox backfill, so for other ingestion paths the column is NULL.

**D2 - the consolidation pass compares raw strings where the read path canonicalises.**
`normalizeEntityName` (NFC, trim, whitespace collapse, lowercase, quote fold) is exported from `entities/canonical.ts:67` and the search path uses it (`search/entity-alias.ts:32`). The dream pass clusters by byte equality on the raw topic string (`dream-plan-topics.ts:59-66`). Note: the originating task claimed the dream pass issues sub-recalls that should resolve aliases; it does not - `dream()` is synchronous and imports no search module. The real asymmetry is the clustering key.

**E1 - the live provider probe runs and its answer is discarded into a warning.**
`indexer.ts:1371-1391` already runs `withTimeout(provider.ping(), 5_000)` on every `o2b search check` with a resolved key. The result becomes a `warnings` entry, never `fatal`, so the verb exits 0 over a provider proved unreachable and a script gating on the exit code reads it as healthy. `o2b doctor` has no such check and structurally cannot host one: `DoctorCheck.run` is synchronous.

**E2 - the bundle carries preferences and the import counts them.**
`exportBankBundle` composes preferences, graph, page contracts and sources. `importBankBundle` restores only the graph and reports `preferencesCarried` as a number. The docblock states this is deliberate because "preferences have a delicate confidence/audit lifecycle". `writePreferenceTxn` is the audited chokepoint for every preference write (lock, re-read inside the lock, expectations chain, revision bump, audit trail) and nothing in `portability/` imports it. `BANK_BUNDLE_SCHEMA_VERSION` is `"1"` and a mismatch is a hard refusal with no migration path.

# Project context

Open Second Brain: a local-first agent memory system. TypeScript on Bun, about 850 modules under `src/`, 1030+ test files, plus a Python plugin under `plugins/hermes/`. Surfaces: an MCP server (108 tools), an `o2b` CLI, and an OpenClaw bundle.

Recent commits on the default branch:

```
a6d10dab feat: evidence at the boundary (v1.46.0) (#162)
29ea0099 fix: the flush that never landed (v1.45.1) (#158)
8d05a62a feat: silence is not an answer (v1.45.0) (#159)
d22b3bd8 feat(vault-scope): state what is indexed instead of enumerating what is not
7f3b35cc feat(search): a result that can say why it is empty
99e004c4 feat(brain): a write says what is wrong with what it wrote
a1f3b69f feat(mcp): a catalog that documents itself, and an argument that is answered
6caf0b83 fix: what four independent reviewers found in this branch
```

Related files: `src/core/brain/snapshot-gate.ts`, `src/core/brain/snapshot.ts`, `src/core/brain/count-guard.ts`, `src/core/brain/intake/source-trust.ts`, `src/core/brain/distill/distill-source.ts`, `src/core/redactor.ts`, `src/core/search/ranker.ts`, `src/core/brain/link-graph/repair-lane.ts`, `src/core/brain/notes/create-note.ts`, `src/mcp/brain/notes-tools.ts`, `src/core/brain/portability/bundle.ts`, `src/core/brain/preference-txn.ts`, `src/core/brain/dream-plan-topics.ts`.

Conventions that constrain any design:

- **Closed vocabularies are a four-piece idiom**, enforced by a census test: a frozen object with camelCase keys and snake_case values, a derived union type, a members array, and a type guard whose parameter is `unknown`. Anything whose values leave TypeScript (an MCP schema enum, a JSON payload, a persisted sidecar) must be registered.
- **Confirmation is a ladder that already exists**, and its strength scales with irreversibility: dry-run by default, then `--apply`, then `--yes` in non-interactive mode, then an exact confirmation phrase (`REPAIR_CONFIRM_PHRASE = "apply repair"`), plus an orthogonal `--expect N` / `--strict` blast-radius count guard. A refusal that is overridden is recorded in the log with the override flagged.
- **Policy decisions return frozen verdict objects with a token array, and do not throw.** Gates evaluate independently and accumulate, so several failures surface together. Reasons are sorted for byte-stable traces.
- Architecture census tests enforce: acyclic imports (`import type` counts as an edge, `await import()` does not), declared raw `fs` write sites, vault-identity assertion on every write-capable Brain module, every doctor code registered or excluded with an 80-character reason, CLI help-surface parity, and version sync across seven manifests.
- Every test file opens with a docblock stating the defect that motivated it and what it deliberately does not cover.

Constraints:

- No stubs and no placeholder implementations of any kind.
- No fallback that silently does nothing or produces a misleading success. When something fails, the failure must be named and surfaced. A verdict that cannot be reached must say so rather than defaulting to the benign answer.
- No hardcoded natural-language word lists in any language. Classification must be structural, or driven by declared frontmatter, or by corpus statistics.
- The vault has no git transport and nothing may place a `.git` directory inside the replicated tree; replication is Syncthing.
- Do not change existing public MCP tool names; the surface is frozen and parity-tested.
- No new external runtime dependencies.
- Byte-identical output when a new feature is absent or inactive is the expected standard, and it is measured rather than asserted.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
