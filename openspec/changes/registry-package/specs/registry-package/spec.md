# Spec Delta

## Purpose

What the published package of Open Second Brain contains, which commands it provides on Linux, macOS and Windows, what those commands require, and what installing it is forbidden to run.

## ADDED Requirements

### Requirement: The package provides its commands on every supported system

The package SHALL declare the commands `o2b`, `o2b-mcp` and `o2b-hook` so that a global install of the package makes each of them runnable on Linux, macOS and Windows with Bun, found on PATH, as the only prerequisite. Each command SHALL behave as its launcher in a clone does: the same arguments, standard streams and exit code. It SHALL NOT declare `vault-log`: its launcher passes `append-event` to the CLI dispatcher, which has no such command.

#### Scenario: A global install

- **WHEN** the packed package is installed globally into an empty prefix on any of the three systems
- **THEN** `o2b version` prints the package version, and each of the three commands starts

#### Scenario: A path with spaces or non-ASCII characters

- **WHEN** the install prefix or the home directory contains a space or a non-ASCII character
- **THEN** every command still runs

#### Scenario: An old Bun

- **WHEN** `o2b` or `o2b-mcp` is run with a Bun older than the declared minimum
- **THEN** it prints the required version to standard error and exits with a non-zero code without running the program

#### Scenario: An old Bun under the hook command

- **WHEN** `o2b-hook` is run with a Bun older than the declared minimum
- **THEN** it prints the required version to standard error and exits 0 without running the hook

#### Scenario: A signal

- **WHEN** a running command receives an interrupt or termination signal
- **THEN** the program it started receives the same signal and no process is left behind

### Requirement: The hook and MCP commands keep their contracts

The hook command SHALL never exit with the code that blocks an agent host and SHALL write its own diagnostics only to standard error. The MCP command SHALL write nothing but protocol messages to standard output.

#### Scenario: A hook that cannot run

- **WHEN** the hook command is given no hook name, a hook that does not exist, or a hook that fails to start
- **THEN** it warns on standard error, writes nothing to standard output and exits 0

#### Scenario: A hook that exits with a blocking code

- **WHEN** the hook itself exits with a non-zero code, including the code that blocks an agent host
- **THEN** the hook command reports it on standard error and exits 0

#### Scenario: The MCP handshake

- **WHEN** the MCP command is started from an installed package and sent an initialize request
- **THEN** the first bytes on standard output are the protocol answer

### Requirement: The package contains what the runtime reads and nothing else

The published file list SHALL be an explicit list that includes everything the runtime reads (sources, launchers, hooks, templates, skills, schemas, the OpenClaw bundle and manifest, the plugin assets and the Codex mirror, the evaluation fixtures) and excludes tests, development scripts, caches and local settings. A committed manifest of the packed paths SHALL be compared in CI, together with a list of paths that must never be packed and a size budget.

#### Scenario: A file the runtime needs

- **WHEN** the package is installed from the packed tarball and a session start hook and a brain initialisation are run from it
- **THEN** both succeed without reading anything outside the installed package and the user's own directories

#### Scenario: The packed list changes

- **WHEN** a change adds, removes or renames a packed file without updating the committed manifest
- **THEN** CI fails and names the paths that differ

#### Scenario: A forbidden path

- **WHEN** a packed path matches the forbidden list (local settings, notes, credentials, development playbooks)
- **THEN** CI fails and names it

### Requirement: Installing runs no script

The published package SHALL declare no `preinstall`, `install`, `postinstall` or `prepare` script. A check SHALL fail when one is added.

#### Scenario: A lifecycle script appears

- **WHEN** a change adds one of those scripts to the package
- **THEN** CI fails and names the script

### Requirement: Clones and marketplace installs are unaffected

The launchers under `scripts/` SHALL keep working as before for a clone and for a plugin marketplace cache, including their dependency bootstrap and the hook launcher's active-root resolution.

#### Scenario: A clone

- **WHEN** `scripts/o2b install-cli` is run in a clone after this change
- **THEN** it links the same launchers as before and they run
