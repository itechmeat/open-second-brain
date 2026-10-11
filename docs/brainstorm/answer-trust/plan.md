# Answer trust: verified quotes, claim attribution, source archives, session identity - implementation plan

Feature branch: `feat/answer-trust` (checked out from `origin/main` at v1.80.0, a00fa3f5). TDD per task, one atomic conventional commit per task, `bun run fmt` + `bun run lint` green before every commit. Work is organized as five implementation lanes in separate worktrees with STRICTLY DISJOINT file ownership: a file is edited by exactly one lane. Within a lane, tasks are ordered substrate-first (pure modules and config before wiring and surfaces). There are NO cross-lane dependencies by design - the four cards and the repair lane land independently and assemble at merge time.

This wave adds NO new MCP tool, NO new CLI verb, and NO new continuity record kind. Every surface change is a field on an existing tool result, an op on an existing tool, a flag on an existing verb, or one registered doctor check, so the tool-name pins (`tests/mcp/mcp.test.ts`, `tests/mcp/brain-tools-parity.test.ts`, `tests/mcp/agent-scope-matrix.test.ts`, `docs/mcp.md`) do not move. Any census that must change for a lane to proceed is a design error and stops that lane.

House rules this wave:

- New verdict vocabularies (Lane A's five quote verdicts, Lane C's archive refusals if vocabulary-shaped): frozen object + companion member list + type guard, registered in `tests/core/architecture/verdict-vocabulary-census.test.ts`. That file is SHARED-APPEND: each lane appends only its own vocabulary block; the census asserts membership per vocabulary, not a wave-global count, so appends never collide.
- New durable Brain directory `Brain/.archives/`: a `STATE_SURFACE_ID` entry and `STATE_SURFACES` row in `src/core/state/surfaces.ts` plus the `DECLARED_SURFACE_COUNT` bump in `tests/core/architecture/state-surface-census.test.ts` (Lane C, Task C1).
- `hooks/hooks.json` is mirrored into the Codex plugin: after editing it, run `bun run sync-plugin-mirrors` (CI and the pre-commit hook gate on `sync-plugin-mirrors:check`; never hand-edit `plugins/codex/hooks/hooks.json`). Every command must keep the resilient shape the `tests/hooks/hooks-json-shape.test.ts` census pins: `$CLAUDE_PLUGIN_ROOT` wrapper, PATH fallback, trailing `exit 0`.
- No identifier containing `secret` before a quoted value anywhere in src or tests; the plugin scanner flags the `const secret = "..."` form. Tests never depend on directory iteration order; every listing sorts deterministically.

## Cross-lane contract (pinned)

| Owner | Files |
|---|---|
| Lane A | `hooks/answer-quote-check.ts` (new); `hooks/hooks.json`; `src/core/brain/answer-quotes/check.ts` (new); `src/core/config.ts`; `tests/core/brain/answer-quotes/**`; `tests/hooks/answer-quote-check.test.ts` (new); `tests/core/config-answer-quote-check.test.ts` (new); the `tests/hooks/hooks-json-shape.test.ts` Stop-order extension and A's verdict-vocabulary census block |
| Lane B | `src/core/brain/truth/store.ts`; `src/core/brain/truth/stated-claims.ts`; `src/core/brain/truth/claim-provenance.ts` (new); `src/core/brain/context-receipts.ts` (`ContextReceiptFilter.receiptId` field only); `src/mcp/brain/knowledge-tools.ts`; `src/cli/brain/verbs/truth.ts`; `tests/core/brain/truth/**`; `tests/core/architecture/claim-attribution-census.test.ts` (new); the existing truth and CLI truth suite extensions |
| Lane C | `src/core/brain/provenance/source-archive.ts` (new); `src/core/brain/ingest/ingest.ts`; `src/mcp/brain/ingest-tools.ts`; `src/mcp/brain/hygiene-tools.ts`; `src/core/brain/hygiene/detectors/capture-scope.ts`; `src/core/brain/path-constants.ts`; `src/core/state/surfaces.ts`; `src/cli/brain/verbs/doctor.ts`; `tests/core/brain/provenance/source-archive.test.ts` (new); `tests/mcp/ingest-tool.test.ts`; `tests/mcp/hygiene-capture-scope-reach.test.ts`; `tests/cli/brain-hygiene.test.ts`; the `tests/core/architecture/state-surface-census.test.ts` count and C's verdict-vocabulary census block; the index-admission walker-exclusion extension |
| Lane D | `src/core/brain/session-recall.ts`; `src/core/brain/session-summary.ts`; `src/core/brain/idea-lineage.ts`; `src/core/brain/doctor/session-identity-check.ts` (new); `src/core/brain/doctor.ts`; `src/cli/brain/verbs/session-summary.ts`; `src/mcp/brain/synthesis-tools.ts` (digest-shape sweep); `tests/core/brain/session-identity-check.test.ts` (new); the session-recall, session-summary and idea-lineage suite extensions |
| Lane R | `src/core/search/property-pushdown.ts`; `src/core/search/store.ts`; `tests/core/search/kind-attributes-pushdown.test.ts`; `CHANGELOG.md` (the two whitespace-damaged lines only) |

