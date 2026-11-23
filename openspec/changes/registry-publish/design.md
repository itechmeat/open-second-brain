# Design

## Context

1. `.github/workflows/release.yml` runs on a pushed `v*` tag and on a manual run. Its `verify` job runs the packaging checks (and the suites when CI did not already pass on the commit); its `release` job creates the GitHub release unless a curated one exists.
2. `bun run pack:check` (`scripts/pack-manifest.ts`) packs with the registry client in dry-run mode and compares paths and sizes with `package-files.txt`. `scripts/npm.ts` starts the registry client on the three systems.
3. `tests/scripts/registry-install.test.ts` installs the packed tarball into a scratch prefix with a scratch home and runs every command.
4. `tests/core/architecture/workflow-action-pins.test.ts` requires every action to be pinned by commit.
5. The package is named `open-second-brain`, `private` is false, and no lifecycle script is published.

## Goals / Non-Goals

Goals:

1. A tagged, verified version reaches the registry from CI, from the checked file, with no stored secret.
2. Nothing publishes until the owner has done the one-time steps.
3. A rerun is safe.
4. The published version is proven installable on the three systems.

Non-Goals:

1. The README, a version bump, any real publish in this change.
2. Changing what `o2b update` does.
3. Publishing anything other than this one package.

## Decisions

### D1. One plan module decides, the workflow only executes

`scripts/publish-plan.ts` exports a pure function and a command line entry.

1. Input: the package version, the event name, the ref type and name, the enabling variable's value, and the registry's answer for the package (its versions and its `latest`, or "no such package", or "could not read").
2. Output, as JSON and as workflow outputs: `action` (`publish`, `skip-already-published`, `skip-disabled`, `skip-not-a-tag`), `tag` (`latest`, `next`, `release-<major>.x`), `version`, and a one-line `reason`.
3. Errors, each with a message that names the repair: the tag's version differs from the package version; the registry could not be read (never treated as "not published"); the package does not exist on the registry while publishing is enabled (the first version is published by hand, see `docs/releasing.md`).
4. Version order uses the semantic version rules already in the dependency tree if one is present; otherwise a small comparison of the three numbers, with any prerelease part making the version a prerelease. No new dependency.
5. The command line entry reads the registry through `spawnNpmSync` with `view <name> versions dist-tags --json`. "No such package" is recognised by the client's `E404` code in its JSON error, not by parsing prose.

Reason: every rule that can cost a version number is a tested function, not a shell condition in a workflow file.

### D2. The `publish` job

Added to `release.yml`:

1. `needs: verify`. It runs for a pushed tag and for a manual run, so both pack, check and attach; only the publish step is gated, on the plan's `publish` action, which the plan gives only for a tag push. Environment `npm-publish`. Permissions: `contents: read`, `id-token: write`; no other job gets `id-token`. The job declares `outputs:` that map `action`, `tag` and `version` from the plan step, because a step output cannot be read from another job.
2. Steps, in this order: check out without persisted credentials; set up Bun at the pinned version and Node at a pinned version of at least 22.14.0; install the registry client at the version `ci.yml` pins (`NPM_VERSION`), the same way `ci.yml` installs it, since the release workflow has no client pin today, the client bundled with Node is too old for trusted publishing, and the packed list depends on the client's inclusion rules; print the client version and fail if it is lower than 11.5.1; `bun install --frozen-lockfile`; run the plan's first stage, the comparison of the tag's version with the package version, which fails here, before anything is packed; `bun run pack:check`; pack once to a directory outside the checkout with scripts ignored; check the real tarball with the command form of task 2.1, which compares its file list with `package-files.txt` using the same comparison function as `pack:check` and its byte size and unpacked size with the committed ceilings (`checkSizes`); run the plan's second stage (the registry read and the decision); upload the tarball as a workflow artifact, always.
3. When the plan says `publish`: `npm publish <tarball> --tag <tag> --access public` with scripts ignored. No token variable is set; the client exchanges the workflow identity itself. Provenance is attached by the registry for a trusted publisher; `publishConfig.provenance: true` in `package.json` makes a publish without provenance fail instead of passing silently.
4. When the plan says a skip: the job writes the reason to the run summary and ends successfully.
5. The enabling variable is `NPM_PUBLISH`, a repository variable, enabling value `enabled`. Any other value is "off".
6. Concurrency: the workflow's existing group per tag already prevents two runs of one tag overlapping.

### D3. The smoke job

`publish-smoke`, `needs: publish`, with `if: needs.publish.outputs.action == 'publish'`, on the three systems.

1. `scripts/registry-smoke.ts <spec>`: creates a scratch directory and gives every child the environment that `tests/helpers/packed-install.ts` builds for the tarball acceptance, by reusing that construction (moved to a place both can import, not copied): the home, the four XDG directories, `BUN_INSTALL`, `BUN_INSTALL_GLOBAL_DIR`, `BUN_INSTALL_BIN`, `BUN_INSTALL_CACHE_DIR`, the temp directory variables, on Windows also `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` (Bun reads `USERPROFILE` there, not `HOME`), and the scratch bin directory first on `PATH`, runs `bun add -g <spec>`, then from the scratch prefix runs `o2b version` (must print the expected version) and `o2b setup --target cursor --no-vault --agent-name smoke --timezone UTC` without `--apply` (must exit 0 and write nothing outside the scratch directory). It removes its scratch directory by its exact path.
2. `<spec>` is `open-second-brain@<version>` in the workflow. The install is retried, with a pause, for up to five minutes when the registry answers that the version does not exist.
3. The same script is covered by a test that passes the path of a locally packed tarball as the spec, next to the existing tarball acceptance, sharing its helpers. The test never contacts the public registry for a write and installs nothing from it.

### D4. Documentation

1. `install.md`: a "From the registry" path first: the prerequisite (Bun), `bun add -g open-second-brain`, `o2b setup --target <host> --apply`. The clone and marketplace paths stay.
2. `install/prerequisites.md`: the line about the registry install loses its "not yet published" wording if it has one.
3. `docs/releasing.md` (new, for maintainers): the one-time owner steps in order (a registry account with two-factor authentication; publish the first version by hand from the tarball attached to the tag's workflow run, with `npm publish <file> --access public`; create the environment `npm-publish` in the repository; then, immediately before the first release that is to publish from CI and not earlier, bind the package on the registry to this repository, the workflow file `release.yml` and the environment `npm-publish`, and set `NPM_PUBLISH` to `enabled`: a new binding expires when no publish succeeds through it within two days and must then be deleted and created again), then the order of every later release (the version bump rides in the feature pull request; tag after merge; the workflow verifies, publishes and smoke-tests), and what to do when a publish fails after the GitHub release exists (rerun the job; a version already published is skipped).
4. `CHANGELOG.md`: an entry under `## [Unreleased]`.

## Risks / Trade-offs

1. A published version is permanent. Mitigation: the plan refuses on any doubt; the published file is the checked file; publishing is off by default.
2. The binding on the registry side is configured by hand and can be wrong. Mitigation: the first enabled release fails loudly in the publish step with nothing published; the page says how to check the binding.
3. Registry propagation. Mitigation: bounded retry in the smoke script.
4. The smoke test runs after the version is public. It cannot prevent a bad publish, only report it; the tarball acceptance in CI is the gate before.
