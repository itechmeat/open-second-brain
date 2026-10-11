# PR #248 review: recall quality - mined sessions, honest admission, SQL-side filtering (v1.80.0)

- **PR**: https://github.com/itechmeat/open-second-brain/pull/248
- **Branch**: `feat/recall-quality` @ `7ac2dc0e`, merge base `3f029241`
- **Size**: 135 files, +13299 / -1093. OCR delegation in range mode found 70 reviewable source files.
- **Reviewer model**: Claude Opus 5.5
- **Scope cards** (`.reviews/current-tasks.md`): t_13a82a31, t_11d51443, t_71cbf5bf, t_82851eda, t_693fa22a, t_1ee67e5b. The design (`docs/brainstorm/recall-quality/design.md`) also has a repair lane for findings left open from PR #244 and PR #247; that lane is reviewed too.

## Verdict

**Not ready to merge.** The engineering is careful in many places:
1. The sargable prefix range is correct, including astral-plane paths.
2. The v14 migration is idempotent, runs in one transaction and never touches the vector tables.
3. The two-tier hydration cut never reads `content` before ranking.
4. The PMI formula is the standard one.
5. Hidden rows in dead weight are dropped before totals.
6. All local gates are green.

Three defects make results silently wrong, though:
1. The session miner writes credential-bearing URLs into the ledger, the hallways artifact and the proposals page in full.
2. Attribute narrowing drops documents whose frontmatter values were cut by the storage bounds.
3. The new `kind: page` filter matches the frontmatter YAML chunk, not the page head.

Several Medium issues limit the feature cards:
1. The lexicon gate switches itself off whenever the vault is edited.
2. `entity prune` would delete legitimate acronyms and topics.
3. Dead weight misses pages that context packs surface by absolute path.
4. The ZH fixture is saturated, so it cannot show whether rerank helps.

CI is red on one Windows shard because of a test this PR adds.

Counts: **3 High, 14 Medium, 15 Low.**

## Gates

1. Local, in the worktree:
   1. `bun run typecheck`: ok.
   2. `sync-version --check`: ok, every mirror at 1.80.0.
   3. `sync-plugin-mirrors:check`: ok.
2. Changed and added test files, run with an isolated `HOME`: **0 failures** in every lane.
   1. Store lane: 92 pass.
   2. Entities and hallways lane: 358 pass.
   3. Eval, dead weight and repairs: 580 pass.
3. CI: everything is green except **`windows (4/10)`**. It fails at `tests/core/brain/link-graph/hallways.test.ts:144` and `:233` (see M9).
4. The PR body and commits carry no AI attribution markers.

## Card verdicts

| Card | Topic | Verdict | Gap |
|---|---|---|---|
| t_11d51443 | Anti-junk entity admission and heal | **Partial** | The predicate and its rules are delivered: shouted-heading and function-word-run verdicts, admitting caseless scripts, and the code-shape bypass. So are the store-learned lexicon with `rebuild` and the creation/advisory split. Gaps: the lexicon reads as stale after any page edit, which turns the gate off (M5). Atomic facts and stated claims never get the handle (M6). Prune deletes advisory-only labels (M3). A refused label aborts the whole intake batch (M4). Re-extracting claims is scoped out, and the design says so. |
| t_13a82a31 | Mined sessions into an associative graph with hallways | **Mostly done** | Delivered: the miner in the import loop (private regions withheld, a per-session cap), PMI over sessions, the derived artifact, the proposals page, and promote/dismiss through `upsertEntity`. Gaps: credential URLs are stored (H1). Re-imports add duplicate ledger rows (M7). Host absolute paths become keys (L8). Windows CI is red (M9). No link-graph pass reads `hallways.json`; manual `promote` is the only bridge. |
| t_71cbf5bf | Push filters into SQL, indexed taxonomy columns | **Partial** | Delivered: the sargable prefix range, the virtual `chunk_kind`, and content hydration for the top k only. Gaps: the status census (`counts.ts`, named in the card) is untouched, so `o2b search status` still walks every row. There is no SQL pagination. Vector ranking is not batched or cached before hydration. The new taxonomy indexes almost never drive a plan, because every lane query starts from an FTS MATCH or the vec0 KNN (L3). |
| t_82851eda | Filterable kind and frontmatter attributes | **Partial** | Delivered: a bounded `document_attributes` table with backfill and the same writes on the indexing path; promoted keys excluded; MCP and CLI exposure. Gaps: `kind` is decided by chunk position, so `page` means the YAML block (H3). Narrowing drops documents at the storage bounds (H2) and on a stale index (M1). Selective filters starve the semantic lane (M2). |
| t_693fa22a | Bilingual EN/ZH rerank evaluation | **Partial** | Delivered: the `lang` field, the per-language split, and a self-authored ZH fixture that runs in CI through `bun test`. Gap: the ZH baseline is already perfect, and the report has no per-language delta, so the gate cannot show whether rerank helps ZH ordering, which is the card's point (M14). |
| t_1ee67e5b | Memory-utilization (dead weight) analytics | **Partial** | Delivered: the operation with CLI parity, the denominator from the live `walkVaultScope` walk, the window bounded by records in the caller's view, hidden rows removed before totals, and the stated caveat. Gaps: pages recorded by absolute path or by id only are never counted as retrieved (M10). The dead list is capped at 50 and cannot be paged (L10). |

