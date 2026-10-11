# Recall quality wave - implementation plan

Executed by the implement node with PARALLEL LANES. The substrate lands first (serial); lanes A-E then run concurrently over disjoint files; the integrator finishes. Every task is atomic and commit-sized.

## Cross-lane contract

### (a) Substrate signatures - land FIRST, every lane codes against the landed code

Lane A, B (and the integrator) code against exactly this surface, landed by S1/S2 as behavior-identical code. Nothing else may redefine it.

```ts
// src/core/brain/entities/canonical.ts (S1)
export type EntityLabelInvalidReason =
  | "empty" | "too-long" | "no-letter-or-digit" | "denylisted"
  | "shouted-heading" | "function-word-run";

export interface EntityLexiconHandle {
  readonly caseful: boolean;            // false for caseless-script corpora
  isCommonWord(token: string): boolean; // store-learned; consulted for caseful scripts only
}

export interface ValidateEntityLabelOptions {
  denylist?: ReadonlySet<string>;
  lexicon?: EntityLexiconHandle | null; // null/absent => byte-identical to v1.79.0 behavior
}
// EntityLabelValidation stays { valid: boolean; reason?: EntityLabelInvalidReason }.
```

Pinned predicate rules (inside `canonical.ts`, pure): labels with a structural code shape (contains `_`, `.`, `/`, any digit, or internal uppercase) bypass `shouted-heading` and `function-word-run` but keep `empty`/`too-long`/`no-letter-or-digit`/`denylisted`; case-based verdicts run only for caseful labels (some letter where `l !== l.toLowerCase()`); caseless labels admit on the structural gate alone. The hard-at-create vs advisory-heal policy split lives in the callers, not the predicate (see A2/A3).

```ts
// src/core/brain/derived-artifact.ts (S2) - the co-occurrence/tuning convention, extracted once
export interface DerivedArtifact {
  schema: string;       // "o2b.<name>.vN"
  generated_at: string; // ISO instant
  dataset_hash: string; // sha256 over the sorted input-set signature
}
export function deriveDatasetHash(parts: readonly string[]): string;
export function writeDerivedArtifact<T extends DerivedArtifact>(
  vaultDir: string, relPath: string, artifact: T,
): void; // atomic write, vault-identity guarded
export function readDerivedArtifact<T extends DerivedArtifact>(
  vaultDir: string, relPath: string, expectedSchema: string, datasetHash: string,
): T | null; // null on missing file, torn JSON, schema mismatch, or dataset-hash expiry (fail-open)
```

Option-type growth owned exclusively by the lane that lands it - no other lane touches these:

- `SearchOptions` (src/core/search/types.ts) kind/attributes growth - owned by LANE C (`kind?: "page" | "section"`, promoted-key property pushdown semantics, query-cache key inputs).
- `brain_recall_telemetry` operation union (`list | summary | gate_list | gate_summary | observed_reuse | cost`) - owned by LANE D (grows `dead_weight` in `src/mcp/brain/recall-tools.ts` op union + tool schema enum + `src/cli/brain/verbs/recall-telemetry.ts` dispatch).

### (b) Per-lane disjoint file ownership - overlap forbidden

Every file is owned by exactly one lane; the only shared files are the APPEND-ONLY registration files below. If two lanes must touch the same non-shared file, stop and escalate - do not coordinate silently.

