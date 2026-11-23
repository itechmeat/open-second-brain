# Design

## Context

From `inventory.md` (each claim with its code reference there):

1. `decideTopicPlan` (`src/core/topics/decide.ts`) runs seven uses in a fixed order under one 20 second budget, on the view writer's device, over candidates limited to eight weeks and taken newest first with per-pass caps (`decide-shared.ts`, `questions-topics.ts`). Its callers reach it through `prepareTopicVerdicts` (`decide-auto.ts`), which fails open to "no verdicts": the dream verb, the MCP dream tool and the maintenance lane task.
2. The uses, their questions, thresholds and versions are in `questions-topics.ts`; their runners in `decide-route.ts`, `decide-same.ts`, `decide-items.ts`, `decide-history.ts`; verdicts land in memory (`verdicts.ts`) and are applied by `planTopics` (`plan.ts`: a route verdict routes, else the ranking `bestTopic` does; a vetoed group is skipped) and by `writeVerdictRecords` (`verdict-writes.ts`: derived items, resolution and completion proposals, history verdicts), all revalidated against the state read under the planning lock.
3. A "same topic" verdict only annotates the review listing of the pass that got it (`plan.ts`, `review.ts`).
4. `runDecision` (`src/core/decision-model/run.ts`) is the one request function: stateless per call, never throws, returns a typed result or a degrade reason; only network and timeout fall through the chain. `mayShareRecord` (`egress-guard.ts`) decides whether a private record may leave. Modes per use are off, shadow, enforce (`config.ts`), and enforce is held to shadow for an untuned entry. A caller tells "not configured" from "failed" by the config status, not by the run result.
5. The asked set is a device-local file keyed by use, subject, question version, model and mode (`decide-asked.ts`).
6. The queue (`src/core/brain/dream-queue/`): `registerDreamWorkOperation` with `validate`, `currentInput`, `apply` and the closed-predecessor rule; `produceWork`, `takeWork`, `answerWork`, `applyAccepted`, `releaseWork`; `answerWork` validates shape only; every entry point takes the owner gate and the queue lock and reads and folds the whole stream, so one call per item is costly. The fold keeps the reason of a failed attempt and drops the reason of a released one. The answer record has `agent` and `model` and no provider.
7. `dream()` and `dreamRun` are synchronous, and the architecture says so ("`dream()` stays synchronous; the asynchronous front doors await this pass"). The decide pass is such a front door: the three callers await it and hand its verdicts to the pass. `dreamRun` returns early when nothing changed, before its executing branch. Topic planning is not inside `dreamRun`: it is `withTopicPass`, a wrapper around it (`src/core/brain/dream-tail.ts`), run on every device's live pass.
8. The writes are not standalone functions. `planUnderLock` (`src/core/topics/planning.ts`) takes the device-local planning lock, reads the fold, checks a fence of topic record ids, builds the append closures, and inside them `writePlan` writes routes and creates and `writeVerdictRecords` writes derived items, proposals and history verdicts. Each of those is guarded by state (an item id equal to the record id, a set of already proposed resolutions, and so on); convergence is a property of planning rereading the fold under its lock. Planning is gated on the view writer (`writerGate`, checked before and under the lock).
9. A veto and an enforced "none" route write nothing today: the veto lives in memory for one pass, the "none" in the asked file. The topics fold applies topic records from any device, resolves registers by last write, and keeps two creates with different ids as two topics.
10. `runDecision` returns per question a choice with optional per-option probabilities, or a probability of yes; confidence is the probability of the chosen option and may be absent. `result.response.model` is always a string; `answeredBy.model` may be null. `mayShareRecord` takes a boolean, and a record the chain may not receive is masked when its candidate is built (`recordCandidate`). A state over the token limit degrades with `budget`, per request.
11. Uses are named with underscores (`topic_route`); `groups()` and `qualifies()` are private to `plan.ts`.

## Goals / Non-Goals

**Goals:**

1. Every closed question is asked, however old, in order.
2. No outcome without an accepted answer.
3. A brain with a decision model in force behaves as before for what the model answers confidently.

**Non-Goals:**

1. The launched agent, MCP tools for a session, text work, drafts.
2. New kinds of question, new thresholds, a change to the chain or its configuration keys.
3. Batching several subjects in one request.

## Decisions

### D1. Where the work runs: the front door, then the pass, then planning

The pass stays synchronous. The asynchronous work keeps the place the decide pass has today, the front door the three callers await (`decide-auto.ts`), which now does, on the dream owner's device, for a live pass only:

1. `produceTopicQuestions` (D3): every eligible subject gets an item. This is unconditional: it does not depend on the pass finding a change.
2. `runDecisionExecutor` (D4): answers what it may within the budget.

Then the callers run `dream()` as today. Its existing `applyAccepted` at the top applies queue work of other operations. Topic planning, in `withTopicPass`, is where the closed questions' answers take effect (D2). A dry run and a preview do none of this.

### D2. Planning is the applier, and the queue is the memory of verdicts

The answers of the seven operations are not applied by the queue's generic `applyAccepted`. An operation carries a trait `appliedBy: "planning"`, and `applyAccepted` skips such items.

`planUnderLock` reads the queue's fold beside the topics fold and builds from it the `TopicVerdicts` value that the decide pass used to hand over in memory:

1. From items that are `accepted` (answered, not yet applied): routes, approvals, kinds, resolutions, completions, keep and hide verdicts. Planning applies them through the closures it has (`writePlan`, `writeVerdictRecords`), which revalidate against the state under the lock as today, and then marks each item applied with the ids of the records written, or with the marker `abstained` when the answer decided nothing (D5), in the same locked section.
2. From items that are `finished`, the standing verdicts that must hold in later passes without any record of their own: a veto of a group, a "none" for a record (it stays unassigned), a same or different hint for a pair. These are read from the fold every time; no new record kind is added for them, and the review listing (`reviewTopics`, called from `review.ts` and `actions.ts`) gets its hints the same way.

A repeat converges because the guards are the existing ones and because an item already marked applied is not fed again.

`planTopics` stays pure: it is given the verdicts. The mapping from a planned group to its item is the group key (`topicGroupKey`). A group is created when it qualifies and its `topic-new` item is answered with an approval; a group with no answer yet, or a veto, is not created. A record is routed only by a route answer; `bestTopic` and its one call are removed, `rankedRouteTopics` keeps building the option list.

**Who plans.** On a brain with a dream owner, topic planning is gated on the dream owner instead of the view writer: `writerGate` in `planning.ts` (both checks and the re-check under the lock) asks the owner role. The view writer keeps rendering the human view. After this change every planning write is a judged write, so there is one planner, the owner's device, and no second device that could create a duplicate topic. On a brain with no owner bound (unbound or legacy) planning keeps the view writer gate and, having no queue answers, creates and routes nothing; doctor already tells such a brain to choose its owner. A device that does not plan says so in its pass summary (`judgment: "elsewhere"`).

### D3. Operations and producing

`src/core/topics/decide-operations.ts` registers seven operations, named after the uses with hyphens (`topic-route` for the use `topic_route`, and so on; one function maps the two spellings). Each has `appliedBy: "planning"`, closed-predecessor rule `release`, `validate`, and `currentInput`.

| Operation | Subject | Input (hashed) | Answer value | Decides |
|---|---|---|---|---|
| `topic-route` | record id | record text, the ranked option topics and their head fields | `choice`, `confidence` | a topic at or above `route_min`; `none` at or above it keeps the record free |
| `topic-new` | group key | member texts, drafted title | `p` | always: below `veto_below` a veto, otherwise an approval |
| `topic-same` | pair `a..b` | the two topics' head fields | `choice`, `confidence` | at or above `same_min` |
| `event-kind` | record id | record text, topic title | `choice`, `confidence` | not routine and at or above `kind_min` |
| `question-resolved` | record id | record text, the open questions | `choice`, `confidence` | a question at or above `resolved_min` |
| `milestone-done` | milestone owner and id | the milestone and the five newest held records | `p` | at or above `done_min` |
| `human-readable` | note id | note text | `p` | always: below `hide_below` hide, otherwise keep |

1. Every answer value also carries `provider` and `model`, so the verdict built from it names its author as verdict bodies do today.
2. `validate`: the shape; a choice is one of the item's options. A choice with no confidence is valid and is treated as below the threshold.
3. `currentInput` rebuilds the input with the builders the runners use today and hashes it; null when the subject is gone or no longer eligible. For `topic-new` it needs the grouping: `groups` and `qualifies` are exported from `plan.ts`.
4. `occurrence`: the UTC day and id of the subject's own record; for a group, of its oldest member; for a pair, of the younger topic's creation; for a milestone, of the milestone.
5. `prompt_version` is the use's question version, so a new version re-asks, as today.
6. Resources `record:<id>` and `topic:<id>`; an `event-kind` item comes after the unfinished `topic-route` item of the same record.
7. Payloads are built without the egress mask (the full text, in the partition of the most private source); masking and refusal are the executor's, at take time.