Shared files, collisions resolved by assignment:

- `src/core/config.ts` - Lane A's `quote_check.*` resolvers own it; no other lane touches it (Lane C's ceilings are constants, not config).
- `hooks/hooks.json` - Lane A owns it (one Stop entry); the Codex mirror is regenerated, never hand-edited.
- `src/core/brain/doctor.ts` - Lane D owns the `DOCTOR_CHECKS` registration edit. Lane C's archive findings ride the hygiene detector and the doctor CLI verb, never the registry.
- `src/core/search/store.ts` - Lane R owns it; Lanes B, C and D must not touch it (they read through existing store APIs without edits).
- `tests/core/architecture/verdict-vocabulary-census.test.ts` - shared-append as above; the only test file two lanes both append to.
- `CHANGELOG.md` - Lane R touches only the whitespace-damaged lines; the release entry itself belongs to the release phase after this plan.

## Lane A config surface (pin - one vocabulary per key, no second reader)

| Key | Home | Values | Default | Resolver |
|---|---|---|---|---|
| `quote_check.recall` | `Brain/_brain.yaml`, `quote_check` block | `off \| shadow \| enforce` | `shadow` | `resolveAnswerQuoteCheckRecall(configPath?)` |
| `quote_check.active` | `Brain/_brain.yaml`, `quote_check` block | `off \| shadow \| enforce` | `shadow` | `resolveAnswerQuoteCheckActive(configPath?)` |
| `quote_check.subagent` | `Brain/_brain.yaml`, `quote_check` block | `off \| shadow \| enforce` | `shadow` | `resolveAnswerQuoteCheckSubagent(configPath?)` |

Resolver semantics, pinned for all three: unknown or wrongly typed values are field-named config errors naming `quote_check.<phase>` (never silently `off`); unknown keys inside the `quote_check` block warn per the strict-block convention. The hook runs a phase's check only when BOTH hold: the phase's injection is enabled (recall requires `recall_inject_enabled`, `src/core/config.ts:1185-1188`; active and subagent their own injection gates) and the resolver returns more than `off`. `shadow` annotates only; `enforce` annotates and appends exactly one Brain-log event per turn.

Hook constants, pinned as named exports in `hooks/answer-quote-check.ts`: `ANSWER_QUOTE_MAX_MESSAGES` (last assistant messages read), `ANSWER_QUOTE_MAX_CHARS` (per-message char budget), `ANSWER_QUOTE_BUDGET_MS` (wall-clock budget) - the bounded, fail-open contract the wave requires on the hot path.

## Tasks

### Task A1: Quote verdict module (Lane A, substrate)
- **Lane**: A. **Files**: new `src/core/brain/answer-quotes/check.ts`; `tests/core/brain/answer-quotes/check.test.ts`; A's block in `tests/core/architecture/verdict-vocabulary-census.test.ts`.
- **Acceptance**: `checkAnswerQuotes({spans, evidence})` composes `quoteHaystack`/`spanOccursIn` over the distill helpers imported in place (`findQuoteSpans`, `normalizeForQuoteComparison`, `src/core/brain/distill/quote-spans.ts:410,466,486` - no fork, no copy; `checkClaimQuotes` unextended) and returns exactly the five verdicts `verified | not-in-note | source-truncated | note-unavailable | not-text`, pinned table-style; the vocabulary is a frozen object + companion list + type guard, census-registered; the false-positive bar is the distill suite itself (`tests/core/brain/distill/quote-check.test.ts`): every span that suite verifies must verify here under the same evidence.
- **Depends on**: none

