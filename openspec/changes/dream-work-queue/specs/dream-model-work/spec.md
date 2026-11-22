# Spec Delta

## Purpose

The queue of dream work that needs a model: what an item is, when it may be taken, how an answer is accepted and applied, what failure does, where the records live, and what the user sees. Who answers the queue is specified by a later change.

## ADDED Requirements

### Requirement: Work that needs a model is a durable item

Dream work that needs a model SHALL be recorded as an item in the brain store before the pass that produced it reports success. An item's identity SHALL be derived from its operation, subject, occurrence, input and the versions of its prompt and answer schema, so that producing the same work again creates no second item. An item SHALL survive a crash, a restart and a transfer of the dream owner.

#### Scenario: The same work produced twice

- **WHEN** a pass produces work that an earlier pass already produced with the same input
- **THEN** the queue holds one item for it

#### Scenario: A crash after producing

- **WHEN** the process ends right after an item was recorded
- **THEN** the next process finds the item waiting

#### Scenario: The owner moved

- **WHEN** the dream owner is transferred to another machine that holds the item's partition
- **THEN** that machine sees the item in the same state

### Requirement: The queue needs the brain store

The queue SHALL exist only for a brain served from the brain store. A brain that is not yet on the store SHALL keep its pass unchanged and have no queue.

#### Scenario: A brain that is not on the store

- **WHEN** a live pass runs on a brain with no store, or on a machine that has not switched to it
- **THEN** the pass outcome is what it was before this change and no queue record is written

### Requirement: Ordered work stays in order and unrelated work proceeds

An item SHALL declare the items it comes after and the resources it touches. An item SHALL be offered only when every predecessor is finished and no earlier item that is neither finished nor closed touches one of its resources. Among the offered items the oldest by occurrence SHALL come first.

#### Scenario: A stuck head

- **WHEN** an item that touches a topic is parked and a later item touches the same topic
- **THEN** the later item is not offered

#### Scenario: A cancelled holder frees its resource

- **WHEN** an earlier item that touches a resource is cancelled and a later item touches the same resource
- **THEN** the cancelled item does not block the later item

#### Scenario: Unrelated work

- **WHEN** an item is parked and another item shares no predecessor and no resource with it
- **THEN** the other item is offered

### Requirement: One live lease per item

Taking an item SHALL be allowed only on the dream owner's device and SHALL record a lease whose generation is above every earlier lease of that item. Only the newest lease of an item SHALL be live. A lease SHALL carry a unique token for that take. If stale-lock takeover creates leases with the same generation, the first lease in fold order SHALL win and later leases of that generation SHALL be rejected. Answer, release and apply records SHALL name the winning token. A lease past its expiry SHALL free the item for a new take, and nothing done under an older lease or a losing token SHALL be accepted afterwards.

#### Scenario: Two workers on the owner's machine

- **WHEN** two processes on the owner's device take at the same moment
- **THEN** they receive different items, or one of them receives nothing and is told the queue is busy

#### Scenario: A stale lock holder resumes after takeover

- **WHEN** two leases are written at the same generation and the later fold-order lease token tries to answer
- **THEN** the first lease token wins and the losing answer is rejected

#### Scenario: A worker that came back late

- **WHEN** a worker answers under a lease that expired and was replaced by a newer lease
- **THEN** the answer is refused and the item's state does not change

#### Scenario: A machine that is not the owner

- **WHEN** a take is attempted on a device that is not the dream owner
- **THEN** it is refused with the dream owner error and nothing is written

### Requirement: An answer is accepted only against the current input

An answer SHALL be accepted only when its generation and lease token match the live lease, the item's input reread at that moment equals the input the answer was produced for, every predecessor is still finished, and the value fits the item's answer schema. An accepted answer SHALL record the agent and the model that produced it. Submitting the same answer again under the same lease SHALL return the first result and write nothing.

#### Scenario: The input changed while the item was out

- **WHEN** an answer arrives for an item whose input is no longer what was sent
- **THEN** the answer is not accepted, the item is superseded by an item for the new input, and the attempt is recorded

#### Scenario: A value outside the schema

- **WHEN** an answer does not fit the answer schema
- **THEN** it is refused, the attempt is recorded as failed with the reason, and the item can be taken again after its retry time