### Repair-lane verdicts

| Finding | Verdict | Note |
|---|---|---|
| #247 M5: target-scoped rules not normalized | **Closed** | Targets are canonicalized on both sides. Non-canonical and `..` targets warn. |
| #247 M4: ingest stages only the summary | **Mostly closed** | Created entity pages stage and the manifest row is held back. A relation from a published entity to a staged one still writes a link before review (M13). |
| #247 M3 residual: `delete_by_source`, schema mutations | **Closed** | Both check deny rules with the credential subject. `write_session` is still unchecked (L13). |
| #244 M4 + L7: manifest rollback note, export nudge | **Closed** | `docs/ingest-manifest.md` is accurate. The unlock nudge prints. |
| #244 L2: bundle `*` allowlist warning | **Closed** | CLI import only. |
| #244 L1: doctor counts a raw `$secret:` as configured | **Closed** | The fix introduces M11. |
| #244 M10: research pool use site unwired | **Not closed** | The live research call site still never passes a vault. The CHANGELOG says otherwise (M12). |

## High

### H1. The session miner stores credential-bearing URLs in full

`src/core/brain/link-graph/session-mining.ts:238`

```ts
if (family === "url") {
  return redactSpecifierCredentials(raw) !== raw || CREDENTIAL_QUERY_PARAM_RE.test(raw);
}
return redactRawOutput(raw, { redactTokens: true }) !== raw;
```

1. **The gap.** Every other family runs the house token pass, `redactRawOutput(..., { redactTokens: true })`. URLs get only userinfo stripping and a fixed list of query parameter names.
2. **What gets through.** These URLs are classed as not secret and are mined:
   1. a Telegram bot URL with the bot token in the path (`/bot123456789:AAH…/sendMessage`);
   2. a Slack webhook (`hooks.slack.com/services/T…/B…/…`);
   3. `?private_token=glpat-…`;
   4. `?client_secret=…`;
   5. an implicit-flow fragment, `#access_token=…`.

   `redactRawOutput` with tokens on redacts all four of the samples tried.
3. **Where it lands.** The whole URL becomes `sourceRefs[].id` in the continuity ledger, which the module header says is stored as-is. From there it is copied to `Brain/link-graph/hallways.json` and `Brain/proposals/hallways.md`, and `promote` can turn it into an entity page that recall surfaces.
4. **Fix.** For `url`, also return `true` when `redactRawOutput(raw, { redactTokens: true }) !== raw`. Add `client_secret`, `private_token`, `refresh_token` and `sig` to the parameter list, and check fragment parameters (`#k=v`) as well as query ones. Pin each sample with a test.

### H2. Attribute narrowing silently drops matching documents at the storage bounds

`src/core/search/schema.ts:831` (and the value cap at `:826`); `src/core/search/property-pushdown.ts:306`

