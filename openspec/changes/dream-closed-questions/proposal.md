# Proposal

## Why

Dream asks seven kinds of closed question (which topic a record belongs to, whether a group deserves a topic, whether two topics are one, what kind of event a record is, whether a question was answered, whether a milestone is done, whether a note is readable). Today each is asked inside a 20 second window, newest first, and when no answer comes a fixed rule decides or the question is dropped. After a busy week or a long silence the older half is never asked. Version 2.0 says the opposite: a question that needs judgment waits for judgment. The queue exists; this change puts the closed questions on it and makes the decision model chain its first executor.

## What Changes

1. Seven queue operations, one per kind of closed question, one item per subject, each with its answer shape, its reread of the current input and its apply (the write functions of today).
2. The pass produces an item for every eligible subject, oldest first, with no lookback window and no per-pass cap.
3. A decision model executor answers ready items one at a time through the existing chain, under a pass budget, with the privacy checks, cost gate and chain fallback unchanged. Modes per use keep their meaning: off (left for the launched agent), shadow (asked and recorded, the item waits), enforce (answered).
4. **BREAKING**: the fixed rule no longer routes a record or stands in for an answer. An unanswered question waits; doctor and the status say how many wait, for which kind, and what would answer them.
5. An answer below its threshold finishes the item as abstained and decides nothing.
6. Topic judgment and topic planning are gated on the dream owner instead of the view writer. The device-local asked file is retired.

## Capabilities

### Modified Capabilities

- `dream-model-work` (from `dream-work-queue`): requirements are added for the closed questions as queue work, the decision model as an executor, and what waiting means for a user.

## Impact

1. Code: `src/core/topics/decide*.ts` (the pass becomes producers and operations), `decide-asked.ts` (retired), `decide-auto.ts` (the front door produces and runs the executor) and its three callers, `planning.ts` (reads the queue's fold under its lock, applies answers, gated on the dream owner), `plan.ts` (no rule routing; creation only on approval), `review.ts` and `actions.ts` (merge hints from the fold), `dream-tail.ts`, `dream-types.ts`, additions to the queue (`produceWorkBatch`, a release reason, an applied mark for planning, a take filter), a new `src/core/brain/dream-queue/decision-executor.ts`, doctor and the queue status view, `docs/decision-models.md`, `docs/how-it-works.md`.
2. Tests: every decide test that asserts "the deterministic outcome stands" changes to "the item waits and nothing is applied"; they are listed in `inventory.md` section 9.
3. Depends on `agent-neutral-dream` and `dream-work-queue`.
4. Risks: more requests per pass without batching; a brain with no decision model in force stops routing until the launched agent exists (the next change); two roles on different devices.
5. Not in this change: the launched agent, MCP tools for a session, text work, drafts, the launch command.
