# Integrity and control of the agent-facing memory surface - implementation plan

## Tasks

### Task 1: Shared unique-match resolver
- **Files**: `src/core/graph/unique-match.ts` (new), `tests/core/graph/unique-match.test.ts` (new)
- **Acceptance**: `resolveUniqueMatch` returns the typed three-status outcome (`unique` with the single target, `ambiguous` with every candidate in a deterministic order, `none` for an empty candidate list); a repeated identical candidate is deduped before the decision so one page naming a term twice never reads as ambiguity.
- **Depends on**: none

### Task 2: Repair-lane unique-match mention-to-wikilink resolution (t_ec6b155d)
- **Files**: `src/core/brain/link-graph/repair-lane.ts`, `tests/core/brain/link-graph/repair-collect.test.ts`, `tests/core/brain/link-graph/repair-lane.test.ts`
- **Acceptance**: the explicit-reference collector pools title and `buildAliasIndex` alias terms per corpus page; a mention term proposes a candidate only when exactly one corpus page key carries it; a term carried by two pages produces `skip-ambiguous` decisions (new `RepairAction` member) in the lane's decision list and no candidates; dry-run and apply behavior, ordering, confidence (`explicit_reference`), threshold, write cap and idempotent rerun are unchanged; an alias mention proposes the same 0.9-confidence candidate a title mention would.
- **Depends on**: Task 1

### Task 3: Pre-extract relative-import binding (t_2356dace)
- **Files**: `src/core/brain/ingest/pre-extract.ts`, `src/core/brain/ingest/ingest.ts`, `tests/core/brain/ingest/pre-extract.test.ts`, `tests/core/brain/ingest/ingest.test.ts`
- **Acceptance**: `preExtractCodeStructure` takes optional `{ ingestedFiles }`; a TS/JS `./`- or `../`-specifier and a Python leading-dot `from .x import` whose probed candidates (joined path, each supported extension, `/index` + each supported extension) contain exactly one ingested file carry `resolvedTo` with that canonical vault-relative path; zero or multiple ingested candidates, a bare package specifier, and a call without `ingestedFiles` all leave seeds byte-identical to today; `ingest.runPreExtract` passes the manifest's canonical path set.
- **Depends on**: Task 1

### Task 4: JSX component-usage edge kind (t_998aa4e6)
- **Files**: `src/core/brain/ingest/pre-extract.ts`, `tests/core/brain/ingest/pre-extract.test.ts`
- **Acceptance**: a .tsx/.jsx line whose opening tag matches the structural rule (name immediately after `<`, preceding character not an identifier or `.`, name in `[A-Z_$][A-Za-z0-9_$]*`) yields a `uses` edge from the source path to the component name; `<div>`, `<nav>`, `<Nav.Item>` and generic type arguments (`Array<Foo>`) produce nothing; the widened kind union dedupes and sorts deterministically through the existing kind-aware `edgeKey`.
- **Depends on**: Task 3 (same file, `pre-extract.ts`; the `uses` kind and the relative-import binding land on one coherent grammar)

### Task 5: Write-batch client request ID and durable receipt (t_b34439d9)
- **Files**: `src/core/brain/write-batch.ts`, `src/mcp/brain/write-batch-tools.ts`, `tests/core/brain/write-batch.test.ts`, `tests/mcp/brain-write-batch.test.ts`
- **Acceptance**: `applyWriteBatch` accepts optional `requestId`; with no request ID behavior is byte-identical; a repeated ID with the same semantic payload returns the retained original result (ledger `ref`) marked as a duplicate receipt and writes nothing; a repeated ID with a different payload throws `IdempotencyPayloadMismatchError`; a fresh ID records the key with the receipt in `ref` after commit; the MCP `brain_write_batch` accepts `request_id` and returns `request_id` plus the receipt status; invalid IDs (empty, over 256 chars) surface the ledger's own named error before any write.
- **Depends on**: none

### Task 6: brain_search when-to-search cue (t_cb1e9d3d)
- **Files**: `src/mcp/search-tools.ts`, MCP search test coverage for the description
- **Acceptance**: the `brain_search` description carries exactly one added sentence that names `brain_recall_gate` as the classifier to consult before widening recall; no fan-out counts, no parallel-search language, and the recall-inject header text is untouched.
- **Depends on**: none