- Substrate: `src/core/brain/entities/canonical.ts`, `tests/core/brain/entities.canonical.test.ts`, `src/core/brain/derived-artifact.ts`, `tests/core/brain/derived-artifact.test.ts`
- Lane A: `src/core/brain/entities/lexicon.ts`, `tests/core/brain/entities.lexicon.test.ts`, `src/core/brain/entities/registry.ts`, `tests/core/brain/entities.registry.test.ts`, `src/core/brain/entities/label-hygiene.ts`, `tests/core/brain/entities.label-hygiene.test.ts`, `src/core/brain/doctor/entity-checks.ts`, `tests/core/brain/entities/doctor.entities.test.ts`, `src/core/brain/fact-extract.ts`, `src/core/brain/atomic-facts.ts`, `tests/core/brain/atomic-facts.test.ts`, `src/cli/brain/verbs/entity.ts`, `tests/cli/brain-entity.test.ts`
- Lane B: `src/core/brain/link-graph/session-mining.ts`, `src/core/brain/link-graph/hallways.ts`, `tests/core/brain/link-graph/session-mining.test.ts`, `tests/core/brain/link-graph/hallways.test.ts`, `src/cli/brain/verbs/hallways.ts`, `tests/cli/brain-hallways.test.ts`, `src/core/brain/continuity/types.ts`, `tests/core/brain/continuity/record-envelope.test.ts`, `src/core/brain/sessions/import.ts`, sessions import tests under `tests/core/brain/sessions/`
- Lane C: `src/core/search/schema.ts`, `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/store/documents.ts`, `src/core/search/store/chunks.ts`, `src/core/search/search.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/core/search/query-cache.ts`, `src/core/search/pipeline/pool-filters.ts`, `src/core/search/result-filters.ts`, `src/mcp/search-tools.ts`, `src/cli/search/verbs/query.ts`, `tests/core/search/prefix-pushdown.test.ts`, `tests/core/search/schema-v14.test.ts`, `tests/core/search/kind-attributes-pushdown.test.ts`, `tests/core/search/hydration-two-tier.test.ts`
- Lane D: `src/core/search/benchmark.ts`, `tests/core/search/benchmark-lang.test.ts`, `tests/core/search/recall-benchmark-zh.test.ts`, `tests/fixtures/recall-benchmark-zh/`, `src/cli/search/verbs/rerank-eval.ts`, `src/core/brain/dead-weight.ts`, `tests/core/brain/dead-weight.test.ts`, `src/mcp/brain/recall-tools.ts`, `src/cli/brain/verbs/recall-telemetry.ts`, `tests/cli/brain-recall-telemetry.test.ts`, `src/core/vault-scope/index.ts` (additive accessor only if measured necessary). `tests/core/search/recall-benchmark.test.ts` and `tests/fixtures/recall-benchmark/` are FROZEN for this wave.
- Lane E: `src/core/brain/permissions/resolve.ts`, `src/core/brain/permissions/document.ts`, `src/core/brain/intake/extract-intake.ts`, `src/core/brain/source-cleanup.ts`, `src/mcp/brain/ingest-tools.ts`, `src/core/brain/doctor/store-integrity.ts`, `src/core/install/ownership-measure.ts`, `src/cli/brain/verbs/secret.ts`, `tests/core/brain/permissions-target-canonicalization.test.ts`, `tests/core/brain/intake-stage-disposition.test.ts`, `tests/core/brain/delete-by-source-deny.test.ts`, `tests/core/install/ownership-research-pool.test.ts`, `tests/cli/secret-unlock-nudge.test.ts`, `tests/core/brain/bundle-wildcard-warning.test.ts`
- Integrator: `README.md`, docs pages, `CHANGELOG.md`, `package.json` + manifests synced by `scripts/sync-version.ts`, census registration fixes.
- APPEND-ONLY shared (each lane appends only its own entries; ratchet tests are the arbiter; the integrator reconciles): `src/cli/command-manifest.ts`, `src/cli/brain.ts` (dispatcher cases), `src/cli/brain/help-text.ts`, census registries (`VISIBILITY_SURFACE_REGISTRY`, write-site/egress/vault-path/origin-channel/append-shard/progress registries).

### (c) Dependency-wait rule

Lanes A and B wait on the substrate; C, D, E wait on nothing. A waiting lane starts by writing its failing tests against the pinned signatures (they fail on the missing surface, which is the expected failure), then polls `git log -- <upstream file>` every 30 s for up to 12 min; if the upstream commit has not landed after 30 min of waiting total, escalate to the orchestrator instead of inventing the surface.