1. **Extractor behaviour.** `documentAttributesFromFrontmatter` drops a value over `ATTRIBUTE_MAX_VALUE_BYTES` (256) and every array element after the 16th, but still stores the key's other values.
2. **Narrowing behaviour.** The narrowing clause keeps a document when it has a matching row, or when it has **no** row for the key: `EXISTS(... value IN ...) OR NOT EXISTS(... key = ?)`. A document with some rows for the key, none equal to the asked-for value, is excluded in SQL, and the live filter never sees it.
3. **Reproduced.** Both cases use the real extractor and fragment. The live filter matches both, and both were returned before this PR.
   1. `source: [<320-byte URL>, "x"]` filtered on `source=<that URL>` excludes the document.
   2. `refs: [r0 … r19]` filtered on `refs=r19` excludes the document.
4. **Contract broken.** The module states that "silence is not a verdict": narrowing may only rule documents in. Here a partly stored key acts as proof of a mismatch.
5. **Fix.** In the extractor, store no rows at all for a key when any of its values was dropped. The existing `NOT EXISTS` arm then keeps the document for the live filter. Pin both cases with a test.

### H3. `kind: page` matches the frontmatter YAML chunk, not the page

`src/core/search/schema.ts:690` (the `chunk_kind` generated column); exposed at `src/mcp/search-tools.ts:299`

```sql
chunk_kind TEXT GENERATED ALWAYS AS
  (CASE WHEN chunk_index = 0 THEN 'page' ELSE 'section' END) VIRTUAL
```

1. **What chunk 0 is.** The constant is named `FRONTMATTER_CHUNK_INDEX`, and `chunkMarkdown` puts a note's YAML block alone in chunk 0. For example, a note's chunk 0 is just `---\ntype: note\nstatus: draft\n---`, and its title and intro start at chunk 1.
2. **What the filter means as a result:**
   1. For a note with frontmatter, `kind: page` searches only the YAML, and `kind: section` covers everything else, including the intro.
   2. For a note without frontmatter, `kind: page` is the first body chunk.

   The same filter therefore means different things on different documents. A query for `widgets` with `kind: page` never finds a note whose intro says "widgets".
3. **Card impact.** t_82851eda asked to filter on the page versus heading/section kind. A position-based column does not deliver that.
4. **Fix.** Derive the kind from the heading structure the chunker already tracks. For example, `page` could be the document head (frontmatter plus content before the first heading), or the first body chunk. Pin a frontmatter note and a bare note in the test.

## Medium

### Store (t_71cbf5bf, t_82851eda)

**M1. Narrowing gives "as indexed" answers for keys that are meant to be judged live.** `src/core/search/property-pushdown.ts:306`.
1. Design decision 8 says keys that are not pushed keep live-file semantics. Narrowing reads the indexed snapshot, though, so a stale index can exclude a document the live filter would accept.
2. Example: a file indexed with `status: draft` now says `status: done`. A filter on `status=done` excludes it in SQL; before this PR the live filter returned it.
3. Fix: either state this in the contract (the tool text currently says the filter is "judged live"), or skip narrowing for documents whose mtime or hash no longer matches the file.

**M2. Selective filters starve the semantic lane.** `src/core/search/store/vectors.ts:643`.
1. The kind, pushdown and narrowing predicates run after the vec0 KNN (`k = limit*4`), not inside it. With a selective filter, most of the k nearest chunks fail it, and the lane returns little or nothing.
2. `kind=page` is the worst case: each document has one YAML chunk, which is rarely near a query vector.
3. Fix: fetch more candidates in proportion to the filter's selectivity, or retry with a larger k when too few survive. Failing that, emit a degradation notice when the lane is starved.

### Entities and hallways (t_11d51443, t_13a82a31)

**M3. The doctor and `entity prune` treat legitimate labels as junk.** `src/core/brain/entities/label-hygiene.ts:109`; the verdicts come from `canonical.ts:500-501`.
1. With a fresh lexicon:
   1. `NASA`, `AWS`, `SQL`, `$HOME` and `MCP::SERVER` come back as `shouted-heading`.
   2. `Meeting`, `Health`, `Rust`, `Go` and `Machine Learning` come back as `function-word-run`.
2. At creation these verdicts are advisory by design. But `findMalformedEntityLabels` feeds both the doctor's `entity-label-malformed` check and `entity prune --confirm`, and prune deletes every candidate regardless of the reason. An operator who prunes to clear structural junk also deletes their acronym and topic entities. A snapshot exists, but this is still data loss.
3. Fix: mark these reason classes as advisory and leave them out of prune unless `--include-advisory` or a `--reason` filter is given.

