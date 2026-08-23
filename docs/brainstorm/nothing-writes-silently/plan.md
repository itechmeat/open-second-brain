# Nothing writes silently - implementation plan

Ten tasks. T1 is the substrate; T2->T3 is the one strict sequence (shared `buildRecommendations` surface); T4, T5, T6, T9 are independent; T7 and T8 depend on T1. TDD per task: failing test first, then implementation, then refactor green.

## Tasks

### Task 1: Shared reconciliation report module
- **Files**: new `src/core/reconciliation-report.ts`; `tests/core/reconciliation-report.test.ts`; `tests/core/architecture/verdict-vocabulary-census.test.ts` (vocabulary pin).
- **Shape**: pure module, no I/O. A report is `{ attempted, found, missing }` where `missing` always names its keys (a bare count constructor does not exist); a builder that refuses `attempted < found` and NaN inputs by name. Closed outcome vocabulary shared by consumers (e.g. `complete | partial | contradicted`).
- **Acceptance**: unit tests incl. refusal cases; vocabulary census pins the outcome tokens.
- **Depends on**: none. Blocks T7, T8, and T3's third-state naming.

### Task 2: Unit A - measured pending-vector count (`t_39b9b633`)
- **Files**: `src/core/search/store/chunks.ts` (new `countChunksWithoutEmbeddings`), `src/core/search/indexer.ts` (`IndexCheckReport` fields + `buildRecommendations` branch), `src/core/search/serialize.ts`, `src/cli/search/verbs/check.ts` output; tests: store unit test, check-report tests, moved recommendation pins.
- **Acceptance**: fully-embedded vault emits NO reindex recommendation (the old always-fires pin moves and is renamed as the fix); pending > 0 names the count and points at `o2b search vector-backfill`; absent/unreadable index reports unrecorded, never zero. No call from the query hot path.
- **Depends on**: none. Blocks T3.