### (d) House rules

- Strict TDD: write the failing test first, run it, and watch it fail with the expected error before implementing. Refactor only with all tests green.
- Commit each atomic unit as its own conventional commit (`feat(search): ...`, `fix(permissions): ...`); never bundle two tasks.
- Stage files BY NAME - never `git add -A` or `git add .`. Commit with `git commit --only <paths>`.
- Format and lint your own files before EVERY commit; a green formatter + linter is a commit precondition, not end-of-PR cleanup. If the formatter touches files outside your lane, surface it, do not fold it in.
- Run tests with a throwaway HOME: `env HOME=$(mktemp -d) bun test <paths>`.
- Credential-shaped literals in fixtures come from `tests/helpers/fake-credentials.ts` assembled parts. Never write an identifier containing `secret` directly before a quoted value; never commit a credential-shaped literal.
- chmod-denial tests guard with `test.skipIf(CHMOD_CANNOT_DENY)` from `tests/helpers/platform.ts`.
- Windows path assertions are normalized on both sides (no raw separator comparisons).
- Subprocess-spawning tests get explicit 20000 ms budgets.
- Order-dependent assertions use sorted listings.
- Census counts reconcile BY MEASUREMENT - never weaken an assertion to make a count fit.
- No new MCP tool: the tool-count pin 115 (`tests/core/install/tool-ceiling.test.ts`) must not move; operations on existing tools are fine.
- Committed artifacts are English; detection and verdict logic contains no hardcoded natural-language word lists or phrases (the standing house invariant - learned or operator-supplied vocabularies only).
- All house rules apply on the branch `feat/recall-quality` only; never touch the project root checkout or another branch. Never commit `.reviews/` (untracked operator scratch).

## Lanes and tasks

### Substrate (serial, lands first; behavior-identical)

#### Task S1: Admission-predicate extension in the leaf kernel
- **Files**: `src/core/brain/entities/canonical.ts`, `tests/core/brain/entities.canonical.test.ts`
- **Acceptance**: `entities.canonical.test.ts` adds the verdict-matrix rows for `shouted-heading` and `function-word-run`, the code-shape bypass, the caseful-only case rule, and caseless-script admit - plus a byte-identity test proving every v1.79.0 verdict is unchanged when `lexicon` is null/absent. Import-cycle ratchet stays green (canonical.ts still imports nothing).
- **Depends on**: none

#### Task S2: Shared derived-artifact IO helper
- **Files**: `src/core/brain/derived-artifact.ts`, `tests/core/brain/derived-artifact.test.ts`
- **Acceptance**: `derived-artifact.test.ts` proves round-trip write/read, torn JSON -> null, schema mismatch -> null, dataset-hash expiry -> null (fail-open), atomic write, and vault-identity guard - mirroring the tuning-store test family. No existing module changes behavior (extraction only; co-occurrence/tuning keep their own code this wave).
- **Depends on**: none

### Lane A - admission + lexicon (t_11d51443)

#### Task A1: Store-learned lexicon module
- **Files**: `src/core/brain/entities/lexicon.ts`, `tests/core/brain/entities.lexicon.test.ts`
- **Acceptance**: `entities.lexicon.test.ts` proves the statistics fold over a corpus walk (`listVaultPages` at `MAINTENANCE_LANE_REACH`, Brain-root excluded, session transcripts excluded - scope asserted in the artifact header), `writeEntityLexicon`/`loadEntityLexicon` on the S2 helper with `o2b.entity-lexicon.v1` + dataset hash, fail-open on a torn/stale artifact (mirroring the tuning-store test), top-K cap, and `resolveEntityLexicon` returning the pinned `EntityLexiconHandle`.
- **Depends on**: S1, S2

