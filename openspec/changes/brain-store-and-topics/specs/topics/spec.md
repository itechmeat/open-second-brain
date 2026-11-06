# Spec Delta

## Purpose

Topics give the user one readable place per area of work (an initiative, a project, a sub-project, a personal matter) where the goal, decisions, open questions and history of that area live, kept current by agents without the user curating every line.

## ADDED Requirements

### Requirement: Topic page
Each topic SHALL be a folder in the human view holding a required `topic.md` and optional companion files. `topic.md` SHALL use a fixed section order: title, one-line description, status, goal, milestones, decisions, open questions, log (newest first), related. Empty optional sections SHALL be omitted.

#### Scenario: New topic page shape
- **WHEN** a topic is created with a title and a goal
- **THEN** its folder contains a `topic.md` with the title, the one-line description, `Status: Active`, the goal and a related section, and no empty optional sections

#### Scenario: Page stays scannable
- **WHEN** a topic has more milestones, decisions or log entries than the page budget allows
- **THEN** the oldest done milestones and log entries move to a companion archive file linked from the related section, and `topic.md` stays within its budget

### Requirement: Topic status lifecycle
A topic SHALL have exactly one status from `Active`, `Waiting`, `Blocked`, `On hold`, `Done` and `Closed`. `Done` SHALL carry a resolved date. A topic with no new event for a configurable quiet period SHALL be offered to the user for a status decision rather than changed automatically.

#### Scenario: Quiet topic
- **WHEN** an `Active` topic has had no event for longer than the quiet period
- **THEN** the next brief or digest asks the user whether to keep it, put it on hold, mark it done or close it, and the status is unchanged until the user answers

### Requirement: Topic events as the write path
Agents SHALL change a topic only by recording topic events in the brain store, from the canonical list in design.md D8 (`topic-create`, `topic-rename`, `topic-status`, `topic-goal`, `decision`, `open-question`, `question-resolved`, `log-entry`, `milestone`, `milestone-done`, `assign`, `unassign`, `merge`, `split`, `link`, `undo`). Agents SHALL NOT write `topic.md` directly.

#### Scenario: Agent records a decision
- **WHEN** an agent records a decision for topic T
- **THEN** a `decision` event naming T is appended to that agent's own shard, and no file in the human view is written by that agent

#### Scenario: Direct page write is refused
- **WHEN** an agent calls a note-writing tool on a path inside a topic folder
- **THEN** the call is refused with a message naming the topic event tool to use instead

### Requirement: Topic pages are rendered by the view writer
A topic page SHALL be rendered as a pure function of the topic's records. Pages SHALL be written only by the view writer device named in the shared settings. While the view writer is offline, pages SHALL stay as they are and no other device SHALL write them.

#### Scenario: Two machines record events for one topic
- **WHEN** agents on two machines record events for topic T before either sees the other's
- **THEN** after both files reach the view writer, it renders one `topic.md` containing both events in clock order, and no sync conflict copy of `topic.md` exists

#### Scenario: View writer offline
- **WHEN** the view-writer laptop is closed for a week
- **THEN** no other machine writes topic pages, agents keep recording topic events, and doctor on the other machines reports the silent writer and the command to move the role

### Requirement: Stable topic identity
Each topic SHALL have an immutable id. The folder name and title SHALL be display values. Renaming a topic SHALL keep its id and every reference to it.

#### Scenario: Rename
- **WHEN** the user renames topic T
- **THEN** its folder and title change, its id stays, and events recorded before the rename still belong to it

### Requirement: Human edits win
A user edit to `topic.md` SHALL be detected by the view writer before every render, merged three ways against the last rendered text (kept in the store), and recorded as a human event in the store before the page is rewritten. A human event SHALL take precedence over any agent or decision-model event that touches the same item.

#### Scenario: User rewrites the goal
- **WHEN** the user edits the goal in `topic.md` and an agent event later proposes a different goal
- **THEN** the rendered page keeps the user's goal, and the agent's proposal appears as an open question attributed to the agent

#### Scenario: User edit on the phone
- **WHEN** the user edits `topic.md` on a phone that only syncs the human view
- **THEN** the view writer records the edit as a human event and the next render keeps it

#### Scenario: Edit races a render
- **WHEN** the phone's edit to `topic.md` arrives while the view writer is rewriting that page
- **THEN** either the pre-rename check catches it, or the resulting sync-conflict copy is ingested as a human edit; in both cases the user's text is in the next render and no copy is left behind

### Requirement: Log entries are earned
Only corrections, decisions made outside the normal flow, blockers, reframings and rejected approaches (with the reason) SHALL produce a log entry on the topic page. Routine progress SHALL stay in the store and SHALL NOT appear on the page.

#### Scenario: Routine progress
- **WHEN** an agent records that it ran the tests and they passed
- **THEN** the event is stored but `topic.md` gains no log entry

### Requirement: Milestone completion needs evidence or the user
A milestone SHALL be marked done only by the user, or by an agent that cites verifiable evidence. A decision-model verdict alone SHALL only propose completion.

#### Scenario: Decision model thinks a milestone is done
- **WHEN** the milestone-done verdict is positive but no agent cited evidence
- **THEN** the page shows the milestone as open with a "looks done, confirm" marker, and the status stays open

### Requirement: Automatic grouping during dream
The topic-planning step of dream SHALL run only on the view writer. It SHALL route unassigned events to existing topics and SHALL create a new topic only when related unassigned events cross a configured threshold and come from at least two sessions. Each automatic create, route or move SHALL be undoable and SHALL be listed in the dream report. An undo SHALL be a synced human record that every machine honours.

#### Scenario: New topic from a cluster
- **WHEN** enough unassigned events about one subject accumulate in one project
- **THEN** dream creates a topic with a drafted title and goal, links the events, lists the creation in its report, and the user can undo it with one command

#### Scenario: Undo an automatic move
- **WHEN** the user undoes an automatic route of event E to topic T
- **THEN** E is unassigned, a human event records the undo, and later dream passes do not route E to T again

### Requirement: Merges and splits are proposed
Merging two topics and splitting one SHALL be proposed to the user and applied only after the user confirms.

#### Scenario: Two machines run dream at once
- **WHEN** dream runs on the view writer and on another machine over the same unassigned events
- **THEN** only the view writer creates topics, and exactly one topic exists for the cluster

#### Scenario: One busy session does not make a topic
- **WHEN** many related events come from a single session
- **THEN** no topic is created until the subject recurs in another session

#### Scenario: Two topics look the same
- **WHEN** the same-topic verdict is positive for topics A and B
- **THEN** the brief proposes the merge, and both topics stay unchanged until the user confirms

### Requirement: Topics on request
The user SHALL be able, through an agent, to create a topic, move material into a topic, rename it, change its status, merge or split topics, and archive a topic. Each request SHALL be recorded as a human event.

#### Scenario: User asks for a topic
- **WHEN** the user says to start a topic for a personal matter with a stated goal
- **THEN** a topic with that goal exists in the human view after the next render, and the request is stored as a human event

### Requirement: Topic scope
A topic SHALL belong to a project scope or to the personal scope. Agents SHALL see the topics of their current project scope by default, and cross-project topics only on request.

#### Scenario: Agent in another project
- **WHEN** an agent works in project P
- **THEN** topic heads from project Q are not injected unless the agent searches for them or the user links the topics