### Task 3: Unit G - record-vs-data audit + restamp verb (`t_808c91b0`)
- **Files**: `src/core/search/store/` audit query (DISTINCT stored dimension vs `index_state` vs vec0 declared width), `indexer.ts` (third state in `IndexCheckReport`, after T2's shape settles), new `src/cli/search/verbs/` restamp verb (vec_version-only, dry-run default, no provider contact), `command-manifest.ts`, search help text; tests: audit unit tests, verb tests, check-output pins.
- **Acceptance**: a meta row claiming dimension N over stored width M reports "record contradicts data" (T1 vocabulary), distinct from drifted and unrecorded; restamp dry-run prints the would-be change and writes nothing; `--apply` restamps `vec_version` only and refuses when model/dimension differ (that repair is deferred by design). CLI-only - MCP tool count stays 113.
- **Depends on**: T2 (same `buildRecommendations` surface), T1 (vocabulary).

### Task 4: Unit B - unreadable-read raise + blank-overwrite guard (`t_589f04fb`)
- **Files**: `src/core/brain/write-batch.ts` (`readExistingNote` -> `parseFrontmatterWithNotices`, new codes `target_unreadable`, `blank_overwrite_refused`), new `src/core/brain/notes/blank-overwrite-guard.ts`, `src/mcp/brain/notes-tools.ts` + `src/mcp/brain/write-batch-tools.ts` (`allow_empty`); tests: write-batch unit tests (unreadable note -> typed refusal, no write; blank body over non-empty -> refusal naming the note; `allow_empty: true` clears; new empty note untouched), MCP schema/parity pins.
- **Acceptance**: an existing-but-unreadable note can no longer be blanked by update or append; refusals name their reason; the guard docblock records the refused placements (fs-atomic, host-memory-write, inline).
- **Depends on**: none.

### Task 5: Unit C - server-derived origin_channel (`t_34f4e3ab`)
- **Files**: new resolver module (entry-point-set process constant, `mcp-tool | cli | import` + explicit unset refusal), threading through `appendLogEvent` (`log.ts`), `writeSignal` (`signal.ts`, sibling of `source_type` + mapping table in docblock), `appendContinuityRecord` (`continuity/store.ts`), the `resolveNoteTarget` envelope (`notes/create-note.ts`); `tests/core/architecture/write-site-census.test.ts` boundary assertion; signal fixtures, frontmatter-key allowlist, `schema_inspect` vocabulary.
- **Acceptance**: all four families stamp the channel with zero new schema fields (grep proves no tool/CLI argument named channel); the census asserts the measured uncovered remainder; existing records are not rewritten.
- **Depends on**: none.

### Task 6: Unit D - derived maintenance-debt block (`t_6285e06f`)
- **Files**: `src/core/brain/status.ts` (`maintenance_debt` block: `log_events_since_dream` + `pending_triggers` only if answerable by a cheap count), status serialization surfaces (`second_brain_status`, `osb://status`), bounded newest-shard overdue flag on `brain_context`; tests: status tests, the dry-run-dream-moves-nothing pin, `brain_context` payload test.
- **Acceptance**: field names match what is measured; the docblock states caller-named note writes are not counted and why; a `--dry-run` dream does not move the ledger; `brain_context` cost stays bounded (newest shard only).
- **Depends on**: none.

### Task 7: Unit E - link candidates + write accounting + dead letter (`t_5b27eb0f`)
- **Files**: `rollup-ladder.ts`, `diarization.ts`, `design-note.ts` (consumer-type `link_candidates` via the zero-embed basename walker / note-title resolver; NOT on `LlmStepFields`, NOT in `schema_hints`), write accounting in T1 vocabulary for multi-artifact commit lanes, new durable dead-letter module under `<vault>/.open-second-brain/` + `state/surfaces.ts` row + `state-surface-census`; tests: envelope shape tests per consumer, accounting tests (all-writes-failed reports attempted/written/failed + first real error, never success), dead-letter round-trip.
- **Acceptance**: `NEEDS_LLM_STEP_KEYS` byte-identical (pin); three note-producing envelopes carry candidates; non-note lanes untouched; a multi-artifact lane interrupted mid-commit leaves a dead-letter record naming the unwritten items.
- **Depends on**: T1.

### Task 8: Unit F - import read-back census + sessions resume (`t_2e58d10f`)
- **Files**: shared read-back helper over existing keys (sessions dedup hashes, ingest content-manifest hashes) reporting in T1 vocabulary; `sessions/import.ts` checkpoint extension reusing `ingest/checkpoint.ts` substrate (keyed on file + turn boundary); STATE_SURFACES: verify whether the existing ingest-checkpoints row covers the new key shape, else add a row; tests: census tests (missing keys named), interrupted-import resume test (resumes at turn boundary, does not re-hash completed turns), checkpoint schema-version refusal.
- **Acceptance**: an import that lost items reports claimed/found/missing with keys named; an interrupted sessions import resumes instead of re-doing; CHANGELOG wording says ingest resume is extended, not introduced.
- **Depends on**: T1.

### Task 9: Unit H form B - visibility surface census + honesty finding (`t_92c26f69`)
- **Files**: new `tests/core/architecture/visibility-surface-census.test.ts` (every note-returning surface: covered by `applyVisibilityScope` or excluded-with-written-reason - search lane, file_context, context_pack, query, backlinks, unlinked_mentions, audit, sources, knowledge lane, resources); `search check` / doctor finding module stating the filter is caller-supplied view scoping, not a boundary, with the measured uncovered count.
- **Acceptance**: census enumerates and fails on an unclassified new surface; the finding appears in check output with the count derived from the census's own numbers (no hand-written N); no enforcement change, no owner-scope path touched, no indexRevision move.
- **Depends on**: none (lands after T2/T3 settle check output, coordinate strings).

### Task 10: Docs, version, release prep
- **Files**: `CHANGELOG.md` (new version heading + link ref; states the Unit A fix as a fixed false statement, F's resume as an extension, H as honesty-not-enforcement, the two refusals), `README.md` "What is new", `docs/architecture.md` / `docs/mcp.md` counts if moved, `package.json` bump + `bun run scripts/sync-version.ts`.
- **Acceptance**: `sync-version.ts --check` green; docs count tests green; full suite, typecheck, lint green on clean HOME.
- **Depends on**: all.
