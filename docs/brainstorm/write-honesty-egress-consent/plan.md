# Write-time honesty and egress consent - implementation plan

Lane structure: six feature lanes (A-F) on disjoint file sets plus one integrator.
Chosen variant: contract-first dependency waves (consultant Variant 2, adapted):
each lane lands its leaf/substrate primitive first, census and registry rows land
with the implementation that needs them, shared files have one primary owner and
append-with-poll for the second writer. TDD is red-first per task: the failing
test, then the fix, then green. Commit per task with `git commit --only <paths>`.
Format only your own files with ./node_modules/.bin/oxfmt; run only your own tests
with `env HOME=$(mktemp -d) bun test <files>`.

Shared-file ownership:
- `src/core/search/indexer.ts`: Lane B owns outright. Lane A coordinates the
  visibility-stamp edit with B before touching it (single coordinated edit, A
  first, B rebases its in-progress work). Lane F never edits it.
- `src/core/brain/diagnostics.ts`: Lane D owns (task D3). Lane A appends its
  doctor signal row in A4 AFTER polling `git log -- src/core/brain/diagnostics.ts`
  for D3's commit (30 s interval, up to 12 min).
- `docs/cli-reference.md`: Lane E owns (E5). Lanes A and B append their CLI doc
  lines in their final tasks after polling for E5's commit.
- Census tests: each lane edits only the census test its feature moves
  (A: visibility-surface if pins move; B: chunk-window + pending-vectors;
  D: none expected; E: egress-census extension; F: state-surface if a durable
  file appears).

## Tasks

### Lane A - F1 privacy markers (t_e095afac)

- **A1: informal privacy marker predicate.** Files: src/core/graph/privacy-markers.ts (new), tests/core/graph/privacy-markers.test.ts. Acceptance: `access: private`, `confidentiality: secret`, `sensitivity: confidential` (string and array forms, NFC/case variants via normToken) resolve to remote-deny; only-formal or keyless pages unchanged; no value read as a caller-scope token.
- **A2: enforce remote-deny at the three read roots and the indexed column.** Files: src/core/search/result-filters.ts (isPathReadableAtReach, applyReachFilter), src/core/vault.ts (listVaultPages), src/core/search/indexer.ts (visibility stamp, coordinated with Lane B), tests/core/search/visibility-filter.test.ts, tests/core/graph/remote-readability.test.ts. Acceptance: a marker-only page is absent from remote listVaultPages and remote search and its indexed snippets stay reserved after rewrite; local reach byte-identical; marker + `visibility: team` still remote-denied.
- **A3: preview-first tighten-only restamp verb.** Files: src/core/brain/privacy-marker-restamp.ts (new), src/cli/brain/verbs/ (new verb registration), tests/core/brain/privacy-marker-restamp.test.ts. Acceptance: default run writes nothing and returns candidates with the would-be visibility line; apply unions the reserved token via writeFrontmatterAtomic behind assertVaultIdentityForWrite; re-run no-op; never weakens existing visibility.
- **A4: doctor finding + registrations.** Files: src/core/brain/doctor/privacy-marker-check.ts (new), src/core/brain/doctor.ts (registry), src/core/brain/applier-capability.ts, src/core/brain/doctor-exits.ts, and ONE appended row in src/core/brain/diagnostics.ts (poll for D3). Tests: doctor-exit census, applier-capability, check unit test. Acceptance: N marker pages yield one warning with count N and paths; zero-marker vaults silent; code resolves through exit tables.
- **A5: census + docs tail.** Files: tests/core/architecture/visibility-surface-census.test.ts (only if pins move), docs/cli-reference.md (poll for E5). Acceptance: census green with named recounts; restamp verb documented.

### Lane B - F2 chunk skip-and-hold (t_f029b413; owns indexer.ts)

