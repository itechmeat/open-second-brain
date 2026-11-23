# Dream

Dream turns what agents captured into a maintained brain: it promotes
repeated signals to rules, confirms, quarantines and retires rules by
their evidence, keeps topics, and writes summaries. Most of a pass works
on counts and rules. Some work needs a model; it waits in the dream work
queue (`o2b dream queue`) until something answers it, and no fixed rule
decides it meanwhile.

This page covers, in order: who owns dream, who answers its model work,
how it starts by itself, what waiting means, catch-up after missed days,
the dream agent, and drafts. Every verb is in the
[CLI reference](cli-reference.md); the store side is in
[brain-store.md](brain-store.md#the-dream-owner).

## The dream owner

Every brain in the brain store has at most one dream owner: one agent
installation on one device. Only the owner's device runs a live pass;
every other device previews (dry runs answer everywhere) and refuses a
live pass with `dream_not_owner` before it asks a model or writes
anything.

1. **Who it is.** The installation that creates the brain (`o2b setup`,
   `o2b init`, `o2b store init`) becomes the owner when its agent name is
   known. With no agent name the brain has no owner, and the command says
   how to choose one. Attaching another machine, running init again and
   the store migration never change the owner.
2. **How to see it.** `o2b dream owner` (MCP `brain_dream_owner`) names
   the owner's device and agent, whether this machine is the owner, a
   pending transfer, the queue, the dream agent and the replay.
3. **How to move it.** `o2b dream owner --here` on the machine that should
   own dream. On the owner's device `--agent <name>` changes the agent at
   once; on another device it records a request that the owner's device
   hands over the next time it looks (a pass, `o2b dream owner`, a session
   start). `--here --force` takes the role at once when the old owner is
   lost; `--release` gives it up.
4. **Any agent on the owner's device** may start the pass; the gate is the
   device. The pass summary names the owner and the agent that started it.

A brain from before 2.0 has no owner record and runs live passes from any
device until you adopt it with `o2b dream owner --here` (see
[updating.md](updating.md#upgrading-to-200)).

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

## How dream starts

Nothing needs to be scheduled. The first session of a day on the dream
owner's machine starts the day's pass by itself:

1. **Where the check runs.** In the session start hook of the hosts that
   have one (Claude Code, Codex, Grok), on every start, resume, clear and
   compact; and in the MCP server at `initialize` and at the first tool
   call of a new UTC day, which covers every other MCP host and a server
   that lives for days. A host that reaches Open Second Brain without MCP
   or a hook (Pi through the command line, Aider through its context file
   and `o2b aider wrap`, OpenClaw through its own plugin) has no session
   entry: its passes come from another agent on the same machine, or from
   `o2b dream run`.
2. **What it costs.** On a closed day the check reads the machine config
   the session already loaded and one small record under the device state
   directory (`dream-trigger/<key>.json`), and returns. It opens no store,
   starts no process and asks no model. The same holds before the retry
   time, with automatic dream off, and on a machine that is not the owner.
3. **What it starts.** When a pass is due on the owner's device, the check
   makes a claim (a small file beside the record, created exclusively, so
   two sessions at the same moment start one worker), and starts one
   detached worker, `o2b dream run --claim <token>`. The session does not
   wait. The worker runs the whole pass under the dream deadline, takes the
   pass lock itself, records the outcome and gives the claim back. Its
   error output goes to a small log in the store's device-local state
   (`dream/worker.log`, one header per attempt).
4. **A worker that died.** A claim older than the dream deadline plus two
   minutes, whose worker holds no pass lock, is a lost worker: the next due
   check removes it and records a failed attempt (doctor:
   `dream-worker-lost`); a later session starts a new worker after the
   retry time.

### What closes a day

A day (UTC, the day the pass started) is closed when a live pass ended
with no window behind, no window open, no source with a gap, and no queued
work that is ready, due and answerable by an executor this machine has
(the decision model for its question, or a verified dream agent). Any
other end leaves the day open and sets a retry time: one hour after the
first failure, doubling, at most one day; three failures in a row wait
four hours. Work that nothing on this machine can answer does not keep the
day open: the day closes, and the next session on the owner's machine and
doctor (`dream-work-unanswerable`) say what waits and what would answer
it.

Every live pass records the day the same way: `o2b dream run`, `o2b brain
dream`, the MCP `brain_dream` tool and the maintenance lane. A pass started
any other way therefore closes the day too, and the trigger never starts a
pass on a day another pass closed, nor while one runs. Each of them holds
the trigger's claim for its whole run, so two passes never overlap: a pass
started while another runs is refused before it asks any model, with an
error naming the running pass (`dream run claim busy`), as a second pass is
refused by the pass lock.

### Turning it off

Automatic dream is the shared setting `dream.auto`, on by default:

```
o2b brain settings set dream.auto false
```

A brain with no dream owner is never started. On one machine only, the
environment variable `OPEN_SECOND_BRAIN_DREAM_AUTO=false` keeps every
session there from starting a pass. `o2b dream status` and doctor
(`dream-auto-off`) say when it is off.

### A scheduled job beside it

A cron job or a scheduler task that runs `o2b brain dream` or the
maintenance lane keeps working. It records the day, and it holds the
trigger's claim, so the trigger and the job never run two passes at once:
one that starts while the other runs is refused. Only the trigger skips a
closed day: a session finds the day the job closed and starts nothing, but
the job, run after the trigger's pass closed the day, still runs a pass
(and asks the models for whatever work is ready). Such a job can be
removed.

### Other machines

A machine that is not the dream owner says nothing about dream at session
start, except one line, at most once a day, when the owner has covered no
window for more than three days: the owner's device and agent, its last
covered day, and the command that takes the role here (`o2b dream owner
--here`).

### The state of the day

`o2b dream status` shows whether automatic dream is on, whether this device
is the owner, today, whether the day is closed and why not, the last run
with its outcome, and the retry time. Doctor reports `dream-day-open` when
the day has stayed open for more than one day, with the reason and the
retry time.

## Waiting

Work that needs a model waits until something can answer it. Nothing
decides it in its place:

1. A record whose topic question waits stays unassigned; a group whose
   approval or wording waits is not created as a topic; a summary that
   waits is not written.
2. Work on one chain or topic waits behind a stuck item; unrelated work
   goes on.
3. An item that fails its checks five times is parked;
   `o2b dream queue retry <id>` offers it again and
   `o2b dream queue cancel <id> --reason <text>` closes it, both on the
   owner's device.

`o2b dream queue`, `o2b dream owner` and doctor say per operation how many
items wait, the age of the oldest and why: `no-model` (no decision model
for the question), `shadow` (the decision model is asked and recorded,
but its use is in shadow mode), `needs-local-executor`, `retry-at`,
`not-reached` (the pass ran out of time) or `no-executor`, each with the
action that changes it. Doctor adds `dream-questions-waiting`,
`dream-queue-no-executor` and `dream-work-unanswerable`.

### The order of fallbacks

Before a live pass on the owner's device:

1. The decision model chain answers the closed questions whose use is
   `enforce`, one item per request, within `dream.model_budget_ms`
   (default 20000). Its providers fall through in their configured order.
2. The dream agent answers what is left that it may answer, with the
   verified `dream_agent_command`. When a session fails to start, exits
   with an error or answers nothing, one entry of
   `dream_agent_fallbacks` is tried, in order.
3. Whatever is still unanswered waits for the next pass.

## Catch-up after missed days

On a brain served from the brain store, a live pass works in windows of
one UTC day. When the owner's machine was off, the next pass replays every
missed day, oldest first: each past day is judged as at its end, today at
the moment of the run. A machine that was off for weeks therefore ends
where daily passes would have ended: trials, staleness and confidence are
judged day by day, and signals are not archived before the promotion they
qualified for was considered.

1. **Coverage is in the store.** A new owner continues where the old one
   stopped, after the old owner's last covered window has synced.
2. **A source with a gap stops coverage.** A shard that cannot be read
   completely is not treated as empty; doctor names it
   (`dream-replay-gap`).
3. **A budget can stop a pass between windows or inside one.** The next
   pass continues from there, and the day stays open until nothing is
   behind.
4. **Late records count from when they arrive.** A record that syncs late
   is never archived unseen and does not reopen a window already judged.
5. **The staged flow waits.** While windows are behind,
   `o2b brain dream stage`, `validate`, `apply` and `retriage` are refused
   with `dream_replay_behind`, naming `o2b brain dream`.

`o2b dream owner` and `o2b dream status` show the last covered window,
how many windows are behind, and the windows whose model work still
waits. A brain whose records still live in the legacy `Brain/` tree runs
its single pass as before; its first live pass after the move to the
store starts the replay.

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
