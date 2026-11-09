## Purpose

What an Open Knowledge Format bundle written by `o2b brain okf-export`
carries out of the machine, and what it must leave behind.

## ADDED Requirements

### Requirement: Private log events stay out of an exported bundle

An OKF bundle built on a machine whose brain lives in the store SHALL NOT
carry, in `log.md`, any log event that the store holds in its `private`
partition, and SHALL carry the log events of the `shared` partition as it
does today, under the content-class policy that already applies to them. A day whose every event is private SHALL NOT count as a log day
of the bundle. A machine on the legacy layout builds `log.md` as before.

#### Scenario: One private and one shared event on a switched machine

- **GIVEN** a switched machine holding both partitions
- **AND** one log event appended to the `shared` partition and one to the
  `private` partition, on two different days
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** `log.md` contains the shared event's text and not the private
  event's text
- **AND** the manifest reads one log day

#### Scenario: A record present in both partitions

- **GIVEN** a switched machine where one log event's record is present in
  both the `shared` and the `private` partition
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** the event is left out of `log.md`

#### Scenario: An unswitched machine

- **GIVEN** a machine still on the legacy layout, with log day files under
  `Brain/log/`
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** `log.md` is built from the day files exactly as before

### Requirement: The export names how many private log events it left out

The bundle manifest SHALL state how many log events were left out for
being private, counted before any content-class filtering, and the export
command SHALL name that count on standard error when it is above zero,
whatever its content-class flags.

#### Scenario: One private event left out

- **GIVEN** a switched machine holding both partitions, with one private
  log event
- **WHEN** the operator runs `o2b brain okf-export`, with or without
  `--include-prompt-derived`
- **THEN** the manifest reads one private log event left out
- **AND** standard error names one private log entry left out

#### Scenario: Nothing private to leave out

- **GIVEN** a switched machine holding only the `shared` partition, or a
  machine on the legacy layout
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** the manifest reads zero private log events left out
- **AND** standard error names no private log entries

### Requirement: An export refuses when a store log shard cannot be read

On a machine whose brain lives in the store, the export SHALL refuse,
writing no bundle, when the store cannot be opened or any log shard of a
partition the machine holds cannot be read, and SHALL name the shard, so the bundle is never short of
events and the private count is never a lower bound.

#### Scenario: An unreadable private log shard

- **GIVEN** a switched machine holding both partitions
- **AND** a log shard of the `private` partition that cannot be read
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** the command fails and names the shard
- **AND** no bundle is written

#### Scenario: A store that cannot be opened

- **GIVEN** a switched machine whose store no longer opens (a held
  partition lost its identity file)
- **WHEN** the operator runs `o2b brain okf-export`
- **THEN** the command fails and says the store is unavailable
- **AND** no bundle is written