#### Task A2: Creation gate + anchoring wiring
- **Files**: `src/core/brain/entities/registry.ts`, `src/core/brain/fact-extract.ts`, `src/core/brain/atomic-facts.ts`, `tests/core/brain/entities.registry.test.ts`, `tests/core/brain/atomic-facts.test.ts`
- **Acceptance**: `entities.registry.test.ts` proves `upsertEntity` resolves the lexicon beside the denylist and applies the tightened verdicts on the CREATE arm only (single-token `function-word-run` and multi-token prior-occurrence-free `shouted-heading` refuse with the new reasons; a single-token shout is a brand/acronym and stays advisory per design.md; the update arm is unaffected; a code-shaped label such as `foo_bar`/`FTS5` still admits). `atomic-facts.test.ts` proves `buildAnchorables`/`anchorEntityForms` skip junk forms while valid aliases still anchor.
- **Depends on**: S1, A1

#### Task A3: Store-wide heal wiring
- **Files**: `src/core/brain/entities/label-hygiene.ts`, `src/core/brain/doctor/entity-checks.ts`, `tests/core/brain/entities.label-hygiene.test.ts`, `tests/core/brain/entities/doctor.entities.test.ts`
- **Acceptance**: `entities.label-hygiene.test.ts` proves `findMalformedEntityLabels` resolves the handle and reports the new reasons (multi-token runs advisory), and the prune path (dry-run default, snapshot-gated) flows them through unchanged; `doctor.entities.test.ts` proves the doctor surfaces them under `entity-label-malformed` with the existing `o2b brain entity prune` remedy. No new repair command.
- **Depends on**: S1, A1

#### Task A4: Lexicon rebuild verb
- **Files**: `src/cli/brain/verbs/entity.ts`, `tests/cli/brain-entity.test.ts`, append-only `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`
- **Acceptance**: `o2b brain entity lexicon rebuild` writes only the derived artifact (dry-run report by default, no `--confirm` needed for a derived write); `brain-entity.test.ts` covers the verb; `manifest-completeness` ratchet stays green.
- **Depends on**: A1

### Lane B - miner + hallways (t_13a82a31)

#### Task B1: Session-mining ledger in the import loop
- **Files**: `src/core/brain/link-graph/session-mining.ts`, `src/core/brain/continuity/types.ts`, `src/core/brain/sessions/import.ts`, `tests/core/brain/link-graph/session-mining.test.ts`, `tests/core/brain/continuity/record-envelope.test.ts`, sessions tests under `tests/core/brain/sessions/`
- **Acceptance**: `session-mining.test.ts` proves the precision detector families (`symbol` from code spans/fences and qualified-identifier shapes, `url` reusing fact-extract patterns, `path` in both slash directions, `qualified-ident`), family-scoped case-preserving side keys (NFC + trim only - never `normalizeEntityName`), secret-shaped-token refusal (credential URLs, token/key query forms), and dedupe at `(family, key, sessionRef)` granularity. `record-envelope.test.ts` covers the additive continuity record kind (no schema bump); sessions tests prove capture-boundary and private-turn withholding are respected and import counters stay never-silent.
- **Depends on**: none

