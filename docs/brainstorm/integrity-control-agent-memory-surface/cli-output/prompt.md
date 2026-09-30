You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave for Open Second Brain combining six cards under the spine "Integrity and control of the agent-facing memory surface of Open Second Brain". All premises below were verified against the live source.

## Card 1 - t_ec6b155d: corpus-wide unique-match mention-to-wikilink edge resolution in link-graph through the apply-gated repair lane

Turn a prose mention of a known corpus page (its title or a declared frontmatter alias) into a link-graph edge, without the author writing a wikilink, under a unique-match-only discipline: a term binds to a target only when exactly one corpus page matches it; ambiguous terms link to nothing. Verified state: the apply-gated repair lane already ships (`src/core/brain/link-graph/repair-lane.ts` - `runRepairLane` writes proposed edges as wikilinks only after an exact confirmation phrase, dry-run default, confidence threshold, write cap, never creates dangling edges). Its `collectRepairCandidates` already collects an `explicit_reference` tier that matches a note's bare TITLE in another note's prose (wikilink and code spans masked, word-boundary, minimum title length 4). Verified gaps: (a) `buildAliasIndex` (`src/core/brain/link-graph/alias-index.ts`) is never consulted by the candidate collector, so alias spellings produce no candidates; (b) there is no unique-match rule - when two corpus pages share a title, a mention produces one candidate edge to EACH, so both false edges reach the operator's apply report; (c) the separate target-centric scanner `findUnlinkedMentions` (`src/core/brain/link-graph/unlinked-mentions.ts`) scans only `Brain/preferences/` + `Brain/retired/` and produces mention reports, not edges - it is not the corpus-wide path. The corpus walk in `loadPages` covers the whole vault with a readable status-scope filter. The increment: pool title + alias terms per corpus page, resolve each mention term to a target only when exactly one corpus page carries that term, feed the existing apply-gated lane.

## Card 2 - t_2356dace: bind relative import specifiers in pre-extract to ingested files, unambiguous resolution only, no Elixir/Rust/Ruby

The deterministic pre-extractor (`src/core/brain/ingest/pre-extract.ts`) emits `imports` edge seeds whose `to` is a raw module specifier (`./foo`, `../bar`, `from .mod import`); nothing binds them to the vault file that satisfies the specifier. Verified: `CodeEdgeSeed.kind` is `"imports" | "inherits"`; `LANGUAGE_BY_EXTENSION` (pre-extract.ts:61) covers .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.pyi only; the P4 pass runs off by default in `ingestSource` (`src/core/brain/ingest/ingest.ts`, `opts.preExtract`), and seeds travel on the result only, never into the summary page. The ingest content manifest (`src/core/brain/ingest/content-manifest.ts`, `readManifest`) records canonical vault-relative paths of ingested sources. Scope: bind RELATIVE specifiers only (TS/JS `./`- and `../`-prefixed, Python leading-dot `from .x import`), resolved against the ingested-file set, binding only when exactly one ingested file satisfies the specifier (extension probing over the supported extensions, candidate set ambiguity refuses); otherwise the seed stays raw. No new languages.

## Card 3 - t_998aa4e6: JSX component-usage edge kind in pre-extract, conservative DOM/member-tag skipping

Widen `CodeEdgeSeed.kind` with a new usage kind. When pre-extracting a .tsx/.jsx source, a JSX element opening tag (`<MyButton/>`, `<_Row>`) becomes an edge seed from the using file to the used component name, while conservatively skipping lowercase DOM tags (`<div>`) and member-expression tags (`<Nav.Item>`). Verified: the line grammar regexes (pre-extract.ts:74-99) cover class/function/extends/implements/import/require only - no JSX-element regex; the edge-push sites in `parseTsJs` (pre-extract.ts:144-164) have no usage site; `edgeKey` (pre-extract.ts:240-242) is already kind-aware, so dedupe/sort keys survive the widened union; .tsx/.jsx are already supported extensions.

## Card 4 - t_b34439d9: write-batch accepts a client request ID and returns a durable receipt, extending idempotency-ledger rememberKey semantics

`applyWriteBatch` (`src/core/brain/write-batch.ts`, MCP surface `brain_write_batch` in `src/mcp/brain/write-batch-tools.ts`) has no client request ID and no durable receipt: a lost MCP response forces a blind retry that can double-apply. Verified prior art in the same codebase: the idempotency ledger (`src/core/brain/idempotency-ledger.ts`) gives signal/preference/apply-evidence writes `rememberKey` semantics - `inserted` / `duplicate_match` / `payload_mismatch`, the stored record's `ref` carries the original write's coordinates, and the signal writer consults the ledger BEFORE writing, returns the original coordinates with `deduped: true` on a same-key-same-hash retry, and throws `IdempotencyPayloadMismatchError` on same-key-different-hash. MCP tools already accept an optional `idempotency_key` string param for those writers. Scope: the same semantics for the write batch - a client-supplied request ID, a payload hash over the batch's semantic operations, consult before commit, the retained original batch receipt returned on a same-key retry, an explicit named refusal on same-key-different-hash. NO durable-queue half (no expiry/queue machinery) and NO worktree-pause half - both explicitly struck by the validator.

## Card 5 - t_cb1e9d3d: one when-to-search cue in the brain_search description pointing at brain_recall_gate as the bound

The `brain_search` tool description (`src/mcp/search-tools.ts:1872`) is purely mechanical: "Full-text search across the vault. Optional semantic layer when configured. Read-only." - the agent gets no when-to-search calibration. Verified: `brain_recall_gate` (search-tools.ts:1863) exists and classifies recall attempts (sufficient/proceed, weak/re_recall, insufficient/abstain) - the validator ruled the cue must point AT brain_recall_gate as the bound rather than inventing a fan-out number. Scope: exactly one when-to-search cue sentence added to the brain_search description naming brain_recall_gate; the recall-inject header (recall-inject.ts:575, "Recalled vault context (relevance-matched to this prompt):") is already neutral and stays untouched; no fan-out counts, no parallel-search language.