### Task A2: quote_check config resolvers (Lane A, substrate)
- **Lane**: A. **Files**: `src/core/config.ts`; `tests/core/config-answer-quote-check.test.ts`.
- **Acceptance**: the three resolvers land beside `resolveRecallInjectEnabled` (`src/core/config.ts:1185`) with the exact semantics of the config surface table above: default `shadow` per phase, `off|shadow|enforce` accepted, any other value a field-named error naming `quote_check.<phase>`, unknown block keys warning; resolvers are pure (`configPath` in, mode out) and read nothing else.
- **Depends on**: none

### Task A3: Stop-hook step and hooks.json entry (Lane A)
- **Lane**: A. **Files**: new `hooks/answer-quote-check.ts`; `hooks/hooks.json` (one Stop entry, ordered after `stop-log-guardrail`, `hooks/hooks.json:112`); `tests/hooks/answer-quote-check.test.ts` (synthetic transcript + injection ledger); the `tests/hooks/hooks-json-shape.test.ts` Stop-order extension.
- **Acceptance**: reads only the last assistant messages under the three named constants; finds quoted spans with `findQuoteSpans`; resolves each span's cited note from the span context (wikilink or vault-relative path) else ledger membership across `LEDGER_KEY_RECALL|ACTIVE|REGROUND|SUBAGENT_INJECT` (`hooks/lib/injection-ledger.ts:23-26`); phase gating consults the injection gate AND the Task A2 resolver; emits exactly ONE `hookSpecificOutput.additionalContext` annotation listing unverified spans with their verdicts (the `hooks/stop-log-guardrail.ts:10` precedent); never blocks, never edits the transcript; any error exits 0 with exactly one stderr audit line; `bun run sync-plugin-mirrors` run and green.
- **Depends on**: Tasks A1, A2

### Task A4: Degradation matrix and the enforce trail (Lane A)
- **Lane**: A. **Files**: `src/core/brain/answer-quotes/check.ts` (truncation and unavailability arms); `hooks/answer-quote-check.ts` (enforce log event); extensions of both A test suites.
- **Acceptance**: the degradation matrix is pinned end-to-end - note unavailable yields `note-unavailable` with the annotation kept; a truncated source (`ContextPackItem.trimmed`, `src/core/brain/context-pack.ts:156`; receipt `truncated` at `src/core/brain/context-receipts.ts:336,447`) is matched against the available prefix, a miss is `source-truncated`, and marks are never stripped on truncated evidence; `shadow` writes nothing to the vault; `enforce` additionally appends exactly one Brain-log event per turn via `appendLogEvent` (`src/core/brain/log.ts:289`) and never more; the hook exits 0 in every arm.
- **Depends on**: Task A3

### Task B1: sample_id on the claim event (Lane B, substrate)
- **Lane**: B. **Files**: `src/core/brain/truth/store.ts`; the truth store test suite.
- **Acceptance**: `AppendClaimInput` and `ClaimEvent` (`src/core/brain/truth/types.ts:50-71`) carry optional `sample_id`; omitted when absent, never invented; present values are stored verbatim and treated as opaque (privacy: receipts store hashes only, so the id discloses nothing); the schema version is unchanged and old ledgers read unchanged, exactly the optional-`extractor` forward-compatibility (`src/core/brain/truth/types.ts:64-69`); roundtrip pinned.
- **Depends on**: none

### Task B2: sampleId threading in stated claims (Lane B, substrate)
- **Lane**: B. **Files**: `src/core/brain/truth/stated-claims.ts`; the stated-claims test suite.
- **Acceptance**: `StatedClaimsPayload` gains optional `sampleId` (`src/core/brain/truth/stated-claims.ts:158-235` is the append path); the value is trimmed and must be non-empty when present - an empty or whitespace-only `sampleId` is a named refusal, never coerced, never stored; threading reaches `AppendClaimInput`; the no-sampleId path is byte-identical to today.
- **Depends on**: Task B1

