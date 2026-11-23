# Brainstorm

The owner's decisions are in `openspec/changes/agent-neutral-dream/brainstorm.md`, section "Model work", items 3 to 10: text work goes only to an agent launched from the command line as a short isolated session that takes the queue through three MCP operations; never an API key, never an open session; the launch command is a line in the machine config, filled in for known agents, with a fallback list; text written by a model is a draft with its author, and applying drafts automatically is a setting; first setup verifies the command with a real short call. `inventory.md` is the code inventory made for the executors; `openspec/changes/dream-closed-questions/` is the first half of the executors and is assumed here.

## What this change adds to those decisions

1. **The three operations are MCP tools of a profile that has nothing else.** `dream_work_take`, `dream_work_answer`, `dream_work_finish`. The existing profile mechanism always keeps a capability tool; the executor profile is made exact: three tools. Alternative: the full server with a prompt that says "use only these". Rejected: the owner's decision is isolation, and a prompt is not isolation.
2. **A run is a credential, not a marker.** The worker writes a device-local run record (run id, a random token's hash, the owner revision, an expiry) and passes the run id and the token to the session's MCP server through its environment. The three tools refuse without a live matching run. The environment marker alone grants nothing, as the owner's decision says; it only tells hooks and capture to stay out. Alternative: a long-lived agent token from the token store. Rejected: it outlives the run and identifies an agent, not a run.
3. **A draft is an accepted answer that is not applied yet.** The queue already separates accepted from applied and records who answered. With the setting on automatic, the pass applies text answers as it applies others; with the setting on review, they stay accepted until a person approves or rejects them. No new record kind, and provenance is the answer record. What is written carries its author.
4. **Two text operations in this change.** The rollup summary (its item exists and its apply refuses today) and the wording of a new topic (title and goal, drafted by a rule today). The merged wording of two topics waits until a person confirms a merge, which is a user action, not a pass; it is not in this change. A rule's principle is already written by the agent that recorded the signal; nothing rewrites it.
5. **The launched agent also answers closed questions nobody else answers.** When a use is off for the decision model, or no decision model is configured, its items are offered to the session. The answer carries a confidence the agent states; the threshold is the use's default.
6. **Presets only for what can be verified here.** The repository records no non-interactive form for any agent. A preset that was never run is a guess that fails on the user's machine. This change ships presets for the agents whose form is verified by the change's own check on the machines it is developed on, and takes a full command line for every other agent. The check is the product feature: `o2b dream agent check` launches a real session against a canary item and records the result.
7. **The worker runs in the front door, bounded.** Where the decision model executor runs, after it, under its own budget, awaited. Starting it detached at session entry is the trigger change.

## Rejected

1. Sending text work to a decision model or any API key (the owner's decision).
2. Taking the queue from an open session (the owner's decision: no session's context is spent on dream).
3. Guessed presets for agents nobody ran.

## Partner

The decisions are the owner's, from the shared brainstorm and its partner. This change adds a code inventory and one independent review of its artifacts; no further free-form round, by the owner's instruction to move faster.