- **B1: hold decision in the embed phase.** Files: src/core/search/indexer.ts (runEmbeddingPhase), tests/core/search/ (embed phase). Acceptance: with a declared window and one over-window chunk, the provider receives only fitting texts, vectors stay 1:1 with what was sent, held tally with reason in stats, held content never reaches vecUpsert.
- **B2: persistent hold record + pending exclusion + release-on-change.** Files: src/core/search/schema.ts (migration + test), src/core/search/store/chunks.ts (PENDING_ANTI_JOIN), src/core/search/embedding-spend.ts. Acceptance: held chunk leaves countChunksWithoutEmbeddings (no perpetual vector-backfill recommendation); model/window/signature change releases holds; unchanged config keeps them held without spend.
- **B3: bounded held-items report on the status wire.** Files: src/core/search/indexer.ts (IndexStats), src/core/search/serialize.ts, tests/core/search/chunk-window-census.test.ts (wire discipline). Acceptance: status carries a capped held list (path, chunk index, estimate, window, reason) with an N-more disclosure, presence/absence byte discipline preserved.
- **B4: doctor check for held sources.** Files: new check under src/core/brain/doctor/ (embeddings-health-check.ts pattern), src/cli/brain/verbs/doctor.ts if wiring needed, tests. Acceptance: one aggregated warning per affected source document with a registered next-step command opening the held list.
- **B5: census verdict/warning update + docs tail.** Files: src/core/search/indexer.ts (formatChunkWindowMeasured), src/core/search/types.ts (new code only if warranted), tests/core/search/chunk-window-census.test.ts, tests/core/search/pending-vectors.test.ts, docs/cli-reference.md (poll for E5). Acceptance: warning names held-list and split-or-exclude levers; both verdicts resolve to registered commands; estimator one-resolver invariant intact.

### Lane C - F3 person-name variants (t_46296794)

- **C1: person-variants leaf module.** Files: src/core/brain/entities/person-variants.ts (new, imports nothing), tests. Acceptance: deterministic bit-stable forms (initials, word order) for person-category names with a minimum-form-length floor; unspaced-script names emit no word-order variants; nickname data is operator-extensible input, never a hardcoded English list.
- **C2: query-side expansion with declared-vs-derived tracking.** Files: src/core/search/entity-alias.ts, tests/core/search/entity-alias.test.ts. Acceptance: query "Bob" resolves against a Robert-only registry; derived forms tracked separately from declared; no-person vaults return the identity expansion byte-identically.
- **C3: exact-declared-first ranking tier.** Files: src/core/search/pipeline/candidate-signals.ts, src/core/search/ranker.ts, tests. Acceptance: declared-form match ranks above derived-variant match for otherwise-equal candidates; derived lane strictly smaller and capped; signals omitted when zero; never-retrieval invariant preserved.
- **C4: registry lookup derived lane.** Files: src/core/brain/entities/registry.ts, tests. Acceptance: getEntity resolves a unique derived match after exact miss; multi-match throws EntityAmbiguityError naming both ids; write-target resolution never follows a quarantined namesake's variant.
- **C5: doctor collision finding.** Files: src/core/brain/doctor/entity-checks.ts, tests/core/brain/doctor.entities.test.ts. Acceptance: two persons sharing a derived variant produce exactly one entity-alias-candidate warning naming both ids.

### Lane D - F4 undated-quantity lint (t_fb442a24; owns diagnostics.ts, help-text.ts)

- **D1: recognizer module.** Files: src/core/brain/undated-quantity.ts (new), tests. Acceptance: currency, percent, number-with-unit, thousands-separated triggers fire; ISO dates, version tokens, list markers, table cells, code spans do not; returns lexeme + offset.
- **D2: fifth detector in lintOnePage.** Files: src/core/brain/page-lint.ts, tests/core/brain/page-lint.test.ts. Acceptance: warning findings with the new code, path "body"; escape hatches (valid_from, ISO date in body, [Source: ..., YYYY-MM-DD] marker) produce no finding; clean page keeps the absent lint key; cap/rank discipline intact.
- **D3: diagnostics registration.** Files: src/core/brain/diagnostics.ts, tests. Acceptance: nextCommandField(code) resolves; findings carry next_command. (Lane A polls this commit before appending its row.)
- **D4: receipt-level integration.** Files: tests/mcp/brain-create-note.test.ts + update/append/batch twins. Acceptance: undated numeric write succeeds AND carries lint.findings with the new code; dated write keeps the byte-identical clean receipt.
- **D5: help text.** Files: src/cli/brain/help-text.ts, tests. Acceptance: claims help names the new finding class; no stale line references.