### Task B3: Read-only claim-provenance join (Lane B)
- **Lane**: B. **Files**: new `src/core/brain/truth/claim-provenance.ts`; `src/core/brain/context-receipts.ts` (`ContextReceiptFilter` gains `receiptId`, matched before the limit, `src/core/brain/context-receipts.ts:84-95,181`); `tests/core/brain/truth/claim-provenance.test.ts` beside `tests/core/brain/context-pack-outcome.test.ts`.
- **Acceptance**: a claim's `sample_id` resolves to `{receipt items, outcome first_pass/evidence verdict}` using `listContextReceipts` by receipt id and `listContextPackOutcomes` by `sampleId` (`src/core/brain/context-pack-outcome.ts:108-118,293-305`); a `sample_id` with a receipt but no outcome row renders "receipt known, outcome unknown" - absent, never invented; a claim timestamped before its claimed receipt's `created_at` carries an inversion flag; the module performs no vault writes (enforced by the Task B6 census); the join widens nothing the caller could not already read at its reach.
- **Depends on**: Tasks B1, B2

### Task B4: brain_truth state accepts sample_id and hydrates reads (Lane B)
- **Lane**: B. **Files**: `src/mcp/brain/knowledge-tools.ts`; the knowledge tool test suite.
- **Acceptance**: `brain_truth state` (`src/mcp/brain/knowledge-tools.ts:751-812`) accepts optional `sample_id` per claim and echoes it per-claim commit exactly as the claim committed; the read op hydrates committed claims through `claim-provenance.ts` when `sample_id` is present; claims without `sample_id` render exactly as today; a missing outcome row renders the "receipt known, outcome unknown" marker, never a fabricated verdict.
- **Depends on**: Task B3

### Task B5: CLI truth --sample-id (Lane B)
- **Lane**: B. **Files**: `src/cli/brain/verbs/truth.ts`; the CLI truth test suite.
- **Acceptance**: `o2b brain truth state --sample-id <id>` threads the id through Task B2's validation; claim reads hydrate provenance identically to the MCP read op; omitting the flag is byte-identical to today; the flag value is validated by the same named refusal as the MCP path.
- **Depends on**: Task B4

### Task B6: Attribution census (Lane B)
- **Lane**: B. **Files**: new `tests/core/architecture/claim-attribution-census.test.ts`.
- **Acceptance**: pins, as architecture invariants: (a) the continuity record-kind vocabulary is unchanged by the wave - the join reads existing `context_receipt` and `brain_context_pack_outcome` rows and introduces no new kind; (b) no recall-time writes - the `truth/` modules and `claim-provenance.ts` import no continuity append path. Either invariant failing stops the lane.
- **Depends on**: Task B3

### Task C1: .archives path constants and state surface (Lane C, substrate)
- **Lane**: C. **Files**: `src/core/brain/path-constants.ts` (`BRAIN_ARCHIVES_DIR` = `".archives"` + `BRAIN_ARCHIVES_REL`, with the dot-dir walker-exclusion doc following the `.artifacts` precedent, `src/core/brain/path-constants.ts:109-116`); `src/core/state/surfaces.ts` (`STATE_SURFACE_ID` entry + `STATE_SURFACES` row); `tests/core/architecture/state-surface-census.test.ts` (`DECLARED_SURFACE_COUNT` +1).
- **Acceptance**: the surface row derives `Brain/.archives/`, `carries_memory: true`, with a reason stating it is durable evidence - deleting it destroys re-verification ability, not current vault content (the deliberate contrast to the artifact store's prune, `src/mcp/artifact-store.ts:110`); the census count matches; nothing else in the tree builds the path by hand (the census's naive-path-builder sweep passes).
- **Depends on**: none

