# Stable error codes at the MCP boundary - implementation plan

Design: `docs/brainstorm/mcp-error-codes/design.md` (decision numbers below refer to its "Design decisions" list).

## How to run this plan

Four lanes with DISJOINT file ownership, so the implement node can run them concurrently in the one worktree. A lane edits only the files listed under its own tasks. Every task is TDD: write the named test first, run it and see it fail for the stated reason, implement, see it pass, then `oxfmt` and `oxlint` on the lane's own files only, then `git add <own paths>` and a conventional commit (`feat(mcp): ...`, `feat(search): ...`, `feat(doctor): ...`, `docs: ...`). Retry on `index.lock`. Gates per task: `bun test <the task's test files>` and `bun run typecheck`.

### Cross-lane contract (fixed now, so lanes do not wait on each other's code)

Lane A exports from `src/mcp/tool-error-codes.ts`:
- `TOOL_ERROR_META_KEY = "open-second-brain/error"`, `TOOL_ERROR_SCHEMA = "o2b.error.v1"`
- `TOOL_ERROR_CODE` (frozen object of the new tokens, decision 5), `TOOL_ERROR_CODES` (closed list incl. imported vocabularies), `type ToolErrorCode`, `isToolErrorCode(value)`
- `codeForError(exc: unknown): ToolErrorCode`, `defaultCodeForRpc(code: JsonRpcErrorCode): ToolErrorCode`, `toolErrorMeta(code): { schema, code }`

The complete new-token list is the one in decision 5: `parse_error`, `invalid_request`, `method_not_found`, `invalid_params`, `internal_error`, `safeguard_timeout`, `safeguard_aborted`, `output_contract_failed`, `config_unreadable`, `skill_not_found`, `skill_invalid_path`, `unknown_skill`, `unknown_operation`, `invalid_status`, `trigger_transition_refused`, `write_session_unknown`, `write_session_terminal`, `session_id_required`, `unknown_argument`. Lane B uses only these plus the imported vocabularies. A token lane B finds missing is reported to the orchestrator, never added by lane B.

Lane C exports:
- from `src/core/search/rerank/failure.ts`: `RERANK_FAILURE_CATEGORY` (`auth`, `quota`, `gone`, `rejected`, `transient`, `timeout`, `network`, `malformed`, `unclassified`), `RERANK_FAILURE_CATEGORIES`, `type RerankFailureCategory`, `isRerankFailureCategory`, `RerankEndpointError`, `rerankCategoryForStatus(status: number)`
- from `src/core/search/rerank/sunset.ts`: `RERANK_SUNSET_SURVEY`, `classifyRerankSunset(model, nowMs, survey?)`
- from `src/core/search/retrieval-trail.ts`: `RETRIEVAL_DEGRADATION.rerankProviderUnavailable = "rerank-provider-unavailable"`, `RETRIEVAL_DEGRADATION.rerankModelSunset = "rerank-model-sunset"`

### File ownership (every file this plan touches, exactly one owner)

| Lane | Owns |
| ---- | ---- |
| A boundary | `src/mcp/tool-error-codes.ts` (new), `src/mcp/protocol.ts`, `src/mcp/server.ts`, `src/mcp/progress.ts`, `src/mcp/output-contract.ts`, `tests/mcp/tool-error-codes.test.ts` (new), `tests/mcp/tool-error-envelope.test.ts` (new), `tests/mcp/mcp.test.ts`, `tests/mcp/progress-token.test.ts` |
| B surfaces | `src/mcp/search-tools.ts`, `src/mcp/brain/recall-tools.ts`, `src/mcp/skill-tools.ts`, `src/mcp/brain/workspace-tools.ts`, `src/mcp/brain/context-tools.ts`, `src/core/brain/write-session/engine.ts`, `src/mcp/argument-guard.ts`, `src/mcp/reach-refusal.ts`, `src/mcp/coerce.ts`, `tests/mcp/search-error-mapping.test.ts`, `tests/mcp/surface-error-codes.test.ts` (new) |
| C rerank | `src/core/search/rerank/failure.ts` (new), `src/core/search/rerank/sunset.ts` (new), `src/core/search/rerank/index.ts`, `src/core/search/rerank/cross-encoder.ts`, `src/core/search/retrieval-trail.ts`, `src/core/search/pipeline/post-rank.ts`, `src/core/search/search.ts`, `tests/core/search/rerank-failure.test.ts` (new), `tests/core/search/rerank-sunset.test.ts` (new), `tests/core/search/rerank.test.ts`, `tests/core/search/rerank.search.test.ts`, `tests/core/search/retrieval-trail.test.ts` |
| D doctor, docs, shared tests | `src/core/brain/doctor/rerank-health-check.ts` (new), `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts`, `src/core/brain/doctor-exits.ts`, `tests/core/brain/doctor/rerank-health-check.test.ts` (new), `tests/helpers/tool-error-envelope.ts` (new), `tests/core/architecture/verdict-vocabulary-census.test.ts`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md` |

