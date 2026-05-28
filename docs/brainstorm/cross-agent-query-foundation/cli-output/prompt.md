You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement a universal cross-agent query foundation for Open Second Brain as one feature-release-playbook PR.

Primary kanban tasks in scope:

1. `t_51c827e7` — `[upstream:obsidian-wiki] Cross-agent targeted wiki search via wiki-agent skill`
2. `t_64dad481` — `[upstream:obsidian-wiki] Memory bridge: compare wiki knowledge by source agent`

Task body excerpts (verbatim):

## t_51c827e7
Upstream added `/wiki-{claude,codex,hermes,openclaw,copilot}` slash commands that query one AI tool's session history from any other tool. Each agent has its own extraction strategy, and a no-query form ingests the last 5 unprocessed sessions. The result is synthesized and returned immediately after ingestion into the shared wiki.

OSB already imports sessions from Claude, Codex, and Hermes, but has no cross-agent query capability. `brain_search` and `brain_query` operate on vault content, not on raw agent history with synthesized answers. Adding cross-agent targeted search would let OSB users ask "what did Codex say about X" from within a Hermes session, enriching the multi-agent brain.

Notes: depends on upstream's extraction strategies per agent. Could be implemented as a brain tool that accepts an agent filter parameter on `brain_search`, or as a new `brain_agent_query` tool.

## t_64dad481
`/memory-bridge` browses and compares wiki knowledge by source tool. `/memory-bridge codex` lists all Codex-sourced pages. `/memory-bridge diff` surfaces what each tool uniquely contributed — the knowledge gaps between AI tools. Supports browse, search, diff, and map modes.

OSB tracks agent identity on every signal, preference, and log entry, but has no tool to compare contributions by source agent. A memory-bridge equivalent would let OSB users see which agent (Claude vs Hermes vs Codex) contributed which preferences, or identify knowledge gaps where one agent found patterns others missed. This aligns with OSB's multi-agent brain architecture.

Notes: could be implemented as `brain_agent_diff` or an additional mode on `brain_digest` that groups by agent. The idempotency-key for cross-agent search (`t_51c827e7`) is a prerequisite — comparison needs the query layer first.

# Project context

Project: Open Second Brain. TypeScript + Bun. Obsidian-native memory layer for AI agents.

Recent commits:
ffde4ac chore(release): v0.14.1 (#40)
bc97b38 refactor: add validation toolchain and normalize project formatting (#39)
b76199a v0.14.0 - Semantic Brain Health and Self-Maintenance (#38)
2147640 v0.13.0 - Hybrid Search and Recall Quality (#37)
84886d1 v0.12.0 - Brain Integrity Suite (#36)

Related files:
- `src/core/brain/sessions/import.ts`
- `src/core/brain/sessions/types.ts`
- `src/core/brain/sessions/registry.ts`
- `src/core/brain/sessions/claude.ts`
- `src/core/brain/sessions/codex.ts`
- `src/core/brain/sessions/hermes.ts`
- `src/cli/brain/verbs/import-session.ts`
- `src/cli/brain/help-text.ts`
- `src/mcp/brain-tools.ts`
- `src/mcp/search-tools.ts`
- `tests/e2e/brain-capture-and-fields.test.ts`
- `tests/core/brain.sessions.*`
- `tests/mcp/*.test.ts`

Observed current constraints from code:
- `SessionAdapterId` is a closed union: `"claude" | "codex" | "hermes"`.
- `agentLabelForTurn()` hardcodes those three adapter ids.
- CLI `brain import-session --format` only accepts `auto|claude|codex|hermes`.
- Current session import replays signals from transcript markers and `brain_feedback` tool calls, but there is no cross-agent query layer over session history.
- `brain_query` and `brain_search` are vault-centric read surfaces today.

Conventions:
- Prefer deterministic, additive surfaces over opaque LLM-only behavior.
- Keep public outputs structured and machine-readable.
- TDD-first. Every atomic unit must start with failing tests.
- No new external dependencies.
- User-facing text should stay in English; do not hardcode language-specific phrases or agent-name matrices into the business logic.
- Existing README positions OSB as “one vault, every agent.” The design should reinforce that rather than optimizing only for today's agents.

Critical design constraint from the operator:
- Only Claude Code and Codex are extra agents available right now, but the solution must remain universal for future agents.
- Do NOT design a hardcoded current-agent matrix. Future agents should require new adapters / registrations, not a rewrite of the query layer.
- Treat this as a universal `agent-source query foundation + first comparison surface`, not a one-off feature for current agents only.

Additional constraints:
- SOLID, KISS, DRY.
- No Python. TypeScript with Bun runtime.
- Keep the implementation suitable for one feature-release-playbook PR with roughly 50-70 files changed if it is the right scope, but project value matters more than exact file count.
- The PR will run through full playbook phases later (brainstorm, design-doc, TDD implementation, self-review, QA, PR, release).

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
