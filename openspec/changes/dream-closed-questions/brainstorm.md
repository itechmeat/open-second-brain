# Brainstorm

The owner's decisions for this part of the series are in `openspec/changes/agent-neutral-dream/brainstorm.md`, section "Model work": closed questions go to a decision model when one is configured and otherwise to the launched agent; the fixed rule no longer decides them; an unanswered question waits in a durable queue; every answer records who gave it. `inventory.md` in this folder is a read-only code inventory by an agent of another model family, made for the executors as a whole.

## The cut: executors in two changes

The inventory shows two bodies of work with one seam between them. The seven closed questions of today's decide pass already have typed questions, answer shapes, thresholds, write functions and an executor that exists (the decision model chain). Moving them onto the queue and ending the rule's stand-in needs no new process, no new MCP surface and no host knowledge. The launched agent needs all three, plus text work and drafts. So: `dream-closed-questions` (this change) and `dream-launched-agent` (next). The series is now eight: `agent-neutral-dream`, `dream-work-queue`, `dream-window-context`, `dream-replay`, `dream-closed-questions`, `dream-launched-agent`, `dream-session-trigger`, `agent-parity`. Main stays correct between the two: after this change a brain with a decision model in force judges as before, through the queue; a brain without one queues its questions and says so.

## Decisions

1. **One item per subject.** Today a request batches up to ten records and treats the whole request as each answer's input. A queue item has one subject and one input hash, and a batch would make one stale record invalidate nine good answers. Alternative: a batch item. Rejected: it changes what an answer and a supersession are. Cost: more requests; measured in the report.
2. **The decision model chain is an executor of the queue.** It takes ready items of the closed operations, asks one question per item through the existing request function, and answers the item with the model named. Its privacy and egress checks, cost gate and chain fallback stay as they are. An item it may not send (private evidence and a hosted chain) is left for a local executor, not failed.
3. **Modes keep their meaning.** `off` for a use: this executor does not take that use's items; they wait for the launched agent. `shadow`: it asks and records the answer for tuning, and the item keeps waiting. `enforce`: the answer is submitted to the queue.
4. **The rule stops deciding.** Where the rule routed a record by ranking when the model gave nothing, the record now stays unassigned until its item is answered. Where a failure "kept today's behaviour" and today's behaviour was "nothing derived", nothing changes. The count thresholds that decide whether a question is worth asking stay: the deterministic pipeline remains the frame. **BREAKING** for a brain that relied on rule routing with no model: its records wait, and doctor says why and what to configure.
5. **Thresholds live in the operation.** An answer below its use's threshold is a valid answer that decides nothing: the item finishes as "abstained", the subject stays as it is, and it is asked again only when its input changes. The queue's own validation stays about shape.
6. **No lookback and no newest-first cap.** The eight-week window and the per-pass caps existed to fit a 20 second budget; they are how a backlog was silently dropped. Every eligible subject gets an item, oldest first. What bounds a pass is the executor's budget, and what is left waits in the queue, visible.
7. **The asked set is the queue.** A finished or abstained item is the record that the question was asked. The device-local asked file is no longer read.
8. **Judgment and topic planning belong to the dream owner.** The decide pass and topic planning ran on the view writer's device. After this change every planning write is a judged write, so planning moves to the dream owner as a whole and the view writer only renders. The first draft moved only "judged writes" and left the view writer planning; the review showed that two planners on two devices create duplicate topics, since the topics fold accepts records from any device.
9. **Planning applies the answers, and the queue remembers them.** The first draft gave each operation an apply that called "the existing write block". The review showed there is none to call: the writes are closures inside planning's locked section, and a veto or a "none" writes nothing at all today. So planning reads the queue's fold under its lock, applies what is newly answered through the closures it already has, and reads standing verdicts (a veto, a "none", a merge hint) from finished items. No new record kind is needed.
10. **The pass stays synchronous.** Asking a model is asynchronous and the pass is not. The work keeps the place the decide pass has today, the asynchronous front door the callers await before the pass, and production there is unconditional, so a quiet brain's backlog is not stuck behind a pass that finds nothing to change.

## Rejected

1. Keeping the rule as a fallback behind a setting: the owner's decision is that a brain with no model path is not a supported state; a setting would keep two behaviours.
2. Moving text work in this change: it needs the launched agent.
3. Answering below-threshold items again on every pass: cost with no new information.

## Partner

The design questions here were settled by the owner in the shared brainstorm, whose partner was an agent of another model family at its highest reasoning setting. This change adds a code inventory and an independent review of its artifacts by a third agent; it was not given a second free-form brainstorm round, by the owner's instruction to move faster.
