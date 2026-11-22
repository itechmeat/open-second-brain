# Brainstorm

This change is one of the changes cut in `openspec/changes/agent-neutral-dream/proposal.md`. The shared brainstorm with the owner's decisions is `openspec/changes/agent-neutral-dream/brainstorm.md` ("Model work" items 1, 2, 5, 6 and 7 are binding here). The brainstorm of the replay change, proposed separately, was written together with this one and holds the partner's whole attack; this file keeps only what concerns the queue.

## The cut changed: six changes, not five

The first cut had one change, "replay and queue". The partner (an agent of another model family than the author, read-only against main, at its highest reasoning setting) judged it too large for one pull request and named the clean split: the durable queue first, with its complete internal lifecycle and no claim about completed coverage; the replay second. The order of the six is now: `agent-neutral-dream`, `dream-work-queue` (this change), `dream-replay`, `dream-executors`, `dream-session-trigger`, `agent-parity`.

## What the code does today

1. Nothing in the store is a work queue. The rollup ladder emits a `needs-llm-step` envelope onto the plan and into the summary, and nothing brings an answer back (`src/core/brain/rollup-ladder.ts`, `src/core/brain/llm-step.ts`).
2. Closed questions go through the decide pass (`src/core/topics/decide.ts`): a decision model when one is configured, under a 20 second budget, newest first inside eight weeks, and the fixed rule on every failure.
3. The store has two partitions, `shared` and `private`, and a record never moves between them. The view writer role is the existing pattern for state every machine must agree on: records in the `shared` partition and a fold (`src/core/view/writer-fold.ts`).
4. The one existing lease is a table in a device-local database, and its known failure is that two machines can both hold it.

## Decisions

Each line gives the author's first answer, the partner's finding where there was one, and what was decided.

1. **The queue is records in the store, folded into one state per item.** Alternative: a local database (rejected: state must survive an owner transfer and must not have two holders). Partner: sound.
2. **Where the records live.** The author put everything in `shared`. Partner: an answer is generated text over evidence, so it can disclose private evidence. Decided: an item, its evidence references and its answers are written to the partition of the most private record they are built from; a machine that does not hold that partition neither takes nor answers such an item, and reports the count without the subjects.
3. **Identity.** The author derived it from kind, subject, input hash and prompt version. Partner: it lacks the operation and the logical occurrence. Decided: an item's id is derived from the operation (the question or text task type), the subject, the occurrence (the window or the logical event that produced it), the input hash and the prompt and schema versions. Producing the same work twice is one item.
4. **Ordering.** The author gave an item one ordering key. Partner: a merge depends on two topics, a rollup of a higher rung on several unfinished summaries. Decided: an item declares the items it comes after and every ordering resource it touches (a record chain, a topic, a rung). An item is ready when all its predecessors are finished and no earlier unfinished item holds one of its resources. Unrelated work proceeds; work behind a stuck head waits.
5. **Leases.** The author judged expiry on the owner machine's clock and fenced with the owner revision. Partner: one machine still has concurrent workers, suspended workers and clock jumps, and the revision tells transfers apart, not two leases inside one revision. Decided: taking is serialised by a device-local lock; every take writes a lease with a generation one above the item's last; only the newest generation is live; expiry frees an item for a new take but an answer under an old generation is never accepted.
6. **Accepting an answer.** The author checked the lease, the revision, the input hash and the schema. Partner: a hash is not a check of the current state, and a repeat after expiry is undefined. Decided: acceptance rereads the item's input under the lock and compares it with the answered input; it checks the lease generation, the owner, the predecessors and the schema. The same answer under the same lease returns the first receipt. An answer for a superseded lease or a changed input changes nothing but its own attempt record; a changed input supersedes the item with a new one.
7. **Accepted is not applied.** Partner: the two must be separate states. Decided: an answer is accepted (durable, validated) and later applied by the producer's own code under the owner gate; only an applied item is finished. Text answers are applied as drafts by the executors change; in this change the application step is a registered function per operation.
8. **Failure.** Retry with bounded backoff; after a fixed number of failed attempts the item is parked and named in doctor with its reason and the retry command. Never decided by the rule. Partner: sound.
9. **Supersession and cancellation.** Partner: missing. Decided: an item whose subject was deleted, retired or changed is superseded by a record that names the reason and, when there is one, the successor; successors of a cancelled item are released or cancelled by their own rule, declared per operation.
10. **Producers in this change.** The author wired the rollup ladder as the only producer. Partner: one text producer does not prove ordering, stale closed answers or blocked successors, and a queue nobody drains must never count as finished work. Decided: the rollup ladder's model step is the one production producer (its envelope is lost today, so nothing regresses), and its unfinished items are reported as waiting, with the plain statement that no executor exists yet. The closed-answer contract and the dependency rules are proven by the queue's own tests with fixture operations registered only in the tests. The decide pass stays as it is until the executors change.
11. **Surfaces.** Counts by state, the age of the oldest ready item, parked items with reasons: in doctor, in the dream owner status, and a verb that lists the queue and retries or cancels an item. The operations take, answer and finish exist as core functions here; exposing them through MCP to a launched session is the executors change.

## Rejected

1. A queue in a device-local database: no transfer, two holders.
2. Everything in the `shared` partition: private evidence would leave through answers.
3. Moving the decide pass onto the queue now: closed questions would have nobody to answer them until the executors change.
4. A public setting that turns on a second production producer only to exercise the queue: fixtures in tests prove the contract without a switch users can see.

## Partner

The partner was an agent of a different model family than the author, run read-only against main at its highest reasoning setting, after a separate code inventory by a third agent. Of the author's eight queue answers it judged three sound, four underspecified and one flawed, and it asked for the split. Its findings are applied in the decisions above; none was overruled.
