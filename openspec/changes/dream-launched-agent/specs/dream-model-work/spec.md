# Spec Delta

## Purpose

The launched agent as an executor of the dream queue: how it is started, what it may do, how its session is kept apart, and what happens to the text it writes.

## ADDED Requirements

### Requirement: The launch command is a machine setting with fallbacks

The command that starts the dream agent SHALL be read from the machine configuration only and SHALL never be a setting shared between machines. It SHALL be either the name of a preset or a program with its list of arguments. An ordered fallback list SHALL be tried when the first command cannot start or fails its run.

#### Scenario: A preset

- **WHEN** the setting names a preset and that agent's program is installed
- **THEN** the session is started with the preset's command

#### Scenario: The first agent is not available

- **WHEN** the first command cannot start and a fallback is configured
- **THEN** the fallback is used and the run records which agent answered

#### Scenario: No command

- **WHEN** no command is configured and work waits that only an agent may do
- **THEN** nothing is started, the work waits, and doctor says a dream agent is not set and how to set it

### Requirement: The command is verified by a real call

`o2b dream agent check` SHALL start a real session with the configured command against a canary item and SHALL report success only when the session took the item, answered it and finished. The result and its time SHALL be recorded on the machine. A command that was never verified SHALL be reported by doctor and at session start, and SHALL not be used for real work.

#### Scenario: A working command

- **WHEN** the check is run with a working command
- **THEN** the canary is answered, the check reports the agent and the model that answered, and the command is marked verified

#### Scenario: A command that does not reach the tools

- **WHEN** the session starts and never calls the tools
- **THEN** the check fails within its time limit, says what it saw, and the command stays unverified

### Requirement: The session works only through three operations

The session SHALL be given exactly three operations: take the next item, answer an item, finish. Take SHALL return one ready item with its bounded evidence and its answer shape, or nothing. Answer SHALL follow the queue's rules for a lease, its input and its shape. Finish SHALL release what the session still holds. Whether the pass is complete SHALL be decided by the worker, not by the session.

#### Scenario: A full loop

- **WHEN** a session takes an item, answers it and asks for the next until nothing is returned
- **THEN** every answered item is accepted with the session's agent and model recorded, and finish releases nothing

#### Scenario: The session stops early

- **WHEN** a session ends without finishing
- **THEN** the worker releases its leases and the items are offered again

### Requirement: A run authorises the operations, a marker does not

The three operations SHALL work only for a live run that the worker created: a run with an identity, a secret, the owner's revision and an expiry, known to this machine only. A call without a matching live run SHALL be refused and write nothing. The marker that tells hooks to stay out SHALL grant nothing by itself.

#### Scenario: The marker without a run

- **WHEN** a process sets the marker in its environment and calls take
- **THEN** the call is refused

#### Scenario: An expired run

- **WHEN** a session answers after its run expired
- **THEN** the answer is refused and the item is unchanged

### Requirement: The session is kept apart

The session's server SHALL expose no tool but the three, no resource and no prompt. In a process that carries the marker, hooks SHALL do nothing and no dream SHALL be started. The session's transcript SHALL never be captured, neither while it runs nor when a host's sessions are imported later. An agent whose command cannot restrict the session to this server SHALL be treated as an agent with no command-line mode.

#### Scenario: No capture

- **WHEN** a dream session runs
- **THEN** no session record, signal or log entry is written by hooks on its behalf

#### Scenario: A later import

- **WHEN** a host's sessions are imported after a dream session ran on it
- **THEN** the dream session's transcript is skipped

#### Scenario: Nothing but the tools

- **WHEN** a client of the session's server lists or reads resources
- **THEN** it gets none

#### Scenario: No recursion

- **WHEN** a dream session starts
- **THEN** it does not start another dream

### Requirement: Text work is done only by the launched agent

A rollup summary and the title and goal of a new topic SHALL be written only by an answer of the launched agent. No rule SHALL write them, and no decision model SHALL be asked for them. Until the answer exists the note is not written and the topic is not created.

#### Scenario: A new topic

- **WHEN** a group qualifies, its creation is approved and its wording item is answered
- **THEN** the topic is created with the agent's title and goal, and its record names the agent and the model

#### Scenario: No agent

- **WHEN** a group qualifies and no agent answers
- **THEN** the topic is not created and its wording item waits

### Requirement: Text written by a model is a draft until it is applied

Every text answer SHALL be kept with its author. With `dream.apply_drafts` set to `auto` it SHALL be applied by the next pass. With `review` it SHALL wait until a person approves or rejects it, and the status SHALL list what waits for review.

#### Scenario: Review

- **WHEN** drafts are set to review and a summary is answered
- **THEN** nothing is written until the user approves it, and after approval the note is written with its author

#### Scenario: Rejected

- **WHEN** the user rejects a draft
- **THEN** nothing is written and the item is closed with that reason

### Requirement: The agent answers closed questions nobody else answers

A closed question whose use is off for the decision model, or on a machine with no decision model, SHALL be offered to the session. Its answer SHALL carry a confidence, and the threshold of its use SHALL apply as for any answer.

#### Scenario: No decision model

- **WHEN** routing items wait, no decision model is configured and a verified agent command exists
- **THEN** the session answers them and the records are routed

### Requirement: A run is bounded

A run SHALL have a time budget and an item budget. The time budget SHALL never exceed what the caller of the pass has left, less a reserve for the pass itself. When either is spent the worker SHALL end the session, release its leases and leave the rest waiting.

#### Scenario: Too little time

- **WHEN** the caller's remaining time is under the minimum a run needs
- **THEN** no session is started in this pass and the status says why

#### Scenario: A session that hangs

- **WHEN** a session does not finish within the time budget
- **THEN** the worker ends it, its leases are released, and the pass completes
