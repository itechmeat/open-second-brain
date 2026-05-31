You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Multi-task PR scope selected by the operator: Recall Control & Trust Suite.

## Task t_b25d9891 - [upstream:flowstate-qmd] Structured recall query documents with lex, vector, HyDE, and intent lanes

**Source**: https://github.com/amanning3390/flowstate-qmd
**Upstream files studied**: `docs/SYNTAX.md`, `README.md`, `src/mcp/server.ts`, `src/store.ts`, `src/embedded-skills.ts`

### What

FlowState-QMD lets capable agents submit a structured recall request instead of one ambiguous string. A query document can include an optional `intent:` line plus typed search lanes such as `lex:`, `vec:`, and `hyde:`. Lexical lanes support exact phrases and negation; semantic lanes are validated separately; the server routes each lane to the right backend, fuses the ranked lists, and can expose explanation traces. The transferable feature is an agent-authored retrieval grammar, not a new ranking trick by itself.

### Why useful for OSB

OSB already has hybrid search, query intent classification, synonyms, MMR, link traversal, entity boost, recency, filters, and `why_retrieved`. Those are mostly internal ranking controls around a user query. Agents often know more structure than a single string can carry: an exact filename or phrase that must match, a semantic paraphrase for fuzzy recall, a hypothetical answer shape, and an intent that disambiguates overloaded terms. A small query-document grammar would let agents ask OSB for evidence in those lanes explicitly while keeping results auditable.

### Current OSB status

- **Verdict**: present_weaker
- **Local evidence**: OSB search can classify intent and combine multiple recall signals, but I did not find an agent-facing structured query document format that accepts typed lexical, semantic, hypothetical-answer, and intent lanes as one request.
- **Related existing work, not a duplicate**: existing query expansion rewrites the query inside OSB; property filters narrow result sets; `why_retrieved` explains selected evidence. This task gives callers a precise, inspectable request grammar and records which lane contributed each result.

### Proposal

Add an OSB structured recall query format for CLI/MCP. Start with a conservative parser for `intent:`, `lex:`, `vec:`, and `hyde:` lines, validate syntax per lane, route lexical requests to FTS and semantic requests to the configured embedding provider, fuse results through the existing ranker, and include lane-level contribution details in `why_retrieved`.

### Acceptance criteria

- CLI and MCP accept a structured recall document as input without breaking the existing plain-string search path.
- Lexical lanes support quoted phrases and safe negation with clear validation errors for malformed syntax.
- Semantic and HyDE lanes degrade gracefully when semantic search is disabled or embeddings are stale.
- Result explanations show the source lane, backend, rank contribution, score contribution, and final selected snippet.
- Tests cover mixed lex/vector requests, intent-only disambiguation, malformed lane syntax, semantic-disabled fallback, and duplicate result fusion.

## Task t_38ec86bd - [upstream:Sibyl-Memory] Search-path FTS5 self-healing and natural-query hardening

**Source**: https://github.com/Sibyl-Labs/Sibyl-Memory
**Upstream files studied**: `sibyl-memory-client/src/sibyl_memory_client/client.py`, `sibyl-memory-client/CHANGELOG.md`

### What

Sibyl-Memory hardened its FTS5 query path in two useful ways. First, it classifies FTS5 failures so malformed user queries, missing schema, and backend corruption produce different outcomes. Second, when an external-content FTS5 index is corrupted or desynchronized, search attempts a bounded `rebuild` from the intact base table and retries once; if the index is still broken, the failure is contained instead of crashing the caller. It also drops standalone uppercase FTS5 operator tokens such as `AND`, `OR`, `NOT`, and `NEAR` from natural-language queries so users do not accidentally require those words literally.

### Why useful for OSB

OSB search is a core Second Brain surface. It already has CJK-aware FTS, query expansion, semantic ranking, MMR, link traversal, entity boost, recency, query cache, `why_retrieved`, and watchdog repair recommendations. The remaining reliability gap is query-path containment: a corrupted FTS shadow table or an awkward natural query should not make the agent lose memory access or silently miss obvious results. The system should repair what is rebuildable, fail loudly for true query errors, and preserve recall for common natural-language connector words.

### Current OSB status

- **Verdict**: present_weaker
- **Local evidence**: `src/core/search/fts.ts` safely phrase-quotes tokens and handles CJK tokenization, while `src/core/search/store.ts` probes FTS5 availability and `brain_watchdog` can recommend search-index repair. CodeGraph did not show a search-path FTS rebuild/retry helper, and current token handling keeps operator words as literal required tokens.
- **Related existing work, not a duplicate**: Watchdog recovery is an operator/probe surface. This task is about bounded self-healing inside the read path and improved natural-query tokenization.

