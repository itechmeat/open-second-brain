# Proposal

## Why

Dream is the pass that turns what agents record into rules and topics, and today it belongs to nobody: the product starts it nowhere, the guides hang it on one agent's cron, a run by the wrong agent only prints a warning, and its judgment is either a fixed rule or an optional model that is off by default. A user who does not run that one agent gets a memory that never consolidates unless they build a scheduler themselves. Version 2.0 makes dream a property of the brain: owned by the agent installation the user chose, started by the product at the first session of the day, judged by a model the user already has, and identical for every supported agent.

## What Changes

The whole design, with the alternatives and the reasons, is in `brainstorm.md`. In short:

1. Every brain has one dream owner: one enrolled agent installation on one machine, by default the one that created the brain. Ownership is transferred by one operation available on the command line and through MCP, and across machines by an acknowledged handoff. Every live dream path passes one gate; a machine that is not the owner previews and does not write. **BREAKING**: a dream run by anything but the owner is refused instead of warned about.
2. Dream is started by the product, with no scheduler: a check at session entry reads one small machine-local record and, when a pass is due, claims it and spawns a one-shot worker. When the day is closed the check costs one file read.
3. A gap is replayed in order. The pass keeps a position per source and processes missed windows oldest first, so a machine that was off for weeks ends in the state daily runs would have produced. Coverage advances only after outcomes are durable.
4. A model takes part in every pass. Closed questions go to a decision model when one is configured and otherwise to the chosen agent; wording and merging go only to the chosen agent, launched from the command line as a short isolated session that takes a queue through MCP. **BREAKING**: the deterministic rule no longer stands in for a missing model; unanswered work waits in a durable queue and is named in doctor.
5. Text a model wrote is stored as a draft with its author recorded; applying drafts automatically is a setting.
6. No agent is privileged. The Hermes cron line and environment file leave the shared recipes, the embeddings guide and the uninstall plan stop assuming Hermes, the digest is shown by any agent at session start, the discipline check moves into doctor, and the Hermes cron installer with its Telegram format is removed. **BREAKING**: `o2b discipline install` and `o2b discipline uninstall` are removed. What is specific to Hermes stays: the memory provider, the host memory bridge, profile isolation, and the repository root as its install entry.
7. An existing installation keeps working until its user adopts the new scheme: an explicit `primary_agent` is kept as the requested owner, an external trigger keeps running, and adoption binds the owner, verifies the model path and then refuses the old trigger with a message that says how to remove it.

### How the work is cut

The repository's rule is one change per pull request. This change is the first of five and carries the shared brainstorm; each of the other four gets its own change with a short brainstorm that points here, its own specs, design and tasks.

1. `agent-neutral-dream` (this change): the owner, its creation, status and transfer, the single gate, adoption of an existing installation.
2. `dream-replay-queue`: positions per source, oldest-first replay, the durable model queue.
3. `dream-executors`: the launch command, the launched session and its isolation, the fallback list, decision models as the first executor for closed questions, drafts, setup questions.
4. `dream-session-trigger`: the session entry check, the claim and the one-shot worker.
5. `agent-parity`: the Hermes surfaces, digest and discipline, the end-to-end journey with no Hermes, the measurement, then the 2.0 documentation and release.

The order is fixed: triggering is enabled only after everything it starts exists.

## Capabilities

### New Capabilities

- `dream-ownership`: who may run a live dream pass on a brain, how the owner is chosen at creation, shown, transferred on one machine and handed over between machines, what every other caller gets, and how an installation from before this change is adopted. Specified in this change.

Named here so the later changes use the same paths; each is specified in its own change:

- `dream-replay`: what a pass covers, in which order missed windows are processed, and when coverage advances.
- `dream-model-work`: the queue of work that needs a model, who may answer it, how an answer is validated, drafts, and what happens to work nobody can answer.
- `dream-trigger`: when a pass starts without a scheduler and what the check costs.
- `agent-parity`: the surfaces every supported agent gets equally, and the ones that are adapter features.

### Modified Capabilities

None in this change. `openspec/specs/` holds five capabilities today (`held-partitions`, `lane-entry-fidelity`, `okf-export`, `remote-log-reads`, `store-shard-gaps`) and none of their requirements change here. The capabilities of the in-flight change `brain-store-and-topics` (`topics`, `human-view`, `brain-store`) are not archived yet; the change `dream-executors` moves topic judgment from the view writer to the dream owner and will carry that delta once those specs are on main.

## Impact

1. Code in this change: `src/core/brain/dream.ts` and its entry points (the dream verb, the MCP dream tool, staged apply, the mutating steps, the maintenance lane's dream task), `src/core/brain/policy/primary-agent.ts`, `src/core/brain/init.ts` and `init-store.ts`, the settings write authority in `src/core/brain/policy/settings-write.ts`, `o2b brain set-primary`, doctor, the handoff pattern in `src/core/view/writer.ts` (reused, not changed), the install guides and the managed writeback block that tell agents who runs dream.
2. Interfaces: a new transfer operation on the command line and in MCP; a new status surface for the owner; `primary_agent` keeps its name and gains a device and enrollment binding and a revision; a refused run gets a named error instead of a warning.
3. Existing installations: nothing changes for a brain until it is adopted, except that the product starts telling the user that the owner is not chosen.
4. Risks carried into the design: a name is not proof of an installation; two machines that sync late must never both hold the role; the gate must sit below every entry point and above model preparation and the early repair writes; a legacy trigger from an older binary cannot honour the new gate, so adoption requires that binary to be upgraded or stopped.
5. Not in this change: any trigger, any model work, any change to the Hermes surfaces beyond the dream ownership text in its install guide.