### Task 7: Caller-selectable FTS match mode (t_c5326ece)
- **Files**: `src/core/search/fts.ts`, `src/core/search/types.ts`, `src/core/search/pipeline/request.ts`, `src/core/search/pipeline/keyword-lane.ts`, `src/core/search/search.ts`, `src/mcp/search-tools.ts`, `src/cli/search/verbs/query.ts`, `tests/core/search/fts.test.ts`, `tests/core/search/search.test.ts`, `tests/mcp/search-global.test.ts`, CLI flag test coverage
- **Acceptance**: `buildFtsMatch` with `any` OR-joins the quoted tokens and still drops caller-typed `AND`/`OR`/`NOT`/`NEAR` tokens; default `all` output is byte-identical to today, including empty-input and single-token cases; the mode threads from `SearchOptions` through the request resolution and keyword lane; MCP `match_mode` validates the enum and rejects anything else; the CLI `--match-mode` flag mirrors it; expansion composition and the derived-term callers (`second-pass.ts`, `evidence-verification.ts`) are unchanged.
- **Depends on**: none

### Task 8: Per-device audit week files (t_774dea61, writer half)
- **Files**: `src/core/reliability/audit.ts`, `tests/core/reliability.test.ts`
- **Acceptance**: `appendAuditRecord` names its file `shardedFileName(isoWeekLabel(timestamp), resolveAppendShardId(), "jsonl")`; two writes with `O2B_DEVICE_ID=a` and `=b` in one week produce `<week>.a.jsonl` and `<week>.b.jsonl` and no process writes the other device's file; `O2B_DEVICE_ID=""` (the test preload default) keeps the legacy `<week>.jsonl` name and byte-identical behavior; the returned path is the file actually written; redaction, timestamp validation and the fsync discipline are unchanged.
- **Depends on**: none

### Task 9: Audit-reader and probe conversion (t_774dea61, reader half)
- **Files**: `src/core/brain/schema-integrity.ts`, `src/core/state/surfaces.ts`, plus their test suites
- **Acceptance**: `readRecordedSchemaPackDigest` lists the schema-mutation directory through `listShardedFiles` with the week grammar, so device shards merge (newest record still wins by its own timestamp) and `*.sync-conflict-*` copies are never parsed; the state inventory's reachability probe for a sharded fixed-name ledger reports the surface present when the legacy name or any shard of its grammar exists, and absent only when neither does; single-file vaults read exactly as before.
- **Depends on**: Task 8 (same grammar), Task 10-11 for the probe's ledger set (landed together with them)

### Task 10: Fixed-name ledgers in `Brain/log/` (t_774dea61, items 7-10)
- **Files**: `src/core/brain/paths.ts`, `src/core/brain/query-demand.ts`, `src/core/brain/recurrence.ts`, `src/core/brain/capture/telegram-capture.ts`, `src/core/brain/skill-proposals.ts`, plus their test suites
- **Acceptance**: query-demand, recurrence-support, capture-decisions and verifier-rejections write `<base>[.<deviceId>].jsonl` through the shard grammar; `readQueryDemand` returns the union of all shards (and the legacy file) in its existing ts-sorted order; query-demand compaction caps only the shard just appended; two devices produce two files and a merged read sees both; `O2B_DEVICE_ID=""` keeps every name and byte identical.
- **Depends on**: Task 8

### Task 11: Remaining fixed-name ledgers (t_774dea61, items 11-13)
- **Files**: `src/core/brain/health/edit-history.ts`, `src/core/brain/git/store.ts`, `src/core/brain/maintenance/journal.ts`, plus their test suites
- **Acceptance**: `pref-<slug>.history`, per-repo `commits` and `maintenance-runs` write per-device shards; `readEditHistory`, the git record read (and its dedup-before-append) and `listJournal`/`consecutiveTaskFailures` merge all shards deterministically with single-shard file order preserved; `sweepJournal` rewrites only the local device's shard to the cap; the git append lock moves to the device's own shard path; two-device tests cover each.
- **Depends on**: Task 8

### Task 12: Doctor conflict sweep extension and append guard (t_774dea61)
- **Files**: `src/core/brain/doctor/store-integrity.ts`, plus the doctor test suite and a new source-layout guard suite
- **Acceptance**: `LEDGER_DIRS` also sweeps `Brain/log/{session-lifecycle,hygiene,schema-mutations,secret-custody,watchdog}`, the hook-audit and watchdog-audit roots, the skill-proposal ledger directory, the per-repo git store directories and `Brain/preferences/`, reporting every `*.sync-conflict-*` copy with the existing merge instruction; a guard test fails when a source file appends via `appendFileSync`/`openSync(..., "a")` without using the shard helpers, with a named allow-list (per-run-unique dream-run files and the doctor repair appending to them).
- **Depends on**: Tasks 8-11

### Task 13: Wave integration check
- **Files**: none (verification only)
- **Acceptance**: `bun run typecheck`, `bun run lint`, and the touched test files all pass; the seven cards' behaviors coexist (a pre-extract result can carry `uses` edges with `resolvedTo` bindings; a repair-lane dry run with alias terms; a batch retry returning a duplicate receipt; a two-device audit week read back merged) without interfering defaults.
- **Depends on**: Tasks 1-7, 8-12