### Proposal

Add an internal FTS safety layer around OSB keyword retrieval that classifies FTS failures, rebuilds rebuildable FTS indexes once, retries the query, and preserves clear error semantics. Extend `buildFtsMatch` tokenization to drop standalone FTS operator tokens when doing so does not empty the query.

### Acceptance criteria

- A corrupted rebuildable FTS table is rebuilt once and the original search retries successfully.
- If rebuild fails, search returns a controlled `SearchError` or warning shape rather than an uncaught SQLite exception.
- Programming/binding errors remain visible and are not converted to empty results.
- Natural-language queries containing uppercase `AND`, `OR`, `NOT`, or `NEAR` do not require those words literally when other meaningful terms exist.
- Queries made only of those words still search for the literal words.
- CLI and MCP search outputs include enough warning metadata for operators to know a self-heal happened.

## Task t_0e2f3a60 - [upstream:ClawMem] Adaptive retrieval gate for automatic context surfacing

**Source**: https://github.com/yoloshii/ClawMem
**Upstream files studied**: `README.md`, `src/retrieval-gate.ts`, `src/hooks.ts`, `src/hooks/context-surfacing.ts`

### What

ClawMem does not run expensive or noisy memory retrieval for every possible prompt. Its context-surfacing hook skips slash commands, very short prompts, greetings, confirmations, shell-command-shaped turns, and repeated heartbeat/dedupe prompts. It also filters obviously useless retrieved bodies before injection and records empty-turn usage rows when needed so later recall attribution stays aligned with transcript turns. The transferable feature is a prompt-aware gate around automatic retrieval, separate from the search engine itself.

### Why useful for OSB

OSB has strong explicit search and context-pack tools, and it is increasingly used through hooks and multiple agent runtimes. As automatic context surfacing grows, quality depends on knowing when _not_ to retrieve: pings, status checks, trivial acknowledgements, command-only turns, or noisy tool chatter should not burn token budget, create misleading usage telemetry, or reinforce irrelevant memories. This is a read-path complement to capture-boundary filtering.

### Current OSB status

- **Verdict**: not_in_osb_useful
- **Local evidence**: Existing OSB work covers context-pack size limits, query intent, search ranking, source-aware session/message capture boundaries, and token-footprint diagnostics. I did not find a dedicated automatic-surfacing gate that classifies a prompt before retrieval, suppresses empty/noisy injections, and preserves telemetry alignment for skipped turns.
- **Related existing work, not a duplicate**: source-aware capture boundaries decide which runtime sessions/messages become Brain evidence. This task decides whether a particular live prompt deserves Brain recall/injection at all.

### Proposal

Add a retrieval gate for OSB host hooks and automatic context-pack injection. The gate should be deterministic, configurable, cheap, and observable: it should skip obvious non-memory prompts, avoid raw prompt persistence before meaningful retrieval, and report why surfacing was skipped in debug mode.

### Acceptance criteria

- Automatic context surfacing skips configured noise prompt classes without invoking semantic/vector retrieval.
- Skipped turns have explicit reasons in diagnostics and do not pollute learned recall signals.
- Transcript-visible skipped turns preserve attribution alignment for later feedback loops.
- The gate is configurable per runtime/profile and fail-open for unknown prompt shapes.
- Tests cover greetings, slash commands, shell commands, duplicate prompts, real memory questions, and post-retrieval noise filtering.

## Task t_ff693b7f - [upstream:ClawMem] Session-scoped focus topic for retrieval steering

**Source**: https://github.com/yoloshii/ClawMem
**Upstream files studied**: `README.md`, `src/session-focus.ts`, `src/hooks/context-surfacing.ts`

### What

ClawMem supports a per-session focus topic. A command writes a small session-specific focus file, and the context-surfacing path uses that topic to steer query expansion, reranking, snippet extraction, chunk selection, and final score adjustment. Matching results get a boost, non-matching results are gently demoted, and the signal is intentionally session-scoped: it does not become permanent memory and does not modify lifecycle metadata.

### Why useful for OSB

OSB has core memory pinning for transient session context, strong search ranking, context packs, and source-agent filters. What is still missing is a light way to tell recall: for this current session, bias searches toward this working topic without teaching the Brain a permanent preference. This is useful during multi-step research, release work, comparative upstream analysis, or debugging sessions where the operator says something like same process for ClawMem and expects follow-up turns to inherit the active topic.

### Current OSB status

