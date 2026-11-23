# Tasks: publishing to the registry

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec delta it names. Tick each box (`- [x]`) as soon
as it is done, so an interrupted run can resume from the first open box.
Partial edits from an earlier attempt may already be in the tree: review
them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration, and never the real global Bun or npm prefix: every install in a test goes to a temp prefix with a temp home, and every child process gets an explicit environment.
2. Nothing is published and the public registry is never written to: no `npm publish`, no `bun publish`, not even with a dry-run flag against the public registry. Tests give the plan a registry answer as data.
3. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
4. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump; the changelog entry goes under `## [Unreleased]`.
5. No test-only seams in production code. No new dependency.
6. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
7. Do not commit, do not push, do not open or comment on pull requests, no subagents. The orchestrator commits.
8. If a stated fact does not match what you find, stop that section and report the mismatch.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then `proposal.md`, the spec delta, `design.md` and `review.md` of this change.
- [x] 0.2 Confirm the tree is clean; run `bun test tests/scripts --timeout 30000` and `bun run pack:check`; note the counts as the baseline. Baseline: 66 pass, 10 skip, 0 fail, 272 expectations; pack check: 1814 paths, 6316303 packed bytes, 21445923 unpacked bytes.

## 1. The plan (spec: "Only a verified version tag publishes", "Publishing is off until the owner turns it on", "A repeat publishes nothing", "The version decides the registry tag")

- [x] 1.1 `scripts/publish-plan.ts`: the pure function of design D1, in two stages (the tag and version comparison, which needs no registry; then the decision), with a table test covering every action including a manual run, every tag rule (prerelease, first version, higher than latest, lower than latest, equal to an existing version) and every error (tag mismatch, unreadable registry, missing package while enabled).
- [x] 1.2 The command line entry: reads the registry answer through `spawnNpmSync`, recognises "no such package" by the client's error code, writes JSON and workflow outputs. Test the parsing with recorded client outputs as fixtures; do not call the registry in a test.

## 2. The packed file (spec: "The published file is the checked file")

- [x] 2.1 Export the comparison from `scripts/pack-manifest.ts` so a real tarball's file list can be checked with it; add a command form that takes a tarball path and checks both its file list and its sizes against the committed ceilings. Test with a tarball packed into a temp directory: one passing, one with an extra file, one over the size ceiling.

## 3. The workflow (spec: "No stored registry secret", "Only a verified version tag publishes")

- [x] 3.1 Add the `publish` job of design D2 to `.github/workflows/release.yml`. Every action pinned by commit, as the architecture test requires.
- [x] 3.2 A test that reads the workflow file and asserts: the publish job needs `verify`, its publish step is gated on the plan's `publish` action, the version comparison step comes before any pack step, the registry client is installed at the version `ci.yml` pins, the job declares outputs for `action`, `tag` and `version`, the smoke job is conditioned on `needs.publish.outputs.action`, the job names the environment, is the only job with the identity token permission, references no registry token secret, and publishes a file path rather than the working directory.
- [x] 3.3 `package.json`: `publishConfig` with public access and provenance required. Regenerate the packed manifest if the tarball metadata changes it.

## 4. The smoke check (spec: "The published version is installed and run")

- [x] 4.1 `scripts/registry-smoke.ts` of design D3, with the bounded retry on "version not found". Test it with a locally packed tarball as the spec, sharing the environment construction of `tests/helpers/packed-install.ts`; assert the expected version, the zero exit of the setup plan, that nothing was written outside the scratch directory, and that the retry stops at its bound (with an injected clock, no real waiting).
- [x] 4.2 Add the `publish-smoke` job on the three systems. If the new test files are slow on Windows, follow the project rule on Windows test shards. Windows shard timing unavailable locally; test absent from `.github/windows-test-timings.json` pending measured Windows CI timing.

## 5. Docs (spec: "The registry install is documented")

- [x] 5.1 `install.md` and `install/prerequisites.md` per design D4; keep the existing documentation tests green and extend the one that checks documented commands so the registry lines are covered.
- [x] 5.2 `docs/releasing.md` per design D4. `CHANGELOG.md` entry under `## [Unreleased]`. Manual bootstrap command includes `--provenance=false` because npm 11.14.1 rejects local provenance generation; see report.

## 6. The gate

- [x] 6.1 `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run pack:check`, `bun run sync-plugin-mirrors:check`, `bun test tests/scripts tests/core/architecture --timeout 30000`, and the documentation tests touched. Full suite: 1114 pass, 10 skip, 0 fail across 56 files; documentation: 23 pass, 0 fail. After the final scratch-helper move, impacted install, smoke and pack tests: 15 pass, 1 skip, 0 fail. Typecheck, lint, formatting, pack and mirror checks passed on final code.

## 7. Report

- [x] 7.1 Final report delivered with section summary, test counts, the npm provenance discrepancy, the Windows timing gap, and the exact one-time owner steps recorded in `docs/releasing.md`.
