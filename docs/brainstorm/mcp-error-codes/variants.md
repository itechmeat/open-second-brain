# Stable error codes at the MCP boundary - variants (audit trail)

Consultant: Claude Code (`claude -p`, primary), prompt in `cli-output/prompt.md`, raw output in `cli-output/claude.md`. It returned three parseable variants and exited 0, so the Codex fallback was not run.

## Variants, verbatim

### Variant 1: Boundary interceptor with a namespaced `_meta` error envelope
- **Approach**: Add one registry module (frozen `MCP_ERROR_CODES` object, members list, guard, census test) and teach the two existing choke points to read a structural `readonly code: string` off any thrown error: `toolError` in server.ts attaches `_meta["open-second-brain/error"] = {code, surface}` next to the unchanged text body, and the MCPError builder copies the code into `data.code` where a wrapping site (skill-tools rewrap, `searchErrorToMcp`) currently drops it. Throws without a code get the single registered `unclassified` code, and `withProgressRefusal` is changed to merge `_meta` instead of replacing it. Rerank liveness joins the same release as a new `RETRIEVAL_DEGRADATION` member `rerank_skipped` whose detail is an identifier reason (`provider_sunset`, `provider_unreachable`, `provider_error`), fed by a rerank sunset survey that reuses the generic classifier from `embeddings/sunset.ts`, a `doctor/rerank-sunset-check.ts` registered in the exit census, and a cache-write bypass when that degradation is present.
- **Trade-offs**:
  - Pro: two change points cover all ~28 coded classes and every surface at once; no per-tool rewiring.
  - Pro: text bodies and existing `data.code` spellings stay byte-identical; `_meta` passes strict SDK result validation, mirroring the existing progress key.
  - Pro: the census test forces each listed code to a live producer and surfaces casing drift as data, without rewriting it.
  - Pro: rerank skip stays inside the closed-vocabulary convention and flows into `search --explain` for free.
  - Con: mixed snake/kebab/UPPER casing is inherited onto the wire as-is; a normalization pass would be a second release.
  - Con: structural duck-typing can pick up unrelated `code` fields (Node `ENOENT` strings); needs the guard to whitelist registry members and route the rest to `unclassified`.
  - Con: the `_meta` merge in progress.ts is a behavior change that needs its own test.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Shared `CodedError` base class, codes normalized at the source
- **Approach**: Introduce an abstract `BrainError` base in core carrying `code`, `surface`, and `retryable`, migrate the ~28 existing coded classes to extend it, and add new `WorkspaceError` and `WriteSessionError` classes with their own enumerated vocabularies for the currently prose-only paths. The server detects errors by `instanceof` and emits both `data.code` (channel A) and the `_meta` envelope (channel B); a `wire` alias table keeps already-emitted spellings while new codes use one canonical casing. Rerank becomes a typed `RerankOutcome` returned by post-rank, consumed by the trail as a degradation member, by doctor, and by the cache layer to skip caching degraded results.
- **Trade-offs**:
  - Pro: strongest typing and one place to answer "what codes exist"; `retryable` lets clients branch on retry versus fallback without a second table.
  - Pro: workspace and write-session refusals gain real codes instead of `unclassified`.
  - Pro: the typed `RerankOutcome` cleanly separates "did not run" from "ran and failed" for the explain and doctor surfaces.
  - Con: touches 28 classes across core; large diff with real chances of altering a message string or a pinned `toBe` text.
  - Con: `instanceof` is brittle across module duplication and the Hermes plugin boundary; structural detection would still be needed as a fallback.
  - Con: two vocabularies (canonical plus wire aliases) is a second convention the constraints warn against.
  - Con: converting write-session prose refusals to typed errors risks moving them between channels and changing wire shape for clients.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Per-surface mapping tables extending the search precedent
- **Approach**: Keep the server untouched and replicate the `searchErrorToMcp` pattern per tool module: `skillErrorToMcp`, `workspaceErrorToMcp`, `writeSessionErrorToMcp`, each with a sibling `*_ERROR_CODES` frozen vocabulary and each producing an `MCPError` with `data.code`. Unmapped throws stay on the prose-only channel B path. Rerank liveness is reported as its own `rerank: {ran, skipped_reason}` block in the retrieval trail rather than a degradation member, with a doctor section that reads the provider registry and a static rerank sunset table.
- **Trade-offs**:
  - Pro: smallest server-side change; each mapping is explicit and locally reviewable, exactly like the existing search module.
  - Pro: no duck-typing, no `_meta` merge change in progress.ts.
  - Con: N mapping sites drift independently; a new tool module ships uncoded unless someone remembers the mapper, which is the gap that produced today's state.
  - Con: moving skill and workspace errors from a `isError` tool result to a JSON-RPC error changes the wire shape clients already see, even though message text is unchanged.
  - Con: a separate `rerank` trail block diverges from the closed `RETRIEVAL_DEGRADATION` convention and does not surface in existing degradation-driven output paths.
  - Con: still leaves the cached-degraded-rerank problem unless handled separately.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: It satisfies every hard constraint directly: text bodies stay byte-identical, no error payload touches `structuredContent`, existing `data.code` spellings are preserved, and the registry census enforces a live producer per code. Two interception points plus the existing namespaced `_meta` precedent deliver cross-surface coverage without the 28-class migration of Variant 2 or the drift-prone per-module mappers and wire-shape change of Variant 3, and the rerank work lands inside the closed-vocabulary and sunset-survey conventions the repository already uses.

## Orchestrator decision

Variant 1 is taken, as the consultant recommended. It is the only variant that keeps text bodies byte-identical, keeps every error payload out of `structuredContent`, and covers every tool through the two seams in `server.ts` instead of relying on each module remembering a mapper (the failure mode that produced today's state, which Variant 3 repeats). Variant 2 was rejected because migrating about 28 core classes to a new base risks altering pinned message strings and adds a canonical-plus-alias second convention; Variant 3 was rejected because it leaves every unmapped throw prose-only, moves skill and workspace errors between channels, and puts rerank liveness outside the closed `RETRIEVAL_DEGRADATION` vocabulary.

Five parts of Variant 1 are overridden, with reasons recorded in `design.md` ("Orchestrator overrides of the consultant's Variant 1"):

1. An unclassified error maps to the existing explicit member `internal_error` and is logged by error name; no `unclassified` boundary code is added, because that would be a blank code by another name.
2. Classification is by `instanceof` over a closed table (with a bounded `cause` walk), not by structurally reading any `.code`, which would leak Node `ENOENT` and similar unregistered tokens.
3. Rerank gets two kebab-case members, `rerank-provider-unavailable` (with `detail.category` from a closed `RERANK_FAILURE_CATEGORY`) and `rerank-model-sunset`, instead of one snake-case `rerank_skipped`: the vocabulary is kebab throughout and names the cause in the code.
4. The `_meta` payload is `{ schema, code }` with no `surface` member.
5. The rerank code is documented as appearing in `--json` and MCP `brain_search`, not in `search --explain` (premise correction in `design.md`).

Orchestrator decisions taken before the consultant ran, and honoured by the chosen variant: channel B code in `_meta["open-second-brain/error"]` with the text unchanged; channel A `error.data.code` with the default derived at the single builder; `withProgressRefusal` merges `_meta`; one closed registry importing the core vocabularies unchanged; a sunset survey with entries only where a source was read; a config-only doctor check registered where the census tests demand; a rerank endpoint failure not written to the query cache; the missing `hybrid-deadline-exceeded` row added to `docs/cli-reference.md`; HTTP 429, the OpenClaw envelope and missing-key-as-degradation out of scope.
