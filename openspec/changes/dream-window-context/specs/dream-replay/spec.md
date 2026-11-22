# Spec Delta

## Purpose

The first part of the dream replay: one present for every rule of a pass, so that a later change can evaluate past days, and the rule that evidence confirms a trial only when dated on or before its deadline.

## ADDED Requirements

### Requirement: A pass with no gap behaves as before

A pass SHALL evaluate one window, today's, at the moment of the run, with every rule that reads the present, the log or the inputs reading them from one value. Its outcome SHALL be what the pass produced before this change, except where this specification says otherwise.

#### Scenario: A daily run

- **WHEN** a pass runs
- **THEN** it promotes, retires, archives and counts exactly as the pass did before this change for the same state and the same moment

#### Scenario: A pass told a future moment

- **WHEN** a pass is run with a moment later than the real clock
- **THEN** it archives no signal that is inside the window at the real time, as before

### Requirement: Evidence confirms a trial only when dated on or before its deadline

Evidence whose event time is after a trial's deadline SHALL NOT confirm that trial.

#### Scenario: Evidence the same evening

- **WHEN** a trial's deadline is in the morning and evidence is dated that evening
- **THEN** the trial is retired

#### Scenario: Evidence on or before the deadline

- **WHEN** evidence is dated on or before a trial's deadline
- **THEN** the trial is confirmed, as before
