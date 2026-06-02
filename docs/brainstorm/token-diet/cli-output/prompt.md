You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic: MCP/hooks token diet — cut per-session context overhead (kanban t_5e6826f3, six children).

Audit of 2026-06-02 (live vault, serialized tool registry):

- 71 MCP tools serialize to 44,912 chars (~12K tokens) of schemas; median ~140 tokens/tool but the top descriptions are 4x over median (payment_receipt_append 2,901 chars; brain_context_pack 2,350; brain_search 1,966; brain_pre_compress_pack 1,566; brain_feedback 1,493).
- SessionStart hook injects Brain/active.md verbatim: 16,550 bytes (~4.5K tokens) per session; 5.2KB (31%) duplicates full principle texts in the "Most-applied (30d)" section (already listed verbatim under "Confirmed"); several stored preference files carry multi-level backslash-escaping artifacts plus leaked tool-call XML fragments (`</principle>\n<parameter name="scope">...`) written at signal-recording time.
- PostCompact active-inject is rejected by the current Claude Code hook output schema (hookSpecificOutput.additionalContext is accepted only for UserPromptSubmit / PostToolUse / PostToolBatch) — preference re-injection after compaction is silently broken AND the validation error echoes the full 16KB payload to stdout.
- hooks/post-write-reminder.ts injects ~1.3KB (~350 tokens) after EVERY successful Write/Edit/MultiEdit/apply_patch — the single largest recurring cost over a long coding session.
- MCP preview budget (MCP_PREVIEW_BUDGET=2000 chars + artifact store + brain_artifact_get) covers only 9 of 71 tools; unbudgeted verbose read tools include brain_query, brain_audit, brain_backlinks, brain_unlinked_mentions, second_brain_query, schema_graph, brain_session_grep, brain_session_expand, brain_recall_telemetry.

Six child tasks:

1. (P4, bugfix) Fix PostCompact active-inject rejected by Claude Code hook schema. Either inject via a supported mechanism or suppress output on PostCompact; keep Codex runtime path intact; add a hook-output contract test pinning which event names may carry additionalContext.
2. (P3) Slim active.md injection: render Most-applied as one-liners (pref id + scope + applied count, no duplicated principle bodies); fix escaping corruption at the write source plus a one-shot cleanup/heal for existing files; add a hard character budget for the injected body with deterministic truncation order (reuse head-budget logic from brain_pre_compress_pack). Target: live vault active.md shrinks >= 35%.
3. (P3) Compress post-write-reminder: full reminder text once per session (it teaches the contract), short <= 200-char nudge afterwards; session-scoped state must be best-effort and fail-soft; Codex one-shot runtime keeps full text always.
4. (P3) Consolidate overlapping MCP read tools 71 -> ~40: six summary tools (brain_morning_brief, brain_daily_brief, brain_weekly_synthesis, brain_monthly_review, brain_operator_summary, brain_digest) -> one brain_brief with window/audience params; five analytics tools (brain_timeline, brain_recurrence, brain_attention_flows, brain_belief_evolution, brain_concept_synthesis) -> one brain_analytics with view param; seven schema read tools -> one schema tool with verb param (schema_apply_mutations stays separate, it writes). Old names remain as deprecated delegating aliases for >= 1 minor release.
5. (P2) Tool description diet: cap descriptions at ~300 chars (what + when), move parameter nuances to per-property schema descriptions and long-form guidance to server instructions/docs; registry guard test fails when any description exceeds the cap.
6. (P2) Extend preview budget: opt the listed verbose read tools into MCP_PREVIEW_BUDGET; flip the default — a registry test enumerates tools WITHOUT a budget and requires an explicit allowlist entry with a reason.

# Project context

Open Second Brain — TypeScript on Bun. Local-first Markdown/Obsidian vault with deterministic agent memory (preferences, signals, dream learning pass), SQLite FTS5+vec search, MCP server (stdio) with full/writer scopes, CLI `o2b`, Claude Code plugin with lifecycle hooks (SessionStart/PostCompact/PostToolUse/Stop), Codex support via the same o2b-hook entry.

Recent commits:
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)
23ff4fb refactor(hermes): single intentional self-bootstrap for the plugin entrypoint (#63)
0952dfc feat: become a native Hermes memory provider (#62)
6fbab0b feat: hands-off post-upgrade migration (v0.31.2) (#61)
496dd2d fix: make plugin updates self-healing (v0.31.1) (#60)

Related files:
- src/mcp/tools.ts (buildToolTable, ToolDefinition, ToolScope full/writer)
- src/mcp/brain-tools.ts (3,592 lines; most brain_* tool definitions)
- src/mcp/search-tools.ts, src/mcp/schema-tools.ts, src/mcp/pay-memory-tools.ts, src/mcp/watchdog-tools.ts
- src/mcp/preview-budget.ts (MCP_PREVIEW_BUDGET seam), src/mcp/artifact-store.ts
- src/mcp/instructions.ts (full ~5.4KB + writer instructions)
- hooks/active-inject.ts, hooks/post-write-reminder.ts, hooks/stop-log-guardrail.ts, hooks/session-capture.ts, hooks/lib/messages.ts, hooks/lib/detect.ts (runtime detection claudecode/codex/unknown), hooks/hooks.json
- src/core/brain/active.ts (regenerateActive renders active.md), src/core/brain/most-applied.ts
- src/core/brain/preference.ts (parse/write preference frontmatter), src/core/brain/signal.ts
- src/core/brain/pre-compress-pack.ts (existing head-budget logic), src/core/brain/text/tokenizer.ts (estimateTokens)
- src/core/brain/doctor.ts (invariant checks), src/core/brain/heal-run.ts
- tests/mcp/mcp.test.ts (registry contract: sorted tool-name list + count)

Conventions:
- Strict TDD, bun test; oxlint baseline 111 warnings (must not grow); oxfmt formatter; tsc typecheck; `bun run validate` aggregates.
- Conventional commits, one PR = one CHANGELOG version; deterministic pure-function cores with thin IO shells; no LLM in deterministic paths.
- Hooks are fail-soft: never exit 2, never block the runtime; messages live in hooks/lib/messages.ts; runtime detection via payload shape.
- MCP registry contract test pins sorted tool names + count; output contracts validated via assertOutputContract.
- Public artifacts use the full product name "Open Second Brain"; no exclamation marks in docs.

Constraints:
- Do not break existing MCP clients abruptly: deprecated tool names must keep working for at least one minor release.
- Writer-scope surface (5 tools) must stay unchanged.
- Hook resilience contract: any internal problem -> warn on stderr and exit 0.
- No new external dependencies.
- Determinism: identical inputs produce identical rendered bodies (active.md idempotent-write property must survive).
- This is a static surface reduction; a separate task (t_20dcb192) covers adaptive per-request tool selection — do not design that here.

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
