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

### Task 8: Wave integration check
- **Files**: none (verification only)
- **Acceptance**: `bun run typecheck`, `bun run lint`, and the touched test files all pass; the six cards' behaviors coexist (a pre-extract result can carry `uses` edges with `resolvedTo` bindings; a repair-lane dry run with alias terms; a batch retry returning a duplicate receipt) without interfering defaults.
- **Depends on**: Tasks 1-7