### Task C2: Source-archive store (Lane C, substrate)
- **Lane**: C. **Files**: new `src/core/brain/provenance/source-archive.ts`; `tests/core/brain/provenance/source-archive.test.ts`; C's block in `tests/core/architecture/verdict-vocabulary-census.test.ts` (if refusals are vocabulary-shaped).
- **Acceptance**: `put(vault, bytes) -> sha256` writes `Brain/.archives/<sha256>.txt`, content-addressed so identical bytes persist once (dedup pinned); `ARCHIVE_MAX_BYTES = 1_048_576` with refuse-not-truncate - a past-ceiling input raises the named error, never a truncated write (the `CaptureExcerptError` posture, `src/core/brain/provenance/capture-scope.ts:243-248`); redaction runs BEFORE persist via `redactRawOutput` (`src/core/redactor.ts:971`), pinned by a test that a credential-shaped input never lands on disk; `verify(vault, hash)` re-hashes and reports match/mismatch; `stats(vault)` feeds the Task C6 doctor section.
- **Depends on**: Task C1

### Task C3: Ingest trusted-branch capture and page stamp (Lane C)
- **Lane**: C. **Files**: `src/core/brain/ingest/ingest.ts` (trusted branch, `src/core/brain/ingest/ingest.ts:390-396`); the ingest suite and `tests/mcp/ingest-tool.test.ts`.
- **Acceptance**: the trusted-local branch reads the source once, `readSourceOrigin`-style (`src/core/brain/intake/source-trust.ts:430-458` - not the byte-discarding `classifySourceOrigin`, `:418-420`), archives the bytes, and stamps `source_archive_hash` + `source_archive_bytes` on the summary page ON SUCCESS ONLY; an archive failure leaves the page unstamped and never fails the ingest (absence still means exactly "not captured"); a source whose digest is refused to remote readers (`src/core/brain/intake/extract-intake.ts:332-336`) is never archived; an oversized source skips capture with the named refusal recorded; untrusted and non-local sources behave byte-identically to today.
- **Depends on**: Task C2

### Task C4: Ingest result field and delete-by-source cleanup (Lane C)
- **Lane**: C. **Files**: `src/mcp/brain/ingest-tools.ts`; `tests/mcp/ingest-tool.test.ts`.
- **Acceptance**: the `brain_ingest_source` result gains `source_archive_hash` following the `capture_scope` field pattern - always present, null when not captured (`src/mcp/brain/ingest-tools.ts:148`) so absence never reads as a missing key to a caller; delete-by-source cleanup (`src/mcp/brain/ingest-tools.ts:218-260`) gains an archive-entry kind so removing a source's last citing page removes its now-orphaned archive entry, reported as its own kind in the cleanup result.
- **Depends on**: Task C3

