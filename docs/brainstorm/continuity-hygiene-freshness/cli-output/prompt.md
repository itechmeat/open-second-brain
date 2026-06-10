You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release ships nine features in two clusters. The architectural question is how the nine features map onto modules and shared substrates: which features share a store, which get their own module, where the seams are.

## Cluster A - session continuity

### A1. Hook-payload session lineage plumbing (kanban t_d08ccc5a)
Carry Hermes session lineage (parent/root id, compression depth) into the plugin hook payload boundary so capture and recall can stitch a conversation that Hermes split across a compression boundary. Verified: the deployed Hermes builds the shell-hook payload in `_serialize_payload` and emits only `hook_event_name, tool_name, tool_input, session_id (= session_id OR parent_session_id), cwd, extra` - no distinct lineage field, no transcript_path. Upstream PR NousResearch/hermes-agent#42940 (adds `parent_session_id` to the payload) is still open. So: extend `HookPayloadBase` with optional `parent_session_id` / `root_session_id` / `compression_depth` (native path, ready for the merged PR), plus an interim lineage-resolution crutch for today's Hermes, isolated and marked `CRUTCH(t_1459706f)` so it can be deleted wholesale later. Fail-soft: missing lineage degrades to current flat-id behaviour, never errors.

### A2. Compression-aware session capture and recall keyed on lineage root (kanban t_a94623ad)
Today `src/core/brain/session-recall.ts` filters records by exact `record.payload["session_id"] === sessionId`, and capture keys everything on the flat id, so each post-compaction segment becomes a separate disconnected Brain session. Adopt a lineage-root key: store `parent_session_id` / `root_session_id` / `compression_depth` on captured session records; key recall and the session-read tools (brain_session_expand / grep / describe) on the lineage root so a query over any segment id returns the full stitched conversation; preserve a continuity edge between adjacent segments. Acceptance: a conversation compacted once is recallable as one session via either the root id or the child id; no regression for never-compacted sessions.

### A3. Depth-aware summary escalation ladder for over-budget context items (kanban t_05f5dc12)
Inspired by hermes-lcm. OSB's per-entry budget today is a hard character cut (`applyCharBudget` in `src/core/brain/recall-budget.ts`, used by context-pack and pre-compress-pack). Add a staged degradation ladder: when an item exceeds its budget, degrade it progressively (e.g. full text -> sentence-boundary-trimmed prose -> first-lines/bullet extract -> hard truncate) instead of cutting mid-sentence. Deterministic, pure, language-agnostic (no language-specific sentence heuristics beyond punctuation/structure).

### A4. Anticipatory Brain context cache for active agent turns (kanban t_4cee9df5)
Inspired by FlowState-QMD. Keep a small, inspectable, turn-specific context pack warm while an agent is working, so the next turn's memory evidence is ready before the agent asks. OSB constraint: NO daemon, NO file watcher (explicit design decision). So the cache must be refreshed on existing hook events (tool-use / prompt-submit hooks already fire) or on explicit command, written atomically to a well-known location, and consumed by a read-the-cache-or-fall-back-to-live-query path.

## Cluster B - hygiene and freshness

### B1. Memory hygiene tool: scan and apply (kanban t_698db8f7)
A hygiene surface with `scan` (diagnostic digest: open contradictions, low-usefulness candidates, near-duplicates, stale pages) and `apply` (remediation: consolidate, forget, archive) modes. Integrates existing substrates: dream-pass contradiction classification (`reconcile-outcomes.ts`), recall-telemetry usefulness signals, plus the new dedup/freshness detectors below. Scan is read-only; apply mutates with an explicit plan and audit trail.

### B2. Semantic deduplication of near-duplicate memories (kanban t_da3f138f)
Detect near-duplicate memory pages/observations via embedding similarity with a configurable threshold (upstream default 0.97). OSB has an embeddings provider registry (local / openai-compat / null). Dedup must work when embeddings are unavailable (fall back to lexical similarity or skip with a clear report). Child of B1: dedup findings surface through hygiene scan; merging happens through hygiene apply.

### B3. LLM-based episodic conflict resolution (kanban t_db375a60)
When episodic memories conflict (contradictory facts about the same entity), resolve by superseding, merging, or flagging for review. OSB hard rule: the Brain core stays deterministic - no LLM runs inside the harness. The existing pattern is an external command bridge (`bench_judge_cmd`: command gets JSON on stdin, returns JSON verdict on stdout, fail-open). Conflict DETECTION must be deterministic; RESOLUTION may consult a configured external resolver command, and with no resolver configured every conflict is flagged for operator review.

