# Design

## Context

1. The store has two partitions, `shared` and `private`; a stream is a family of per-device, per-month shards; a record never moves between partitions; record kinds are validated by form, with no registry to extend (`src/core/store/FORMAT.md`).
2. The view writer role is the pattern for state all machines must agree on: records, a fold in `(clock, device, id)` order through `prepareRecords`, rejected records listed and never applied (`src/core/view/writer-fold.ts`, `src/core/store/fold.ts`).
3. Records are written through `storeWrite` / `routeWrite` (`src/core/store/store-write.ts`) and read through `readStreamRecords` (`src/core/store/read/stream-read.ts`), which reports unreadable shards and gaps. A device-local lock is `withLocalLock` (`src/core/store/local-lock.ts`).
4. The change `agent-neutral-dream` gives every live dream path one gate, `assertDreamOwner`, which throws `DreamNotOwnerError` (code `dream_not_owner`), a pass lock on the owner's device, and an owner revision that grows with every transfer.
5. The rollup ladder builds a `needs-llm-step` envelope (`src/core/brain/rollup-ladder.ts`, `llm-step.ts`); the pass puts it on the plan and in the summary (`dream-summary.ts`, `dream-report.ts`) and counts emitted work toward higher rungs through the ledger baselines. Nothing consumes the envelope. The ladder works on counts only: it is handed `salienceGate.admitted`, a number, and its ledger holds counters; the salience gate keeps ids only for the facts it excluded (`src/core/brain/salience-gate.ts`).
6. A stream is known to the store's enumerations (the digest cut, the doctor walks, the device-state scan, the search shard scan, `o2b store shard`, the migration dry run) only when it is in `STORE_STREAMS` (`src/core/store/constants.ts`). `FORMAT.md` is shipped verbatim and a store's copy is refreshed only for a newer format version (`src/core/store/format-doc.ts`); `tests/core/store/format-doc.test.ts` requires every stream and kind to be documented.
7. `storeWrite` throws when there is no store, and on a machine that has not switched to the store the dual write swallows failures. A dry run reaches the start of `dreamRun` like any pass and must write nothing. The local lock is not re-entrant and waits 5 seconds by default (`src/core/store/local-lock.ts`, `src/core/fs-lock.ts`).

## Goals / Non-Goals

**Goals:**

1. A queue whose state every machine folds identically and only the owner's device changes.
2. Ordering, leases and acceptance that hold under a crash, two local workers, a late worker and an owner transfer.
3. No private evidence in the shared partition.
4. No change to any existing pass outcome.

**Non-Goals:**

1. Anything that answers an item: executors, the MCP tools for a session, the launch command, drafts.
2. Moving closed questions off the decide pass, or removing the fixed rule.
3. Replay, coverage, the trigger.

## Decisions

### D1. Records and the fold

A new stream `dream-work` in each partition, added to `STORE_STREAMS` so every enumeration sees it. Kinds, all written with `agent` authority by the owner's device unless stated:

| Kind | Body | Written by |
|---|---|---|
| `dream-work-item` | `id`, `operation`, `subject`, `occurrence`, `input_hash`, `prompt_version`, `schema_version`, `answer_schema`, `after` (item ids), `resources` (strings), `private_resource_barriers` (sha256 keys of resources held by earlier private work), `evidence` (record ids and blob references, bounded), `payload` (what the executor is shown) | the producer |
| `dream-work-lease` | `item`, `generation`, `lease_token` (unique to this take), `run`, `owner_revision`, `expires_at` | take |
| `dream-work-answer` | `item`, `generation`, `lease_token`, `input_hash`, `value` or `text`, `agent`, `model`, `receipt` | answer |
| `dream-work-attempt` | `item`, `generation`, `lease_token`, `outcome` (`failed`, `refused`, `released`), `reason`, `retry_at` | answer, release, expiry seen by take |
| `dream-work-applied` | `item`, `generation`, `lease_token`, `receipt`, `effects` (ids of what was written) | apply |
| `dream-work-closed` | `item`, `reason` (`cancelled`, `superseded`), `successor`, `authority` | cancel, supersede |
| `dream-work-retry` | `item`, `authority` `human` | the retry command |

The item id is the hex sha256 of the canonical JSON of `[operation, subject, occurrence, input_hash, prompt_version, schema_version]`. A second `dream-work-item` with an id already folded is ignored.

The fold (`foldDreamWork`) is given the `dream-work` records of the partitions a device holds and the dream owner records of the `settings` stream, puts them through `prepareRecords` together (one total order, `(clock, device, id)`), and gives each item one state:

1. `waiting`: no live lease, no accepted answer, not closed, not parked. With `ready` true or false (D2) and `retry_at`.
2. `leased`: the newest winning lease has no terminal record and has not expired at the fold's `now`.
3. `accepted`: an answer whose generation and `lease_token` match the newest winning lease and whose `input_hash` is the item's.
4. `finished`: an applied record for the accepted answer.
5. `parked`: `MAX_ATTEMPTS` failed attempts since the item or since the last `dream-work-retry`.
6. `closed`: a closed record.

