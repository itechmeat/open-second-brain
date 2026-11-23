# Tasks: agent parity

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done. Partial edits from an earlier attempt may already be
in the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration, and never the real `~/.hermes`. Tests set HOME and the host home overrides under a temp directory before anything runs.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`.
4. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. Do not touch `plugins/hermes/`, the root `__init__.py` and `cli.py`, or `src/core/doctor-hermes-parity.ts`: they are Hermes' adapter and stay.
7. If a fact the design states does not match the code, take the smallest deviation that keeps the spec's requirements and list it in the report.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md`, `review.md` and `inventory.md` (section "Change B").
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/cli/cron-recipe.test.ts tests/cli/maintenance-cron.test.ts tests/cli/search-cron-template.test.ts tests/cli/discipline*.test.ts tests/discipline tests/hooks --timeout 30000` and note the counts: 835 pass, 29 fail, 864 tests. Baseline failures were environment-specific (`head -c 0` and Bun cache writes in temporary HOME snapshots).

## 1. Recipes (spec: "Printed recipes name no agent")

- [x] 1.1 Tests first: each of the three recipes prints two sections, no agent's command and no path under an agent's home; the script sources the product's env file when it exists and is silent when it does not; the byte-pinned expectations updated to the new text.
- [x] 1.2 `cron-recipe.ts`, `maintenance-cron.ts`, `search-cron-template.ts`, `partner-codegraph-cron.ts`, the recommendation in `src/core/search/indexer.ts`, the recipe in `docs/how-it-works.md`; the four pinned tests (`cron-recipe`, `maintenance-cron`, `search-cron-template` with its fixture, `partner-codegraph-resync`) (design D1).

## 2. Discipline (spec: "The product installs into no agent's scheduler", "The discipline verdict is a doctor finding")

- [x] 2.1 Tests first: `discipline install` and `uninstall` are unknown commands and the help names `report`; the report is plain Markdown with no Telegram escaping; the Telegram capture verb still escapes as before (its helper moved, with its test); the doctor check emits the verdict through the stream that does not change the exit code, computes it once per day (a second doctor call runs no git and walks no transcripts) and is silent when the report is disabled or cannot run; leftover jobs in a temp Hermes jobs file are listed by doctor and by the uninstall plan and the file is untouched.
- [x] 2.2 The removals and additions of design D2, the command manifest (`tests/cli/manifest-completeness.test.ts`, the help parity tests), the doctor registration and the exit census, `package.json` `files` and `bun run scripts/pack-manifest.ts --write`.

## 3. The digest (spec: "The digest reaches every agent")

- [x] 3.1 Tests first: after a pass that promoted rules the session start hook shows a digest within 600 characters naming them and the full command, once per machine across sessions (a new session id does not show it again); unchanged audit events produce no digest; a full payload still carries the digest and keeps the cut note as its last line; a digest that cannot fit is shown at the next session; an otherwise empty payload prints the digest alone; the MCP instruction text announces a digest on a host without a hook, and reading the resource or the view marks it delivered; existing hook output and ceiling tests pass. The dream-session marker test is omitted because no marker exists on `main`.
- [x] 3.2 `renderDigestBrief`, the device-local delivered file, the digest in the runtime notices channel of `hooks/active-inject.ts` with its reserved characters, the line in `src/mcp/instructions.ts` and the recording on read (design D3). The proposed interval key uses the persisted finalized `run_id` because this branch stores no covered interval.

## 4. Uninstall and guides (spec: "Uninstalling names only what is installed", "Guides do not assume an agent")

- [x] 4.1 Tests first: the plan with no Hermes integration holds no Hermes step; with a Hermes manifest entry or plugin directory it does.
- [x] 4.2 `src/cli/uninstall.ts` (design D4), with detection in `src/core/install/integrations.ts`.
- [x] 4.3 The guides of design D5; `bun run sync-plugin-mirrors`; `tests/docs/install-verify-conformance.test.ts` passes with the install guides' expected-output blocks untouched.

## 5. The journey (spec: "The whole journey works with no Hermes")

- [x] 5.1 `tests/e2e/no-hermes-journey.test.ts` (design D6). The setup verb was already on the branch, so the journey uses `setup`; sections 1-4 were driven directly. The first live pass settles the fresh owner claim, then the next pass promotes the rule.

## 6. Docs

- [x] 6.1 `CHANGELOG.md` under `## [Unreleased]` with the two breaking points and what a Hermes user does; `docs/cli-reference.md`.

## 7. The gate

- [x] 7.1 Ran each gate. Full suite: 28,445 passed, 31 skipped, 83 failed across 28,559 tests and 2,305 files; failures were outside changed areas, including platform/process identity and timing-sensitive cases. `tsc`, format, paths, mirror, version, pack, link-ratchet, Hermes scan, and Hermes Python tests passed. Lint exits 1 on existing repository-wide warnings, with no warnings in changed files. The initial suite attempt lacked an isolated outer HOME; its guard reported a change to the real Hermes jobs file, attribution unknown. That file was not opened or changed by me. The full suite was rerun with an isolated HOME and host configuration and reported no real-home guard change.
- [x] 7.2 Not applicable: no changed runtime code is included in the OpenClaw bundle.

## 8. Report

- [x] 8.1 Report delivered with per-section changes and test counts, design deviations, gate results, and remaining limitations.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