## Card 6 - t_c5326ece: explicit caller-selectable AND/OR match mode in FTS via buildFtsMatch, operator tokens still dropped

`buildFtsMatch` (`src/core/search/fts.ts:31`) joins quoted tokens with an implicit AND; uppercase FTS5 operator tokens (AND/OR/NOT/NEAR) typed by the caller are dropped when other tokens remain; OR exists only as automatic synonym expansion in `buildExpandedFtsMatch`. Verified: no `matchMode`/`match_mode` exists anywhere in src/tests/docs. Threading path verified: `SearchOptions` (types.ts:810) -> `resolveSearchRequest` (pipeline/request.ts) -> `runKeywordLane` (search.ts:125, pipeline/keyword-lane.ts) -> `runFtsQueryDetailed` -> `buildFtsMatch`. Two other direct `runFtsQueryDetailed` callers (pipeline/second-pass.ts, evidence-verification.ts) use derived terms, not caller queries. Exposed surfaces: MCP `brain_search` input schema (search-tools.ts:106) and the CLI `o2b search` verb flags (src/cli/search/verbs/query.ts). Scope: an explicit caller-selectable ALL (default, unchanged) vs ANY (OR-joined) match mode through buildFtsMatch and the surfaces above; operator-typed operator tokens stay dropped in both modes; synonym expansion composes unchanged.

# Project context

Open Second Brain - a memory layer for AI agents living in an Obsidian vault. TypeScript on Bun 1.1+, no LLM in the deterministic kernel paths, MCP servers + lifecycle hooks + `o2b` CLI surfaces over one core.

Recent commits:
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0) (#215)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0) (#214)
0afa0c5a chore(deps): bump the bun-minor-and-patch group with 5 updates (#201)
f6212cd2 fix: quiet one-line Stop reminder via Claude Code feedback channel (v1.58.2) (#202)
534befdb chore(deps): bump the github-actions group with 3 updates (#200)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1) (#199)
6f33c424 feat: payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0) (#197)
d7e6094a feat: a second platform (v1.57.0) (#191)
54bb28d9 feat: what this install knows (v1.56.0) (#185)
5f415267 feat: who wrote what, and how to take it back (v1.55.0) (#184)
dc552590 feat: private is not a suggestion (v1.54.0) (#183)
23e6b81e fix(brain): merged pages leave the dedup pool, and the write seam refuses cycles (v1.53.1) (#182)
323e2f09 feat: nothing writes silently, nothing degrades silently (v1.52.0) (#178)

Related files:
- src/core/brain/link-graph/repair-lane.ts (apply-gated repair lane, collectRepairCandidates)
- src/core/brain/link-graph/alias-index.ts (buildAliasIndex)
- src/core/brain/link-graph/unlinked-mentions.ts (findUnlinkedMentions, target-centric)
- src/core/brain/ingest/pre-extract.ts (deterministic pre-extractor)
- src/core/brain/ingest/ingest.ts (P4 pass wiring, runPreExtract)
- src/core/brain/ingest/content-manifest.ts (ingested-file manifest)
- src/core/brain/write-batch.ts (atomic write-batch kernel)
- src/core/brain/idempotency-ledger.ts (rememberKey ledger)
- src/core/brain/signal.ts (established consult-before-write idempotency pattern)
- src/mcp/brain/write-batch-tools.ts (brain_write_batch MCP surface)
- src/mcp/search-tools.ts (brain_search, brain_recall_gate)
- src/core/search/fts.ts (buildFtsMatch, buildExpandedFtsMatch, runFtsQueryDetailed)
- src/core/search/pipeline/keyword-lane.ts, src/core/search/pipeline/request.ts, src/core/search/search.ts, src/core/search/types.ts (match-mode threading path)
- src/cli/search/verbs/query.ts (o2b search flags)
- tests/core/brain/, tests/core/search/, tests/mcp/ (colocated test suites)

Conventions:
- Deterministic kernel: no LLM, no wall-clock beyond caller-supplied time, output depends only on explicit inputs; no natural-language word lists anywhere (programming keywords count as grammar).
- Honesty: no fake empty success; unsupported/unresolvable states are named (typed errors, `extracted: false` with reason, machine-readable codes); "nothing writes silently, nothing degrades silently".
- Writes go through the vault-identity guard (`assertVaultIdentityForWrite`) and atomic writes (temp file + rename); byte-identical rewrites skip and say so.
- Client-facing idempotency: optional `idempotency_key` MCP param; ledger statuses inserted/duplicate_match/payload_mismatch; same-key-different-hash is a named error, never a silent overwrite.
- Parameter style: camelCase in core APIs, snake_case on MCP/CLI surfaces; optional knobs default to byte-identical behavior.
- Docs live beside the code as module doc comments; user-facing docs in docs/ (mcp.md, cli-reference.md, how-it-works.md). Tests are bun tests under tests/ mirroring src/ layout.

Constraints:
- No new external dependencies (runtime deps today: proper-lockfile only).
- Do not change existing public API shapes incompatibly: new parameters are optional and default to today's byte-identical behavior.
- No durable-queue or worktree-pause machinery (explicitly struck).
- No hardcoded natural-language phrases in any language beyond the established grammar-level tokens; the search description cue is the one sanctioned English prompt-layer string.
- All-or-nothing batch semantics must be preserved; the request-ID consult must run before any commit.
- Determinism in pre-extract: binding may depend only on explicit inputs (path, content, ingested-file set), never on ambient state.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
