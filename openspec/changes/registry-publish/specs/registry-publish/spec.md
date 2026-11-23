# Spec Delta

## Purpose

How a released version of Open Second Brain reaches the package registry: the trigger, the file, the identity, the tag, the repeat behaviour and the check afterwards.

## ADDED Requirements

### Requirement: Only a verified version tag publishes

A version SHALL be published only by the release workflow, only for a pushed version tag whose version equals the package version, and only after the workflow's verification job passed on that commit. No pull request, branch push or manual run SHALL publish.

#### Scenario: A version tag

- **WHEN** a tag `v<version>` is pushed and `<version>` equals the package version and verification passes
- **THEN** that version is published

#### Scenario: A manual run

- **WHEN** the release workflow is started by hand
- **THEN** nothing is published; the tarball is packed, checked and attached to the run

#### Scenario: A tag that does not match

- **WHEN** the tag's version differs from the package version
- **THEN** the job fails before packing and nothing is published

### Requirement: The published file is the checked file

The job SHALL pack exactly once, check the packed paths and sizes against the committed manifest with the same check the pull request gate uses, and publish that same file. No install script SHALL be present in the published package metadata.

#### Scenario: The tarball differs from the manifest

- **WHEN** the packed paths differ from the committed manifest
- **THEN** the job fails and nothing is published

### Requirement: No stored registry secret

The job SHALL authenticate to the registry with the workflow's short-lived identity token and SHALL read no stored registry credential. It SHALL run in a deployment environment used by no other job, and only that job SHALL be granted the identity token permission. The published version SHALL carry a provenance statement naming the repository, the workflow and the commit.

#### Scenario: The workflow file

- **WHEN** the workflow is read
- **THEN** no step refers to a registry token secret, the identity token permission appears only on the publish job, and that job names its environment

### Requirement: Publishing is off until the owner turns it on

While the repository variable that enables publishing is not set to its enabling value, the job SHALL pack, check and attach the tarball to the run, SHALL say in its summary that publishing is off and how to turn it on, and SHALL publish nothing.

#### Scenario: The variable is unset

- **WHEN** a version tag is pushed and the variable is unset
- **THEN** the run succeeds, carries the tarball as an artifact, and the registry is not contacted for a write

### Requirement: A repeat publishes nothing

When the version is already on the registry, the job SHALL publish nothing and succeed, and SHALL say so in its summary.

#### Scenario: A rerun

- **WHEN** the job runs again for a version already published
- **THEN** it exits successfully without a publish attempt

### Requirement: The version decides the registry tag

A version with a prerelease part SHALL be published under `next`. A version without one SHALL be published under `latest` when it is higher than the registry's current `latest` or when the package has no `latest`; otherwise under `release-<major>.x`, leaving `latest` where it is.

#### Scenario: A release candidate

- **WHEN** version `2.0.0-rc.1` is published
- **THEN** its tag is `next` and `latest` does not move

#### Scenario: A patch on an older line

- **WHEN** version `2.0.5` is published while `latest` is `2.1.0`
- **THEN** its tag is `release-2.x` and `latest` stays `2.1.0`

### Requirement: The published version is installed and run

After a publish, the workflow SHALL install that exact version from the registry into a scratch prefix with a scratch home on Linux, macOS and Windows, and SHALL run `o2b version` and a store-only `o2b setup` plan from it. A registry that does not serve the version yet SHALL be retried for a bounded time. A failure SHALL fail the workflow and SHALL be reported with the version and the system.

#### Scenario: The registry is slow

- **WHEN** the version is not served on the first attempt and is served within the retry window
- **THEN** the check passes

### Requirement: The registry install is documented

`install.md` SHALL give the registry install as one command followed by `o2b setup`, with Bun as the stated prerequisite, and SHALL keep the existing paths. A maintainer page SHALL list the one-time owner steps and the order of a release.

#### Scenario: A reader with Bun installed

- **WHEN** the reader runs the documented install line and then the documented setup line for a host
- **THEN** the host is connected with no clone of the repository
