# Spec Delta

## Purpose

Agent context decides what each of many concurrent agents on many machines receives from the brain, so every agent can reach what the others saved quickly while its context window holds only what its current task needs.

## ADDED Requirements

### Requirement: Session start digest
At session start an agent SHALL receive, within a configured token budget: the heads of the active topics of its project scope (title, one-line description, status, goal), its applicable rules, and pinned context. It SHALL NOT receive topic bodies, raw records or other projects' topics.

#### Scenario: Agent starts in a project with many topics
- **WHEN** an agent starts in project P that has 30 active topics and the budget fits 12 heads
- **THEN** it receives at most 12 heads, chosen by relevance to the session, plus a line saying how many more exist and how to list them

### Requirement: Detail on demand
An agent SHALL be able to fetch a topic's full page, its recent events, or a search over its records through the existing tool surface, without loading other topics.

#### Scenario: Agent opens one topic
- **WHEN** an agent asks for topic T's details
- **THEN** it receives T's page and recent events only

### Requirement: Neighbour updates
Before a turn, an agent SHALL receive new records written by other agents since its last turn on the same topic or project only when they pass a relevance check against the current task, within a small token budget. Records it wrote itself SHALL never be returned.

#### Scenario: Another agent changed a shared decision
- **WHEN** an agent on another machine records a decision on the topic this agent works on
- **THEN** this agent's next turn includes a one-line notice of that decision with a pointer to fetch it

#### Scenario: Unrelated neighbour activity
- **WHEN** other agents record routine progress on unrelated topics in the same project
- **THEN** nothing is injected into this agent's turn

### Requirement: Freshness bound
Records from another machine SHALL be visible to an agent's reads as soon as file sync has delivered them, with no extra delay added by Open Second Brain beyond one index catch-up.

#### Scenario: Visible after sync
- **WHEN** a record from machine B has been delivered to machine A
- **THEN** the next read by any agent on A includes it

### Requirement: Budgets are enforced and reported
Every injection SHALL respect its token budget and SHALL report when content was cut, naming what was left out and how to get it.

#### Scenario: Budget exceeded
- **WHEN** the selected heads and rules exceed the session start budget
- **THEN** the lowest-ranked items are dropped, and the digest ends with a line naming how many were dropped and the command to list them