#### Scenario: A repeated submission

- **WHEN** the same answer is submitted twice under one live lease
- **THEN** the second call returns the first receipt

### Requirement: Accepted is not finished

An item SHALL be finished only when its accepted answer has been applied by the operation that produced it, on the dream owner's device. An item that is waiting, leased, accepted but not applied, or parked SHALL never be reported as completed work.

#### Scenario: Accepted and then a crash

- **WHEN** the process ends after an answer was accepted and before it was applied
- **THEN** the next pass on the owner's device applies it once

#### Scenario: A dry run

- **WHEN** a pass runs as a dry run or a preview
- **THEN** it produces no item and applies no answer

#### Scenario: Nobody can answer yet

- **WHEN** items wait and no executor exists
- **THEN** the pass reports them as waiting, and no surface counts them as done

### Requirement: Failed work is retried, then parked and named, never decided by a rule

A failed attempt SHALL set a retry time with bounded backoff. After the fixed number of failed attempts the item SHALL be parked. A parked item SHALL be named in doctor with its reason and the command that retries it. No fixed rule SHALL decide an item in place of an answer.

#### Scenario: Repeated failure

- **WHEN** an item fails the fixed number of times
- **THEN** it is parked, doctor names it with the reason and the retry command, and its dependants wait

#### Scenario: A manual retry

- **WHEN** the user retries a parked item
- **THEN** it is offered again with its attempts counted from zero

### Requirement: An item that lost its subject is closed

When the subject of an item is deleted or retired, the item SHALL be cancelled with the reason recorded. An item that waited on a cancelled item SHALL be cancelled or released as its operation declares.

#### Scenario: The subject is gone

- **WHEN** the record an item is about is retired while the item waits
- **THEN** the item is cancelled with that reason and is no longer offered

### Requirement: Private evidence stays in the private partition

An item, its evidence references and its answers SHALL be written to the partition of the most private record they are built from. A device that does not hold that partition SHALL neither take nor apply such items and SHALL show nothing of them. A device that held the partition and lost it SHALL say that private work is unknown.

#### Scenario: A machine without the private partition

- **WHEN** the queue is listed on a device that does not hold the private partition
- **THEN** no private item, subject, evidence or answer is shown, and no private item is offered to a take

#### Scenario: A machine that lost the private partition

- **WHEN** the queue is listed on a device whose held-partition ledger shows the private partition as lost
- **THEN** the listing says that private work is unknown

### Requirement: The queue is visible

Doctor, the dream owner status and a queue verb SHALL show the number of items by state, the age of the oldest item that is ready, and every parked item with its reason. The queue verb SHALL list items, retry a parked item and cancel an item, and SHALL be refused for writes on a device that is not the dream owner.

#### Scenario: A backlog

- **WHEN** ready items have waited longer than the reporting threshold
- **THEN** doctor reports the count and the age of the oldest

#### Scenario: Listing as JSON

- **WHEN** the queue verb is run with the JSON flag
- **THEN** standard output holds one JSON document with the counts and the items

### Requirement: The rollup ladder's model step is queued

When the rollup ladder fires a rung that needs a model, the pass SHALL produce a queue item for it in place of the request that was only printed, and SHALL keep reporting the rung in its summary.

#### Scenario: A rung fires

- **WHEN** a pass fires a rollup rung
- **THEN** the queue holds one item for that rung with the facts it must summarise, and a second pass over the same state adds none


#### Scenario: Supersession is interrupted

- **WHEN** the process stops after writing a changed-input successor but before closing the old item
- **THEN** the old item remains open, the successor is durable, and the next recheck closes the old item with that successor so dependants can follow it

#### Scenario: Evidence exceeds one item

- **WHEN** a fact rung fires with more than 200 new facts
- **THEN** the same pass records all facts in separate items of at most 200 evidence ids each

#### Scenario: A forced owner transfer lands during a queue write

- **WHEN** ownership changes after the pre-lock gate and before the entry point writes
- **THEN** the under-lock ownership recheck refuses the write

#### Scenario: A shared item follows private work on the same resource

- **WHEN** an earlier open private item and a later shared item touch the same resource
- **THEN** the shared item records only the opaque resource barrier, and a shared-only owner does not offer it before private work is visible