**M4. One refused label aborts an intake batch partway, and every retry hits the same label.** `src/core/brain/entities/registry.ts:545`.
1. `intakeExtraction` calls `upsertEntity` in a loop. It does not validate labels first and does not catch `InvalidEntityLabelError`; only the hallways CLI catches it.
2. When one label in a batch is refused (for example a single common word such as `Meeting`), the entities before it are created, the relations are skipped and the call fails. A retry fails the same way, so that intake can never complete.
3. Fix: validate labels with the same lexicon in `validateIntake`, or skip each refused label, count it and carry on.

**M5. The lexicon gate turns itself off in any vault that is being edited.** `src/core/brain/entities/lexicon.ts:154`.
1. The dataset hash includes `rel + mtimeNs:size` for every page. Editing any operator page changes the hash, and `resolveEntityLexicon` then returns `null`.
2. Nothing rebuilds the lexicon automatically. The only writer is the manual `entity lexicon rebuild --apply`.
3. Short-lived processes (CLI, hooks) and every MCP restart after an edit run without the gate. A long-running process keeps an old handle indefinitely. Whether the gate is on comes down to process age and edit timing.
4. Fix: hash a coarser corpus signature (the page set, or token-count buckets, without mtimes), or accept staleness up to a set age, or rebuild in the dream or maintenance pass.

**M6. The lexicon is never passed on the second anchoring path.** `src/core/brain/atomic-facts.ts:57`.
1. No caller passes `DecomposeOptions.lexicon` or the new `opts` on `anchorEntityForms`. The callers are `facts.ts:71`, `diarization.ts:178/192` and `truth/stated-claims.ts:130/135`.
2. The fact-extract path drops junk forms through `buildAnchorables`, while atomic facts and stated claims still anchor on them. The comment "the two can never drift" no longer holds, and design decision 6 is only half delivered.
3. Fix: resolve the handle at these callers, or inside `anchorEntityForms` when the vault is known.

**M7. Re-importing a transcript appends duplicate ledger rows every time.** `src/core/brain/sessions/import.ts:398`.
1. `minedSeen` starts empty on every run and is never seeded from the existing ledger. A drained checkpoint restarts at turn 0, so each re-import appends up to 512 rows per session again.
2. `tests/core/brain/sessions/import-mining.test.ts:193` pins that behaviour.
3. Hallways folds the duplicates, so its output stays correct, but the ledger and the fold time grow without limit when directory imports repeat.
4. Fix: seed the set from the existing `session_entity_mention` rows for the `sessionRef`, or skip mining for files that are already fully imported.

**M8. Hallways promote can add an edge to a dismissed partner.** `src/cli/brain/verbs/hallways.ts:311`. `computeHallways` removes dismissed keys, but not pairs that include them. `promote` can therefore still add a `related` edge to a dismissed partner that already exists as an entity. Fix: drop pairs where either side is dismissed.

**M9. The red Windows shard is caused by this PR.** `src/core/brain/link-graph/hallways.ts:58-59`, used by `tests/core/brain/link-graph/hallways.test.ts:144` and `:233`.
1. `HALLWAYS_ARTIFACT_REL` and `HALLWAYS_PROPOSALS_REL` are built with `node:path` `join`, even though the comment says "all posix-joined", so they contain backslashes on win32.
2. `writeHallways*` returns `join(vault, REL)`, which uses native separators. The test normalizes only the expected side, so the comparison fails.
3. Fix: build the constants with `posix.join` and return a normalized path. Alternatively, normalize both sides in the test.

### Eval, dead weight and repairs

**M10. Dead weight never counts pages that were surfaced by absolute path or by id only.** `src/core/brain/dead-weight.ts:100` and `:130`.
1. `surfacedPaths` adds the raw `sourceRefs[].path` and `top_artifacts[].path` values, then counts a page as retrieved only when that path is in the set from the walk, which is vault-relative POSIX.
2. Context packs record `join(dir, name)`, which is absolute (`preferences-collect.ts:222`, `context-pack.ts:507`). Pre-compress telemetry records `brainActivePath(vault)`, also absolute, and its items as `{ id }` only (`pre-compress-pack.ts:335-337`).
3. As a result, a preference page that every context pack surfaces, and `Brain/active.md`, are reported as dead weight: the pages recall uses most are listed as never used. A Windows backslash spelling misses the same way.
4. `dead-weight.test.ts` covers only relative paths.
5. Fix: make each surfaced path vault-relative and pass it through `canonicalNotePath` before comparing. Add tests with context-pack and pre-compress records.

