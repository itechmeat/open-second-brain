# Tasks: the registry package

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec delta it names. Tick each box (`- [x]`) as soon
as it is done, so an interrupted run can resume from the first open box.
Partial edits from an earlier attempt may already be in the tree: review
them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration, and never the real global Bun or npm prefix: every install in a test goes to a temp prefix with a temp home.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump. Nothing is published: no `npm publish`, no `bun publish`, not even with a dry-run flag against the public registry.
4. No test-only seams in production code. A spy or a module mock is restored in `finally`.
5. Do not change the launchers under `scripts/` or their tests, except where a task says so.
6. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
7. Do not commit, do not push, do not open or comment on pull requests, no subagents. The orchestrator commits.
8. During a section run the test files you touched and their neighbours. The wider run is in the gate section.
9. If a baseline or a stated fact does not match what you find, stop and report it; do not work around it.

## 0. Preconditions

- [x] 0.1 Read the project instructions first (`CLAUDE.md`), then `proposal.md`, the spec delta, `design.md` and `review.md` of this change.
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/scripts --timeout 30000` and note the counts as the baseline. If the baseline has failures, stop and report them: do not build on a red baseline.
- [x] 0.3 Run `npm pack --dry-run --json --ignore-scripts` and keep the file count and sizes for the report. If a fact the design states about the code does not hold (an entry path, a guard, a file that is not there), stop that section and report the mismatch instead of guessing.

## 1. The launchers (spec: "The package provides its commands...", "The hook and MCP commands keep their contracts")

- [x] 1.1 A test helper that builds a throwaway package root under your temp directory: a copy of `bin/*.js`, a `package.json` with a chosen `engines.bun`, and small fixture entries (`src/cli/main.ts` and `hooks/<name>.ts` stand-ins that write their arguments as JSON to a file named by an environment variable and exit with a code named by another). The launchers resolve the root from their own location, so this proves their behaviour without any seam in production code.
- [x] 1.2 Tests first, `tests/scripts/registry-launchers.test.ts`. Against the throwaway root: arguments with spaces, quotes, shell metacharacters and non-ASCII characters arrive intact and in order; `o2b-mcp.js` puts `mcp` first; the child's exit code is the launcher's; with `engines.bun` set above the running version, `o2b.js` and `o2b-mcp.js` print one line naming the required version, exit 1 and the fixture entry never ran, and `o2b-hook.js` prints the line, exits 0 and the hook never ran; `o2b-hook.js` with no name, with an unknown name, and with a hook that exits 2 each exit 0 with one line on standard error and nothing on standard output; on Linux and macOS a `SIGTERM` sent to the launcher reaches a long-running fixture child and both processes end. Against the checkout's own `bin/*.js`: `o2b.js version` prints the package version; `o2b-hook.js active-inject` with a real SessionStart payload exits 0; `o2b-mcp.js` answers an initialize request and its first bytes on standard output are the protocol answer. On macOS the environment the child receives matches the rule `tests/scripts/macos-sqlite-shim.test.ts` holds the bash launcher to (share the expected values), for `o2b` and `o2b-mcp` and not for `o2b-hook`.
- [x] 1.3 `bin/_launch.js` and the three launchers (design D1). Add `engines.bun` to `package.json` and a test that the bash precheck's minimum equals it.
- [x] 1.4 `package.json` `bin` points at the new files (design D2). Find every test that reads `bin` from `package.json` (`zg --rg -F '"bin"'` and `pkg.bin`), update each and name it in the report.

## 2. No lifecycle script (spec: "Installing runs no script")

- [x] 2.1 Remove `prepare` from `package.json` and delete `scripts/prepare.ts`. Correct the comment in `.githooks/pre-commit` that names it. Add a short section "Git hooks" to the root `CLAUDE.md`: run `bun run hooks:install` once in a new checkout (design D4).

## 3. The file list (spec: "The package contains what the runtime reads and nothing else")

- [x] 3.1 Confirm the inventory of design D2 against the code: search for reads relative to the package or repository root (hooks, templates, skills, schemas, plugin manifests and mirrors, the OpenCode plugin asset, the discipline report pair, the Hermes root loader, the OpenClaw bundle, fixtures). Write the final list into the report with the code reference for each entry, and name every entry you added to or dropped from the design's list.
- [x] 3.2 Tests first, `tests/scripts/pack-manifest.test.ts`: the check passes on the committed manifest; fails naming the path when a packed file is not in the manifest and when a manifest path is not packed; treats backslash paths and a different input order as equal; fails on a forbidden path; fails over a size ceiling and passes under it; fails when `package.json` gains a lifecycle script. Build these cases by calling the script's exported functions with crafted input, not by editing the real `package.json`.
- [x] 3.3 `scripts/pack-manifest.ts` with `--write` and `--check`, the `pack:check` script, the committed `package-files.txt` (design D3). `package.json` `files` as the explicit list (design D2).
- [x] 3.4 `.github/workflows/ci.yml`: an exact npm version installed in the `validate` job next to the Bun pin, and `pack:check` as a step of that job.

## 4. Acceptance from the tarball (spec: all requirements, as installed)

- [x] 4.1 `tests/helpers/packed-install.ts`: pack once into a temp directory, install into a scratch root with the complete child environment of design D5 built from an empty object, assert before any command that the resolved install, bin, config and state paths are inside the scratch root, return the paths of the installed commands, clean up by exact path. File-level timeout from `tests/helpers/cli-timeout.ts`.
- [x] 4.2 `tests/scripts/registry-install.test.ts`: the three groups of cases of design D5. `o2b init` must be shown to have created a store under the scratch root (the store, not the starter templates). Skipped with a stated reason when the registry cannot be reached, and failing instead when the CI variable is set.
- [x] 4.3 `.github/workflows/ci.yml`: the variable that forbids the skip, set for every job that runs this file; a `package-macos` job that runs `pack:check` and this test file on macOS, pinned like the other jobs (same Bun version source, the same npm pin, pinned action revisions).
- [x] 4.4 Run the acceptance file locally and report the time and the measured start time of `o2b version` through the new launcher and through `scripts/o2b`; say that the Windows timings file needs a refresh from the first CI run.

## 5. Clones and marketplace installs (spec: "Clones and marketplace installs are unaffected")

- [x] 5.1 Run `tests/scripts` and `tests/cli/install-cli*.test.ts` unchanged; they must pass. Add one test that `scripts/o2b install-cli` in a temp copy of the checkout, with an isolated home, still publishes the launchers under `scripts/`: symbolic links to the bash launchers on Linux and macOS, `.cmd` wrappers on Windows (`src/cli/install-cli.ts`).

## 6. Docs

- [x] 6.1 `CHANGELOG.md` under `## [Unreleased]`: the new launchers, the explicit package contents, the removed `prepare` script.
- [x] 6.2 `install/prerequisites.md`: one short paragraph that the package provides the commands from a registry install and that Bun on PATH is the prerequisite, without an install line for the public registry yet (the package is not published in this change).

## 7. The gate

- [x] 7.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`, `bun run pack:check`.
- [x] 7.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.

## 8. Report

- [x] 8.1 Report: per section what was built (files), the tests added with real counts, the packed file count and sizes before and after, the final runtime file list, the start times of 4.4, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
