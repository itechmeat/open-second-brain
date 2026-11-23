# Proposal

## Why

The package can be installed from its tarball and one command connects a host, but the tarball is not on the registry, so the install line the documentation is about to promise does not work. Publishing must not depend on a stored secret or on a file built on someone's machine.

## What Changes

1. The release workflow gets a `publish` job: on a version tag, after verification, it packs once, checks the tarball against the committed manifest, and publishes that file with the registry's trusted publishing, in a deployment environment of its own, with no stored registry secret.
2. The job is off until a repository variable turns it on. While off it attaches the verified tarball to the workflow run.
3. A rerun for a version already on the registry publishes nothing and succeeds.
4. The registry tag is decided by the version: prerelease to `next`, a normal version to `latest`, an older line to its own tag without moving `latest`.
5. After a publish, the published version is installed from the registry on Linux, macOS and Windows and its commands are run.
6. `install.md` and `install/prerequisites.md` describe the registry install; a maintainer page describes the one-time owner steps and the release order.

This is the third of the three package changes: `registry-package`, `setup-verb`, `registry-publish`.

## Capabilities

### New Capabilities

- `registry-publish`: when a version reaches the registry, from which file, under which tag, with which identity, and how the result is checked.

### Modified Capabilities

None.

## Impact

1. Code: `.github/workflows/release.yml` (the new job and the smoke job), a new `scripts/publish-plan.ts` with its tests, `package.json` (`publishConfig`), `install.md`, `install/prerequisites.md`, a new `docs/releasing.md`, `CHANGELOG.md`, `tests/core/architecture/workflow-action-pins.test.ts` if a new action is used.
2. Existing installs and the existing release flow: unchanged. With the variable unset, a release behaves as today plus one workflow artifact.
3. Depends on `registry-package` and `setup-verb`.
4. Risks: a published version cannot be replaced; a misconfigured binding fails the job after the GitHub release exists; registry propagation delay makes the smoke install flaky.
5. Not in this change: the README, a version bump, any actual publish, the meaning of `o2b update`.
