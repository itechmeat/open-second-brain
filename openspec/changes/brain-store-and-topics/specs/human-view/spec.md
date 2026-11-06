# Spec Delta

## Purpose

The human view is the small set of readable Markdown pages a person actually wants from the brain, written to a folder of the user's choice so any Markdown viewer, Obsidian included, can show them on any device without indexing machine data.

## ADDED Requirements

### Requirement: Configurable target
The human view SHALL be written to a configurable folder: a folder inside the vault, any other folder, or none. With no target, the brain SHALL work fully and write no pages.

#### Scenario: No target
- **WHEN** no human-view target is configured
- **THEN** no page is written anywhere, and every brain operation still works

#### Scenario: Vault target
- **WHEN** the target is a folder inside the vault
- **THEN** Obsidian shows the pages, and no other brain file exists in the vault

### Requirement: Fixed page set
The view SHALL contain: a page of what the brain knows about the user (confirmed rules grouped by subject), a weekly history in plain language, decisions, reports and source summaries, and topics. Raw signals, log events, ledgers, metrics, caches and agent context digests SHALL NOT appear in the view.

#### Scenario: Machine data excluded
- **WHEN** the view is rendered on an install with thousands of signals and log events
- **THEN** the view holds pages from the fixed set only, and none of them is a raw signal, log file or ledger

### Requirement: Small and stable file count
The number of files in the view SHALL grow with topics, reports and weeks, not with signals or events. Re-rendering with no new content SHALL change no file.

#### Scenario: Idle render
- **WHEN** the view is rendered twice with no new records in between
- **THEN** no file's bytes or modification time change

### Requirement: Plain Markdown
Pages SHALL be plain Markdown readable in any viewer, without YAML frontmatter and without links that only resolve in Obsidian. Machine identifiers needed to map a page back to the store SHALL sit in one HTML comment line.

#### Scenario: Read in a generic viewer
- **WHEN** a page is opened in a plain Markdown viewer
- **THEN** it renders with no frontmatter block and with working relative links

### Requirement: Language of the view
Generated prose in the view SHALL use the user's configured language. Quoted source text SHALL stay in its original language.

#### Scenario: Russian-speaking user
- **WHEN** the view language is set to Russian
- **THEN** headings and generated summaries are in Russian, and quoted English source lines stay in English

### Requirement: Human edits flow back
An edit the user makes to a view page SHALL be detected by the view writer before it rewrites that page, and recorded in the store as a human record. The last rendered text SHALL be kept in the store as the merge base. Pages that are summaries only (history, the user profile page) SHALL accept edits as corrections that the next render keeps.

#### Scenario: Edit overwritten by a racing render
- **WHEN** a sync tool that makes no conflict copies delivers a phone edit just before the writer renames a new version of that page
- **THEN** the writer finds the replaced bytes differ from its base, records them as a human edit, renders again, and the edit is in the page one render later

#### Scenario: User corrects a rule on the profile page
- **WHEN** the user rewrites a rule's wording on the profile page
- **THEN** the store gains a human record changing that rule, and the next render shows the user's wording

### Requirement: One view writer
Only the view writer device, named by a shared human settings record, SHALL write view pages. The first machine that migrates or initialises the store SHALL become the view writer, and only the user SHALL move the role. A move SHALL take effect only after the old writer records that it released the role, unless the user forces it because the old writer is unreachable. No other code or device SHALL write into the view folder.

#### Scenario: Render on another machine
- **WHEN** a machine that is not the view writer runs dream
- **THEN** it writes no view page, and its report names the view writer

#### Scenario: User moves the role
- **WHEN** the user runs the command to make the current machine the view writer
- **THEN** the previous writer records its release at its next catch-up, this machine starts rendering only after it has seen that release, and no page is written by both

#### Scenario: Forced move
- **WHEN** the old writer is unreachable and the user forces the move
- **THEN** this machine renders at once, the command warns about a possible extra render by the old writer, and the old writer stops at its first catch-up after the change

#### Scenario: Silent view writer
- **WHEN** the view writer has published nothing for 3 days
- **THEN** doctor on every machine reports it and names the command to move the role