Shared files and how they are handled:
- `src/mcp/search-tools.ts` is touched by B only. C's two new degradation codes reach its `brain_search` outputSchema automatically (the enum is spread from `RETRIEVAL_DEGRADATION_CODES`, `search-tools.ts:520-545`), so C does not edit it.
- `src/mcp/tool-error-codes.ts` is A's. B depends on its exports (contract above) and never edits it.
- `tests/core/architecture/verdict-vocabulary-census.test.ts` registers both A's and C's new four-piece vocabularies; D owns it. Until D1 lands, the census test fails on the integrated tree; it is expected to be red only between A1/C1 and D1.
- `tests/helpers/tool-error-envelope.ts` is D's (task D0, which needs only A1's constants). A's and B's tests import it once it exists; a lane that starts before D0 reads the envelope inline in its own test file and switches to the helper in its own file later. D never edits A's or B's tests.
- `CHANGELOG.md`, `package.json` and the mirrored manifests are NOT in this plan: the version bump (minor, 1.66.0) and the CHANGELOG entry ride in phase 5 of osb-pr-prepare.
- If `bun run typecheck` after A2 flags an `MCPError` site in a lane-B file (risk 1), lane B fixes that throw's type in its own file; lane A does not edit it.

Dependency summary: A1 -> A2 -> A3; A1 -> B1..B5; C1 -> C2 -> C3; A1 + C1 -> D1; C3 -> D2; A1 -> D0; all -> D3 (D3 can be drafted from the design and finalized last).

## Tasks

### Lane A - boundary registry, server seam, progress merge

### Task A1: closed boundary registry and classifier
- **Files**: `src/mcp/tool-error-codes.ts` (new), `tests/mcp/tool-error-codes.test.ts` (new)
- **Test first**: (a) `TOOL_ERROR_CODES` is frozen, unique, and contains every member of each imported vocabulary (`SEARCH_ERROR_CODES`, `SHAPE_VIOLATION_CODES`, `SEMANTIC_VIOLATION_CODES`, `VAULT_FROZEN_REFUSAL`, `WRITE_BINDING_REFUSED_CODE`, `REACH_REFUSAL`, `OWNER_SCOPE_REFUSALS`, and the type-only vocabularies of write batch, create note, note lifecycle, note revert, scaffold stub, note title resolution, note template, pinned, exact state, host memory write, count guard) plus exactly the 19 new tokens; (b) the pinned wire tokens `budget_exceeded`, `invalid_action`, `invalid_target`, `vault_frozen` are members verbatim; (c) every new token matches `^[a-z][a-z0-9_]*$`; (d) `defaultCodeForRpc` maps each of the five JSON-RPC constants to its snake token; (e) `codeForError` returns the carried code for a `WriteBatchError`, `SearchError`, `PinnedBatchError`; `safeguard_timeout` / `safeguard_aborted` for the safeguard errors; `config_unreadable` for `ConfigReadError`; `config_invalid` for `BrainConfigError`; `preference_not_found` for a plain `Error` whose `cause` is `BrainPreferenceNotFoundError`; (f) a plain `Error`, a Node fs error carrying `code: "ENOENT"`, and a non-Error throw all return `internal_error`, and each writes exactly one stderr line `warning: unclassified tool error mapped to internal_error: <name>` (spy on `process.stderr.write`; the line never contains the message).
- **Implementation notes**: type-only vocabularies get a member array declared with `satisfies ReadonlyArray<X>` and a compile-time exhaustiveness check (decision 4); the `instanceof` table is a closed `ReadonlyArray<[ctor, code | (e) => code]>`; the cause walk has a named depth constant; core files are not edited.
- **Acceptance**: the new test passes; `bun run typecheck` is clean.
- **Depends on**: none

