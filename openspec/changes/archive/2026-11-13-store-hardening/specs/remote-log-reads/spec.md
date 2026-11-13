# Spec Delta

## ADDED Requirements

### Requirement: Every reader with a remote surface withholds private log events

Every MCP tool and resource that renders log events, or text derived from
them, to a caller below local reach SHALL withhold the events the store
holds in its `private` partition, whatever they name: the timeline
analytics, the daily, weekly, monthly, today and morning briefs, idea
discovery, idea lineage, agent provenance, backlinks and the note write
logs. A local caller SHALL see them as before.

#### Scenario: A private note in the remote timeline and briefs

- **GIVEN** a switched machine with one shared note event and one private
  note event that names nothing, both inside the window
- **WHEN** a remote caller reads `brain_analytics` (timeline) and
  `brain_brief` (daily, weekly, morning)
- **THEN** each answer carries the shared note's text and not the private
  note's text
- **AND** a local caller's answers carry both

#### Scenario: Agent provenance below local reach

- **GIVEN** a switched machine where agent `secret-agent` wrote only one
  private log event
- **WHEN** a remote caller runs `brain_agent_query` or `brain_agent_diff`
- **THEN** neither the contribution nor the agent appears, and the counts
  read as if the event did not exist

#### Scenario: Backlinks from a private event

- **GIVEN** a switched machine where the only reference to a shared
  preference is a private log event
- **WHEN** a remote caller reads `osb://backlinks/<that preference>` or
  `brain_backlinks`
- **THEN** the answer lists no backlink from the log and its count is 0

#### Scenario: Link-derived answers from a private event

- **GIVEN** the same machine, a shared MOC note that links that
  preference, and a second private log event that links an artifact id
  with no file
- **WHEN** a remote caller reads `brain_analytics` (concept synthesis) of
  the preference, `brain_moc_audit` of the MOC note, `brain_doctor`, or
  the `brain_doctor` repair preview
- **THEN** no answer lists or counts a reference from either private
  event, and no broken-backlink finding names the missing id
- **AND** a local caller's answers list and count both

#### Scenario: A note write in a private operation

- **GIVEN** a switched machine where a shared note was written inside a
  private operation, so its note-write event is private
- **WHEN** a remote caller runs `brain_writes` or `brain_write_destinations`
- **THEN** the write is not listed and not counted
- **AND** the revert plan `brain_writes` returns for that note's path
  lists no write from the private operation

### Requirement: Counts and timestamps below local reach ignore private log events

A number or timestamp derived from log events and shown to a caller below
local reach SHALL be computed as if the withheld events did not exist:
most-applied counts and order, the last dream and last apply-evidence
times, the count of log days, the maintenance overdue flag, the memory
cost meter, the token footprint of the log, and the stale counts. Every
private event, counted or rendered, stays visible to a local caller.

#### Scenario: Most-applied counts

- **GIVEN** a switched machine with a shared confirmed preference that has
  one shared and two private `applied` evidence events in the window
- **WHEN** a remote caller reads `brain_context`, `osb://active` or
  `osb://digest/latest`
- **THEN** the preference's applied count reads 1
- **AND** a local caller reads 3

#### Scenario: Status timestamps

- **GIVEN** a switched machine whose newest apply-evidence event and
  newest dream event are private
- **WHEN** a remote caller reads `second_brain_status` or `osb://status`
- **THEN** the last apply-evidence time and the last dream time are the
  newest shared ones, or absent when there is none

#### Scenario: Maintenance actions from the log footprint

- **GIVEN** a switched machine whose token footprint crosses the warning
  threshold only with a private event's text counted
- **WHEN** a remote caller reads `brain_doctor`, `osb://digest/latest`,
  or `brain_brief` (digest, operator)
- **THEN** no answer carries the token-footprint maintenance action
- **AND** a local caller's answers carry it

#### Scenario: Cost meter

- **GIVEN** a switched machine with one shared and one private memory
  write in the window
- **WHEN** a remote caller asks `brain_recall_telemetry` for the cost
  meter
- **THEN** the meter counts one write

### Requirement: Preference mode of brain_query applies the reference rule

`brain_query` in preference mode SHALL return, to a caller below local
reach, only the evidence events its sibling modes would return: no
private event, and no event naming a record the caller cannot read. The
result count it records in recall telemetry SHALL be the count it
returned.

#### Scenario: Private and unreadable evidence

- **GIVEN** a switched machine with a shared preference whose evidence is
  one shared event, one private event, and one shared event that names a
  page reserved against remote reads
- **WHEN** a remote caller runs `brain_query` with that preference
- **THEN** the evidence holds only the first event
- **AND** the recall telemetry row of the call counts one result

### Requirement: A new log reader is classified before it ships

Every module that reads store log events SHALL be classified as one that
filters for a remote caller, one that serves only local callers, or a
computation that must see every event, with its reason; a module that
reads log events and carries no classification SHALL fail the build's
test suite, naming the module.

#### Scenario: An unclassified reader

- **WHEN** a module starts calling a store log reader and no
  classification names it
- **THEN** the test suite fails and names the module