- **Verdict**: present_weaker
- **Local evidence**: transient pinning shipped, and OSB search already has recency, intent, MMR, entity boost, link traversal, and query expansion. Pinning preserves explicit facts, but it does not appear to provide a per-session retrieval-bias topic that influences search/context assembly while staying outside durable Brain state.
- **Related existing work, not a duplicate**: Pinned memory keeps specific facts visible. This task adds a scoped ranking signal for which Brain evidence should be favored during the current session.

### Proposal

Add a session focus surface for OSB that can be set, cleared, inspected, and passed through search/context pack APIs. The focus should be explicit, temporary, and visible in `why_retrieved` so the operator can tell when it influenced recall.

### Acceptance criteria

- A focus topic can be set for one session without affecting other sessions.
- Search/context-pack results show measurable but bounded ranking changes for focus-matching evidence.
- `why_retrieved` reports the focus contribution.
- Clearing or expiring the focus returns ranking behavior to baseline.
- Focus state never becomes a confirmed preference or durable Brain fact unless explicitly promoted by the operator.

## Task t_71942f88 - [upstream:plur] Polarity-aware Brain context lanes with consider pool

**Source**: https://github.com/plur-ai/plur
**Upstream files studied**: `README.md`, `packages/core/src/inject.ts`, `packages/core/src/polarity.ts`, `packages/core/src/schemas/engram.ts`, `packages/claw/src/assembler.ts`, `packages/mcp/src/tools.ts`

### What

PLUR classifies memories into practical injection lanes instead of dumping every recalled item into one undifferentiated block. Its injection pipeline detects `do not` / `never` / `avoid` style rules as constraints, keeps normal rules as directives, and puts lower-confidence or activation-spread matches into an `also consider` pool. It then formats the lanes with progressive disclosure: high-priority directives get fuller detail, constraints stay separate, and speculative context is only included when budget remains.

### Why useful for OSB

OSB already has context packs, recall ranking, token budgets, visibility filters, prompt-injection guardrails, and `why_retrieved`. The missing product affordance is semantic separation of the recalled Brain context before it reaches an agent. A hard prohibition like `never run destructive git commands`, a positive convention like `use Bun for this project`, and a weakly related memory should not arrive in the same paragraph with the same implied authority. Separating them would make OSB context easier for agents to follow and easier for operators to audit.

### Current OSB status

- **Verdict**: present_weaker
- **Local evidence**: Existing tasks cover prompt-injection protection, MCP output boundaries, preference quality gates, score reasons, and context budgets. I did not find a Brain injection format that explicitly routes recalled items into directive, constraint, and low-confidence consideration lanes with different authority levels.
- **Related existing work, not a duplicate**: preference quality gates improve what gets stored. This task changes how stored context is assembled and presented at retrieval/injection time.

### Proposal

Add polarity-aware context lanes to OSB recall/context-pack output. The feature should classify Brain items by operational authority, keep negative constraints visually and structurally separate from positive directives, and reserve a small optional pool for nearby but lower-confidence memories.

### Acceptance criteria

- Recalled Brain context can be returned as separate directive, constraint, and consider lanes.
- Negative/prohibition preferences are classified deterministically and can be overridden in frontmatter.
- `why_retrieved` and source provenance are preserved for every lane.
- The consider pool is budget-capped and never crowds out higher-authority context.
- Tests cover polarity classification, manual override, lane ordering, JSON output, and prompt rendering.
- Existing plain recall output remains backwards compatible unless lane output is requested.

## Task t_85581d59 - [upstream:Sibyl-Memory] Verified multi-record retrieval for evidence-spanning questions

**Source**: https://github.com/Sibyl-Labs/Sibyl-Memory
**Upstream files studied**: `sibyl-memory-client/src/sibyl_memory_client/multi_record.py`, `sibyl-memory-client/CHANGELOG.md`

### What

Sibyl-Memory added a `multi_record_search` helper for questions whose answer spans multiple records. Instead of requiring one record to contain every query term, it performs per-token recall, unions candidates, tracks which terms each record supports, then verifies the candidate set. The verification gates abstain when a significant term has no corpus support, require rare/selective term coverage, drop purely preparatory records for terminal-state queries, and rank by IDF-weighted coverage. The key insight is that recall-only multipass search can regress by pulling distractors; the verify gates are what make multi-record retrieval trustworthy.

### Why useful for OSB

OSB's search is already strong at ranking individual chunks and expanding recall through semantic, link, entity, recency, and graph layers. A Second Brain often needs answers that span several artifacts: a preference plus its apply-evidence log, a retired rule plus the superseding rule, a project note plus recent session facts, or a payment receipt plus its generated asset. A verified multi-record retrieval mode would return an evidence pack instead of a flat list, making agent answers more grounded and less likely to overfit the top single chunk.

