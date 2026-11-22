# Proposal

## Why

Dream has work that needs a model: wording a summary, merging two rules, answering a closed question. Today that work is either dropped (the rollup ladder emits a request nothing answers) or decided by a fixed rule when a model is not there. Version 2.0 says such work waits for a model instead. Waiting needs a place: a durable queue that survives a crash and an owner transfer, keeps ordered work in order, never lets two workers hold one item, and tells the user what is stuck. This change builds that queue and nothing that drains it.

## What Changes

1. A work queue in the brain store: items, leases, answers, attempts and their fold into one state per item.
2. Core operations on it: produce, take, answer, apply, release, retry, cancel. They are functions in this change; a launched agent session reaches them through MCP in the change `dream-executors`.
3. Ordering by declared predecessors and resources, so work on one chain or topic never overtakes a stuck item while unrelated work proceeds.
4. Privacy: an item and its answers live in the partition of the most private record they are built from.
5. One production producer: the rollup ladder's model step, whose request is lost today.
6. Visibility: doctor codes, a section in the dream owner status, and `o2b dream queue` to list, retry and cancel.
7. Nothing else changes: the decide pass, the fixed rule and every existing pass outcome stay as they are. An item nobody can answer yet is reported as waiting.

### How the work is cut (amended)

The first proposal of this series cut five changes. The brainstorm of this change splits its second one in two, so the order is: `agent-neutral-dream`, `dream-work-queue` (this change), `dream-replay`, `dream-executors`, `dream-session-trigger`, `agent-parity`.

## Capabilities

### New Capabilities

- `dream-model-work`: the queue of work that needs a model: what an item is, when it may be taken, how an answer is accepted, what failure does, and what the user sees. Specified in this change for the queue itself; who answers, drafts and the end of the fixed rule are added by `dream-executors`.

### Modified Capabilities

None.

## Impact

1. Code: a new module family under `src/core/brain/dream-queue/` (records, fold, operations, registry of operations), the rollup ladder's emission in `src/core/brain/dream-rollup.ts` and `dream-report.ts`, doctor, the dream owner status, a new verb under `o2b dream`, the command manifest and CLI reference.
2. Store: new record kinds in a new stream `dream-work` of both partitions. The format document gains a section. No migration: a store without these records has an empty queue.
3. Depends on `agent-neutral-dream`: every writing operation passes the owner gate.
4. Risks carried into the design: a fold that every machine computes the same way while only one machine writes leases; an item whose evidence is deleted while it waits; the size of the stream over years.
5. Not in this change: any executor, any MCP tool for a session, drafts, closed questions moving off the decide pass, replay, the trigger.
