# Design

## Context

From `inventory.md` (each claim with its code reference there) and the designs before this one:

1. The queue: `takeWork`, `answerWork`, `releaseWork`, `applyAccepted`, operations registered with `validate`, `currentInput`, `apply`. The change `dream-closed-questions` adds to it the trait `appliedBy: "planning"`, a take filter by operation, a release reason kept by the fold, `produceWorkBatch`, the decision model executor and the producer of closed questions; this change is built on a branch that holds it, and task 0.1 stops without it. The queue reads the settings stream only for the owner records, and its listing has no text field (the fold keeps an answer's text). The answer record has `agent` and `model`. Every writing entry point passes the dream owner gate.
2. `rollup-summary` is registered; its `apply` refuses. Its payload holds the prompt, the schema hints and the target path; its answer is a whole note (frontmatter with a `kind`, then a body).
3. A new topic's title and goal are drafted by `draftTitle` and `draftGoal` in `src/core/topics/plan.ts` and written on the create record by planning.
4. MCP: tools are `ToolDefinition` objects assembled in `buildToolTable`; a profile (chosen with `--tool-profile`) pairs a scope with a window of allowed tools, and every table keeps `second_brain_capabilities`, whose report names the withheld tools. Resources (`resources/list`, `resources/templates/list`, `resources/read`) are dispatched with no profile check and serve brain prose. The instruction text has no per-profile form. Profiles are enumerated twice (`TOOL_SURFACE_PROFILES` and `INSTALL_TOOL_PROFILE_NAMES` in `src/core/brain/policy/blocks/install.ts`, held equal by a test), and a profile name is a legal `tool_profile` value in the brain's settings. Over stdio a caller has no credential and takes the configured identity. `handleInitialize` runs no hook and no capture.
5. Every hook command goes through one launcher, `scripts/o2b-hook` (and, from a registry install, `bin/o2b-hook.js`). Session capture has two seams, both through the capture boundary and both keyed on a session id or a transcript path: the live hook and the batch import, which reads a host's transcripts later with no environment of the session. No environment marker suppresses either.
6. Subprocess precedents: host probes, synchronous with a ten second cap (`host-probe.ts`), and the detached self-worker, fire and forget (`o2b-command.ts`). Nothing starts a program, awaits it for minutes and ends it. The only quoting helper joins words for display; nothing splits a command line. No non-interactive form of any agent is recorded in the repository.
7. Machine-local settings are flat keys of the machine config with environment twins; shared settings are a closed list of store keys, so a key that is not in that list never syncs.
8. The front door (`decide-auto.ts`) is asynchronous and awaited by the three callers of a live pass. The MCP dream tool and the maintenance lane task share one cooperative deadline, 600 seconds by default, that the pass's checkpoints enforce; the dream verb passes none.
9. Every queue entry point needs a store and passes the owner gate. The rollup note is written by the note creation path, which makes store writes of its own.

## Goals / Non-Goals

**Goals:**

1. A user's own agent answers the queue in a session that can do nothing else.
2. Nothing a model wrote appears without its author, and nothing is applied against the user's review setting.
3. A machine with no decision model works once an agent command is verified.

**Non-Goals:**

1. Starting anything at session entry, or detached: the trigger change.
2. Presets for agents that were not run by this change's check.
3. Model-written pages of the human view; the merged wording of two topics.

## Decisions

### D1. Settings and presets

Machine config keys, with environment twins, validated like the decision model keys (an error names the key, never a value):

1. `dream_agent_command`: a preset name, or a JSON array of strings: the program and its arguments.
2. `dream_agent_fallbacks`: a JSON array whose entries are preset names or such arrays, tried in order.
3. `dream_agent_budget_ms` (default 300 000) and `dream_agent_items` (default 50): the bounds of one run.

A custom command is an array, not a line, so nothing is split or quoted on any system. Its strings may hold the placeholders `{prompt}` (the fixed task text), `{mcp_config}` (the path of a file the worker writes for the run, holding the one server of D3 in the common MCP JSON shape) and, for agents that take the server inline, `{mcp_command}` and `{mcp_args_json}`. The program is started without a shell.

`src/core/brain/dream-queue/agent-presets.ts` holds a table `name -> { program, args, restricts }`: `restricts` says whether the form limits the session to the given server and tools. A preset with `restricts: false` is not offered. The table ships with the presets this change verified by task 6 (at least Claude Code and Codex, the two agents on the development machines); each entry names the program version it was verified with. Any other agent is configured with a full command line, and the check of D5 is what makes it usable.

### D2. The run record and the marker

`src/core/brain/dream-queue/run-record.ts`: before starting a session the worker writes `<device state>/dream/runs/<run id>.json` with the run id, the sha256 of a random token, the owner revision, the expiry (now plus the budget) and the allowed operations; mode 0600. It is removed when the run ends; a stale one is ignored by its expiry and swept by the next run.

The session's MCP server receives two environment variables: `OPEN_SECOND_BRAIN_DREAM_RUN` (the run id) and `OPEN_SECOND_BRAIN_DREAM_TOKEN`. The first is the marker: any process that carries it is "inside a dream session". The pair, checked against the run record, is the credential.

The marker is honoured in one function, `insideDreamSession(env)`, called in the two hook launchers before any hook file is run (exit 0 at once), by the live capture seam, and by the future day check. It never widens anything.

The batch import has no environment to read, so the session also marks itself in its content: the fixed task begins with the line `open-second-brain-dream-session <run id>`, and the capture boundary treats a session whose first user message begins with that line as ignored, at both seams. The run id in the line lets a doctor tell a real run's transcript from text that merely quotes the line; a transcript with the line is never captured either way.

The server of the run appends one line per call (the tool, the outcome, no content) to `<device state>/dream/runs/<run id>.calls`, which is what the worker and the check read to say what a session did.

### D3. The executor profile and its three tools

A profile `dream-executor` that is exact: its tool table is the three tools and nothing else (the capability tool is not kept), and in it the server answers the resource methods with an empty list and refuses a read, does not advertise resources or prompts at initialize, and gives the fixed task as its instruction text. The profile is not a legal `tool_profile` value of a brain's settings and not an install profile: it is reachable only as `o2b mcp --tool-profile dream-executor`, and in it the server refuses to start without a live matching run (the two variables).

1. `dream_work_take {}` returns `{ item: null, reason }` or `{ item: { id, generation, operation, question, payload, evidence, answer_shape } }`. It calls `takeWork` with the run id and the run's filter (D4), counts against the run's item budget, and never returns a private item's evidence beyond what the item holds.
2. `dream_work_answer { id, generation, value | text, model, confidence? }` calls `answerWork` with `agent` set from the run (the configured agent name of the command that was started, not what the session claims) and `model` as stated by the session. It returns the queue's result: accepted with a receipt, or refused with the reason, so the session can correct a shape error once.
3. `dream_work_finish {}` releases every lease of the run.

Each handler checks the run first and passes the dream owner gate through the queue. The run record's owner revision must equal the current one.

### D4. The agent executor

`src/core/brain/dream-queue/agent-executor.ts`: `runAgentExecutor(queue, { vault, deadline })`, called by the front door after the decision model executor, in a live pass on the owner's device.

**The time it may take.** The run's budget is the setting, clamped by the caller: the dream verb passes the setting; the MCP dream tool and the lane task pass the time left on their shared deadline minus a reserve of 90 seconds for the pass that follows. Under 30 seconds the executor is skipped for this pass with the reason `no-time`, and the status says so. The run record's expiry is this clamped budget.

**Starting and ending a program.** A new helper, `src/core/process/run-program.ts`: start a program by absolute path with an argument array and an environment, asynchronously; resolve on exit or at a deadline; at the deadline end it (on POSIX the termination signal to the process group, then the kill signal after five seconds; on Windows the process tree) and resolve with `timed-out`. It never uses a shell. It has its own tests with small scripts, on the three systems.

1. Decide what the session may take: every text operation; a closed operation when the decision model is not active or its use is off. Nothing ready: return.
2. Resolve the command: the verified one (D5); none verified: return with the reason, and the status names it.
3. Write the run record and the MCP config file; start the program with the absolute path found on PATH, the arguments from the template, the two variables in its environment, standard input closed, output to a run log under the device state directory; no shell.
4. Await `runProgram`. On the deadline it ends the process; the executor continues.
5. Release every lease the run still holds, remove the run record and the config file.
6. A session that exited non-zero or answered nothing: try the next fallback once, with a fresh run. Record which command ran and how it ended; no second pass over the fallbacks in one run.

The fixed prompt is one paragraph: call take; for the item, read the question and the payload, produce the answer in the given shape, call answer; repeat until take returns no item; then call finish and stop. It names no file, no tool but the three, and no user data.

### D5. Verification

`o2b dream agent` (`src/cli/dream/agent.ts`): `show`, `set <preset or command> [--fallback ...]`, `check [--command ...]`.

`check` creates a throwaway store with both partitions under the device state directory (not the brain), claims its dream owner for this device, registers a canary operation for the duration of the call (`agent-check`: a fixed question with one right closed answer and one short text answer), produces two canary items there, starts a session exactly as D4 does against that store, and passes when both items were answered correctly and finish was called, within 120 seconds. It records `{ command hash, agent, model, verified_at, program version }` in `<device state>/dream/agent-verified.json`. A command whose hash is not in that file is not used by D4. The throwaway store is removed afterwards by its exact path. The check prints what the session did when it fails, from the run's call log: started or not, tools listed or not, calls made.

If the setup verb of the change `setup-verb` is in the branch this is built on, `o2b setup` gains `--dream-agent <preset>`: it sets the command and runs the check as one of its verification steps, and without the flag reports that no dream agent is set. If it is not, this is left for the change that lands second, and the report says so.

### D6. Text operations

1. `rollup-summary`: `apply` validates the note (frontmatter with the expected `kind`, a non-empty body, the bounded size), writes it at the target path of the payload through the note creation path with `written_by: { agent, model, item }` in its frontmatter, and returns the path as its effect. A second apply finds the same content and writes nothing. `apply` runs inside the queue's lock and the note creation path takes locks of its own: the task proves the order with a test that applies while another process holds each of those locks, and moves the write after the queue lock if they can deadlock.
2. `topic-wording` (new, `appliedBy: "planning"`): subject the group key, input the member texts, answer `{ title, goal }` with length bounds, `after` the group's `topic-new` item. Planning creates a topic when it qualifies, its `topic-new` answer is an approval and its wording answer is applied-eligible; the create record carries the title, the goal and the author. `draftTitle` and `draftGoal` are removed from the create path; the drafted title stays only as part of the `topic-new` question's input, where it is today. The item is produced by the producer of closed questions, for every group that qualifies, in the same batch as its `topic-new` item.

### D7. Drafts

A text operation carries the trait `text: true`. `dream.apply_drafts` (a shared setting, since it is a rule of the brain and not of a machine): `auto` or `review`, default `auto`.

1. `auto`: text answers are applied like any other, by `applyAccepted` or by planning.
2. `review`: an accepted text answer is not applied until a `dream-work-approve` record with human authority exists for the item. `o2b dream queue approve <id>` writes it; `o2b dream queue reject <id> --reason <text>` cancels the item. `o2b dream queue --state accepted` lists what waits, with the text.

The fold is given the setting's value in its input (the queue reads it from the settings stream it already reads) and gains the state `awaiting-review` (accepted, text, review mode, not approved), counted apart in the status. The queue's listing gains the answer's text for accepted text items. `dream.apply_drafts` is added to the closed list of shared setting keys.

### D8. Surfaces

1. Doctor: `dream-agent-unset` (advice: work waits that only an agent may do and no command is set), `dream-agent-unverified` (warning: a command is set and was never verified, or its hash changed), `dream-agent-failed` (warning: the last run failed, with how), `dream-drafts-waiting` (advice: count awaiting review). `dream-queue-no-executor` now speaks only when neither executor can answer an operation. All registered (`doctor.ts`, `store-side-pass.ts`) and placed for the exit census (`doctor-exits.ts`, `diagnostics.ts`).
2. The dream status: the command (preset name or "custom"), verified or not and when, the last run (agent, model, items answered, how it ended), items awaiting review.
3. The queue's `executor` field becomes true per operation when something can answer it.
4. `docs/dream.md` (new): who answers what, how to set and check the agent, what a session can and cannot do, drafts. `docs/mcp.md`: the profile and its three tools.

## Risks / Trade-offs

1. Isolation is only as good as the agent's own flags. A preset states `restricts`; a custom command line is the user's statement. The server side holds regardless: the profile has three tools and a run credential, so the session cannot do more through Open Second Brain; what else the agent's own tools can touch is the agent's configuration, and the documentation says so.
2. A session costs the user's subscription. The item budget and the time budget bound it; the status shows what a run consumed in items.
3. Private evidence is shown to the user's own agent on the user's own machine. The egress checks of the decision model do not apply to a local command; a command that fronts a hosted model sends it out. Stated in `docs/dream.md`; a setting `dream_agent_private` (default on) lets a user keep private items from the session.
4. The model a session reports for itself is not verifiable. It is recorded as stated; the agent name is the worker's.
5. Presets go stale when an agent changes its flags. The check fails loudly and the user sets a command line.
6. Topic creation now waits for two answers (approval and wording). On a machine with a decision model and no agent, topics are approved and never created; doctor's `dream-agent-unset` is the pointer.
