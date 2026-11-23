# Spec Delta

## Purpose

How a dream pass starts with no scheduler: where the check runs, what it costs, when it starts a pass, what closes a day, how failure is spaced out, and what a machine that is not the owner says.

## ADDED Requirements

### Requirement: The check at session entry is nearly free on a closed day

At session entry the product SHALL check whether a dream pass is due. When the machine's record says the day is closed, the retry time has not come, automatic dream is off, or this device is not the owner, the check SHALL return having read the machine configuration and that one record, with no store opened, no process started and no model asked.

#### Scenario: A second session the same day

- **WHEN** a session starts on the owner's machine after today's pass closed the day
- **THEN** the check reads the record and returns, and nothing is started

#### Scenario: A machine that is not the owner

- **WHEN** a session starts on a machine whose record says another device owns dream
- **THEN** the check returns without reading the store

#### Scenario: Hosts without a session hook

- **WHEN** a host with no session start hook opens its MCP connection
- **THEN** the same check runs at that moment

### Requirement: A due pass is started once, detached

When a pass is due on the owner's device the check SHALL make an exclusive claim without waiting, check again under it, and start one detached worker that proves the claim. The session SHALL not wait for the pass. A check that cannot make the claim SHALL return.

#### Scenario: The first session of the day

- **WHEN** the first session of a day starts on the owner's machine
- **THEN** one worker is started, the session continues at once, and the worker runs the pass

#### Scenario: Two sessions at the same moment

- **WHEN** two sessions start at the same moment on the owner's machine
- **THEN** exactly one worker is started

#### Scenario: A worker that died

- **WHEN** a worker ended without recording an outcome
- **THEN** the next due check finds its claim abandoned, records a failed attempt, and a later check starts a new worker after the retry time

### Requirement: A day is closed only by a complete pass

A day SHALL be closed when a live pass ended with the replay not behind, no source with a gap, and no queued work that is ready, due and answerable by an executor this machine has. Any other end SHALL leave the day open and set a retry time: one hour after the first failure, doubling, at most one day. Work that no executor on this machine can answer SHALL not keep the day open; it SHALL be reported.

#### Scenario: The budget was spent

- **WHEN** a pass stops on its budget with windows still behind
- **THEN** the day stays open with a retry time, and the next due session continues

#### Scenario: Nobody can answer here

- **WHEN** a pass ends with items waiting and neither a decision model nor a verified agent command exists
- **THEN** the day closes, and doctor and one note at the next session start on that machine say what waits and what would answer it

#### Scenario: Repeated failure

- **WHEN** three passes in a row fail
- **THEN** the retry time is four hours after the third, and sessions before it start nothing

### Requirement: Every live pass records the day

A live pass started by the dream verb, the MCP dream tool or the maintenance lane SHALL record its outcome the same way as the worker. The trigger SHALL not start a pass on a day another pass closed, nor while another pass is running.

#### Scenario: An external trigger ran first

- **WHEN** a scheduled job ran a complete pass this morning and a session starts later
- **THEN** the check finds the day closed and starts nothing

### Requirement: Automatic dream can be turned off, and needs an owner

Automatic dream SHALL be a setting of the brain, on by default. A brain with no dream owner SHALL never be triggered.

#### Scenario: Turned off

- **WHEN** the setting is off
- **THEN** no session starts a pass, and the dream status says automatic dream is off

### Requirement: Other machines say one thing, once

A machine that is not the owner SHALL say nothing about dream at session start, except that when the owner has covered no window for three days it SHALL show one line naming the owner, its last covered day and the command that takes the role, at most once a day.

#### Scenario: A silent owner

- **WHEN** the owner's newest covered window is four days old and a session starts on another machine
- **THEN** that session shows the one line, and a second session the same day does not

### Requirement: The state of the day is visible

`o2b dream status` SHALL show whether automatic dream is on, whether this device is the owner, the day, whether it is closed and why not, the last run with its outcome, and the retry time.

#### Scenario: An open day

- **WHEN** the last pass failed
- **THEN** the status names the failure and the time of the next attempt
