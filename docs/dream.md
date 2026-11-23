# Dream: who answers what

Dream turns what agents captured into a maintained brain. Most of a pass
works on counts and rules. Some work needs a model; it waits in the dream
work queue (`o2b dream queue`) until something answers it, and no fixed
rule decides it meanwhile.

## Who answers

1. **The decision model chain** (see [decision-models.md](decision-models.md))
   answers the seven closed questions whose use is set to `enforce` in
   `decision_model_uses`: which topic a record belongs to, whether a group
   deserves a topic, whether two topics are one, what kind of event a held
   record is, whether a question was answered, whether a milestone is done,
   whether a note belongs in the history.
2. **The dream agent**, your own agent started in a short session,
   answers everything else:
   1. the rollup summary of a fired rollup rung (a whole note);
   2. the title and goal of a new topic (`topic-wording`);
   3. every closed question whose use is `off` for the decision model, or
      all of them on a machine with no decision model. Its answer carries
      a confidence, and the use's threshold applies as for any answer.

Both run before a live pass on the dream owner's device (`o2b dream
owner`), the decision model first. A new topic needs two answers: the
approval of its group and its wording. Until the wording exists the topic
is not created.

## Setting the agent

The command is a machine setting, never shared between machines:

1. `dream_agent_command`: a preset name, or a JSON array of strings, the
   program first and then its arguments. Nothing is split or quoted; the
   program is started without a shell.
2. `dream_agent_fallbacks`: a JSON array of preset names or such arrays,
   tried in order when a session fails to start, exits with an error or
   answers nothing (one fallback per run).
3. `dream_agent_budget_ms` (default 300000) and `dream_agent_items`
   (default 50): the bounds of one run.
4. `dream_agent_private` (default on): off keeps items built from private
   records away from the session.

Each key has an environment twin (`OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND`
and so on). Set the command with `o2b dream agent set`, then verify it:

```bash
o2b dream agent set '["/path/to/agent", "--print", "{prompt}", "--mcp-config", "{mcp_config}"]'
o2b dream agent check
o2b dream agent show
```

The arguments may hold placeholders, filled for each run:

1. `{prompt}`: the session's fixed task;
2. `{mcp_config}`: the path of a file holding the one server of the run in
   the common MCP JSON shape (`{ "mcpServers": { "open-second-brain-dream":
   { "command", "args", "env" } } }`);
3. `{mcp_command}` and `{mcp_args_json}`: that server's program and its
   arguments as a JSON array, for an agent that takes a server inline.

`check` starts a real session exactly as a pass would, against two canary
items in a throwaway store under the device state directory (removed
afterwards; nothing reaches your brain). It passes only when the session
took both items, answered them correctly and finished, within 120 seconds,
and then records the command as verified by its hash, with the agent, the
model the session named and the program's version. A command that was
never verified, or that changed since, is not used for real work. When
the check fails it says what the session did: whether it started, whether
it listed the tools, and the calls it made.

No presets ship in this version. A preset is offered only for an agent
whose non-interactive form was run by the check on a development machine,
and that form must restrict the session to the one server it is given. An
agent's own login lives in its own home directory, and the development
check could not use it there, so every agent is configured with a full
command for now.

## What a session can and cannot do

The session's only Open Second Brain server is `o2b mcp --tool-profile
dream-executor` (see [mcp.md](mcp.md)). It has three tools,
`dream_work_take`, `dream_work_answer` and `dream_work_finish`, no
resources and no prompts, and it works only for the live run the worker
created: a device-local run record holding the hash of a token handed to
the session's server. The agent recorded on every answer is the worker's
name for the command it started; the model is what the session says it
is, and cannot be checked.

The worker ends the session when its time or item budget is spent, and
releases what it still holds; whether the pass is complete is the
worker's decision, not the session's. The session's process carries a
marker (`OPEN_SECOND_BRAIN_DREAM_RUN`): every hook exits at once, nothing
is captured, and no dream starts from inside it. Its task begins with the
line `open-second-brain-dream-session <run id>`, so its transcript is
skipped by a later import too. The marker grants nothing.

What else the agent's own tools can touch (files, shell, network) is that
agent's configuration: the command line you set is your statement of it.
Isolation on the Open Second Brain side holds regardless.

A session costs your agent's subscription. Private evidence is shown to
your own agent on your own machine; an agent that fronts a hosted model
sends it there. Turn `dream_agent_private` off to keep private items from
the session.

## Drafts

Every text answer is kept with its author. The shared setting
`dream.apply_drafts` decides when it is applied:

1. `auto` (default): the next pass applies it. A rollup summary is written
   to its note under `Brain/rollups/` with `written_by`, `written_by_model`
   and `written_by_item` in the frontmatter; a wording creates the topic,
   whose record names the agent and the model.
2. `review`: the answer waits in the state `awaiting-review`. List the
   waiting text with `o2b dream queue --state awaiting-review`, then
   `o2b dream queue approve <id>` (the next pass applies it) or
   `o2b dream queue reject <id> --reason <text>` (nothing is written and
   the item is closed with the reason).

## Status and doctor

`o2b dream owner` shows the queue and the dream agent: the command,
whether and when it was verified, and the last run (the agent, the model,
the items answered and how it ended, or why no session started, such as
`no-time` when the caller had too little time left). Doctor reports
`dream-agent-unset`, `dream-agent-unverified`, `dream-agent-failed` and
`dream-drafts-waiting`, and `dream-queue-no-executor` when neither the
decision model nor the dream agent can answer an operation.
