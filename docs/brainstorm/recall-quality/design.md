# Recall quality wave - admission, session hallways, store filter pushdown, bilingual eval and dead-weight telemetry

**Status:** draft
**Author:** osb-feature-release orchestrator, design node (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Six verified cards in the recall-quality wave share one defect family: recall quality is bounded by what enters the graph and by what the store can filter, not by how results are ranked. Junk labels pass the structural-only entity admission gate; session-mined precision signals (code symbols, URLs, paths, qualified identifiers) never reach any link-graph surface; the search store cannot push kind or frontmatter-attribute predicates into SQL (the path prefix predicate is a non-sargable `substr`, property filters run post-rank per-row from the live file, and the whole candidate pool hydrates `content` before ranking); the eval layer has no bilingual dimension and no committed ZH evidence; and recall telemetry has no dead-weight view. A repair lane carries the outstanding operator-review findings from merged PRs #244/#247 so the release ships clean.

## Scope

- t_11d51443 - store-learned entity-label lexicon plus structural shouted-heading rejection, wired through the existing admission choke points and the existing heal triangle (creation gate, store-wide re-admission, doctor, snapshot-gated prune).
- t_13a82a31 - session-mined precision entities as a side continuity ledger, a hallways PMI pass over that ledger, and thresholded promotion into the entity registry; `o2b brain hallways mine|show|promote|dismiss` surface.
- t_71cbf5bf - one v14 store migration: sargable path range predicates, virtual generated `chunks.chunk_kind`, taxonomy indexes, and the two-tier hydration cut.
- t_82851eda - bounded `document_attributes` side table backfilled from chunk 0, with `kind` and promoted-key pushdown exposed on the MCP/CLI query surface.
- t_693fa22a - optional `lang` field on benchmark queries, per-language report split, and a bundled self-authored ZH fixture gated in CI on the offline local-provider stack.
- t_1ee67e5b - `dead_weight` operation on `brain_recall_telemetry` with full CLI parity; `walkVaultScope` denominator, telemetry-window-bounded semantics, reach-gated output.
- Repair lane - six commits covering every outstanding review finding: PR #247 M5 (unnormalized target-scoped rules), M4 residual (ingest `stage` verdict only stages the summary page), M3 residual (`delete_by_source` and schema mutations not evidenced as deny-consulted); PR #244 M10/L1 (research pool use site unwired), M4 + L7 (manifest rollback note and export-before-wrap nudge, shipped as one documentation commit), L2 (bundle allowlist `*` warning).

## Out of scope

- `reextract_claims` - no subject: claims are a deterministic rebuildable view (`claim-graph.ts` projection, `rebuildClaimGraph`); `buildEntityIndex` is already the index-rebuild heal. Dropped per recon R2.
- The "Jev" reranker backend - no new reranker model or provider in this wave; the existing rerank gate and registry are reused as-is.
- Team / multi-tenant analytics - the dead-weight view is per-vault, owner-scoped; no cross-vault or fleet rollups.
- New MCP tools - the tool-count pin of 115 (`tests/core/install/tool-ceiling.test.ts`) must not move; all work rides operations on existing tools and CLI verbs.
- Real-model embedding calls in committed tests - CI ZH pins certify tokenization, indexing and rerank ordering on the deterministic local provider plus bundled jieba/FTS; real multilingual-e5 semantics remain a documented operator lane (`o2b search rerank-eval --kind ...`).
- Managed-block installer / Stop-hook backstop - not part of this wave.

## Chosen approach

Variant 1: pinned-kernel parallel lanes over a shared substrate (consultant recommendation, orchestrator agrees; full text and the losing variants in `variants.md`).

A short serial substrate stage lands the wave's only genuine cross-lane contract as behavior-identical code before peak parallelism: the `ValidateEntityLabelOptions` extension in leaf `canonical.ts` (lexicon handle injected parameter-style exactly like the denylist; new `shouted-heading` / `function-word-run` reasons; structural code-shape bypass; caseful-only case rules with caseless-script admit) plus one derived-artifact IO helper (schema-version + dataset-hash + fail-soft read) that both `Brain/entities/lexicon.json` and `Brain/link-graph/hallways.json` consume. Then five feature lanes run fully in parallel over disjoint file sets - (A) admission + lexicon, (B) session mining + hallways, (C) the single v14 migration closing both store cards, (D) bilingual eval + dead weight, (E) the six-finding repair micro-lane - followed by an integrator pass (census reconciliation, docs, version bump to 1.80.0 with the CHANGELOG entry inside this PR, full local gate).

## Design decisions

1. **Delivery model: Variant 1.** The wave's one semantic coupling - mined promotion flowing through the tightened admission gate - is pinned and landed as behavior-identical substrate code before any feature lane starts, so lanes A and B code against landed predicates, not promises. The riskiest single artifact (the atomic first-open v14 migration) stays isolated in one lane; the repair lane's files genuinely intersect nothing.
2. **t_13a82a31 uses a side continuity ledger + hallways pass + thresholded promotion (recon Variant B), never import-time minting.** `Brain/entities/` is walked (memoized) on every read and is sized for tens to low hundreds of entities; ambient auto-writes of operator-facing pages collide with the ambient-consent and trust-lane posture. The detector runs in the import loop where raw turn text is available (recall-DAG rows may hold externalized placeholders), dedupes at `(family, canonical key, sessionRef)` granularity, and keys provenance on the transcript basename, never the host absolute path.
3. **Link-graph reach asymmetry is named, not resolved.** The co-occurrence pass walks vault pages excluding all of `Brain/`, while communities/bridges run over the search Store, which admits `Brain/**` (except `Brain/state`/`payloads`/`pending`). Hallways therefore feeds a separate session-derived graph: `Brain/link-graph/hallways.json` stays an artifact beside - never merged into - the vault-derived co-occurrence graph (session/vault graph separation), and promotion through `upsertEntity` is the only bridge into the store-backed passes, because graph-holdout lifts recall only where edges are materialized as pages/relations.
4. **t_11d51443 uses the options-injected lexicon handle (recon Variant A).** `canonical.ts` is a leaf module that imports nothing (protected by the import-cycle ratchet), so the lexicon rides `ValidateEntityLabelOptions` exactly like the denylist - a parameter, never an import. The lexicon is store-learned only (`Brain/entities/lexicon.json`, `o2b.entity-lexicon.v1`, dataset-hashed, fail-open on expiry): the "no natural-language word list" invariant is stated in at least four modules, and a stale artifact reads as absent so admission degrades to today's behavior, never mis-rejects. `normalizeEntityName` output is persisted-key-stable; the lexicon changes validity verdicts only, never normalization.
5. **Structural verdict rules are pinned in the predicate:** `shouted-heading` is a pure structural case test - hard only for multi-token, digit-free, caseful labels with no prior stored occurrence, advisory (doctor + prune) otherwise; `function-word-run` fires only for caseful-script labels where every token is common per the handle - hard at creation only for single-token labels, advisory for multi-token runs. Structural code shapes (contains `_`, `.`, `/`, a digit, or internal uppercase) bypass both new verdicts but keep the empty/length/denylist checks - without the bypass the gate would junk-reject exactly the symbols lane B mines. Caseless scripts (Han, kana, Thai): case-based rules are undefined there, so caseless labels admit on the structural gate alone, and the common-word verdict is caseful-script-only, degrading to admit.
6. **Single creation choke point: `upsertEntity`.** All minting converges there (`intakeExtraction` from MCP NER and source-ingest, `assignNoteLabel`, and lane B's promotion), so the tightened gate is applied in one place - on the create arm only - and the store-wide heal rides the existing `findMalformedEntityLabels` -> doctor `entity-label-malformed` -> snapshot-gated dry-run-default `entity prune` triangle with no new repair command. Anchoring boundaries (`buildAnchorables`, `anchorEntityForms`) resolve the handle so junk forms stop anchoring facts. Search's `extractEntities` stays liberal and uncoupled - it is a re-ranking boost, not a node minter.
7. **t_71cbf5bf + t_82851eda close as one v14 migration (recon Variant B).** `applyMigrations` runs all pending migrations inside one `BEGIN`/`COMMIT`, so a large vault pays one longer, crash-safe first-open (single `ROLLBACK` on failure) instead of incremental risk. The migration never rewrites `embeddings`/`chunk_vec`/`chunk_vec_map`: all DDL is documents/chunks-only; `chunk_kind` is a VIRTUAL generated column (metadata-only, instant) - STORED generated columns are explicitly avoided because they would rewrite every row; the attributes backfill is one scan of `chunk_index = 0` rows plus parse (the measured v12 shape). The sargable form is `d.path >= ?1 AND d.path < ?2` with `?2 = prefix || U+FFFF` over POSIX+NFC BINARY-collated paths, with the caller prefix passed through `canonicalNotePath` (which also fixes the latent Windows backslash mismatch).
8. **Promoted keys are excluded from `document_attributes`.** `type`, `tags`, `pinned`, `visibility`, `aliases` already have exactly one writer each in existing structures (`documents.page_type`, the `links` table with `idx_links_target_path`, `pinned`/`visibility` columns, `doc_aliases`); the extractor skips them so no key gains a second source of truth. Pushed-key filtering becomes "as indexed" while fallback keys keep today's live-file semantics - a documented divergence, consistent with everything else search returns (content itself is the indexed snapshot).
9. **t_1ee67e5b "never" is bounded and honest.** Telemetry is opt-in with the gate off by default and only the top-10 surfaced rows per query are recorded, so the report claims "no recorded retrieval surface within telemetry history", states the observation window (earliest matching record `createdAt`) and the gate caveat, and never claims absolute never. The denominator is `walkVaultScope` included paths (current on-disk truth), never the `documents` table (a stale superset would misreport vanished pages as dead weight). At remote reach the path list passes through `requestRefView`/`gatedOwnerScopeView` with hidden rows dropped before `total`, so hidden-row counts do not leak. The operation rides `brain_recall_telemetry` (six-member union grows to seven) with CLI parity, matching every other aggregate on that tool; no new tool, no pin movement.
10. **t_693fa22a ships the ZH evidence as a sibling fixture with its own CI gate.** Adding ZH pages to the existing fixture vault would change the EN denominators and invalidate the pins' measured-history comment, so `tests/fixtures/recall-benchmark-zh/` (self-authored, licence-clean, mirroring the EN set's shape) gets its own gate on the offline stack (local feature-hashing embedder + bundled jieba/tiny-segmenter FTS expansion). ZH pin thresholds are measured on first run, then frozen - the census-by-measurement rule applies to pins too.

## File changes

Substrate (serial, first):
- modify `src/core/brain/entities/canonical.ts`, `tests/core/brain/entities.canonical.test.ts`
- new `src/core/brain/derived-artifact.ts`, `tests/core/brain/derived-artifact.test.ts`

Lane A - admission + lexicon (t_11d51443):
- new `src/core/brain/entities/lexicon.ts`, `tests/core/brain/entities.lexicon.test.ts`
- modify `src/core/brain/entities/registry.ts`, `src/core/brain/entities/label-hygiene.ts`, `src/core/brain/doctor/entity-checks.ts`, `src/core/brain/fact-extract.ts`, `src/core/brain/atomic-facts.ts`, `src/cli/brain/verbs/entity.ts`
- extend `tests/core/brain/entities.registry.test.ts`, `tests/core/brain/entities.label-hygiene.test.ts`, `tests/core/brain/entities/doctor.entities.test.ts`, `tests/cli/brain-entity.test.ts`
- append-only: `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`

Lane B - miner + hallways (t_13a82a31):
- new `src/core/brain/link-graph/session-mining.ts`, `src/core/brain/link-graph/hallways.ts`, `src/cli/brain/verbs/hallways.ts`, `tests/core/brain/link-graph/session-mining.test.ts`, `tests/core/brain/link-graph/hallways.test.ts`, `tests/cli/brain-hallways.test.ts`
- modify `src/core/brain/continuity/types.ts` (additive record kind), `src/core/brain/sessions/import.ts`, sessions and continuity tests under `tests/core/brain/sessions/` and `tests/core/brain/continuity/`
- append-only: `src/cli/brain.ts` (dispatcher case), `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`

Lane C - store v14 migration (t_71cbf5bf + t_82851eda):
- modify `src/core/search/schema.ts`, `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/store/documents.ts`, `src/core/search/store/chunks.ts`, `src/core/search/search.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/core/search/query-cache.ts`, `src/core/search/pipeline/pool-filters.ts`, `src/core/search/result-filters.ts`, `src/mcp/search-tools.ts`, `src/cli/search/verbs/query.ts`
- new `tests/core/search/prefix-pushdown.test.ts`, `tests/core/search/schema-v14.test.ts`, `tests/core/search/kind-attributes-pushdown.test.ts`, `tests/core/search/hydration-two-tier.test.ts`

Lane D - eval + dead weight (t_693fa22a + t_1ee67e5b):
- new `src/core/brain/dead-weight.ts`, `tests/core/brain/dead-weight.test.ts`, `tests/core/search/benchmark-lang.test.ts`, `tests/core/search/recall-benchmark-zh.test.ts`, `tests/fixtures/recall-benchmark-zh/` (vault + dataset)
- modify `src/core/search/benchmark.ts`, `src/cli/search/verbs/rerank-eval.ts`, `src/mcp/brain/recall-tools.ts`, `src/cli/brain/verbs/recall-telemetry.ts`, `src/core/vault-scope/index.ts` (additive included-paths accessor, only if measurement shows one is needed), `tests/cli/brain-recall-telemetry.test.ts`
- untouched by rule: `tests/core/search/recall-benchmark.test.ts` (EN pins and fixture)

Lane E - repairs (files disjoint from every feature lane):
- modify `src/core/brain/permissions/resolve.ts`, `src/core/brain/permissions/document.ts`, `src/core/brain/intake/extract-intake.ts`, `src/core/brain/source-cleanup.ts`, `src/mcp/brain/ingest-tools.ts`, `src/core/brain/doctor/store-integrity.ts`, `src/core/install/ownership-measure.ts`, `src/cli/brain/verbs/secret.ts`, docs pages for the rollback note
- new `tests/core/brain/permissions-target-canonicalization.test.ts`, `tests/core/brain/intake-stage-disposition.test.ts`, `tests/core/brain/delete-by-source-deny.test.ts`, `tests/core/install/ownership-research-pool.test.ts`, `tests/cli/secret-unlock-nudge.test.ts`, `tests/core/brain/bundle-wildcard-warning.test.ts`

Integrator:
- modify `README.md`, docs index pages, `CHANGELOG.md`, `package.json` + `scripts/sync-version.ts`-mirrored manifests; census registration reconciliation where the append-only rule left drift.

## Risks and open questions

- A mid-wave predicate misprediction touches lanes A and B simultaneously; mitigated because the default-null handle keeps pre-wiring behavior byte-identical, so amendment is cheap.
- The v14 first-open transaction is longer on large vaults (scan + N parses + three b-tree builds); lane C measures a synthetic large store before freezing and documents the cost; crash-safety is inherited from the single-transaction runner.
- Shouted-heading false positives (brands, acronyms-in-expansion): the hard gate is limited to multi-token, digit-free, caseful labels with no prior stored occurrence; everything else is advisory via doctor. An operator allowlist (denylist inverse) is a future card if demand appears.
- Lexicon corpus scope skew: the corpus is vault user pages only (`MAINTENANCE_LANE_REACH`, Brain-root excluded, session transcripts excluded), stated in the artifact header so the dataset hash binds the scope.
- Attribute bounds (64 keys/doc, 16 values/key, 256 bytes/value) are proposals; lane C confirms against real vaults. Overflow decrements the attribute set, never fails the index; disclosure rides the existing degradation-notice registry as an optional new code, leaving `frontmatter-line-dropped`/`frontmatter-unreadable` behavior byte-identical.
- `walkVaultScope` may not expose its included-path list today; lane D measures first and adds the smallest additive accessor only if needed.
- ZH CI pins are provisional until the first measured run; if the offline stack cannot reach a reasonable floor, the honest fallback is reporting-only (no pinned gate) with the reason recorded - decided by measurement, not assertion.
- Windows portability: prefix canonicalization via `canonicalNotePath` fixes the backslash prefix gap; hallways provenance keys on transcript basenames, never host absolute paths; new categories/ids pass slug validation.
