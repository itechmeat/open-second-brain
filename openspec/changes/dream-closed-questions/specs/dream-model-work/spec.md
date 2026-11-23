# Spec Delta

## Purpose

The closed questions of dream as work on the queue: what is asked, who may answer in this change, what an answer does, and what a user sees while a question waits.

## ADDED Requirements

### Requirement: Every closed question is a queue item

For each kind of closed question the pass SHALL produce one queue item per eligible subject, oldest first, with no limit by age. Production MAY stop at the pass deadline, leaving unreached subjects for the next pass. The thresholds that decide whether a subject is eligible SHALL stay as they are. A subject whose question is already waiting, answered or abstained for the same input, prompt version and schema version SHALL NOT get a second item. A new item SHALL be allowed when either version changes, even if an earlier version is waiting, answered or abstained.

#### Scenario: A backlog older than eight weeks

- **WHEN** two hundred unassigned records exist, some three months old
- **THEN** eligible subjects are produced oldest first until the pass deadline

#### Scenario: A second pass after incomplete production

- **WHEN** the first pass reaches its deadline before producing every eligible item, and the state is unchanged
- **THEN** the second pass produces the remaining eligible items and no duplicate items

### Requirement: The fixed rule does not answer in place of a model

A closed question SHALL be decided only by an accepted answer. A record SHALL NOT be routed to a topic by ranking alone, and no outcome SHALL be derived because a model was absent, slow, refused or wrong. Until its item is answered the subject SHALL stay as it is.

#### Scenario: No decision model

- **WHEN** a pass runs on a brain with no decision model in force and unassigned records exist
- **THEN** the records stay unassigned, their items wait, and nothing is written for them

#### Scenario: A timeout

- **WHEN** the decision model times out for an item
- **THEN** the item waits with a retry time and the subject is unchanged

### Requirement: The decision model chain answers queue items

When a decision model is active and a use is set to enforce, ready items of that use SHALL be taken in queue order, asked one item per request through the decision model chain, and answered with the provider's and the model's name. The chain's privacy and egress checks, its daily cost gate and its fallback between entries SHALL apply unchanged, and the executor SHALL stop when its budget is spent.

#### Scenario: Enforce

- **WHEN** a routing item is ready, its use is enforced, and the model returns a valid answer whose confidence meets or exceeds the routing threshold
- **THEN** the model is asked once for that item, the answer is accepted and applied, and the record is routed to the chosen topic

#### Scenario: Private evidence and a hosted model

- **WHEN** an item is built from a private record and the chain may not receive it
- **THEN** nothing is sent, the item waits without a failed attempt, and the status says it waits for a local executor

#### Scenario: The budget is spent

- **WHEN** the executor's budget ends with items still ready
- **THEN** the pass continues without them and they are counted as waiting

### Requirement: Modes per use keep their meaning for queue items

A use set to off SHALL be left untouched for another executor. A use set to shadow SHALL be asked once per item and input and recorded, without the item being answered.

#### Scenario: Shadow

- **WHEN** an item's use is in shadow
- **THEN** the model's answer is recorded for tuning, the item keeps waiting, and nothing is applied

#### Scenario: Off

- **WHEN** an item's use is off
- **THEN** the decision model is not asked and the item waits for another executor

### Requirement: An unsure answer decides nothing and is not asked again

For a kind of question that has a threshold, an answer whose confidence is below it, or that carries no confidence, SHALL finish the item as abstained. The two kinds whose every answer is a decision (whether a group deserves a topic, whether a note is readable) SHALL never abstain. The subject SHALL stay as it is, and SHALL get a new item only when its input changes.

#### Scenario: Below the threshold

- **WHEN** a routing answer names a topic with confidence below the routing threshold
- **THEN** the record stays unassigned, the item is finished as abstained, and the next pass asks nothing for it

#### Scenario: The input changed

- **WHEN** a new topic appears that changes the options of an abstained routing question
- **THEN** a new item is produced for that record

### Requirement: Answers are applied through the existing writes, once

Applying an accepted answer SHALL write what the same verdict writes today (a route, an approved or vetoed topic creation, a derived item, a resolution or completion proposal, a keep or hide verdict), with the answering model recorded, and SHALL have one result when repeated. An answer whose subject no longer matches the current state SHALL not be applied.

#### Scenario: A stale subject

- **WHEN** a record was assigned by a person while its routing item was out
- **THEN** the answer is not applied and the item is superseded or cancelled

#### Scenario: A veto holds in later passes

- **WHEN** a group's creation was vetoed and the next pass sees the same group
- **THEN** the topic is not created and nothing is asked again

#### Scenario: A merge hint survives the pass

- **WHEN** a "same topic" item is answered
- **THEN** the hint is shown by the topic review in later sessions

### Requirement: Topic judgment and topic planning run on the dream owner's device

On a brain with a dream owner, producing, answering and applying closed questions and planning topics SHALL happen only on the owner's device. Any other device SHALL produce, apply and plan nothing, and its pass SHALL say that judgment runs elsewhere. On a brain with no owner bound, no closed question SHALL be decided.

#### Scenario: Owner and view writer on different devices

- **WHEN** the dream owner is one device and the view writer another
- **THEN** the owner's device produces the items, applies the answers and plans the topics, and the other device renders the view from what has synced and plans nothing

#### Scenario: A pass that changes nothing else

- **WHEN** a live pass on the owner's device finds no other change and unassigned records exist
- **THEN** their items are still produced

### Requirement: Waiting is visible and explained

Doctor and the dream status SHALL show, per kind of closed question, how many items wait, the age of the oldest, and why they wait: no decision model in force for that use, a use in shadow, private evidence with a hosted chain, a retry time, the daily decision model cost gate, or simply not reached yet within the budget. Each reason SHALL come with the action that changes it.

#### Scenario: Nothing can answer

- **WHEN** routing items wait and the routing use is off
- **THEN** doctor reports the count, says that no decision model answers routing, and names the setting that turns it on
