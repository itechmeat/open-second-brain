# Tasks: the dream window context

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done, so an interrupted run can resume from the first open
box. Partial edits from an earlier attempt may already be in the tree:
review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests build stores and vaults in temp directories.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: by the owner's release plan the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request.
4. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin. Time is injected through the pass's existing `now` option.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. Do not commit, do not push, do not open or comment on pull requests, no subagents. The orchestrator commits.
7. If a baseline or a fact the design states does not match what you find, stop that section and report it; do not work around it.
8. The existing dream tests are the proof that the pass did not change. Do not edit an existing test unless a section names it; report every existing test you changed and why.

## 0. Preconditions and the baseline

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md` and `review.md`, and `inventory.md` in this folder.
- [x] 0.2 Confirm the tree is clean. Run the dream tests (`tests/core/brain.dream*.test.ts`, `tests/core/brain/dream*.test.ts`, `tests/core/brain/signal-archive*.test.ts`, `tests/core/brain/doctor-inbox-archivable.test.ts`, `tests/mcp` files that call the intent review) and note the counts. A red baseline is reported, not built on.
- [x] 0.3 Check that nothing under `src/` differs from the branch point (`git diff --quiet <merge base> -- src`); if it does, stop. Then `tests/helpers/dream-history.ts` (design D4) and the expected dumps for the table of seeds, committed as fixtures. Nothing in `src/` changes in this section.

## 1. The context (spec: "A pass with no gap behaves as before")

- [x] 1.1 The census test in `tests/core/architecture/` as design D2 defines it (the module list, the three banned things, what is allowed), seen red first; put the list of today's offenders in the report.
- [x] 1.2 `src/core/brain/dream-replay/window.ts`: the context built after the scan, the evidence set where it is read today, the throw on an early read (with its test).
- [x] 1.3 The split of `evidence.ts` into matching and `evidence-read.ts`; the one read owned by `window.ts`; `scanApplyEvidence` and the per-preference readers taking it from the context; `dream-apply.ts` passing the retired rule's evidence into `moveToRetired`. Tests first: the lookup returns for a slug exactly what `collectEvidenceForSlug` returns, `ret-` targets included; a rule retired inside a pass and the same rule retired from the command line get the same evidence sections.
- [x] 1.4 Every other row of the table in design D2. The three outside callers: `review-tools.ts` and `inbox-archive-check.ts` pass their value, the reject path is unchanged.
- [x] 1.5 After this section: the baseline of 0.2 passes with no test edited (`tests/core/brain/dream-checkpoints.test.ts` and the future `--now` test of `signal-archive-edges.test.ts` among them), the census is green, and the dumps of 0.3 are reproduced exactly.

## 2. The deadline rule (spec: "Evidence confirms a trial only when dated on or before its deadline")

- [x] 2.1 Tests first: evidence dated on or before the deadline confirms; evidence dated after it does not confirm, still counts, and the trial is retired at its deadline, with the pass run in the morning and in the evening of the deadline day ending the same; the path from quarantine back to confirmed is unchanged.
- [x] 2.2 The rule (design D3). Rerun the baseline and name any existing test that changed. Regenerate only the dumps of the seeds this rule affects and list them in the report with the reason.

## 3. Docs

- [x] 3.1 `CHANGELOG.md` under `## [Unreleased]` with the breaking point. `docs/how-it-works.md`: the sentence that describes trial confirmation.

## 4. The gate

- [x] 4.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`.
- [x] 4.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 4.3 Time one pass on a generated brain before and after (the single evidence read should not make it slower); put both in the report.
- [x] 4.4 Windows shards: name the new test files that run longer than a few seconds, so the orchestrator folds the first CI run's timings into `.github/windows-test-timings.json`.

## 5. Report

- [x] 5.1 Report: per section what was built (files), the tests added with real counts, every existing test changed and why, the timing of 4.3, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
