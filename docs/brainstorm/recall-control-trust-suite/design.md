# Recall Control & Trust Suite - precise, auditable recall without a search rewrite

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain already has strong hybrid search, structural query intent, CJK-aware FTS, query expansion, MMR, link traversal, entity boost, recency, context packs, and explainable `reasons[]`. The remaining gap is caller control and trust: agents cannot submit a structured recall request, the FTS read path cannot self-heal a rebuildable desync, automatic context surfacing has no cheap skip gate, session-local focus cannot steer ranking, context packs do not separate constraints from directives, and evidence-spanning questions still return a flat result list.

This suite improves recall precision and auditability while preserving the existing search architecture. The default plain-string path must remain backward-compatible; richer behavior is opt-in through explicit options, CLI flags, or MCP arguments.

## Scope

- Add a deterministic structured recall query parser for `intent:`, `lex:`, `vec:`, and `hyde:` lanes.
- Add bounded FTS5 read-path hardening: natural-language operator-token cleanup, failure classification, one rebuild/retry for rebuildable FTS desync, and visible warnings.
- Add a pure retrieval surfacing gate for automatic context injection callers.
- Add session-scoped focus state and ranking contribution plumbing without teaching the Brain a permanent preference.
- Add polarity-aware context lanes (`directives`, `constraints`, `consider`) for context-pack style output.
- Add optional verified multi-record evidence packs with matched/missing term diagnostics and abstention reasons.
- Expose the new surfaces through focused CLI/MCP options and JSON fields while preserving current outputs by default.
- Add focused unit and integration tests for each atomic task.

## Out of scope

- Adding a vector database backend or changing the storage model.
- Replacing the existing `search.ts` orchestration with a new pipeline abstraction.
- Changing default result ranking for callers that do not opt into the new features.
- Learning retrieval weights from user feedback.
- LLM-based answer generation or LLM-based verification.
- Persisting session focus as a confirmed preference or durable Brain fact.
- Blocking explicit `brain_search` when the surfacing gate would skip automatic context.

## Chosen approach

Use surgical pure helpers around the existing search architecture. Each selected task gets a small, deterministic module and focused tests, then minimal wiring at the current owning boundary:

- parser before CLI/MCP search dispatch;
- FTS safety at the keyword retrieval boundary;
- gate before automatic context-surfacing callers;
- focus as an optional ranking input and reason contribution;
- polarity classification during context-pack assembly;
- evidence-pack verification as an optional post-search mode.

The implementation should prefer explicit data contracts over a new framework. The core stays deterministic and runtime-adapter independent; CLI and MCP remain thin parse/render layers.

## Design decisions

- Keep plain query behavior byte-compatible where possible; new behavior requires `--query-doc`, `--evidence-pack`, `--session-focus`, `--lanes`, or MCP equivalents.
- Represent structured query documents as parsed lane specs, not as a new query language for storage. `lex` routes to existing FTS, `vec` and `hyde` route through existing semantic policy and degrade to warnings when semantic search cannot run.
- Model FTS self-heal as a typed keyword retrieval outcome so warnings can flow through `SearchOutcome.warnings` without hiding real programmer errors.
- Keep retrieval gate pure and caller-owned. It classifies prompt text and returns `{ shouldSurface, reason }`; hook/adapter code decides whether to record a skipped-turn diagnostic.
- Store session focus in a small runtime file keyed by session id, with explicit set/status/clear operations and expiry. Search accepts focus as an option rather than reading global state implicitly.
- Add focus and lane contributions to the existing `reasons[]`/`why_retrieved` concept instead of inventing a second explanation channel.
- Build polarity lanes from existing context-pack candidates first; add deterministic classifier and optional frontmatter override, but keep the old flat context-pack output unless lane output is requested.
- Implement evidence packs as a separate optional result mode. It may internally run multiple searches, but it returns structured coverage diagnostics and abstains when significant terms have no support.

## File changes

Expected new files:

- `src/core/search/structured-query.ts`
- `src/core/search/fts-safety.ts`
- `src/core/search/surfacing-gate.ts`
- `src/core/search/session-focus.ts`
- `src/core/brain/context-lanes.ts`
- `src/core/search/evidence-pack.ts`
- focused test files under `tests/core/search/` and `tests/core/brain/`
- MCP/CLI integration tests under `tests/mcp/` and `tests/cli/`

Expected modified files:

- `src/core/search/fts.ts`
- `src/core/search/store.ts`
- `src/core/search/search.ts`
- `src/core/search/ranker.ts`
- `src/core/search/types.ts`
- `src/core/search/index.ts`
- `src/core/brain/context-pack.ts`
- `src/cli/search.ts`
- `src/cli/brain.ts` or related brain subcommand wiring for focus/context lanes
- `src/cli/command-manifest.ts`
- `src/mcp/search-tools.ts`
- `src/mcp/brain-tools.ts` if context-pack/focus MCP surfaces live there
- `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`

## Risks and open questions

- FTS rebuild tests must corrupt/desync the FTS table without creating nondeterministic SQLite failures.
- Structured `hyde` lanes may need to be treated as semantic text only; no LLM hypothetical-answer generation belongs in this PR.
- Session focus storage must avoid cross-session bleed and must not require a daemon.
- Evidence-pack verification can become expensive if implemented naively; cap candidate counts and keep it opt-in.
- The context-lane output shape must be explicit enough for MCP clients but should not bloat default tool output.
- The final implementation may trim one lower-priority task if Phase 2 proves the selected six-task scope risks a platform rewrite; any trim must be recorded in this design and plan before code completion.
