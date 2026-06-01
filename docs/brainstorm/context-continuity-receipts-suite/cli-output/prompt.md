You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement a Context Continuity & Injection Receipts Suite for Open Second Brain using the following local Hermes triage snapshot tasks. Treat the tasks as one cohesive multi-task PR, but propose variants that keep the implementation professional, SOLID, KISS, and DRY.

## Selected tasks

### t_772706ee P3 - Session summary DAG with lossless drill-down recall

Hermes-LCM persists raw conversation messages, compacts older context into a depth-aware summary DAG, and exposes bounded recovery tools (`lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`, `lcm_load_session`). OSB already has session import adapters, deterministic session codec, conversation fact extraction, context packs, and pre-compress preference packs, but does not have a session-local hierarchy where compacted conversation ranges can be searched, described, and expanded back to exact source turns. Acceptance: ingest long imported Hermes/Claude/Codex session into raw turns and at least two DAG depths without losing source IDs; search returns raw-turn and summary-node hits with bounded snippets; expanding a summary node returns immediate sources with pagination and exact raw turn follow-up; opt-in and no default behavior change; tests cover lineage, pagination, oversized turns, rebuildability, and idempotency.

### t_192d9c8c P3 - Model-aware context budget presets with dry-run diagnostics

Hermes-LCM has inspectable model-family context presets. OSB has many independent knobs (`brain_context_pack` limits, `brain_pre_compress_pack`, MCP preview budget, search limits), but no read-only diagnostic that maps runtime/model context characteristics to recommended OSB budget settings while preserving overrides. Acceptance: `context-preset suggest` returns recommendation with reason/confidence/no mutation; `context-preset diff` reports exact proposed changes while preserving explicit overrides; at least tight-context and long-context presets; token-footprint or doctor can reference diagnostics; tests cover selection, override preservation, invalid override reporting, JSON output.

### t_57eedc53 P3 - Pre-compaction decision and commitment capture

Hermes-LCM optionally scans the soon-to-be-compacted conversation segment and writes durable decisions, commitments, outcomes, rules, and open questions. OSB has `brain_pre_compress_pack`, import-session, timeline, and fact extraction, but not a compression-boundary capture path. Acceptance: bounded compression-boundary payload can produce durable typed records with source turn refs; best-effort and never blocks compression on failure; idempotent by session+turn range+text hash; extracted records appear in timeline/search surfaces; tests cover empty/noisy segments, duplicate extraction, media/base64 sanitization, failure handling.

### t_6e50c711 P3 - Cache-stable Brain context pack ordering with ranking annotations

ContextPilot reorders retrieved context blocks to improve prefix/KV-cache reuse while preserving original ranking metadata. OSB context packs optimize for one request at a time. Acceptance: optional cache-stable order without changing selected blocks; moved blocks retain original rank, score, why_retrieved; plain Markdown and JSON remain understandable; disabled by default; tests cover deterministic ordering, rank preservation, repeated-block grouping, backwards-compatible output.

### t_8c5f1093 P2 - Lossless repeated-context deduplication with reference hints

ContextPilot detects byte-identical or chunk-identical repeated context within an explicit session and replaces later repeats with auditable reference hints only when the original remains accessible. OSB has compression, payload externalization, budgets, and artifacts, but no session-scoped repeated-context dedup pass. Acceptance: detect repeated context across explicit session IDs; replace with reference hints only when original remains accessible; content-defined chunking catches shifted repeated sections; visibility boundaries prevent cross-session/agent contamination; diagnostics report blocks saved; tests cover repeated tool results, shifted blocks, missing-original fallback, isolation, small-input no-op.

### t_92d938e9 P2 - Prompt context receipts for auditable Brain injection

Hermes-agentmemory records which memories were summarized into context. OSB has `why_retrieved`, query cache, context packs, and logs, but no receipt log of the final Brain context that crossed the prompt boundary. Acceptance: context-pack, pre-compress, and future context paths can emit receipts; receipts include stable source identifiers, ranking/budget metadata, redaction/private flags, final injected-text hash; no raw private content by default; CLI/MCP can list/show by session/host/trigger/source/receipt id; forget/source purge can find/invalidate references; tests cover emission, redaction-safe serialization, filters, cache/forget integration.

### t_e3d045d6 P1 - Recall telemetry log with coverage and knowledge-gap summary

ByteRover records recall queries and summarizes coverage/cache/timing/gaps. OSB has `why_retrieved`, query cache, ranking diagnostics, token-footprint, and benchmarks, but no retained recall telemetry log for live recall usage. Acceptance: search/context-pack calls can record bounded local telemetry without changing returned results; telemetry can be disabled/redacted; view supports time/status/detail filters and JSON; summary reports coverage, cache hits, latency, top artifacts, unanswered gaps; interrupted calls visible after timeout; tests cover log write, pruning, corrupt tolerance, aggregation, privacy redaction.

# Project context

Project: Open Second Brain, TypeScript/Bun CLI + MCP server, filesystem-first Obsidian-compatible Brain vault.

Recent main commits:

- 3b7b3a5 feat(brain): add safety governance foundations (#55) / v0.28.0
- 794ee45 feat(search): ship recall control and trust surfaces (#54) / v0.27.0
- 40d4e2b feat: cjk schema lifecycle recovery (#53) / v0.26.0
- f62918c feat: runtime schema packs foundation (#52) / v0.25.0
- 14d1ee1 feat: brain model semantics foundation (#51) / v0.24.0
- 3a5d5c3 feat: agent capability CLI integration (#50) / v0.23.0
- a085bfa feat: vault portability + session economy (#49) / v0.22.0
- 73e4a28 feat: brain lifecycle suite (#48) / v0.21.0
- bd49cd5 feat: recall and ranking quality (#47) / v0.20.0
- 5fa7eb0 feat: MCP context economy (#45) / v0.18.0

Related files and existing surfaces:

- `src/core/brain/context-pack.ts`: builds `brain_context_pack` items with token/char budgets, polarity lanes, and v0.28 safety reports.
- `src/core/brain/pre-compress-pack.ts`: builds `brain_pre_compress_pack` addendum for host compression boundaries.
- `src/mcp/brain-tools.ts`: MCP handlers for context pack, pre-compress pack, search, receipts/future tools should fit here.
- `src/core/brain/sessions/types.ts`, `src/core/brain/sessions/import.ts`: normalize Claude/Codex/Hermes transcripts to `SessionTurn` and import `@osb` markers/tool calls.
- `src/core/search/*`: existing search ranking, evidence packs, query cache, focus, structured query.
- `src/mcp/artifact-store.ts`: context economy stores oversized tool output artifacts.
- `src/core/brain/payload-registry.ts`: v0.28 payload externalization foundation.
- `docs/cli-reference.md`, `docs/mcp.md`, `README.md`, `CHANGELOG.md`: user-facing docs to update.

Project conventions and constraints:

- Brain source of truth remains plain Markdown/vault files. Derived indexes/caches must be rebuildable or auditable.
- Prefer deterministic, bounded, opt-in surfaces. Avoid silently mutating live config or injecting raw private content.
- CLI/MCP outputs need stable JSON contracts and tests. Read-only/preview-first is preferred for governance and context workflows.
- No new external dependencies unless clearly necessary.
- Do not replace Hermes-LCM or build a general LLM orchestration platform.
- Do not change default `brain import-session`, `brain codec`, `brain_context_pack`, or search behavior unless the caller opts in.
- Version bump must happen before GitHub push, but not during Phase 0.
- Before every commit, run `bun run fmt` and `bun run lint`.
- Phase 2 implementation must be TDD and atomic commits.

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
