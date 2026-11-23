# Brainstorm: publishing to the registry

The brainstorm of the registry package (`openspec/changes/registry-package/brainstorm.md`, with an independent partner of another model family) covered three changes and cut them: the package, the setup verb, publishing. This file records the part that belongs to publishing and the decisions taken since.

## Facts

1. The package is installable from its tarball and checked in CI (`registry-package`); one command connects a host from a registry install (`setup-verb`). Nothing publishes the tarball.
2. The owner chose the unscoped name `open-second-brain`. The name is free on the registry until the first publish.
3. The registry lets a package name its publishing workflow (trusted publishing): the workflow proves its identity with a short-lived token from the CI provider, no long-lived secret is stored, and the published version carries a provenance statement. The binding is configured on the registry side for a package that already exists, so the very first version cannot use it.
4. `release.yml` already has a `verify` job and a job that creates the GitHub release; both run on a version tag. The curated GitHub release is normally created before the tag's workflow runs.
5. A published version can never be replaced. A wrong tarball costs a version number.

## Options considered

1. A long-lived automation token in the repository secrets. Rejected: a secret that can publish any version, readable by any workflow that is changed to read it.
2. Publishing by hand from the owner's machine for every release. Rejected: the tarball then comes from an unverified tree and carries no provenance.
3. Trusted publishing from the release workflow, with the first version published by hand once. Chosen.

## Decision

1. A `publish` job in the release workflow, after `verify`, on a version tag only. It packs once, checks the tarball against the committed manifest, and publishes that exact file. It holds no registry secret: identity comes from the workflow token.
2. The job runs in a deployment environment of its own, which the registry binding names, so a different workflow or job in this repository cannot publish.
3. The job is off until the owner turns it on with one repository variable. While off it still packs, verifies, and attaches the tarball to the workflow run, which is the file the owner publishes by hand the first time.
4. A version that is already on the registry is a success, not an error: a rerun publishes nothing.
5. A prerelease version goes to the `next` tag, a normal version to `latest`. A normal version lower than the registry's `latest` is published under a tag named after its major line and does not move `latest`.
6. After publishing, the job installs the published version from the registry into a scratch prefix on the three systems and runs the commands.
7. The install documentation gets the registry path: one install line, then `o2b setup`. The README is a later change.

## Rejected

1. Publishing from a pull request or from `main` without a tag.
2. A second package name or a scope.
3. Publishing with Bun's own publish command: provenance and trusted publishing are the registry client's features.

## Open questions

None for the design. The owner's part is listed in the tasks: a registry account with two-factor authentication, the first publish by hand, the binding of the workflow, the repository variable.