#### Task B2: Hallways pass + artifact
- **Files**: `src/core/brain/link-graph/hallways.ts`, `tests/core/brain/link-graph/hallways.test.ts`
- **Acceptance**: `hallways.test.ts` proves entity->session incidence and pairwise PMI (co-occurrence's math) over the ledger, `Brain/link-graph/hallways.json` written through the S2 helper (`o2b.hallways.v1`, dataset-hashed, fail-soft read), a reviewable proposals file with dismissals (bridges pattern), and separation from the vault-derived co-occurrence graph (no shared artifact, no merge).
- **Depends on**: B1, S2

#### Task B3: Hallways CLI + thresholded promotion
- **Files**: `src/cli/brain/verbs/hallways.ts`, `tests/cli/brain-hallways.test.ts`, append-only `src/cli/brain.ts`, `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`
- **Acceptance**: `brain-hallways.test.ts` covers `mine|show|promote|dismiss`; promotion is offered only for keys seen in >= N distinct sessions and flows through `upsertEntity`/`relateEntities` exclusively - a test proves a promoted label failing the tightened gate is refused by the admission path (the pinned coupling), and that ambient auto-write never happens without the promote step. Manifest and visibility-surface ratchets stay green.
- **Depends on**: B2, S1

### Lane C - store v14 migration (t_71cbf5bf + t_82851eda)

#### Task C1: Sargable path range predicates
- **Files**: `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/store/documents.ts`, `tests/core/search/prefix-pushdown.test.ts`
- **Acceptance**: `prefix-pushdown.test.ts` proves `keywordTopK`, `semanticTopK`, `countDocumentsUnderPrefix` (and the pending-vector census sharing the `substr` form) use `d.path >= ?1 AND d.path < ?2` with `?2 = prefix || U+FFFF`, that the caller prefix passes through `canonicalNotePath` (a win32 backslash prefix now matches), that `assertSafePathPrefix` refusals are unchanged, and that results are byte-identical to the `substr` form on fixture stores.
- **Depends on**: none

#### Task C2: v14 migration - kind column, taxonomy indexes, attributes table
- **Files**: `src/core/search/schema.ts`, `tests/core/search/schema-v14.test.ts`
- **Acceptance**: `schema-v14.test.ts` proves the v14 entry appends to `MIGRATIONS` and runs inside the single open transaction; `chunk_kind` is a VIRTUAL generated column (`page` for `chunk_index = 0`, else `section`) with `idx_chunks_kind`; `idx_documents_page_type` exists; `document_attributes(document_id, key, value)` is created and backfilled from chunk 0 (v12 recipe) with promoted keys (`type`, `tags`, `pinned`, `visibility`, `aliases`) skipped and bounds enforced (64 keys/doc, 16 values/key, 256 bytes/value - overflow decrements, never fails); `embeddings`, `chunk_vec`, `chunk_vec_map` compare byte-identical before/after; the expected-schema gap check self-derives green; refusal above LATEST still names `o2b search reindex`.
- **Depends on**: none (in-lane order after C1)

#### Task C3: Indexer attribute writes
- **Files**: `src/core/search/indexer.ts`, `src/core/search/store/documents.ts`, `tests/core/search/schema-v14.test.ts` (extended)
- **Acceptance**: upsert writes attributes computed from the already-parsed frontmatter (same parse that feeds `fmNotices`, so degradation notices are untouched); the content_hash fastpath skips unchanged documents exactly as today; a schema-v14 extension test proves freshen/update/delete keep the side table consistent and bounded.
- **Depends on**: C2

#### Task C4: Kind + promoted-key pushdown on the query path
- **Files**: `src/core/search/types.ts`, `src/core/search/query-cache.ts`, `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/pipeline/pool-filters.ts`, `src/core/search/result-filters.ts`, `src/mcp/search-tools.ts`, `src/cli/search/verbs/query.ts`, `tests/core/search/kind-attributes-pushdown.test.ts`
- **Acceptance**: `kind-attributes-pushdown.test.ts` proves: `kind` pushdown on the keyword lane (WHERE before ORDER BY/LIMIT) and the semantic lane (post-KNN filter inside the 4x overfetch); promoted keys (`type`, `tags`, `pinned`, `visibility`) pushed as SQL equality/EXISTS with normalized values (`type` via `normalizeSchemaToken`; attributes stored as `String(value)` scalar form preserving `matchesAny` semantics); mixed filter maps push the promoted half and keep the rest post-rank with `canDropRows` overfetch preserved; absent filters leave the SQL byte-identical (defaults test); the query-cache key grows for `kind`. MCP `kind` argument and CLI `--kind` surface covered; existing lane-output tests stay green.
- **Depends on**: C2, C3

#### Task C5: Two-tier hydration cut
- **Files**: `src/core/search/store/chunks.ts`, `src/core/search/search.ts`, `tests/core/search/hydration-two-tier.test.ts`
- **Acceptance**: `hydration-two-tier.test.ts` proves the pool hydrates metadata-only (no `c.content`) and content hydrates for the rankCap ids after `assembleRankedResults`; final results (content, scores, order) are byte-identical on fixture stores; peak-hydration row count asserted against the rankCap, not the pool.
- **Depends on**: C4 (single writer on `search.ts` at a time)

### Lane D - eval + dead weight (t_693fa22a + t_1ee67e5b)

#### Task D1: Language field + per-language report split
- **Files**: `src/core/search/benchmark.ts`, `src/cli/search/verbs/rerank-eval.ts`, `tests/core/search/benchmark-lang.test.ts`
- **Acceptance**: `benchmark-lang.test.ts` proves `lang?: string` validates like `answer` (non-empty string when present, default "en"), `byLang` aggregates fold from `perQuery` with the same reduce as the overall report, and `rerank-eval` renders the split. Report change is additive (return value, not a record).
- **Depends on**: none

#### Task D2: Bundled ZH fixture + offline CI gate
- **Files**: `tests/fixtures/recall-benchmark-zh/` (self-authored ZH vault + ~12 queries, 2-3 with `answer`), `tests/core/search/recall-benchmark-zh.test.ts`
- **Acceptance**: the new gate runs `runRerankEvalGate` for the ZH set on the offline stack (local provider + bundled jieba/tiny-segmenter FTS) with ZH pins measured on the first run then frozen; `tests/core/search/recall-benchmark.test.ts` and `tests/fixtures/recall-benchmark/` are byte-untouched (EN denominators preserved).
- **Depends on**: D1

#### Task D3: Dead-weight fold
- **Files**: `src/core/brain/dead-weight.ts`, `src/core/vault-scope/index.ts` (additive included-paths accessor only if measurement shows one is needed), `tests/core/brain/dead-weight.test.ts`
- **Acceptance**: `dead-weight.test.ts` proves the complement math: full set = `walkVaultScope` included paths, retrieved set = union of `recall_telemetry` `top_artifacts` paths + `recall_observed_use` sourceRefs paths; vanished (deleted-but-indexed) pages are never reported; the window states the earliest matching record `createdAt`; the report is a read-only deterministic fold (no emit).
- **Depends on**: none

#### Task D4: dead_weight surfaces with CLI parity
- **Files**: `src/mcp/brain/recall-tools.ts`, `src/cli/brain/verbs/recall-telemetry.ts`, `tests/cli/brain-recall-telemetry.test.ts`
- **Acceptance**: `brain-recall-telemetry.test.ts` covers the `dead_weight` op (union grows to seven) following the `observed_reuse` envelope (`{vault_path, window, pages_total, pages_retrieved, dead_count, dead (capped), gate_caveat}`), with `since`/`until` args honored; remote-reach filtering drops hidden rows before `total` (`requestRefView`/`gatedOwnerScopeView`); CLI subcommand parity; tool-ceiling pin stays 115.
- **Depends on**: D3

### Lane E - repairs (files disjoint from every feature lane)

#### Task E1: Canonicalize target-scoped permission rules (PR #247 M5)
- **Files**: `src/core/brain/permissions/resolve.ts`, `src/core/brain/permissions/document.ts`, `tests/core/brain/permissions-target-canonicalization.test.ts`
- **Acceptance**: the new test proves a rule target written with `.\` or backslash separators (`Notes\a.md`) matches a stored POSIX path (`Notes/a.md`) via `canonicalNotePath` normalization on both sides, and an unnormalized target in the permissions document draws a warning; existing permission tests stay green.
- **Depends on**: none

#### Task E2: Ingest `stage` verdict stages entity pages and manifest row (PR #247 M4 residual)
- **Files**: `src/core/brain/intake/extract-intake.ts`, `tests/core/brain/intake-stage-disposition.test.ts`
- **Acceptance**: the new test proves that on a `stage` disposition the entity pages and the manifest row are staged into review (`Brain/pending/`) rather than published - only the deny arm publishes nothing, and the docblock states the disposition contract; the deny-before-any-write behavior is pinned regression-free.
- **Depends on**: none

#### Task E3: Deny-consulted evidence for delete_by_source and schema mutations (PR #247 M3 residual)
- **Files**: `src/core/brain/source-cleanup.ts`, `src/mcp/brain/ingest-tools.ts`, `src/core/brain/doctor/store-integrity.ts`, `tests/core/brain/delete-by-source-deny.test.ts`
- **Acceptance**: the new test proves `delete_by_source` and the ingest-tools schema-mutation lanes resolve the document against the credential subject and refuse on `deny` (same `refuseDocumentDeny` discipline as update/append), and the store-integrity doctor reports the covered lanes; the CHANGELOG claim wording ("update or append") is corrected via the integrator's 1.80.0 entry.
- **Depends on**: none

#### Task E4: Wire the research-pool use site to the vault config (PR #244 M10/L1)
- **Files**: `src/core/install/ownership-measure.ts`, `tests/core/install/ownership-research-pool.test.ts`
- **Acceptance**: the new test proves `resolveResearchPoolEnv` receives the vault-resolved configuration (not raw `process.env` alone), so a raw `$secret:` string no longer counts as a configured research key in doctor, and the refusal names the unresolved reference - making the v1.78.0 claim true on the live path.
- **Depends on**: none

#### Task E5: Custody-flow documentation (PR #244 M4 + L7)
- **Files**: `src/cli/brain/verbs/secret.ts`, docs page for the ingest manifest (rollback note), `tests/cli/secret-unlock-nudge.test.ts`
- **Acceptance**: the new test proves the unlock flow prints an export-before-wrap/unlock nudge; docs state that the content-manifest schema move is one-way for older binaries (schema 3 rollback note). CHANGELOG wording rides the integrator's 1.80.0 entry.
- **Depends on**: none

#### Task E6: Bundle import wildcard-allowlist warning (PR #244 L2)
- **Files**: `src/mcp/brain/ingest-tools.ts` (bundle import warning surface) or the bundle import CLI path it shares - measured and kept within lane E's disjoint set, `tests/core/brain/bundle-wildcard-warning.test.ts`
- **Acceptance**: the new test proves importing a bundle whose allowlist contains `*` emits a named warning (AAD still refuses tampering); no behavior change for non-wildcard allowlists.
- **Depends on**: none

### Integrator

#### Task I1: Census reconciliation
- **Files**: append-only registration files (`src/cli/command-manifest.ts`, census registries) wherever lane appends left drift; measured-count fixes in tests
- **Acceptance**: the full census family is green by measurement: `manifest-completeness`, `visibility-surface`, `progress-census`, `write-site-census`, `egress-census`, `vault-path-census`, `origin-channel-census`, `append-shard-census`, `entity-read-census`, `tool-ceiling` (115 unchanged), import-cycle ratchet. No assertion weakened; counts reconciled by measurement.
- **Depends on**: S1-S2, A1-A4, B1-B3, C1-C5, D1-D4, E1-E6

#### Task I2: Docs and README
- **Files**: `README.md`, affected docs pages, repair-lane CHANGELOG claim wording (folded for I3)
- **Acceptance**: docs describe the new user-visible surfaces (hallways, entity lexicon rebuild, kind/property pushdown semantics including the as-indexed vs as-on-disk divergence, rerank-eval language split, dead-weight view); links resolve; English throughout.
- **Depends on**: I1

#### Task I3: Version bump + CHANGELOG + full local gate
- **Files**: `package.json`, manifests via `bun run scripts/sync-version.ts`, `CHANGELOG.md`
- **Acceptance**: `CHANGELOG.md` gains the `## [1.80.0] - <date>` entry and its compare link reference; version is 1.80.0 with `sync-version.ts --check` green - all inside this PR before any push; the CI `validate` job's gates pass locally in CI order (Bun 1.4.0, Python 3.11). Windows job is left to CI.
- **Depends on**: I2
