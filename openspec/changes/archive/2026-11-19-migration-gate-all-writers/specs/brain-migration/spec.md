# Spec Delta

## Purpose

A migration of a vault stops every writer of that vault on the migrating
machine, whatever lane or path it writes through, and the refusal tells
the writer what runs and what to do. The quiesce requirement of
`brain-migration` stays as it is; these two requirements say what it
refuses and what the refusal says.

## ADDED Requirements

### Requirement: Every writer of the vault is refused while the gate names it
While this machine's migration gate names a vault, every write into that vault SHALL be refused: from any CLI verb, MCP tool, hook or background worker, on every path (content, Brain log and audit records, per-vault state, caches kept in the vault). The rollback and the legacy tree removal hold the same gate and SHALL refuse the same writes. Only the run's own snapshot SHALL pass. Writes into another vault SHALL proceed.

#### Scenario: A log note during migration
- **WHEN** `o2b brain note` or `brain_note` runs on the migrating machine mid-migration
- **THEN** it is refused and no Brain log file is written or changed

#### Scenario: Another vault's migration
- **WHEN** the gate on this machine names another vault
- **THEN** writes into this vault proceed

#### Scenario: A hook during migration
- **WHEN** the session start, prompt or stop hook runs while the gate names the vault
- **THEN** the hook exits successfully, writes nothing into the vault, and shows at most one notice line

### Requirement: The refusal says what runs and what to do
The refusal SHALL name the run that holds the gate (a migration, its rollback or the legacy tree removal), since when it holds it, how far it is when the run reported that, and, when its process is gone, what continues it: the next start for an automatic migration, or the command. An MCP caller SHALL receive the structured refusal `migration_in_progress` saying whether to retry later or to recover the run first.

#### Scenario: A running migration
- **WHEN** a write is refused while the migration runs
- **THEN** the message names the migration, since when it runs and its progress, and an MCP caller is told to retry later

#### Scenario: A stopped migration still holds the gate
- **WHEN** the migration's process is gone and its gate remains
- **THEN** a write is refused with a message saying the run stopped, that the next start continues an automatic migration, and naming `o2b brain migrate-store --resume`