Records that break the rules (a lease by a device that the owner fold does not name as the owner at that record's place in the order, a duplicate lease generation after the first lease in fold order, an answer for a generation or token that is not the newest winning lease, an applied record without its answer and token) are rejected, listed and never applied, as in the view writer fold. The fold takes `now` as a parameter and is pure.

Constants in one module: `MAX_ATTEMPTS` 5, backoff 1, 5, 30 minutes, then 6 hours, lease time 15 minutes, backlog reporting threshold 24 hours.

### D2. Readiness and order

An item is ready when every id in `after` is `finished`, and no item that is earlier in order, neither `finished` nor `closed`, shares a string in `resources`. Order is by `occurrence` (a sortable string the producer supplies: the window day and a sequence), then by the item record's place in the fold. `after` naming a `closed` item follows the operation's declared rule: `cancel` (the dependant is closed as cancelled by the settle step, D4) or `release` (the edge is dropped).

Resource strings are namespaced by the producer: `topic:<id>`, `chain:<preference id>`, `rung:<name>`.

### D3. Operations and their registry

`src/core/brain/dream-queue/operations.ts` holds a registry keyed by `operation`: the answer schema validator, `currentInput(subject)` that rereads the store and returns the input hash or `null` when the subject is gone, `apply(item, answer)` that writes the effects and returns their ids, and the closed-predecessor rule. Production code registers its operations at module load; tests register fixture operations through the same call and remove them in `finally`. An item whose operation is not registered on this build is `waiting` and never ready, and doctor names the operation: an older binary must not guess.

### D4. The core functions

In `src/core/brain/dream-queue/queue.ts`. The queue exists only for a brain that is served from the store. On a brain with no store, or on a machine that has not switched to it, `produceWork` and `applyAccepted` are not called (the pass decides with the same predicate it already uses for store-only work), the rollup envelope is carried as today, and `queueStatus` answers that the queue starts with the store. So no existing pass outcome changes there.

Every public function that writes calls `assertDreamOwner` before the queue lock and rechecks it after acquiring the queue lock, immediately before any write. This closes the transfer window even for forced claims that do not take the dream pass lock. A missing or unreadable owner record is a refusal. The queue lock is taken exactly once, at entry: `withLocalLock` on a lock file in the store's device-local state directory with a budget of 30 seconds. The lock is not re-entrant, so the functions below are thin entry points over unlocked internal steps (fold, settle, supersede, produce), and no entry point calls another. A take that cannot get the lock within the budget returns nothing with the reason `busy`; the other functions throw the lock error.

The settle step is internal and runs first in `takeWork` and `applyAccepted`: it writes a `released` attempt for every lease found expired, and a `dream-work-closed` record for every dependant whose predecessor is closed under the `cancel` rule. The fold stays pure; settle is what turns what the fold derives into records.

1. `produceWork(spec)`: computes the id, picks the partition (D5), writes the item if the fold does not have it. Returns the id and whether it was new. Called inside the pass, before the pass reports.
2. `takeWork({ run, now })`: folds and settles; picks the first ready item whose `retry_at` has passed and whose partition this device holds; rereads its input and supersedes it if changed (D6); writes a lease with generation one above the newest and a unique token; returns the item with its payload, evidence and lease token.
3. `answerWork({ item, generation, lease_token, value, agent, model, now })`: folds; an identical answer under the same generation and token returns the stored receipt; refuses when either does not match the newest live lease, the lease expired, a predecessor is no longer finished, or the value fails the schema (a `failed` attempt with the reason and the next `retry_at`); rereads the input and supersedes on change; otherwise writes the answer with a receipt (the answer record's id).
4. `applyAccepted({ now })`: folds and settles; for every `accepted` item in order, calls the operation's `apply` and writes the applied record with the effect ids. `apply` must be idempotent by item id, because a crash can fall between its writes and the applied record.
5. `releaseWork({ item, generation, lease_token })`: a `released` attempt; no backoff. A token from a worker that lost same-generation arbitration cannot release the winning lease.
6. `retryWork(item)` and `cancelWork(item, reason)`: human authority, from the verb.
7. `queueStatus({ now })`: no gate, no writes: counts by state, the oldest ready item's age, parked items with reasons, unreadable or absent partitions, operations unknown to this build.

A live pass (never a dry run, never a preview) calls `applyAccepted` at the top of `dreamRun`, after the gate and the pass lock, and calls `produceWork` in the branch that executes the plan, beside the audit log write. Nothing in the planning code calls the queue: the rollup plan is built on every dry run and preview, and is built again by the run id collision path.

### D5. Partitions

`produceWork` receives the records its evidence and payload are built from and writes the item to `private` when any of them are in `private`, otherwise to `shared`. If it can see an earlier open private item that holds one of the same resources, a shared item records sha256 keys of those resources in `private_resource_barriers`. A shared-only fold treats each barrier as blocked without receiving a private item id, subject, evidence or answer. Leases, answers, attempts, applied and closed records go to the item's partition. A device folds only the partitions it holds. A device that never held `private` sees no private item; the opaque barrier only prevents later shared work from overtaking it. A device that held `private` and lost it (the held-partition ledger reports the gap) says that private work is unknown, with no subjects.

### D6. A changed or missing subject

When `currentInput` returns a different hash, the successor item is written first, then the old item is closed as `superseded` with the successor id and the same `after` and `resources`; dependants that named the old id follow to the successor in the fold. If the process stops after writing the successor, the old item remains open and a later recheck finds the same successor id, then closes the old item. When it returns `null`, the item is closed as `cancelled` with the reason `subject gone`.

### D7. The rollup ladder as the producer

The ladder itself is not changed: it keeps working on counts, and its tests stay as they are. The identities of the facts come from the salience gate, which is changed to return the ids of the facts it admitted next to their count.

In the executing branch of a live pass, for every rung the plan fired, the pass calls `produceWork` with operation `rollup-summary`, subject the rung and its target, occurrence the pass's day and the rung's sequence from the ledger, and resources `rung:<name>`:

1. Fact rung: the evidence is the admitted fact ids that no earlier `rollup-summary` item of this rung has as evidence. The queue is thereby the record of which facts were handed out; no second ledger is added. The evidence list is bounded (200 ids) per item. If more are new, the same pass writes follow-up items for each remaining batch, without waiting for another rung firing.
2. Identity rung (built from summaries): the evidence is the ids of the fact rung's items produced since the last identity item, and `after` names those of them that are not finished.

The envelope stays on the plan and in the summary. The ledger baseline is advanced as today.

The operation's `apply` is registered and refuses with a clear error in this change: there is no executor, so no answer can exist, and writing a rollup page from a model's text is the executors change. `currentInput` (the hash of the evidence ids that still exist) and the schema are real. This keeps the producer path, the identity and the evidence set under test without inventing an output format early.

### D8. Surfaces

1. Doctor: `dream-queue-parked` (error, one per parked item: operation, reason, the retry command), `dream-queue-backlog` (warning: count and age of the oldest ready item, over the threshold), `dream-queue-no-executor` (info, once: items wait and this version has nothing that answers them), `dream-queue-unknown-operation` (warning), `dream-queue-rejected` (warning: records the fold rejected, by kind). The check is registered where store-side checks are (`DOCTOR_CHECKS`, `STORE_SIDE_CHECKS`) and every code is placed in `DIAGNOSTIC_SIGNALS` or `DOCTOR_EXIT_EXCLUSIONS`, which the exit census test enforces.
2. The dream owner status of `agent-neutral-dream` (`o2b dream owner`, `brain_dream_owner status`) gains a `queue` section from `queueStatus`.
3. `o2b dream queue [--json] [--state <state>]`, `o2b dream queue retry <id>`, `o2b dream queue cancel <id> --reason <text>`. Listing is ungated; retry and cancel pass the owner gate. Exit codes follow the existing verbs. In the command manifest `dream` gains child entries (`queue`, `queue retry`, `queue cancel`, in the nested command shape), or completion and `help --json` do not offer them; `docs/cli-reference.md` is updated.
4. The pass summary gains `model_work`: produced, waiting, applied in this pass.

## Risks / Trade-offs

1. The stream grows forever. Finished and closed items older than a retention period are a compaction concern for the store, not solved here; the fold's cost is measured in the report on a generated queue of ten thousand items.
2. `apply` idempotency is a contract on every operation; the test kit runs each registered operation's apply twice.
3. A lease's expiry depends on one machine's clock. Only the owner's device leases, a clock jump backwards can only keep an item leased longer, and a jump forwards frees it early while the generation still refuses the late worker.
4. An item folded on a machine that syncs late may look ready there; nothing follows from that, because only the owner's device takes.
5. The salience gate returns one more field. The ladder is untouched and its tests stay green unchanged.
6. The local lock is taken over after 60 seconds of a holder that looks dead. A suspended worker that wakes after a takeover can write a lease at the same generation as the replacement. The deterministic fold order keeps one token for that generation and rejects the other; answer, release and apply records must carry the winning token, so a resumed loser cannot change the item.
7. The `dream-work` fold is not one of the digest's fold hashes; a divergence between machines shows only as shard counts in the cut.
8. `FORMAT.md` gains a section. Whether an added stream needs a newer format version is decided by the rule that document states for additive changes; the task reads it and follows it, and the report says which way it went.