### Task C5: Hygiene detector missing/mismatched-archive finding (Lane C)
- **Lane**: C. **Files**: `src/core/brain/hygiene/detectors/capture-scope.ts`; `tests/mcp/hygiene-capture-scope-reach.test.ts`; `tests/cli/brain-hygiene.test.ts`.
- **Acceptance**: an ingest summary stamped `source_archive_hash` whose archive entry is absent or re-hashes differently yields the named finding (one per page, `review` proposed action, the detector's existing shape); a page with no stamp is unchanged - absence means not captured, never a finding; findings flow through the existing hygiene surfaces (`brain_hygiene` tool, `o2b brain hygiene scan`, the Stop hygiene-digest hook) with no registry edits; reach rules hold - a caller who may not read the page learns nothing new from the finding.
- **Depends on**: Tasks C2, C3

### Task C6: Archive read surface and doctor section (Lane C)
- **Lane**: C. **Files**: `src/mcp/brain/hygiene-tools.ts` (`archive_get` op); `src/cli/brain/verbs/doctor.ts` (informational archive section); the hygiene tool and doctor verb tests.
- **Acceptance**: `archive_get` on the existing `brain_hygiene` tool resolves a hash to the archived bytes, modeled on `brain_artifact_get`'s bounded-fetch posture and LOCAL reach only - a remote-reach caller gets the same answer an absent entry gives, never the bytes (the visibility rule the design pins); an unknown hash is a named miss; the doctor CLI section is count-only informational (entry count, total bytes, missing/mismatched count) with no fix verb; no new tool and no new verb, so the tool-name pins stay unmoved.
- **Depends on**: Tasks C2, C5

### Task D1: Explicit no-session semantics in recall (Lane D)
- **Lane**: D. **Files**: `src/core/brain/session-recall.ts`; the session-recall test suite.
- **Acceptance**: the read-path coercion at `src/core/brain/session-recall.ts:577` treats a missing or non-string `session_id` as no-session explicitly (no `String(... ?? "")`); a record without `session_id` is excluded from scoped recall and from `lineageScope`; the lineage ledger's blank-id omission (`:619-627`) is pinned unchanged; unscoped reads still return the record; a non-string value (number, null) is excluded, not coerced.
- **Depends on**: none

### Task D2: Grouping sites and the digest shape sweep (Lane D)
- **Lane**: D. **Files**: `src/core/brain/session-summary.ts` (the filter at `:243`, the scope compare at `:339`, the digest at `:375`); `src/cli/brain/verbs/session-summary.ts`; `src/mcp/brain/synthesis-tools.ts`; the session-summary test suite plus consumer rendering cases.
- **Acceptance**: grouping at `:243` and `:339` skips no-session records rather than matching them against `""` (the shared-bucket defect); `SessionSummaryDigest.sessionId` becomes presence-gated (key omitted when absent); the CLI verb and the synthesis surface render a no-session summary without crashing and without fabricating an id; a consumer that cannot tolerate the absent key stops the lane for a design check - no fallback to `""` is acceptable anywhere.
- **Depends on**: none

### Task D3: Idea-lineage no-session semantics (Lane D)
- **Lane**: D. **Files**: `src/core/brain/idea-lineage.ts` (the turn index at `:120`, the source resolution at `:198`); the idea-lineage test suite.
- **Acceptance**: the turn-index grouping skips no-session records rather than keying them by `""`; the source resolution emits undefined rather than `""` for a record with no session; lineage output never merges two unrelated no-session records into one group (pinned by a two-record case).
- **Depends on**: none

### Task D4: blank-session-identity doctor check (Lane D)
- **Lane**: D. **Files**: new `src/core/brain/doctor/session-identity-check.ts`; `src/core/brain/doctor.ts` (`DOCTOR_CHECKS` registration adjacent to `orphanSessionCheck`, `src/core/brain/doctor.ts:174-201`); `tests/core/brain/session-identity-check.test.ts`.
- **Acceptance**: count-only and fail-soft - one pass over `listContinuityRecords`, one issue per affected record kind carrying the count, NO `fix` field (repair belongs to t_6cc80627's backup-gated posture); an unreadable ledger yields the uncertain-stream outcome, mirroring the orphan-session patterns (`src/core/brain/doctor/orphan-session-check.ts:37-40`); the check runs in `o2b brain doctor` and the `brain_doctor` tool with zero config; no payload is ever rewritten.
- **Depends on**: Task D1 (shares the no-session predicate's definition; reads only)

### Task R1: Freshness gate on attribute narrowing (Lane R)
- **Lane**: R. **Files**: `src/core/search/property-pushdown.ts`; `src/core/search/store.ts`; `tests/core/search/kind-attributes-pushdown.test.ts`.
- **Acceptance**: the pinned case passes - a document indexed as `status: draft`, edited to `status: done`, filtered `status=done`, is returned; stale candidates fall through to the live post-rank filter instead of being silently excluded by the `EXISTS ... OR NOT EXISTS` fragment (`src/core/search/property-pushdown.ts:303-321`, applied at `:386`); fresh candidates take the SQL path unchanged (the no-per-row-file-read case is pinned alongside); the advertised "narrow on the attribute snapshot, judged live" semantics (`src/mcp/search-tools.ts:293`) hold for every narrowed key.
- **Depends on**: none

### Task R2: CHANGELOG whitespace repair (Lane R)
- **Lane**: R. **Files**: `CHANGELOG.md` (the damaged lines at `CHANGELOG.md:264` and `CHANGELOG.md:2450` only).
- **Acceptance**: the missing spaces at `:264` and the broken list indentation at `:2450` are repaired; the diff touches no other line; docs-only, no code paths, no behavior.
- **Depends on**: none
