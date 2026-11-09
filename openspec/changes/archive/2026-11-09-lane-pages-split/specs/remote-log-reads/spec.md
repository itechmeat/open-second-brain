## Purpose

What a caller below local reach (a remote MCP client) may read of the
operational log of a machine whose brain lives in the store.

## ADDED Requirements

### Requirement: Private log events are withheld below local reach

A reader that renders log events to a caller below local reach SHALL
withhold every event the store holds in its `private` partition, whatever
the event names, and SHALL show it to a local caller. A day whose every
event is withheld SHALL read as a day with no events, the same answer a
day that was never logged gives.

#### Scenario: A remote caller reads a day with a private event

- **GIVEN** a switched machine with one shared and one private log event
  on the same day
- **WHEN** a remote caller reads `osb://log/<that day>`
- **THEN** the page shows the shared event and not the private one
- **AND** a local caller reading the same day sees both

#### Scenario: A remote caller reads a day with only private events

- **GIVEN** a switched machine whose only log event of a day is private
- **WHEN** a remote caller reads `osb://log/<that day>`
- **THEN** the read fails exactly as for a day with no log events