### Task A2: channel A default code at the single builder
- **Files**: `src/mcp/protocol.ts`, `src/mcp/server.ts`, `tests/mcp/tool-error-envelope.test.ts` (new, channel A part)
- **Test first**: through `MCPServer.handleRequest`: (a) an unknown method answers `error.data.code === "method_not_found"`; (b) a tool throwing `MCPError(INVALID_PARAMS, msg)` with no data answers `data: { code: "invalid_params" }` and `message` unchanged; (c) a thrower-supplied `data.code` (pinned `budget_exceeded`) is untouched; (d) a record `data` without a code (argument guard shape) keeps every member and gains `code` last; (e) a non-`MCPError` throw outside `tools/call` answers `INTERNAL_ERROR`, message `internal error: <redacted>` unchanged, `data.code === "internal_error"`, and logs the stderr line.
- **Implementation notes**: narrow `MCPError.data` to `Readonly<Record<string, unknown>> | undefined` and add `type JsonRpcErrorCode` over the five constants (decision 3); `errorResponse(requestId, code: JsonRpcErrorCode, message, data?)` merges the default code (decision 2); `stdio.ts` and `http.ts` transport errors inherit it with no edit there; add one stdio parse-error case to the test.
- **Acceptance**: new test passes; existing `tests/mcp/frozen-refusal.test.ts`, `argument-guard.test.ts`, `brain-memory-bridge.test.ts`, `brain-pinned-context.test.ts`, `brain-create-note.test.ts`, `search-error-mapping.test.ts` still pass unchanged; `bun run typecheck` clean.
- **Depends on**: A1

### Task A3: channel B `_meta` code and progress merge
- **Files**: `src/mcp/server.ts`, `src/mcp/progress.ts`, `src/mcp/output-contract.ts`, `tests/mcp/tool-error-envelope.test.ts` (channel B part), `tests/mcp/mcp.test.ts`, `tests/mcp/progress-token.test.ts`
- **Test first**: (a) a handler throwing a safeguard timeout yields `isError: true`, `content[0].text` byte-identical to v1.65.0, `structuredContent` absent, `_meta["open-second-brain/error"]` equal to `{ schema: "o2b.error.v1", code: "safeguard_timeout" }`; (b) the output-contract failure in `mcp.test.ts:640-643` additionally carries `output_contract_failed`; (c) a call with a progress token over a single-response transport that then fails carries BOTH `_meta` keys; (d) a successful call with no progress token has no `_meta` key at all (byte-identical); (e) an unclassified throw carries `internal_error` and logs once.
- **Implementation notes**: `toolError(message, code)` gets its code from `codeForError` at the catch (`server.ts:463-478`); `output-contract.ts` throws a named `OutputContractError` with the same message and A1's table maps it; `withProgressRefusal` merges (decision 10).
- **Acceptance**: tests pass; `tests/mcp/schema-tools.test.ts:273-277`, `long-running-tools.test.ts`, `brain.test.ts:508, 718`, `visibility-matrix.test.ts` pass unchanged.
- **Depends on**: A2

### Lane B - per-surface mappers

### Task B1: search codes reach the wire
- **Files**: `src/mcp/search-tools.ts`, `src/mcp/brain/recall-tools.ts`, `tests/mcp/search-error-mapping.test.ts`
- **Test first**: every `SearchError` code mapped by `searchErrorToMcp` yields `data.code === <the SearchError code>`, with `message` and numeric code unchanged (the `EMBEDDING_QUOTA_MESSAGE` `toBe` pin stays); the fallback arm keeps its `[CODE]` suffix; the recall path (`recall-tools.ts:959`) carries the code too.
- **Acceptance**: test passes; `tests/mcp/search-*.test.ts` pass.
- **Depends on**: A1

### Task B2: skill errors
- **Files**: `src/mcp/skill-tools.ts`, `tests/mcp/surface-error-codes.test.ts` (new, skills part)
- **Test first**: an unknown skill answers `data.code === "unknown_skill"`; a `SkillError` `NOT_FOUND` answers `skill_not_found`, `INVALID_PATH` answers `skill_invalid_path`; messages unchanged.
- **Implementation notes**: a total `Record<SkillErrorCode, ToolErrorCode>` (decision 7); `src/core/surface/skills.ts` is not edited.
- **Acceptance**: test passes; existing skill tool tests pass.
- **Depends on**: A1

### Task B3: workspace refusals
- **Files**: `src/mcp/brain/workspace-tools.ts`, `tests/mcp/surface-error-codes.test.ts` (workspace part)
- **Test first**: an unknown `brain_intention` or `brain_trigger` operation answers `unknown_operation`; an unknown trigger status answers `invalid_status`; a transition on an absent id and on an id the caller may not see answer the SAME `trigger_transition_refused` and byte-identical messages (decision 9).
- **Acceptance**: test passes; existing workspace tests pass.
- **Depends on**: A1