`produceTopicQuestions(queue, state, deadline)` in `decide-produce.ts` builds candidates with today's builders minus the lookback and the caps, oldest first, and writes them with a new queue entry point `produceWorkBatch(queue, specs)`: one gate, one lock, one read and fold, one write per new item. Producing one by one would read and fold the whole stream per item. It stops at the deadline and reports how many subjects are left; the next run continues, since existing items are skipped by identity.

### D4. The decision model executor

`src/core/brain/dream-queue/decision-executor.ts`: `runDecisionExecutor(queue, { vault, deadline })`, asynchronous.

1. Resolve the decision model configuration. Not active: return with `not-configured`, having taken nothing.
2. Loop until the deadline: `takeWork` filtered to the closed operations whose use is not off and whose item was not already released in this run; none: stop. (`takeWork` gains the optional filter.)
3. The item's partition is the privacy flag: for an item in `private`, `mayShareRecord(cfg, use, true)`; refused: `releaseWork` with the reason `egress-refused`, continue.
4. Build the request from the payload and the one question; `runDecision`.
5. A typed answer in enforce: `answerWork` with `agent: "decision-model"`, `model: result.response.model`, and the value of D3. In shadow (also an untuned entry held to shadow): `releaseWork` with the reason `shadow`; the accounting record `runDecision` writes for every attempt is the record of the answer.
6. Degraded: `timeout`, `network`, `invalid_reply`, `http_*` and a per-request `budget` (a state too large): a failed attempt, so backoff and parking apply. `cost_gate`: `releaseWork` and stop the loop.

`releaseWork` gains an optional reason, and the fold keeps the last release reason with the input hash it was given for. An item released as `shadow` or `egress-refused` for its current input is not taken again by this executor until the input, the configuration's mode for the use, or the chain changes (the take filter reads the fold's field). No device-local file is involved.

The deadline is `dream.model_budget_ms` (default 20 000, today's constant) for production and answering together, production first; the lane task and the MCP tool clamp it to their own deadline as they do today.

### D5. Abstaining

For the five operations with a threshold, an answer below it (or a choice with no confidence, or `none` / routine where that means "nothing") decides nothing: planning marks the item applied with `abstained`, writes nothing for it, and the subject is asked again only when its input changes. `topic-new` and `human-readable` always decide, as today, and never abstain. A "none" route at or above the threshold is a decision (the record stays free), not an abstention.

### D6. The asked file

`decide-asked.ts` and its file are no longer read or written. The file is left on disk.

### D7. Surfaces

1. The queue status groups waiting items by operation and, for the closed ones, by reason, each derived from records: `no-model` (the configuration is not active or the use is off), `shadow` and `needs-local-executor` (the last release reason for the current input), `retry-at` (a failed attempt), and `not-reached` (ready, due and answerable, simply not taken yet: the budget). `dream-queue-no-executor` becomes per operation and names the setting: for a closed operation, `decision_model_uses` with the use and `enforce`.
2. Doctor code added: `dream-questions-waiting` (advice, per operation: the count, the oldest age, the reason and the action). Registered and placed for the exit census (`doctor.ts`, `doctor-exits.ts`, `diagnostics.ts`).
3. The pass summary's `model_work` gains `abstained` and, per operation, `asked`; the summary gains `judgment` (D2).
4. `docs/decision-models.md`: the section on what happens without a model is rewritten; `docs/how-it-works.md`: the decide pass becomes the queue, and topic planning's device.

## Risks / Trade-offs

1. One request per subject instead of ten per request: more requests and more input tokens for the shared context. The report measures a pass over a generated backlog before and after (requests, time). If the cost is unacceptable the remedy is a batch executor that still answers items one by one; not built here.
2. A brain with no decision model in force stops routing records and creating topics until the launched agent exists. This is the owner's decision; it holds for the time between this change and the next, both before any release.
3. Topic planning moves from the view writer's device to the dream owner's. On a brain where the two differ, the device that planned yesterday stops and the owner's starts; both read the same synced topic records, so nothing is lost, and there is never a moment when both are allowed to plan, because the role folds agree. A brain with no owner stops creating and routing until its owner is chosen.
6. `milestone-done` hashes the five newest records of a topic, so an active topic supersedes its item whenever a record arrives, as its asked key changes today. A test pins it; the executor's cost follows it.
4. A first run on a large brain produces thousands of items in one batch write, bounded by the deadline and resumed by identity. Taking and answering are one queue call per item, bounded by the same deadline; the report measures them.
5. An abstained item is never asked again until its input changes. A better model later does not revisit it; `o2b dream queue retry` on a finished item is not offered. Accepted: the question version changes when the prompt does.
