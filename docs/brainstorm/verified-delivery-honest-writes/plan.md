# Cycle 20261026 (verified-delivery-honest-writes) - implementation plan (four parallel lanes + integrator)

Implementation runs in four parallel lanes on provably disjoint file sets, followed by an integrator/docs phase that owns every cross-lane docs surface and runs the full gates. Every feature below carries its kanban card id. Inside a lane, tasks are serial. Every task is TDD: the acceptance test is written first and must fail with the expected error before the implementation lands.

## Lane structure

| Lane | Card(s) | One-line scope | Files |
|------|---------|----------------|-------|
| A - delivery | `t_cb6a5558`, `t_f8510c55` | Score-aware tail trim in the context pack; reply-presence receipts joined by session id | 20 |
| B - export privacy | `t_b88c2190` | The preferences bank/llms-txt export learns the existing deny markers and names every omission | 9 |
| C - capture writes | `t_50794f57`, `t_dc782fd5` | Dead-letter schema v2, classification and one-command recovery; the `brain validate` git-dirty gate | 15 |
| D - operator surfaces | `t_9571a47f`, `t_cfe2ce5d`, `t_8e49ec96` | Folder moves on the note-lifecycle surface; status store-ownership honesty; doctor client versions | 13 |
| Integrator/docs phase | all | Consolidated docs rows, CHANGELOG, full gates | 5 |