### Lane E - F5 content-class egress (t_5f545a9b; owns egress seam, cli-reference.md)

- **E1: content-class stamp primitive.** Files: src/core/brain/provenance/content-class.ts (new), src/core/brain/write-batch.ts (reserved update key), src/core/brain/notes/create-note.ts (creation merge), tests. Acceptance: unknown values refuse; stamp server-side at creation; callers cannot forge or strip the key on update; spelling avoids origin-channel census spellings.
- **E2: stamp the deterministic prompt-derived write paths.** Files: src/core/brain/sessions/import.ts, the create-note envelope for mcp-tool claims, src/core/brain/research/research.ts and the in-process generation writers, tests. Acceptance: session import and research runs carry the class; operator-authored CLI writes do not; the four pinned writer input interfaces unchanged (origin-channel census green).
- **E3: guard class policy + per-verb override.** Files: src/core/egress/guard.ts, src/core/egress/registry.ts (reasons), the export verbs (bank-export, graph-export, okf-export, export, continuity, explorer, knowledge-pack), tests. Acceptance: default export omits class-marked items and NAMES each omission; override includes them with a notice; transcript export refuses-or-names, never silently empties; egress-census guard-call rules stay green.
- **E4: knowledge-pack block reason + census extension.** Files: src/core/brain/portability/knowledge-pack.ts, tests/core/architecture/egress-census.test.ts (or content-class-census.test.ts new). Acceptance: prompt-derived is a named block reason; census pins in both directions that every sharedRedactor site applies the class filter.
- **E5: operator disclosure + no-backfill invariant.** Files: docs/cli-reference.md, SECURITY.md, tests. Acceptance: default-excluded class and override documented where the census demands; a pre-stamp vault fixture exports unchanged (era boundary asserted).

### Lane F - F6 provider-decline consent (t_fa467133)

- **F1t: consent resolver.** Files: src/core/search/provider-consent.ts (new), src/core/brain/config-template.ts (key declarations), tests. Acceptance: unset and explicit decline resolve to distinct states; unreadable/unparseable config resolves to declined (fail-closed); resolver extends the capability-tier ladder rather than paralleling it; import-cycles green.
- **F2t: honor the decline before any network call.** Files: src/core/search/embeddings/provider.ts (makeProvider typed declined error naming the keys), src/core/search/semantic-phase.ts refusal path, src/core/search/indexer.ts (the embed phase and the embedding probe resolve the consent and hand it to makeProvider - a coordinated edit with F2, shipped as such), tests. Acceptance: declined vault refuses at provider construction with a fetch counter asserting no network call; unset-config vaults behave byte-identically to today.
- **F3t: doctor consent probe.** Files: src/core/doctor-readiness.ts (READINESS_PROBE + DEFAULT_PROBES, split the skipped-decline arm), tests. Acceptance: declined vault reports a decline sentence naming search_semantic_enabled=false / embedding_provider=disabled and lists present provider env vars BY NAME ONLY (tests assert absence of values); unset keeps the existing sentence.
- **F4t: consent-stamp primitive with kill switch.** Files: src/core/egress/consent-stamp.ts (new, no destination declared), tests. Acceptance: kill switch set refuses every stamp regardless of any other env value; refusal discloses what would leave the machine; leaf-level redaction composes via redactForEgress.
- **F5t: durable-surface registration if needed.** Files: src/core/state/surfaces.ts, tests/core/architecture/state-surface-census.test.ts (only if a durable file appears). Acceptance: new row attributed with sources, counts bumped with a written reason, naive cross-check green.

### Integrator (single pass after all lanes)

- Census recount across all moved pins; full local gates in CI order (CI-pinned Bun); cross-lane contract verification (declined error surfaces by name through the indexer's consent-resolved provider construction); remaining docs.

## Dependency notes

- A4 depends on D3 (diagnostics.ts append-with-poll). A5/B5 depend on E5 (cli-reference.md append-with-poll).
- A2's indexer stamp edit is coordinated with Lane B before B1 starts editing the indexer; A performs its indexer edit FIRST, B proceeds after.
- C2, C3, C4, C5 depend on C1. E3, E4 depend on E1. F2t, F3t, F4t depend on F1t.
- No lane waits on another lane's feature completion otherwise; all six start in parallel.
