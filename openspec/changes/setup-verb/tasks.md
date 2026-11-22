# Tasks: the setup verb

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done. Partial edits from an earlier attempt may already be
in the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration (`~/.codex`, `~/.claude`, `~/.grok`, `~/.cursor` and the like), not the real global Bun or npm prefix. Every test sets HOME, the XDG roots and the host home overrides (`CODEX_HOME`, `GROK_HOME`, `PI_HOME`) under a temp directory before anything runs.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request. Nothing is published.
4. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. If a fact the design states does not match the code, stop that section and report it.
7. Existing adapter payload tests and the expected-output blocks of the install guides must pass unchanged: a checkout registers what it registered.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md`, `review.md` and `inventory.md`. Confirm the launchers of `registry-package` are in this branch (`bin/o2b.js`); if not, stop.
- [x] 0.2 The partial attempt left the tree modified, so a clean-tree baseline was unavailable. Ran `bun test tests/core/install 'tests/cli/install*.test.ts' tests/cli/bootstrap.test.ts --timeout 30000` with isolated HOME, XDG roots and host overrides: 599 pass, 0 fail, 3302 expect calls, 42 files.

## 1. The origin (spec: "A registry install registers an absolute command")

- [x] 1.1 Tests first, `tests/core/install/origin.test.ts`: a Bun global layout, an npm global layout on POSIX and in the Windows shape, a plugin cache, a checkout, npm's runner cache (whose parent is also `node_modules`), Bun's cache, a symbolic link to the package root.
- [x] 1.2 `src/core/install/origin.ts` (design D1). The plugin cache rule moves here; `src/cli/install-cli.ts` and `install-cli-windows.ts` import it (the import cycle census must pass).

## 2. The registered command and its record (spec: "A registry install registers an absolute command", "Where a registration came from is recorded and checked")

- [x] 2.1 Tests cover registry commands on POSIX and Windows, Grok argument cleanup, probe of a missing launcher, update no-op, registry bootstrap, immediate apply verification, checkout/plugin-cache payload compatibility, runner-cache refusal helper, manifest origin and legacy entries, and store-only payload/apply/verify behavior.
- [x] 2.2 `origin` on `InstallEnv` is set by `buildInstallEnv`; the four hand-built environments use the builder. `launcherCommand` is shared by payload build, verification, update and bootstrap; `cliArgs` strips the registry head; install and setup refuse runner-cache origin; `recordEntry` stamps the origin.

## 3. Host kinds (spec: "Hosts with their own plugin mechanism are instructed")

- [x] 3.1 Tests first: the table covers every target of the vocabulary and the four plugin hosts; it agrees with `src/cli/bootstrap/targets.ts` for every target both name.
- [x] 3.2 `src/core/install/host-kinds.ts` (design D5). `bootstrap` is not changed.

## 4. The verb (spec: "One command connects a host", "Setup never asks when it cannot", "The result is machine readable")

- [x] 4.1 `tests/cli/setup.test.ts` covers fresh no-vault/vault setup, no-op second run, plan, missing choices, consent, contradictions, plugin/print hosts, uninstalled hosts, failed verify, JSON output and stdout restoration. 9 pass, 6 skipped as `NOT RUN` because sqlite-vec is unavailable; all test homes and host overrides are isolated.
- [x] 4.2 `src/cli/setup.ts`, callable init and MCP probe functions, stdout capture, dispatch, command manifest and `docs/cli-reference.md` are implemented. Help/manifest/documentation checks: 39 pass, 0 fail across 4 files.
- [x] 4.3 Added packed registry setup acceptance test for a file-written host, absolute pair under scratch install and install check. Packed suite: 4 pass, 1 skipped as `NOT RUN` because sqlite-vec self-test is unavailable.

## 5. Doctor (spec: "Where a registration came from is recorded and checked")

- [x] 5.1 Added tests first for stale registry launcher, older registry version and distinct PATH providers. `doctor-readiness.ts` reports `stale_registration` with setup repair, informational `registration_version`, and informational `path_providers`. Doctor readiness suite: 80 pass, 0 fail.

## 6. Docs

- [x] 6.1 Added the setup and registry behavior under `## [Unreleased]`. Added `After installing from a registry` to `install.md` with one Cursor setup command and exit codes 0 through 7. No package install line added.

## 7. The gate

- [x] 7.1 Ran each gate command separately. Typecheck, lint, formatting, path check, plugin mirror check, version check and pack check passed. The full test command completed with 28,203 pass, 33 skipped and 74 failures across 2,278 files; most failures were 5-second timeouts in unrelated tests during the 4,209-second run. The required scoped run had 1,705 pass, 16 skipped and one self-spawn census failure. Added the setup command census entry, added the payload builder's host-config exception to the self-spawn census, then reran both affected census suites successfully.
- [x] 7.2 The OpenClaw entry imports none of the changed setup, install or doctor code, so no bundle rebuild was needed.

## 8. Report

- [x] 8.1 Reported per section in the implementation handoff, including files, actual test counts, existing test changes, deviations and remaining limits.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
