# Integrity and control of the agent-facing memory surface - six-card release wave (mention-to-wikilink unique-match resolution, import binding, JSX usage edges, write-batch request receipts, when-to-search cue, FTS match mode)

**Status:** draft
**Author:** orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's agent-facing memory surface leaves integrity and control gaps on six fronts, each verified against the live source. Prose mentions of known pages bind to nothing (and ambiguous titles bind to several things at once); pre-extract import seeds stay dangling specifiers; JSX render relationships are invisible; a retried `brain_write_batch` call can double-apply because no client request ID and no durable receipt exist; the `brain_search` description gives the agent no when-to-search calibration; and FTS matching is hardcoded to implicit-AND with no caller-selectable breadth. The wave closes all six under one spine without changing any default behavior for callers who do not opt in.

## Scope

- t_ec6b155d: corpus-wide unique-match mention-to-wikilink edge resolution through the apply-gated repair lane - title and alias terms pooled per corpus page, a mention term binds only when exactly one corpus page carries it, ambiguous terms are refused by name in the lane's decision list.
- t_2356dace: bind relative import specifiers (TS/JS `./`- and `../`-prefixed, Python leading-dot `from .x import`) to ingested files via an optional `resolvedTo` field on the `imports` edge seed, resolved against the ingest content manifest, exactly-one-candidate only, never clobbering a raw seed. No new languages.
- t_998aa4e6: a `uses` edge kind in the pre-extract line grammar for JSX element tags in .tsx/.jsx sources, skipping lowercase-initial DOM/intrinsic tags and member-expression tags.
- t_b34439d9: `applyWriteBatch` accepts an optional client request ID; on a repeated ID with the same semantic payload the retained original batch receipt is returned without re-applying; on a repeated ID with a different payload a named error refuses. The idempotency ledger's `rememberKey` semantics are extended; no durable-queue and no worktree-pause machinery.
- t_cb1e9d3d: exactly one when-to-search cue sentence added to the `brain_search` tool description, naming `brain_recall_gate` as the bound for widening recall.
- t_c5326ece: a caller-selectable FTS match mode (`all` default, `any` OR-joined) on `buildFtsMatch`, threaded through the keyword lane, the search API options, the MCP `brain_search` schema and the `o2b search` CLI flags; caller-typed FTS5 operator tokens stay dropped in both modes.

## Out of scope

- No durable-queue, expiry or worktree-pause machinery (validator-struck halves of t_b34439d9).
- No Elixir/Rust/Ruby support in pre-extract.
- No change to `findUnlinkedMentions` (it stays the target-centric report scanner for `Brain/preferences/` + `Brain/retired/`).
- No change to the recall-inject header or `deriveRecallHint` wording (already neutral).
- No fan-out counts, parallel-search language, or invented recall bounds in the search description.
- No new external dependencies; no version bump in this node (the bump rides with the release phases per CLAUDE.md).
- No change to the two internal derived-term `runFtsQueryDetailed` callers (`pipeline/second-pass.ts`, `evidence-verification.ts`) - they keep the default `all` mode.

## Chosen approach

Variant 2 from the brainstorm (shared unique-resolution discipline with named refusals, existing ledger reuse, local edits for the two lexical cards), with two orchestrator refinements recorded under Design decisions.

One small pure module, `src/core/graph/unique-match.ts` (placement mirrors the existing `src/core/graph/` shared helpers; final home confirmed during implementation against the import-direction rules), exposes the shared discipline:

```ts
type UniqueMatch<T> = { readonly status: "unique"; readonly target: T }
                     | { readonly status: "ambiguous"; readonly matches: ReadonlyArray<T> }
                     | { readonly status: "none" };
function resolveUniqueMatch<T>(candidates: ReadonlyArray<T>): UniqueMatch<T>;
```