**M11. Ownership measurement now decrypts secrets and can abort install and onboarding.** `src/core/install/ownership-measure.ts:179` and `:182`.
1. `resolveResearchPoolEnv(process.env, opts.vault)` goes through `resolveNamedSecret` and then `resolveSecretReadOnly`, so a check that only asks whether a key is present decrypts it.
2. The catch handles only `SecretReferenceError`. A wrapped keyfile throws `SecretStoreLockedError`, and a missing keyfile throws `SecretStoreKeyfileMissingError`; both are re-thrown.
3. Example: with `TAVILY_API_KEY=$secret:tavily` and a wrapped store (the state after `secret unlock`), `o2b install` (`install.ts:233`) and onboarding (`onboarding.ts:198`) abort.
4. Fix: use the metadata-only `namedSecretAvailable` / `listNamedSecretAvailability`. Report a locked store or missing keyfile as `unchecked` with a reason, and never decrypt during a measurement.

**M12. The CHANGELOG says the PR #244 M10 research site is fixed, but it is not.** `CHANGELOG.md:33`.
1. The entry says "the pool now resolves references through the vault's own configuration … making the earlier claim true on the live path". But `resolveResearchPoolEnv` still has one caller, the ownership measurement, and `buildResearchPool` has no live caller that passes a vault.
2. Only the doctor half (#244 L1) was fixed.
3. Fix: pass the vault at the real research call site, or reword the entry.

**M13. A staged intake writes a link to an unreviewed page into a published entity.** `src/core/brain/intake/extract-intake.ts:365`.
1. Relations are applied before staging, and `relateEntities` writes `[[new-id]]` into the `from` page.
2. Given a relation `existing → new`, the published entity gains a link to an entity that exists only in `Brain/pending/notes/`. Recall and the graph see a dangling link before review, and the link stays if the operator rejects the staged page.
3. Re-ingests also create duplicate pending entries, because the manifest row is held back and the entities are created again each time.
4. Fix: under `stage`, defer relations whose `from` is not in `createdPages`, or stage them as pending edits. Deduplicate pending entries by publish target.

**M14. The ZH gate cannot show whether rerank improves ordering.** `tests/core/search/recall-benchmark-zh.test.ts:108`; `src/cli/search/verbs/rerank-eval.ts:145`.
1. The ZH fixture is already perfect without rerank: hit@5 = MRR = 1.000, with every expected path at rank 1. Rerank can only tie or lose, and the test accepts either `enable` or `keep-disabled`.
2. `by_lang` reports absolute numbers for each arm, with no per-language delta. A reranker that helps EN and hurts ZH would still be recommended on the combined delta.
3. Fix:
   1. Add ZH queries the baseline does not rank first: paraphrase, synonym and mixed-script queries.
   2. Emit `delta_hit_at_k` and `delta_mrr` for each language.
   3. Make a regression in any one language block the `enable` verdict.

## Low

1. **L1.** `src/core/search/property-pushdown.ts:159` / `:359`: pushed `type` and `visibility` compare after normalizing (NFC, trim, lowercase), while the live `matchesAny` is exact. As a result, `type=NOTE` now matches `type: note`, and `type=note` matches `type: Note`, where before the PR neither did. Document this or compare raw values.
2. **L2.** `src/core/search/types.ts:871`: the `SearchOptions.properties` doc still lists `tags` as pushed, but `tags` was moved back to the live filter.
3. **L3.** `src/core/search/schema.ts:690` and the `idx_chunks_kind` / `idx_documents_page_type` creates: the planner will almost never use either index, because the lane queries start from the FTS MATCH or vec0 KNN. They add write cost for little gain.
4. **L4.** `src/core/brain/link-graph/session-mining.ts:352`: the `path` family mines host absolute paths verbatim (`/home/<user>/…`, `C:\Users\<user>\…`), including usernames, and they reach `hallways.md` and promoted pages. The design's "never host absolute path" rule is honoured only for `sessionRef`. Make paths relative to the vault or project root, or replace the home directory with `~`.
5. **L5.** Two definitions of "code shape" disagree. Mining's `hasCodeCue` accepts `: $ @ \`; `canonical.ts:316` `CODE_SHAPE_CHAR_RE` does not. So mined `$HOME` or `MCP::SERVER` fail as `shouted-heading` in the doctor and prune, which is what the bypass was meant to prevent.
6. **L6.** `session-mining.ts`, fenced-block pass: a code block that contains any URL is skipped whole, so every symbol in it is lost.
7. **L7.** `hallways.ts` `dismissHallwayKey` reads, modifies and writes without a lock, so concurrent dismissals can lose one. The proposals text says "with mining enabled", but there is no such switch: mining always runs on a writable import.
8. **L8.** `src/core/search/benchmark.ts:308`: `lang` is not normalized, so `" zh"` and `"ZH"` pass validation and form separate groups.
9. **L9.** `src/core/brain/schema-mutate.ts:219`: the schema lane reuses the `ingest` action. A deny on `ingest` also blocks schema batches, and there is no way to deny schema changes alone. Document the coupling or add a dedicated action.
10. **L10.** `src/cli/brain/verbs/recall-telemetry.ts:205`, `src/mcp/brain/recall-tools.ts:310`: the dead list is capped at 50, and both surfaces reject `limit`, so the full list can never be seen.
11. **L11.** `src/core/brain/permissions/document.ts:571`: the permissions loader runs on every write, so a non-canonical target prints its stderr warning on every write.
12. **L12.** The CHANGELOG reformat damaged older entries:
    1. `CHANGELOG.md:264` loses the spaces around inline code: `` `estimated_cost_usd`used ``, `` so`search status`then ``.
    2. `CHANGELOG.md:2450` loses the list-item indentation.
    3. Several blank separator lines are gone.

    Commit `fff6586a` restored only the table. Restore the rest from the base.
13. **L13.** `src/core/brain/doctor/store-integrity.ts:307`: the doctor resolves only an untargeted `ingest`, so target-scoped denies (on `Brain/_brain.yaml` or a source) never show up. `write_session` still checks no permissions document and is missing from the lane list.
14. **L14.** `src/cli/brain/verbs/secret.ts:413`: the bundle wildcard warning exists only in the CLI import path.
15. **L15.** No link-graph pass reads `Brain/link-graph/hallways.json`. The design names this asymmetry, but the card's "associative graph" is reachable only through manual `promote`.

## Checked and fine

1. **Prefix upper bound.** The code-point increment, a run of trailing U+10FFFF, surrogate skipping and the lower-bound-only path are all correct, and `canonicalNotePath` is applied to the caller prefix.
2. **Migration idempotence.** The `table_xinfo` guard for the generated column, `IF NOT EXISTS` on the DDL, and a backfill gated on "no rows yet". `ON DELETE CASCADE` cleans attribute rows, with `foreign_keys` on.
3. **Query cache.** The cache key includes `kind` and the narrowing fold.
4. **Hydration.** Nothing before ranking reads `content`, and content is restored before the dedupe merge and MMR.
5. **Hallways math and safety.** PMI is `log2(co·N / (df_l·df_r))`. Duplicate ledger rows fold at `(family, key, sessionRef)`. Provenance uses the transcript basename. Private regions are withheld from mining.
6. **Dead-weight reach gating.** Hidden pages are removed before `total` and the window are computed, so a remote caller cannot learn their counts.
7. **Release hygiene.** Version 1.80.0 is mirrored and the check passes. The CHANGELOG heading and compare link are present. The Hermes static schemas were regenerated. The tool-count pin did not move.

## Recommended order of fixes

1. H1: run the token redactor on URLs and widen the parameter list. Stored credentials are the most expensive defect to undo after release.
2. H2 and H3: store no rows for a key when any value is dropped, and give `kind` a meaning based on structure. Together with M1 and M2, these make the new filters safe to advertise.
3. M9: make the hallways path constants posix-joined, so CI turns green.
4. M3, M4 and M5: keep advisory verdicts out of prune, make intake skip refused labels, and give the lexicon a coarser staleness key.
5. M10 and M11: normalize surfaced paths in dead weight, and use the metadata-only secret check in ownership measurement.
6. M12 and M13: correct the CHANGELOG claim, and defer relations from staged intakes.
7. M14, then the Low items.
