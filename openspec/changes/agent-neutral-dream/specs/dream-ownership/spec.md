# Spec Delta

## Purpose

Who may run a live dream pass on a brain: how the owner installation is chosen when a brain is created, how it is shown and transferred, what every other machine gets, and how a brain from before this capability is adopted.

## ADDED Requirements

### Requirement: A brain has at most one dream owner

A brain whose records live in the brain store SHALL have at most one dream owner at a time. The owner is one agent installation on one device, recorded in the `shared` partition as the device id, the agent name and a revision. Two devices that claim before either claim has synced SHALL resolve to one owner by the same rule on every device.

#### Scenario: Two claims race

- **WHEN** two devices each record a claim before either has seen the other's
- **THEN** after both have caught up, every device reports the same single owner, and the device that lost reports that it is not the owner

#### Scenario: The owner is shown

- **WHEN** a user or an agent asks for the dream owner on any device
- **THEN** the answer names the owner's device and agent, whether this device is the owner, the revision, and any transfer that is pending

### Requirement: The creating installation becomes the owner

When a brain is created, the installation that creates it SHALL become the dream owner. Attaching a device to a brain that already exists, initialising again, switching a machine to the store and starting another agent's plugin SHALL never change the owner. When the creating installation has no agent identity, the brain is created with no owner and the command says so.

#### Scenario: A new brain

- **WHEN** an agent installation creates a brain and its agent name is known
- **THEN** that device and agent are recorded as the owner

#### Scenario: A second device attaches

- **WHEN** a second device attaches to an existing brain
- **THEN** the owner is unchanged and the second device reports that it is not the owner

#### Scenario: No agent identity

- **WHEN** a brain is created from a terminal with no agent name configured and no name is given
- **THEN** the brain has no owner, and the command prints how to choose one

### Requirement: Only the owner's device runs a live pass

Once a brain has an owner, every path that can change the brain through dream SHALL run only on the owner's device: the dream command, the MCP dream tool, staging, applying, discarding and re-triaging a staged pass, the steps that write, and the dream task of the maintenance lane. A device that holds the role through its own claim SHALL run a live pass only after one further catch-up has confirmed the claim. On any other device these SHALL refuse with a named error that states the owner and how to transfer, before any model is asked and before any record or file is written. Previews and dry runs SHALL keep working on every device.

#### Scenario: A live pass on another device

- **WHEN** a device that is not the owner starts a live dream pass by any of those paths
- **THEN** the pass is refused with the error code `dream_not_owner`, the message names the owner's device and agent and the transfer command, and nothing is written

#### Scenario: A preview on another device

- **WHEN** a device that is not the owner asks for a dry run
- **THEN** the dry run answers as before

#### Scenario: The maintenance lane on another device

- **WHEN** the maintenance lane runs on a device that is not the owner
- **THEN** its dream task is skipped with the reason recorded, its other tasks run, and the lane's exit code does not report a failure for the skip

#### Scenario: Another agent on the owner's device

- **WHEN** an agent other than the owner's agent starts a live pass on the owner's device
- **THEN** the pass runs, and its record names the agent that started it and the owner

### Requirement: Ownership is transferred by one operation

Ownership SHALL be transferred by one operation available on the command line and through MCP at local reach. On the owner's own device it changes the agent at once. From another device it records a request; the owner's device releases the role the next time it checks ownership, and only then does the requesting device become the owner. A forced transfer SHALL be available on the command line only and SHALL warn that the previous owner may keep running until its first catch-up after the forced claim reaches it. A caller at remote reach SHALL never transfer ownership.

#### Scenario: Changing the agent on the owner's device

- **WHEN** the transfer names another agent on the owner's device
- **THEN** that agent is the owner at once, with a new revision

#### Scenario: Moving to another device

- **WHEN** a device that is not the owner asks for the role
- **THEN** the request is recorded and shown as pending on every device, the requesting device still refuses live passes, and after the owner's device releases the role the requesting device is the owner

#### Scenario: A second transfer

- **WHEN** an agent transfers ownership after an earlier transfer was made by a person on the command line
- **THEN** the transfer succeeds: this operation is not blocked by who made the previous one

#### Scenario: A remote caller

- **WHEN** a caller at remote reach asks to transfer ownership
- **THEN** the request is refused and nothing is recorded

#### Scenario: Two requests

- **WHEN** two devices ask for the role before the owner releases it
- **THEN** exactly one of them becomes the owner, the same one on every device, and the other is told its request lost

### Requirement: A brain from before this capability keeps working until it is adopted

A brain with no owner record SHALL behave as before: a live pass runs from any device, and a declared `primary_agent` produces the existing warning for another agent. The owner status SHALL say that no owner is bound and, when a `primary_agent` is declared, name it as the requested owner. Adoption is the transfer operation run on the device that is to own the role; ownership SHALL never be inferred from an installed agent, from the last writer in the log or from the machine that performed an update. A brain whose records still live in the legacy tree SHALL report that ownership is enforced only after the brain moves to the store.

#### Scenario: Before adoption

- **WHEN** a brain has a declared `primary_agent` and no owner record
- **THEN** live passes run as before, and the owner status names the declared agent as requested and not bound

#### Scenario: Adoption

- **WHEN** the transfer operation is run on a device of such a brain
- **THEN** that device and its agent become the owner, and from then on other devices refuse live passes

#### Scenario: Doctor

- **WHEN** doctor runs on a brain
- **THEN** it reports the owner, whether this device is the owner, a pending transfer, a brain with no owner, and a declared `primary_agent` that differs from the owner's agent