### Task B4: write-session codes
- **Files**: `src/core/brain/write-session/engine.ts`, `src/mcp/brain/context-tools.ts`, `tests/mcp/surface-error-codes.test.ts` (write-session part)
- **Test first**: an op needing a session without `session_id` answers `session_id_required`; an unknown id answers `write_session_unknown`; a terminal session answers `write_session_terminal`; an error carrying `errors[]` keeps `data.errors` byte-identical and gains the seam default `invalid_params`; messages unchanged.
- **Implementation notes**: `WriteSessionRequestError` gains an optional `code` (constructor option, so every other site stays valid and keeps the seam default, which matches its JSON-RPC code); `context-tools.ts:164-173` forwards it into `data`.
- **Acceptance**: test passes; `tests/core/brain/write-session*` and `tests/mcp/*write-session*` pass.
- **Depends on**: A1

### Task B5: argument guard, reach refusal, owner-scope refusal
- **Files**: `src/mcp/argument-guard.ts`, `src/mcp/reach-refusal.ts`, `src/mcp/coerce.ts`, `tests/mcp/surface-error-codes.test.ts` (refusal part)
- **Test first**: an undeclared argument answers `data.code === "unknown_argument"` with `tool`, `unknown_arguments`, `declared_arguments` unchanged; a caller-supplied reach answers `caller-supplied-reach`; an owner-scope refusal answers `foreign-owner` or `unresolved-identity` as its outcome names.
- **Acceptance**: test passes; `argument-guard.test.ts`, `reach-refusal.test.ts`, `owner-scope-refusal.test.ts` pass unchanged.
- **Depends on**: A1

### Lane C - rerank codes, sunset, cache

### Task C1: typed rerank failure category
- **Files**: `src/core/search/rerank/failure.ts` (new), `src/core/search/rerank/cross-encoder.ts`, `src/core/search/rerank/index.ts`, `tests/core/search/rerank-failure.test.ts` (new), `tests/core/search/rerank.test.ts`
- **Test first**: `rerankCategoryForStatus` maps 401/403 auth, 402 quota, 404/410 gone, 408/429/5xx transient, other 4xx rejected; with `tests/helpers/fake-http.ts`, an endpoint timeout, a network failure, a non-JSON body, a wrong score count and a duplicate index each surface a telemetry event `{ status: "error", category: <expected> }`, and every thrown error keeps `code === "RERANK_PROVIDER_HTTP"` and its v1.65.0 message; a provider throwing a plain `Error` yields `unclassified`.
- **Implementation notes**: decision 12; the vocabulary is a four-piece one (frozen object, list, guard, type), registered in the census by D1.
- **Acceptance**: tests pass; `rerank.decision-model.test.ts` passes unchanged.
- **Depends on**: none

### Task C2: `rerank-provider-unavailable` in the trail, not cached
- **Files**: `src/core/search/retrieval-trail.ts`, `src/core/search/pipeline/post-rank.ts`, `src/core/search/search.ts`, `tests/core/search/retrieval-trail.test.ts`, `tests/core/search/rerank.search.test.ts`
- **Test first**: (a) HTTP 503 from the rerank endpoint yields the heuristic order, the `rerank_degraded:` warning unchanged, and `retrieval_trail.degraded` containing `{ code: "rerank-provider-unavailable", detail: { category: "transient" } }`; (b) the same query run twice calls the endpoint twice (the degraded outcome was not cached); (c) a healthy rerank and a disabled rerank produce no trail; (d) every code still has a unique non-empty sentence, and the new sentence names no provider.
- **Implementation notes**: decisions 11, 13, 16; `PostRankOutcome.degraded` merged at `search.ts:485`; the cache bypass sits beside the `decisionFallback` rule at `search.ts:517`.
- **Acceptance**: tests pass; `tests/mcp/search-retrieval-trail.test.ts` and `tests/cli/search-retrieval-trail.test.ts` pass unchanged.
- **Depends on**: C1

