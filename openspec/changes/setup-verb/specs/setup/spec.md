# Spec Delta

## Purpose

The one command a user or an agent runs after installing Open Second Brain to connect it to one agent host: its steps, what it asks, what it registers, what it verifies and how it ends.

## ADDED Requirements

### Requirement: One command connects a host

`o2b setup --target <host> --apply --yes` SHALL, in order, configure the machine when it is not configured, create or connect the brain, connect the host, verify the connection, and report every path it wrote, the registered command, what was verified and what the user must still do. Run again on a connected machine it SHALL write nothing to the configuration, the brain or the host and SHALL report the same state.

#### Scenario: A fresh machine with no vault

- **WHEN** setup is run for a host with `--no-vault`, an agent name and a time zone on a machine with no configuration
- **THEN** the machine is configured, a brain store exists, the host is connected, verification passes and the exit code is 0

#### Scenario: A second run

- **WHEN** the same command is run again
- **THEN** nothing is written to the configuration, the brain or the host, and the report says the host is already connected

#### Scenario: A plan

- **WHEN** setup is run without `--apply`
- **THEN** it prints what it would do and which choices an apply still needs, writes nothing and exits 0, also on a machine with no configuration and no choices given

### Requirement: Setup never asks when it cannot

Without a terminal, setup SHALL ask nothing. When an apply is asked for and a required choice is missing it SHALL fail before any write, with a usage error that names the missing flag. With a terminal and no target it SHALL start the interactive wizard.

#### Scenario: A missing choice without a terminal

- **WHEN** setup is run with `--apply` and without a terminal on an unconfigured machine and neither `--vault` nor `--no-vault` is given
- **THEN** it exits with the usage code, names the flag, and nothing was written

#### Scenario: Consent

- **WHEN** setup is run with `--apply` and without `--yes` and without a terminal
- **THEN** it exits with the consent code and nothing was written

### Requirement: A registry install registers an absolute command

When the running code is a registry install, the command registered in a host SHALL be the absolute path of the running Bun followed by `run` and the launcher file inside the installed package, and refreshing integrations later SHALL keep it. When the running code is a checkout or a plugin cache, the registered command SHALL be what it was before this change. Setup SHALL refuse to register from a known package runner's temporary cache.

#### Scenario: Registered from a registry install

- **WHEN** a host is connected from a registry install
- **THEN** the host's configuration holds an absolute Bun path and an absolute launcher path, and checking the install right afterwards reports no drift

#### Scenario: An update keeps the registration

- **WHEN** `o2b update` runs after a host was connected from a registry install
- **THEN** the registered command is unchanged and the host is reported up to date

#### Scenario: Registered from a checkout

- **WHEN** a host is connected from a checkout
- **THEN** the host's configuration is byte for byte what it was before this change

#### Scenario: A temporary cache

- **WHEN** setup is run through a package runner that keeps the package in a temporary cache
- **THEN** it refuses, says why, and names the permanent install command

### Requirement: Where a registration came from is recorded and checked

Each registration SHALL record its origin, the package root and the version that wrote it. Doctor SHALL report, each with the command that repairs it: a registered command whose file no longer exists, a registration written by an older version than the one running, and more than one `o2b` on PATH that resolve to different files.

#### Scenario: The package moved

- **WHEN** the registered launcher path no longer exists
- **THEN** doctor reports the host as registered with a stale path and names the setup command that repairs it

#### Scenario: Two copies

- **WHEN** a checkout's `o2b` and a registry install's `o2b` are both on PATH
- **THEN** doctor names both and which one runs, as information

### Requirement: Hosts with their own plugin mechanism are instructed

For a host that installs Open Second Brain through its own plugin mechanism, setup SHALL write nothing into the host, SHALL print the host's install step, and SHALL end with the exit code that means a step is left. For the generic target it SHALL print the configuration to merge by hand and end with the same code.

#### Scenario: A plugin host

- **WHEN** setup is run for such a host
- **THEN** the machine and the brain are set up, the host's own step is printed, nothing was written into the host's configuration, and the exit code is 7

#### Scenario: The generic target

- **WHEN** setup is run for the generic target
- **THEN** the configuration to merge is printed, nothing is written into any host, and the exit code is 7

### Requirement: The result is machine readable

With `--json`, standard output SHALL hold exactly one JSON document with the steps, their outcomes, the written paths, the registered command, the verification results and the remaining actions.

#### Scenario: JSON output

- **WHEN** setup is run with `--json`
- **THEN** standard output parses as one JSON document and diagnostics are on standard error