Lane-owned total: 57 files (10 new; Lane A's list carries 20 files once its one stray entry is read as the registry file below). Integrator adds 5 (2 of them Lane C-owned wiring files edited only after Lane C lands). No lane ever touches a file in another lane's set.

## Cross-lane contract

1. **Shared wiring files are owned by Lane C alone**: `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`. Lane D needs none of them: the folder actions extend the existing `note-lifecycle` verb surface (`src/cli/brain/verbs/note-lifecycle.ts`, not a wiring file), the doctor probe registers in `src/core/doctor-readiness.ts`, and the status snapshot fields flow through `src/core/brain/operator-snapshot.ts` and `src/mcp/brain/health-tools.ts`. The two folder-action description lines inside Lane C-owned files (`command-manifest.ts` note-lifecycle entry, `help-text.ts` usage block) are integrator-phase line items, not Lane D work.
2. **Integrator-owned docs**: `docs/cli-reference.md` and `CHANGELOG.md` are owned by the integrator/docs phase - NO lane edits them. The same treatment extends to `docs/mcp.md`, which Lanes A, C and D all need rows in; no lane edits it either.
3. **Commits and hygiene**: each lane commits with `git commit --only <its own paths>` (stage and commit in ONE step; never `git add -A`, never a bare `git commit -am`) and runs the repo formatter and linter - `./node_modules/.bin/oxfmt` and `./node_modules/.bin/oxlint` - on its own files before every commit. If the whole-tree pre-commit hook fails because another lane has unformatted files, retry after 30 seconds, up to 5 times; only then commit with `--no-verify` after verifying its own files are clean.
4. **Tests**: every lane runs ONLY its own targeted tests (`bun test <its own files listed below>`), never the whole suite. Two pinned suites are exceptions by construction: `tests/cli/help-surface-parity.test.ts` and `tests/cli/completions.test.ts` are manifest-derived - Lane C runs them after its manifest rows land; they pass without edits.
5. **Dependencies**: none between lanes. The integrator runs the full gates (typecheck, full test suite, validate) after all four lanes land.
6. **Collision protocol**: the lane sets above are exhaustive. If a lane discovers it needs a file outside its set (for example a census edit both lanes' vocabulary extensions are expected to make unnecessary), it stops and reports to the orchestrator instead of editing.
7. **Deviations the review wave recorded** (each stopped, reported and was approved, per rule 6): the architecture censuses needed rows after all - `tests/core/architecture/claim-attribution-census.test.ts` pins the new `reply_presence` kind and `tests/core/architecture/write-site-census.test.ts` plus `src/core/brain/destructive-sites.ts` declare the folder prune (and its fault cleanup); the below-local-reach fixes touched files outside every lane - `src/core/brain/explorer.ts`, `src/mcp/tool-error-codes.ts`, `tests/hooks/active-inject-receipt-session.test.ts`, `tests/cli/doctor-exit.test.ts` - and edited Lane A's `src/core/search/visibility-surface-registry.ts` row again (the receipts-visibility entry in the lane's list below).

## Lane-exclusive file sets

- **Lane A**: `src/core/brain/context-pack.ts`, `src/core/config.ts`, `src/mcp/brain/pack-tools.ts`, `hooks/answer-quote-check.ts`, `src/core/brain/answer-quotes/check.ts`, `src/core/brain/continuity/types.ts`, `src/core/brain/receipts/types.ts`, `src/core/brain/context-receipts.ts`, `hooks/active-inject.ts`, `src/cli/brain/verbs/context-receipts.ts`, `src/core/search/visibility-surface-registry.ts` (the receipts-visibility row; listed as knowledge-tools in the design phase, corrected on review - the receipts tool lives in pack-tools.ts and knowledge-tools.ts is untouched), `docs/how-it-works.md`, `docs/observability.md`, `hooks/README.md`, `tests/core/brain/context-pack-tail-trim.test.ts`, `tests/core/config-counterparty-brief.test.ts`, `tests/mcp/context-pack-tool.test.ts`, `tests/hooks/answer-quote-check.test.ts`, `tests/core/brain/context-receipts.test.ts`, `tests/mcp/context-receipts-tool.test.ts`.
- **Lane B**: `src/core/brain/export.ts`, `src/cli/brain/verbs/export.ts`, `src/core/brain/portability/knowledge-pack.ts`, `src/core/brain/portability/bundle.ts`, `src/cli/brain/verbs/bank-export.ts`, `tests/core/brain/export.test.ts`, `tests/cli/brain-export.test.ts`, `tests/cli/export-redaction.test.ts`, `tests/core/brain/portability/knowledge-pack.test.ts`.
- **Lane C**: `src/core/brain/dead-letter.ts`, `src/core/brain/extract-signals.ts`, `src/core/brain/dead-letter-recovery.ts`, `src/core/brain/vault-dirty.ts`, `src/core/brain/diagnostics.ts`, `src/cli/brain/verbs/dead-letters.ts`, `src/cli/brain/verbs/validate.ts`, `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`, `tests/core/brain/dead-letter.test.ts`, `tests/core/brain/dead-letter-recovery.test.ts`, `tests/cli/brain-dead-letters.test.ts`, `tests/cli/brain-validate.test.ts`.
- **Lane D**: `src/core/brain/notes/folder-lifecycle.ts`, `src/core/brain/notes/lifecycle.ts`, `src/cli/brain/verbs/note-lifecycle.ts`, `src/mcp/brain/lifecycle-file-tools.ts`, `src/core/brain/operator-snapshot.ts`, `src/mcp/brain/health-tools.ts`, `src/core/doctor-readiness.ts`, `src/cli/main.ts`, `tests/core/brain/notes/folder-lifecycle.test.ts`, `tests/core/brain.operator-snapshot.test.ts`, `tests/cli/status.test.ts`, `tests/mcp/maintenance-status-reach.test.ts`, `tests/core/doctor-readiness.test.ts`.
- **Integrator/docs phase**: `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `src/cli/command-manifest.ts` (note-lifecycle description line, after Lane C), `src/cli/brain/help-text.ts` (usage-block line, after Lane C).

## Tasks

### Lane A - delivery

#### Task A1: tail-trim flag resolver and pack option (Lane A, card `t_cb6a5558`)
- **Files**: `src/core/config.ts` (`resolveTailTrimContextPack`, config key `tail_trim_context_pack`, env `OPEN_SECOND_BRAIN_TAIL_TRIM_CONTEXT_PACK`, beside the entity-facts resolver), `src/core/brain/context-pack.ts` (`tailTrim?: boolean` on `ContextPackOptions` next to `entityFacts`, byte-identity docblock; `"tail-trim"` added to the `ContextPackSkipped.reason` union; conditional `tailTrim` report member declared), `tests/core/config-counterparty-brief.test.ts` (new resolver describe beside the `resolveEntityFactsContextPack` one).
- **Acceptance**: the new resolver tests fail first (the export does not exist), then pass: default off, config key on, env override wins. Existing context-pack pins stay green unchanged - an absent option is byte-identical.
- **Depends on**: none.

#### Task A2: trim and rescue engine (Lane A)
- **Files**: `src/core/brain/context-pack.ts` (relevance computation under the flag, top-3 keep and restatement keep-rule after the unified walker, tail drop with `"tail-trim"` skips, priority-order rescue of `over-budget` candidates under freed budget, `tokensUsed` recompute, module constants `CONTEXT_PACK_TAIL_TRIM_KEEP` and `TAIL_TRIM_KEEP_FRACTION`, report member attached in `finalizeContextPackReport`, counters in `contextPackBudgetMetadata`), `tests/core/brain/context-pack-tail-trim.test.ts` (new).
- **Acceptance**: the new suite fails first (flag on, no trim happens), then passes: flag off byte-identical; top-3 immunity; restatement keep at the fraction; tail drop emits `"tail-trim"` skips and surfaces gap `tail_trim`; rescue re-admits an over-budget candidate in priority order within `maxTokens` and never touches the attention item; ranked-mode scores reused; report member absent when off; the `packingPolicy` branch untouched.
- **Depends on**: A1.

#### Task A3: MCP wiring and trim docs (Lane A)
- **Files**: `src/mcp/brain/pack-tools.ts` (flag read beside the densityRanking/entityFacts block, opts threading, conditional response member), `tests/mcp/context-pack-tool.test.ts`, `docs/how-it-works.md` (context-pack section), `docs/observability.md` (telemetry payload row).
- **Acceptance**: the MCP test extension fails first, then passes: config key on means the response carries the trim block and skip reasons; key absent means the member is absent and the response is byte-identical.
- **Depends on**: A2.

#### Task A4: reply-presence fold and record kind (Lane A, card `t_f8510c55`)
- **Files**: `hooks/answer-quote-check.ts` (per-ledger-candidate outcome fold inside the existing budget and fail-open arms; sibling `reply_presence` record emitted once per checked turn), `src/core/brain/answer-quotes/check.ts` (`ANSWER_QUOTE_VERDICT` extended with `absent`), `src/core/brain/continuity/types.ts` (`reply_presence` union member + `CONTINUITY_RECORD_KINDS` entry, same edit), `src/core/brain/receipts/types.ts` (`reply_presence` row in `KEPT_CONTINUITY_KINDS`), `tests/hooks/answer-quote-check.test.ts`.
- **Acceptance**: the hook test fails first (no presence record), then passes: exactly one record per checked turn with a verdict per injected note - `verified` when a span checked out, the strongest miss verdict otherwise, `absent` for notes no span touched; `stop_hook_active` silence; fail-open when the ledger write fails; budget-expiry arms. The vocabulary census and the fold-decision census pass WITHOUT edits (entries self-derive; the keep row is the kind's fold decision).
- **Depends on**: none.

#### Task A5: presence join, session key and read surfaces (Lane A)
- **Files**: `src/core/brain/context-receipts.ts` (conditional `reply_presence` member on the summary; sibling lookup by `session_id`; `unjoined` outcome when no key matches), `hooks/active-inject.ts` (`sessionId` added to the `session_inject` receipt payload), `src/cli/brain/verbs/context-receipts.ts` (`show` prints presence), `src/mcp/brain/pack-tools.ts` (`brain_context_receipts` conditional member), `tests/core/brain/context-receipts.test.ts`, `tests/mcp/context-receipts-tool.test.ts`, `hooks/README.md` (Stop row and file list; transcript-availability caveat).
- **Acceptance**: the context-receipts test fails first, then passes: a sibling record joins by exact `session_id`; no key match reads `unjoined`, never an inferred window match; a receipt whose notes have no presence record reports absent rather than verified; the `session_inject` receipt now carries `session_id`; CLI and MCP show surfaces always carry the member, naming either the verdicts or the explicit `unjoined` outcome.
- **Depends on**: A4.

### Lane B - export privacy

#### Task B1: collector denial reporting (Lane B, card `t_b88c2190`)
- **Files**: `src/core/brain/export.ts` (`PreferenceCollection.denied` computed in `collectPreferenceRows` from the frontmatter map already parsed there, via `hasPrivacyDenyMarker` and `pageVisibility`; `rows` stays complete), `tests/core/brain/export.test.ts`.
- **Acceptance**: the deny-matrix tests fail first, then pass: informal marker keys times values deny; `visibility: private` denies; reason is `"visibility"`; unmarked rows are untouched; an empty denial leaves the collection byte-identical; parse refusals behave exactly as before.
- **Depends on**: none.

#### Task B2: export lanes name the omission (Lane B)
- **Files**: `src/core/brain/export.ts` (denying detail path for `collectExportRows`; `exportPreferencesJson` additive `omitted` envelope field, absent when empty, schema stays 1; `exportPreferencesLlmsTxt` detailed `{text, omitted}` variant with the string signature delegating), `src/cli/brain/verbs/export.ts` (stderr omission notice in the `contentClassOmissionNotice` shape, remedy names the reservation key; exit 0), `tests/core/brain/export.test.ts`, `tests/cli/brain-export.test.ts`, `tests/cli/export-redaction.test.ts`.
- **Acceptance**: the CLI and byte-identity tests fail first, then pass: marked preferences leave the json and llms-txt outputs and appear in `omitted`; nothing-to-deny runs stay byte-identical (the existing fixtures hold); the notice goes to stderr only; no new CLI flag exists.
- **Depends on**: B1.

#### Task B3: shared surfaces stay consistent (Lane B)
- **Files**: `src/core/brain/portability/knowledge-pack.ts` (denied preferences become `blocked` entries `{kind: "preference", id, reason: "visibility"}`; the every-entry-blocked error path still reads correctly), `src/core/brain/portability/bundle.ts` (bank bundle filters denied rows), `src/cli/brain/verbs/bank-export.ts` (stderr omission notice, same shape as its content-class notice), `tests/core/brain/portability/knowledge-pack.test.ts`, `tests/cli/export-redaction.test.ts` (bundle and bank-export pins).
- **Acceptance**: the knowledge-pack test fails first, then passes: a marked preference is absent from the pack and named in `blocked`; the bank bundle excludes it and the verb names it; unmarked vaults produce byte-identical bundle output.
- **Depends on**: B1.

### Lane C - capture writes

#### Task C1: dead-letter schema v2 with frozen payload (Lane C, card `t_50794f57`)
- **Files**: `src/core/brain/dead-letter.ts` (`DEAD_LETTER_SCHEMA_VERSION` to 2; optional `payload` on `DeadLetterRecord` and `RecordDeadLetterInput`; serializer field order; strict per-version parsing, unknown versions refuse), `src/core/brain/extract-signals.ts` (the failure-time record call passes the validated items), `tests/core/brain/dead-letter.test.ts`.
- **Acceptance**: the schema tests fail first, then pass: v2 round-trips with the payload; v1 letters parse unchanged and carry no payload; an unknown version refuses with today's error; the extractor's letter carries the items it failed to write.
- **Depends on**: none.

#### Task C2: recovery classifier (Lane C)
- **Files**: `src/core/brain/dead-letter-recovery.ts` (new; `classifyDeadLetter` returning category, reason and exact command string; `planRecovery` per-item verdicts; `applyRecovery` delegating to `commitExtractedSignals` with the recorded payload), `tests/core/brain/dead-letter-recovery.test.ts` (new).
- **Acceptance**: the classifier table fails first, then passes over fixture vaults: `recover` for a v2 letter whose session is still capture-classified with undelivered missing items; `pending` when the items sit staged in the write-approval queue; `re-extract` for a v1 letter; `not_recoverable` for an unknown or now-ignored session and for an unknown lane; `resolved` when every missing key exists on disk; apply re-runs at current state and already-written items dedup away.
- **Depends on**: C1.

#### Task C3: dead-letters verb and wiring (Lane C)
- **Files**: `src/cli/brain/verbs/dead-letters.ts` (new; list default with per-row copy-paste commands, `show <id>`, `recover <id>` dry-run default, `--apply` requiring `--yes` under `--json`/non-TTY, frozen-vault and vault-identity guards, retention preserved), `src/cli/brain.ts` (imports and dispatch case), `src/cli/brain/verbs/index.ts` (export), `src/cli/command-manifest.ts` (row), `src/cli/brain/help-text.ts` (row), `src/core/brain/diagnostics.ts` (`DIAGNOSTIC_SIGNALS` entry pointing at the verb), `tests/cli/brain-dead-letters.test.ts` (new).
- **Acceptance**: the CLI test fails first, then passes: list renders classification and recovery command per row and exits 0; recover previews per-item verdicts dry; `--apply` without `--yes` under `--json`/non-TTY refuses typed; a frozen vault refuses; nothing ever deletes the letter; `help-surface-parity` and `completions` pass once the manifest row exists.
- **Depends on**: C2.

#### Task C4: standalone validation gate (Lane C, card `t_dc782fd5`)
- **Files**: `src/core/brain/vault-dirty.ts` (new; `git status --porcelain` over the vault, vault-relative Markdown paths, modified + added + untracked, named non-worktree refusal), `src/cli/brain/verbs/validate.ts` (new; `--paths`/`--dirty` exactly-one selection, `lintPagesWithContext` reuse, exit contract errors 1 / `--strict` warnings 2 / unreadable named page 1 / clean 0, `--json` in `PageLintReport` shape), `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`, `tests/cli/brain-validate.test.ts` (new).
- **Acceptance**: the CLI test fails first, then passes: paths mode lints the named set; dirty mode over a fixture repo picks up modified, added and untracked Markdown; the exit matrix holds including strict warnings and the unreadable-named-page block; a non-worktree vault refuses with exit 2; giving neither or both selectors is a usage error; no auto-fix exists.
- **Depends on**: none (independent of C1-C3; wiring-file edits are serial within the lane).

### Lane D - operator surfaces

#### Task D1: folder lifecycle core (Lane D, card `t_9571a47f`)
- **Files**: `src/core/brain/notes/folder-lifecycle.ts` (new; folder envelope mirroring `resolveNoteTarget` minus the `.md` rung; move-set planning; occupancy pre-flight with `destination_occupied`; per-file link-assert-unlink relocation; pairs and rewrite over the successfully moved set; `FolderLifecycleResult`), `src/core/brain/notes/lifecycle.ts` (`move-folder` and `rename-folder` added to `NOTE_LIFECYCLE_ACTION` with docblocks), `tests/core/brain/notes/folder-lifecycle.test.ts` (new).
- **Acceptance**: the suite fails first, then passes: envelope refusals (`Brain/` destination, vault root as source, scope exclusions, `source_missing`); occupied destination file or directory refuses with nothing moved and the source untouched; applied moves relocate every file, rewrite inbound path-spelled links in one pass to minimal spellings, leave bare-basename links untouched and resolving, and name mid-set failures in `moveFailures` with pairs computed from the moved set only; dry-run is the default and writes nothing.
- **Depends on**: none.

#### Task D2: folder surfaces (Lane D)
- **Files**: `src/cli/brain/verbs/note-lifecycle.ts` (action dispatch and renderer `moved`/`moveFailures` lines), `src/mcp/brain/lifecycle-file-tools.ts` (action enum flows from the extended constant; `path` description covers folders), `tests/core/brain/notes/folder-lifecycle.test.ts` (surface cases).
- **Acceptance**: the surface tests fail first, then pass: `move-folder` to a same-parent destination and `rename-folder` across parents refuse `wrong_action`; `delete`/`archive` refuse for folder actions; the MCP tool accepts the new actions through the one constant; the vocabulary census passes without census edits (the entry self-derives).
- **Depends on**: D1.

#### Task D3: status store group (Lane D, card `t_cfe2ce5d`)
- **Files**: `src/core/brain/operator-snapshot.ts` (`store` group on `OperatorSnapshot`: `writerLock` three-state fail-soft, `writerLockReason`, `writerLockAgeMs`, `writerLockOwner` always null v1, `writerLockPath`, `thisCaller: "read-only"`; injected `writerLockHeldAt` seam; renderer line on both branches), `src/mcp/brain/health-tools.ts` (`brain_status` payload carries `store`; `writerLockPath` withheld below local reach), `tests/core/brain.operator-snapshot.test.ts`, `tests/cli/status.test.ts`, `tests/mcp/maintenance-status-reach.test.ts`.
- **Acceptance**: the snapshot tests fail first, then pass: no lock dir reads `free`; a lock directory created the way `proper-lockfile` does reads `held` with a non-negative age; an injected throw reads `unknown` with the errno in the reason; owner is null with a held lock and the renderer says the record carries no identity; `healthy` stays true and `problems` unchanged when held; CLI `--json` and human output carry the group; MCP withholds the path below local reach while keeping the state fields.
- **Depends on**: none.

#### Task D4: doctor client-versions probe (Lane D, card `t_8e49ec96`)
- **Files**: `src/core/doctor-readiness.ts` (`client_versions` probe appended to `DEFAULT_PROBES` after `registered_commands`; constant target-to-argv table with `generic: null`; async spawn inside the per-probe timeout; pass/unknown/skipped grading; optional additive `rows` field on `ReadinessProbeResult`, set only here), `src/cli/main.ts` (readiness rendering lists the rows under the probe detail), `tests/core/doctor-readiness.test.ts` (new `probeClientVersions` describe).
- **Acceptance**: the probe tests fail first, then pass: an answered spawn yields `pass` with the raw first stdout line; runner throw, non-zero exit, timeout and empty stdout each yield `unknown` with the reason; null-command and manifest-less runs yield `skipped`; mixed aggregates read `unknown` with the census; `rows` appears on this probe and no other; a fully-unknown probe keeps doctor at exit 6, not 1. The table's binary names are verified against each adapter's detect logic before the task lands (only `codex` and `copilot-cli` are confirmed by in-repo precedent).
- **Depends on**: none.

### Integrator/docs phase (outside the four lanes; runs after all lanes land)

#### Task I1: consolidated docs and CHANGELOG
- **Files**: `docs/cli-reference.md` (tail-trim diagnostics wording, dead-letters and validate rows, note-lifecycle folder actions, status store line, doctor readiness probe), `docs/mcp.md` (`brain_context_pack` trim block, `brain_context_receipts` presence member, `brain_note_lifecycle` folder actions, `brain_status` store group, hook-less-agent validate pointer), `CHANGELOG.md` (one release narrative and bullets for all eight features, byte-identity guarantees named explicitly), `src/cli/command-manifest.ts` (note-lifecycle description line), `src/cli/brain/help-text.ts` (usage block with the folder actions).
- **Acceptance**: the full gates pass - typecheck, formatter and linter clean tree-wide, the full test suite green including `help-surface-parity`, `completions`, the vocabulary census and the fold-decision census; every docs row matches the shipped behavior.
- **Depends on**: Lanes A, B, C, D all landed.
