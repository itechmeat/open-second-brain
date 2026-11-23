# Spec Delta

## Purpose

Which surfaces of Open Second Brain every supported agent gets equally, and which belong to one adapter.

## ADDED Requirements

### Requirement: Printed recipes name no agent

A scheduler recipe the product prints SHALL offer a crontab form and a systemd form and SHALL name no agent's scheduler. Its script SHALL read optional environment variables from a file of the product's own and from no agent's file.

#### Scenario: A recipe

- **WHEN** a recipe is printed for the maintenance lane, the reindex or the code graph resync
- **THEN** its output holds no agent's command and no path under an agent's home

#### Scenario: Keys for a scheduled script

- **WHEN** the product's env file exists
- **THEN** the script sources it, and the recipe output names that file

### Requirement: The product installs into no agent's scheduler

The product SHALL have no command that writes a job into an agent's scheduler. The discipline report SHALL be a plain command with plain Markdown output.

#### Scenario: The removed commands

- **WHEN** `o2b discipline install` or `o2b discipline uninstall` is run
- **THEN** it is an unknown command, and the help names `o2b discipline report`

#### Scenario: Telegram capture is untouched

- **WHEN** the Telegram capture verb formats a message
- **THEN** it escapes as before

#### Scenario: Jobs left by an earlier version

- **WHEN** an agent's jobs file holds jobs this product installed earlier
- **THEN** doctor and the uninstall plan name the file and the jobs and say how to remove them, and change nothing

### Requirement: The discipline verdict is a doctor finding

When the discipline report is enabled for a brain, doctor SHALL report its verdict for the last day as advice, with the command that prints the full report. It SHALL not change doctor's exit code.

#### Scenario: An alert day

- **WHEN** the report's verdict for yesterday is an alert
- **THEN** doctor shows it as advice and exits as it would without it

### Requirement: The digest reaches every agent

After a pass that changed something, the next session on a machine of the brain SHALL be told once. On a host with a session start hook a short digest SHALL be shown at session start within the hook's size limit. On a host without one, the MCP instruction text SHALL say that a digest is available and where to read it. The same digest SHALL not be shown twice on one machine.

#### Scenario: A host with a hook

- **WHEN** a pass promoted two rules and a session starts on a host with a session start hook
- **THEN** the session shows a digest naming the two rules and the command for the full one, and the next session does not

#### Scenario: A host without a hook

- **WHEN** the same happens on a host that only has MCP
- **THEN** the instruction text of its next connection says a digest is available

#### Scenario: Nothing changed

- **WHEN** the last pass changed nothing
- **THEN** no digest is shown

### Requirement: Uninstalling names only what is installed

The uninstall plan SHALL list the steps of an agent only when that agent's integration is installed on the machine.

#### Scenario: No Hermes

- **WHEN** the plan is printed on a machine with no Hermes integration
- **THEN** it holds no Hermes step

### Requirement: Guides do not assume an agent

The finishing guide, the embeddings guide and the install router SHALL be written for any supported agent. What only one agent needs SHALL be in that agent's guide.

#### Scenario: The finishing guide

- **WHEN** a user of any supported agent follows the finishing guide
- **THEN** no step asks for a command of an agent they do not use

### Requirement: The whole journey works with no Hermes

On a machine with no Hermes, no Python and no network, a user SHALL be able to set up a brain for a supported agent, record experience, have dream run with model work, see its digest at the next session, move the dream owner role and uninstall. A test SHALL drive this journey.

#### Scenario: The journey

- **WHEN** the journey test runs
- **THEN** every step succeeds and nothing it prints or writes names Hermes