- The repair lane's explicit-reference collector (t_ec6b155d) builds a term index over `loadPages` output: NFC + lowercase term keys from each page's title plus the aliases `buildAliasIndex` resolves to that page's key. A masked, word-boundary mention scan per source page (the existing `mentionsTerm` mechanics) looks each matched term up in the index; `resolveUniqueMatch` decides. `unique` proposes a candidate (existing `explicit_reference` strength and confidence); `ambiguous` emits one `skip-ambiguous` decision per matching pair into the existing `RepairReport.decisions` list; `none` contributes nothing. Alias terms are exactly as strong as title terms; the reason string names the term it matched.
- The pre-extract specifier binder (t_2356dace) takes an optional third options argument `{ ingestedFiles?: ReadonlySet<string> }` on `preExtractCodeStructure`. `ingest.runPreExtract` passes the manifest's canonical path set (`readManifest(vault).entries` keys). For a relative specifier the binder probes the candidate path set (specifier joined to the source dir; each supported extension; `/index` + each supported extension); `resolveUniqueMatch` over the candidates that are members of `ingestedFiles` decides: exactly one ingested file fills the seed's new optional `resolvedTo` field (canonical vault-relative path); `ambiguous` or `none` leaves the seed raw.
- The JSX usage kind (t_998aa4e6) widens `CodeEdgeSeed.kind` with `"uses"`. One line-grammar regex matches JSX opening tags whose name is immediately after `<`, the preceding character is not an identifier character or `.`, and the name itself is `[A-Z_$][A-Za-z0-9_$]*` - which skips lowercase-initial DOM/intrinsic tags and every member-expression tag containing a dot, without a DOM vocabulary list. `edgeKey` is already kind-aware; the dedupe/sort order survives the widened union unchanged.
- The write-batch receipt (t_b34439d9) follows the established `signal.ts` consult-before-write pattern: after the existing vault-identity assert and before validation/commit, a supplied request ID is hashed (`computePayloadHash` over the semantic operations array) and consulted with `lookupKey`; `duplicate_match` returns the retained original `WriteBatchResult` (stored in the ledger record's `ref`) with a receipt status, committing nothing; `payload_mismatch` throws the ledger's own `IdempotencyPayloadMismatchError`; an unseen key proceeds. After a successful commit, `rememberKey` records the key with the receipt in `ref`. Absent request ID: byte-identical behavior. The MCP surface `brain_write_batch` accepts `request_id` (string) and returns `request_id` plus the receipt status on every result.
- The search cue (t_cb1e9d3d) appends one sentence to the `brain_search` description naming `brain_recall_gate` as the tool that classifies whether widening recall is warranted. No fan-out numbers.
- The FTS match mode (t_c5326ece) adds a `FtsMatchMode` type (`"all" | "any"`) and an options argument on `buildFtsMatch`; `"any"` joins the quoted, operator-dropped tokens with ` OR `. The mode threads `SearchOptions.matchMode` -> `ResolvedSearchRequest.matchMode` -> `KeywordLaneInput.matchMode` -> `RunFtsOptions.matchMode`. `buildExpandedFtsMatch` composes unchanged (an OR-joined base group OR'd with expansion terms is semantically the flat ANY superset). MCP: `match_mode` enum on `brain_search`. CLI: `--match-mode all|any` on `o2b search`.

## Design decisions

- **Shared resolver is generic and tiny; domain index-building stays local.** The link-graph term map and the pre-extract path probing are different domains; only the exactly-one decision is shared. A generic three-status resolver keeps the discipline from drifting without forcing a common input shape. (Variant 2's core, trimmed of its broader index-first suggestions.)
- **Ambiguity is named where the report already lives.** Card 1's refusals ride the existing `RepairReport.decisions` via a new `skip-ambiguous` action - no report-shape change, no silent drop. Card 2's refused bindings are NOT surfaced as a separate `unbound` list (refinement over Variant 2): the seed staying raw is itself the visible conservative outcome, and an aggregate list would duplicate the seeds it describes.
- **The receipt ledger write is not inside the batch's atomic unit.** Refinement over Variant 2's wording: the ledger is a separate JSONL store and no cross-file atomic unit exists. The sequencing is the one `signal.ts` already ships and the ledger's own documentation accepts - consult before any commit, `rememberKey` re-checks under its shard lock on record, and the primary target (a sequential retry after a lost response) is fully deduped because the record is durable before the retry runs.
- **Core option named `requestId`, MCP param named `request_id`.** The card's vocabulary is request ID + receipt; the mapping stays in the tools layer (no MCP shapes in the core). Validation is delegated to the ledger's `normaliseKey` (non-empty, max 256) so an invalid ID raises the ledger's own named error rather than a duplicate validator.
- **`resolvedTo` is additive; `to` keeps its raw-specifier semantics.** Existing consumers of pre-extract seeds see unchanged required fields; the bound file path is explicit and optional, matching the convention that new parameters default to byte-identical behavior.
- **JSX skipping is structural, not lexical.** Lowercase-initial and dotted tag names are skipped by character class, not by a DOM tag list - the project has no per-language word lists, and the conservative rule cannot fall out of date.
- **ANY mode keeps operator-token dropping and composes with expansion.** `dropStandaloneOperators` runs before the join in both modes; `buildExpandedFtsMatch` reuses `buildFtsMatch`, so expansion in ANY mode yields `(a OR b) OR "exp1"` - semantically the flat ANY superset, byte-stable code path.
- **Alias terms carry the same `explicit_reference` confidence as titles.** The load-bearing discipline is the unique-match rule, not the term's spelling; downstream thresholds are unchanged.

## File changes

New files:
- `src/core/graph/unique-match.ts` (shared `resolveUniqueMatch`)
- `tests/core/graph/unique-match.test.ts`

Modified files:
- `src/core/brain/link-graph/repair-lane.ts` (term index, unique-match resolution, `skip-ambiguous` action)
- `src/core/brain/link-graph/alias-index.ts` (read as-is; the collector inverts the frozen alias-to-id map in memory to group alias terms per page key, so no modification is expected)
- `src/core/brain/ingest/pre-extract.ts` (`uses` kind, JSX regex, relative-specifier binding, optional `ingestedFiles` argument, optional `resolvedTo` on seeds)
- `src/core/brain/ingest/ingest.ts` (`runPreExtract` passes the manifest path set)
- `src/core/brain/write-batch.ts` (request ID option, consult-before-commit, receipt in result)
- `src/mcp/brain/write-batch-tools.ts` (`request_id` param and result fields)
- `src/mcp/search-tools.ts` (`brain_search` description cue, `match_mode` schema param)
- `src/core/search/fts.ts` (`FtsMatchMode`, `buildFtsMatch` options, `RunFtsOptions.matchMode`)
- `src/core/search/pipeline/keyword-lane.ts`, `src/core/search/pipeline/request.ts`, `src/core/search/search.ts`, `src/core/search/types.ts` (threading)
- `src/cli/search/verbs/query.ts` (`--match-mode` flag)
- Tests: `tests/core/brain/link-graph/repair-collect.test.ts`, `tests/core/brain/link-graph/repair-lane.test.ts`, `tests/core/brain/ingest/pre-extract.test.ts`, `tests/core/brain/ingest/ingest.test.ts`, `tests/core/brain/write-batch.test.ts`, `tests/mcp/brain-write-batch.test.ts`, `tests/core/search/fts.test.ts`, `tests/core/search/search.test.ts`, `tests/mcp/search-global.test.ts`, plus CLI test coverage for the flag
- Docs touched by the release phase (not this node's commit): `docs/mcp.md`, `docs/cli-reference.md`

## Risks and open questions

- The mention scan is O(pages x terms) in the explicit-reference collector (already true today for the title-only loop); alias terms grow the term set. The existing vault-size bounds apply; if the collector's cost regresses on large vaults, the term scan can reuse the masked-body lowercasing it already computes once per source page.
- `skip-ambiguous` decisions can list many pairs for a generic term shared by many pages; the existing `MIN_EXPLICIT_REFERENCE_TITLE_LENGTH` guard keeps the common noise out, and dry-run default means the operator sees the list before any apply.
- JSX tag detection in a line grammar misclassifies contrived lines (a capitalized comparison operand, a multi-line JSX open); the module comment documents the heuristic limits, and the conservative skip rules keep false edges out at the cost of missing some usages.
- The ledger scan on `lookupKey` is linear over shards; a batch retry on a vault with heavy idempotency traffic pays the same scan the signal writers already pay.
- Open question resolved during implementation: the exact export home for `resolveUniqueMatch` (module placement must respect the codebase's import-direction conventions between `src/core/graph/` and `src/core/brain/`).