### Task C3: rerank sunset survey and skip
- **Files**: `src/core/search/rerank/sunset.ts` (new), `src/core/search/rerank/index.ts`, `src/core/search/pipeline/post-rank.ts`, `src/core/search/retrieval-trail.ts`, `tests/core/search/rerank-sunset.test.ts` (new), `tests/core/search/rerank.search.test.ts`
- **Test first**: (a) every survey entry has a non-empty `source`, and `reviewedAt` parses; (b) with an injected survey holding a past date for the configured model, the search makes NO HTTP call (fake-http records zero requests), returns the heuristic order and carries `rerank-model-sunset`; (c) a future announced date, an off-survey model and a surveyed negative all call the endpoint as today; (d) kinds `local` and `decision-model` never consult the survey; (e) a sunset outcome is cached (second identical query makes no request and returns the same trail).
- **Implementation notes**: decisions 14, 15 and premise correction 5. Survey rows: read https://docs.cohere.com/docs/deprecations and record the `rerank-*-v2.0` models with the date and announcement the page states; read https://zeroentropy.dev/articles/zeroentropy-is-joining-notion/ and the model cards for the `zerank-*` checkpoints and record them as open-checkpoint negatives with that source. Set `reviewedAt` to the day the pages are read. No row without a read source. The header records why the ZeroEntropy hosted shutdown is liveness, not a sunset.
- **Acceptance**: tests pass; `nowMs` reaches post-rank from the existing clock in `search.ts`, never `Date.now()` inside rerank.
- **Depends on**: C2

### Lane D - doctor check, docs, shared test helpers

### Task D0: envelope test helper
- **Files**: `tests/helpers/tool-error-envelope.ts` (new)
- **Test first**: none of its own (a pure reader); it is exercised by A3's and B's tests that adopt it.
- **Implementation notes**: `readToolErrorCode(result)` reads `result._meta[TOOL_ERROR_META_KEY].code`; `readRpcErrorCode(response)` reads `response.error.data.code`; both import A1's constants and throw a named assertion error when the member is missing, never return `undefined` silently.
- **Acceptance**: `bun run typecheck` clean.
- **Depends on**: A1

### Task D1: census registration
- **Files**: `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Test first**: on the integrated tree with A1 and C1, the census scan fails naming `TOOL_ERROR_CODE` and `RERANK_FAILURE_CATEGORY` as unregistered.
- **Implementation notes**: register both beside the `EMBEDDING_SUNSET*` and `RETRIEVAL_DEGRADATION` entries; the rerank sunset adds no vocabulary (decision 14).
- **Acceptance**: the census test passes.
- **Depends on**: A1, C1

### Task D2: config-only rerank doctor check
- **Files**: `src/core/brain/doctor/rerank-health-check.ts` (new), `src/core/brain/doctor.ts`, `src/core/brain/diagnostics.ts`, `src/core/brain/doctor-exits.ts`, `tests/core/brain/doctor/rerank-health-check.test.ts` (new)
- **Test first**: (a) rerank disabled: no finding; (b) enabled `openai-compat` with no base URL, no model, no key, or an unregistered `search_rerank_provider` name: one `rerank-endpoint-unconfigured` error; (c) an injected survey with an announced date inside 90 days or in the past: `rerank-model-sunset-announced` warning naming the model and the date; (d) off-survey model: `rerank-model-sunset-unsurveyed` uncertain; stale survey: `rerank-model-sunset-undetermined` uncertain; (e) the check makes no network call; (f) `tests/core/brain/doctor-exit-census.test.ts` passes with the four codes registered.
- **Implementation notes**: decision 17; the factory takes the survey as a parameter (as `makeEmbeddingSunsetCheck` does); the window is `EMBEDDING_SUNSET_WARNING_WINDOW_DAYS` imported, not a second literal; registered after `embeddingsHealthCheck` in `DOCTOR_CHECKS`.
- **Acceptance**: tests pass, doctor census green.
- **Depends on**: C3

### Task D3: docs
- **Files**: `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`
- **Test first**: none (prose); verified by reading the rendered tables and by `bun run link-ratchet:check` and `check:paths`.
- **Content**: `docs/mcp.md` gains "### Tool errors (since v1.66.0)" under "Protocol": the two channels, `error.data.code` and `_meta["open-second-brain/error"]`, the payload shape, the closed code list (generic tokens plus a pointer to each imported vocabulary), the casing note, the `internal_error` rule, and that text bodies are unchanged. `docs/cli-reference.md`: trail table gains `hybrid-deadline-exceeded` (orchestrator decision 4), `rerank-provider-unavailable` (with the `detail.category` members) and `rerank-model-sunset`; the doctor section lists the four rerank codes. `docs/how-it-works.md:1096` names the trail code beside the `rerank_degraded:` warning and the no-cache rule. English, "Open Second Brain" in full, no exclamation marks, no card ids.
- **Acceptance**: tables match the source vocabularies member for member.
- **Depends on**: A3, B1-B5, C3, D2 (drafted early, finalized last)