### B4. Source freshness detection for stale and orphaned pages (kanban t_d9624ef6)
Pages derived from external sources (ingested docs, imported sessions) can go stale. Track source identity + content hash at ingest; compute freshness on demand (`stale` = source changed since derivation, `orphaned` = all sources gone); surface freshness in lint-style checks and in search/recall result metadata. No background jobs - freshness computed on demand from recorded state. There is an existing `source_invalidation` continuity record kind and `sourceRefs` with optional `hash` on every continuity record.

### B5. Targeted recompile of stale pages with dry-run preview (kanban t_fe490119)
Given freshness state from B4, refresh only the affected derived pages: recompile pages whose owning sources changed, clean up orphans, skip unrelated content. `--dry-run` previews the full plan with zero writes. Integrates with the session import and search indexer pipelines (full re-import / full re-index exist today; this adds the selective path).

# Project context

Open Second Brain: a TypeScript + Bun memory system (CLI `o2b`, MCP server, hooks) over an Obsidian-style markdown vault. v1.2.0, 4140 tests.

Recent commits:
8972f13 refactor: SOLID/DRY decomposition - domain modules, unified helpers, surface guards (v1.2.0) (#86)
6651228 refactor: language-agnostic fact extraction + README slim (v1.1.0) (#85)
9886d9a refactor: make search and classification language-agnostic (#84)
618870e refactor!: remove the pay.sh integration and the Pay Memory layer (#83)
72bac52 fix(hermes): advertise static tool schemas so the provider registers with its full tool set (#81)

Related files:
- hooks/lib/stdin.ts (HookPayloadBase: session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input)
- src/core/brain/session-lifecycle.ts (captureSessionLifecycleEvent -> normalizePayload -> capture boundary -> marker/fact extraction)
- src/core/brain/capture-boundary.ts, src/core/brain/sessions/import.ts, src/core/brain/session-recall.ts
- src/core/brain/continuity/{types,store,read-model}.ts (append-only JSONL Brain/continuity/<month>.jsonl; ContinuityRecord {schema "o2b.continuity.v1", id, kind, createdAt, sourceRefs[{id,path,hash,kind}], payload, private, redacted}; kinds: context_receipt, recall_telemetry, gate_telemetry, pre_compact_extract, session_turn, session_summary_node, source_invalidation; additive optional fields do NOT bump the schema version)
- src/core/brain/recall-budget.ts (applyCharBudget - pure shared budget primitive, per-entry trim is a hard code-point cut)
- src/core/brain/context-pack.ts (packContext), src/core/brain/pre-compress-pack.ts
- src/core/brain/dream.ts + dream-refresh.ts + reconcile-outcomes.ts (deterministic dream pass, contradiction classification)
- src/core/brain/recall-telemetry.ts (recall_telemetry records, usefulness signals)
- src/core/search/ (bun:sqlite store, FTS + embeddings provider registry local/openai-compat/null, RRF fusion, query cache keyed by corpus-generation revision, indexer with incremental content-hash fastpath)
- src/core/bench/judge.ts (the external-command LLM bridge pattern: spawnSync sh -c, JSON stdin/stdout, 60s timeout, fail-open)
- src/mcp/brain/*.ts (16 domain tool modules, 54 MCP tools, aggregated by brain-tools.ts)
- src/cli/brain/verbs/ (76 CLI verb files sharing brainVerbContext)

Conventions:
- Fail-soft everywhere: a broken subsystem never blocks capture, search, or hooks; telemetry/metrics failures are swallowed.
- Pure deterministic core helpers; Object.freeze on returned aggregates; no Date.now()/randomness inside pure functions (clock passed in).
- src/core never calls process.exit / console.log (layering guard test).
- A frozen-surface parity test pins the exact 54 MCP tool names; adding tools is allowed but must deliberately update the parity list.
- Language-agnostic: no hardcoded natural-language phrases for content processing; all output strings English.
- Append-only JSONL for continuity data; markdown + frontmatter for Brain pages; SQLite only for the derived search index (rebuildable).
- Conventional commits; TDD (failing test first).

Constraints:
- No new external dependencies (runtime deps today: proper-lockfile only).
- No background daemons, no file watchers ("No daemon, no watcher" - explicit design decision; index updates happen on explicit commands or existing hook events).
- The Hermes lineage crutch must be isolated in one module and marked CRUTCH(t_1459706f).
- LLM-dependent behavior must degrade to flag-for-review when no external resolver command is configured.
- Do not change existing public CLI verb/MCP tool semantics; additive surfaces only.

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
