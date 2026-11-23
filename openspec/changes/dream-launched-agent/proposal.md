# Proposal

## Why

Dream has work only a capable model can do: writing a summary, naming a topic, and, on a machine with no decision model, every closed question. The owner decided who does it: the user's own agent, started by a command, in a short session that sees nothing but the queue. This change builds that: the command, the session's three tools, the run that authorises them, and what happens to the text.

## What Changes

1. A launch command in the machine config (`dream_agent_command`) with an ordered fallback list (`dream_agent_fallbacks`), presets for verified agents, and `o2b dream agent` to show, set and check it. The check launches a real short session against a canary item.
2. An agent executor: after the decision model executor, when ready work is left that only an agent may do, the worker starts the session, waits within a budget, and ends it.
3. Three MCP tools in a profile that exposes nothing else: `dream_work_take`, `dream_work_answer`, `dream_work_finish`, authorised by a per-run credential.
4. Isolation: a marker in the session's environment makes hooks, session capture and the day check stay out; the marker grants nothing.
5. Text work applied: the rollup summary writes its note; a new topic is created with the title and goal the agent wrote. **BREAKING**: a new topic is no longer named by the rule; it waits for its wording.
6. Drafts: `dream.apply_drafts` is `auto` (default) or `review`; in review, text answers wait for `o2b dream queue approve <id>` or `reject <id>`. Everything written by a model carries the agent and the model.
7. Closed questions no decision model answers are offered to the session.
8. Doctor and the status say whether a command is set, whether it was verified and when, and what waits for it.

The series order is in `openspec/changes/dream-closed-questions/brainstorm.md`: this is the sixth of eight.

## Capabilities

### Modified Capabilities

- `dream-model-work`: requirements are added for the launched agent, its three operations, its isolation, text work and drafts.

## Impact

1. Code: `src/core/config.ts` (the two keys), a new `src/core/brain/dream-queue/agent-executor.ts`, `agent-presets.ts`, `run-record.ts`; `src/mcp/` (the profile, the three tools, the run check); every hook entry (the marker); `src/core/brain/capture-boundary.ts`; `src/core/brain/dream-queue/rollup-work.ts` (a real apply); `src/core/topics/` (the wording operation, creation waits for it); a new `src/cli/dream/agent.ts` and additions to the queue verb; doctor; `docs/dream.md` (new), `docs/mcp.md`, `docs/cli-reference.md`, `install.md`.
2. Depends on `dream-closed-questions` and everything before it.
3. Risks: an agent whose command line cannot restrict its tools; a session that hangs; cost of a session on the user's subscription; private evidence shown to the user's own agent.
4. Not in this change: starting dream at session entry, the merged wording of topics, model-written pages of the human view, presets for agents that were not verified.