### Current OSB status

- **Verdict**: not_in_osb_useful
- **Local evidence**: OSB has hybrid search, `why_retrieved`, link traversal, `brain_context_pack`, `brain_synthesise`, graph export, backlinks, and timeline/evolution tools. It does not appear to have a dedicated retrieve-then-verify evidence-pack mode that checks query-term support across multiple records and abstains on unsupported terms.
- **Related existing work, not a duplicate**: `brain_synthesise` and context packs gather bounded context; this task adds a query-time verification layer for evidence-spanning questions.

### Proposal

Add an optional OSB search mode that returns verified evidence packs for multi-record questions. The mode should gather candidates across search layers, compute support coverage for significant query terms, apply conservative verification gates, and return a structured pack with support/abstention reasons.

### Acceptance criteria

- Multi-record search can return several complementary Brain artifacts when no single chunk contains the full query vocabulary.
- Unsupported significant terms produce an explicit abstention or missing-support warning.
- Rare/selective term coverage is required so broad neighboring clusters do not pollute evidence packs.
- Terminal-state queries down-rank or drop draft/planning-only records unless they also contain terminal evidence.
- The output is available from CLI and MCP in JSON with matched/missing term diagnostics.
- Tests cover evidence-spanning preference/log queries, retired/superseded chains, no-support abstention, distractor rejection, and CJK or non-English token handling.

# Project context

Project: Open Second Brain, TypeScript on Bun. Obsidian-compatible Markdown vault memory layer with CLI, MCP server, and runtime adapters.

Recent commits:

- 40d4e2b (v0.26.0) feat: cjk schema lifecycle recovery - CJK search, schema admin, lifecycle hooks, watchdog (#53)
- f62918c (v0.25.0) feat: runtime schema packs foundation - schema vocabulary, artifact taxonomy, schema inspection (#52)
- 14d1ee1 (v0.24.0) feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
- 3a5d5c3 (v0.23.0) feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa (v0.22.0) feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 (v0.21.0) feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 (v0.20.0) feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f (v0.19.0) feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 (v0.18.0) feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2147640 (v0.13.0) feat: Hybrid Search and Recall Quality: explainable recall, MMR, link traversal, entity boost, header anchoring (#37)

Related files:

- `src/core/search/fts.ts`: builds safe FTS5 MATCH expressions and runs keyword retrieval.
- `src/core/search/store.ts`: central SQLite boundary; `keywordTopK`, `semanticTopK`, hydration, typed relation reads.
- `src/core/search/search.ts`: orchestrates keyword, semantic, query plan, cache, rank, traversal, MMR, filters, visibility, relations, warnings.
- `src/core/search/ranker.ts`: pure scoring and `reasons` layer assembly.
- `src/core/search/query-plan.ts`: pure structural query intent and weight profile.
- `src/core/search/types.ts`: `SearchOptions`, `SearchOutcome`, `BrainSearchResult`, warnings and error types.
- `src/core/brain/context-pack.ts`: bounded context pack assembly from Brain preferences/retired pages.
- `src/cli/search.ts`: `o2b search`, JSON and human rendering, property/visibility flags.
- `src/mcp/search-tools.ts`: `brain_search` schema, argument parsing, error mapping, MCP output shape.
- Existing tests: `tests/core/search/fts.test.ts`, `tests/core/search/search.test.ts`, `tests/core/search/ranker-reasons.test.ts`, `tests/mcp/search.test.ts`, `tests/mcp/brain-search-reasons.test.ts`.

Conventions:

- Core modules stay deterministic and do not depend on runtime adapters.
- CLI wrappers parse flags, resolve config, shape exit codes, and render output; core owns behavior.
- MCP tools validate inputs, map typed errors, and expose structured content plus compact text.
- Search JSON exposes structured `reasons[]`; human output shows them only with `--verbose`.
- Read paths should preserve backward compatibility unless a new explicit flag or option requests richer output.
- Search index is rebuildable under `.open-second-brain/`; `Brain/active.md` is derived.
- Public docs use the full project name, not OSB abbreviation.
- Package scripts: `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run test`, `bun run validate`, `bun run sync-version:check`.

Constraints:

- Do not add a vector database or new external retrieval dependency in this PR.
- Keep plain string `o2b search` and `brain_search` backward-compatible.
- Prefer pure parser/ranker helpers with focused tests.
- Keep new automatic-surfacing behavior opt-in/configurable; do not change explicit `brain_search` semantics silently.
- Keep self-healing bounded: at most one rebuild/retry, with a visible warning.
- No new public AI-authorship markers.

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
