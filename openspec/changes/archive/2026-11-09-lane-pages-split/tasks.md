# Tasks: split the lane page store, and keep private log events out of OKF exports

First read `openspec/project.md`, then this change folder: `proposal.md`,
`design.md`, `specs/okf-export/spec.md`; `brainstorm.md` and `review.md`
say why the design is what it is. Then work through this list.

Work in order, one section at a time. Before a section, read its part of
`design.md` and, for Part B, `specs/okf-export/spec.md`. Tick each box
(`- [x]`) as soon as it is done, so an interrupted run can resume from the
first open box. Partial edits from an earlier attempt may already be in
the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code. Part A changes no behaviour, so it adds no
test: the existing suite is its proof.

## Environment and rules

Work only in this checkout. Set this in every shell before any `bun`
command:

```sh
export TMPDIR=$HOME/.cache/osb-lane-pages-split-tmp
mkdir -p "$TMPDIR"
```

Never read or write the real `~/.config/open-second-brain`, any real
vault, or the real `~/.local/state/open-second-brain`; tests get temp
directories from the test preload. Never stop a process you did not
start. Do not commit, push or open a pull request. Do not start
subagents. English only in code and comments, no exclamation marks, and
the product is written "Open Second Brain" in full.

During a section run only the tests it names
(`bun test <file> [-t <name>]`). The whole gate runs once, in section 4.

Change nothing this list does not ask for. When the code does not match
what `design.md` or this list says (a name, a line, a signature), stop at
that task and explain the mismatch in the report instead of improvising.

## 0. Preconditions

- [x] 0.1 Confirm the tree: `git log --oneline -1` shows the commit
  "feat(store): migration, vault-free mode and the minimal human view
  (#292)" (or a later main), and `wc -l src/core/store/lane-pages.ts`
  prints a number above 700. Run
  `bun test tests/core/lanes tests/core/store tests/core/brain/store-only tests/core/brain/portability tests/core/architecture tests/mcp/lane-tools-no-vault.test.ts`
  and note the pass and fail counts as the baseline for Part A
  (everything should pass; if anything fails here, stop and report it).
  `tests/core/architecture/write-site-census.test.ts` pins the files that
  write; it must keep passing unchanged through Part A (see 1.3).

# Part A: the split (D1)

## 1. Move the store side

- [x] 1.1 Create `src/core/store/lane-entry-store.ts` with a short header
  comment, and move into it verbatim, with their doc comments, every
  function and constant D1 lists (items 1 to 3, `lanePagesInStore`
  included). Export the ones `lane-pages.ts` still calls; keep the rest
  module-private.
- [x] 1.2 In `lane-pages.ts` delete the moved code, import what it calls
  from `./lane-entry-store.ts`, and re-export `lanePagesInStore`,
  `laneEntryClockMs` and `laneEntryInPrivate`. Remove only the imports
  the compiler reports unused (`statSync` and `existsSync` stay).
  `lane-entry-store.ts` must not import `lane-pages.ts`.
- [x] 1.3 Check: `bunx tsc --noEmit -p .` is clean; `wc -l` shows both
  files under 700 lines; `git diff --stat` touches only these two files;
  `bun run lint` and `bun run fmt:check` are clean (run `bun run fmt` to
  fix formatting). Rerun the baseline tests of 0.1: same counts. The
  write-site census must pass unchanged (design, Risks): if it fails,
  undo the move that broke it instead of editing the census.

# Part B: private log events (D2, spec `okf-export`)

## 2. The partition of a log event, read once

- [x] 2.1 Test first, in a new
  `tests/core/store/log-events-partition.test.ts` (copy the switched
  machine setup of `tests/core/brain/portability/okf-store-only.test.ts`;
  `appendLogEvent` is in `src/core/brain/log.ts`): an event appended
  inside `withOperationPrivacy(true, …)` reads back from
  `readStoreLogEventsReport` with `partition: "private"`, one appended
  outside it with `partition: "shared"`; a record whose JSONL line is
  copied into the other partition's shard (same record id in both) reads
  back once, as `private`; `readStoreLogEvents` returns the same events
  as the report; on an unswitched vault the report is `null`.
- [x] 2.2 Implement D2 item 1 (`partition`, private wins,
  `readStoreLogEventsReport`, `readStoreLogEvents` delegating).
- [x] 2.3 Implement D2 item 2: export `WHOLE_LOG` and add `groupLogDays`
  in `src/core/brain/log-days.ts`. Verify: `bun test tests/core/brain/log-days.test.ts`
  passes unchanged.

## 3. The export

- [x] 3.1 Tests first, in
  `tests/core/brain/portability/okf-store-only.test.ts`, on a switched
  machine: (a) one shared and one private event on two days:
  `buildOkfBundle(vault)` gives `log.md` with the shared text and without
  the private text, `manifest.log_days` 1 and
  `manifest.log_private_omitted` 1; (b) a machine holding only `shared`
  (`neverHeld` from `tests/helpers/held-partitions.ts`):
  `log_private_omitted` 0; (c) a private log shard made unreadable
  (`chmod 000`, the test under `test.skipIf(CHMOD_CANNOT_DENY)` from
  `tests/helpers/platform.ts`, the mode restored in `finally`):
  `buildOkfBundle` throws an error naming the shard; (d) the duplicate
  record of 2.1: left out of `log.md` and counted.
- [x] 3.2 Test first, in `tests/core/brain/portability/okf.test.ts`: an
  unswitched vault with log day files gives `log_private_omitted` 0 and
  the same `log.md` as before; a manifest without `log_private_omitted`
  parses with the value 0 (add a case to the existing manifest parse
  test).
- [x] 3.3 Tests first, in `tests/cli/okf-cli.test.ts`, on a switched
  machine with one private event: the verb's standard error contains
  `left 1 private log entry out of log.md`, both without and with
  `--include-prompt-derived`; the written `okf.json` carries
  `"log_private_omitted": 1` (this proves the count survives
  `buildOkfBundleFromPages`); with an unreadable private log shard the
  verb exits non-zero and writes no bundle.
- [x] 3.4 Implement D2 items 3 to 5: `buildLog`, `OkfLog.privateEntries`,
  the manifest field in every place D2 item 4 names (the two `Pick`
  types, `assembleOkfBundle`, `ManifestInput`, the parser,
  `readSpecOkfBundle`), and the notice in `okf-export.ts` outside the
  `--include-prompt-derived` branch.
- [x] 3.5 Check: the tests of 2 and 3 pass, `bunx tsc --noEmit -p .` is
  clean, and `wc -l` shows every changed source file under 700 lines (if
  a file was already above 700 before this change, as `okf.ts` is, say so
  in the report and add no more than the change needs).

## 4. The gate

- [x] 4.1 Run the whole gate from `openspec/project.md` ("The local
  gate"), each command on its own. All must pass. Then rebuild the
  OpenClaw bundle (`bunx bun@1.4.0 run build:openclaw`) and note whether
  `openclaw/index.js` changed (`git diff --stat openclaw/index.js`); keep
  the rebuilt file.
- [x] 4.2 In `openspec/changes/brain-store-and-topics/tasks.md`, append
  to the text of tasks 3.13 and 3.14 the sentence
  "Done in change `lane-pages-split`." and tick both boxes.

## 5. Report

- [x] 5.1 Finish with a report of at most 40 lines: every box ticked or why not; the
  line counts of `lane-pages.ts` and `lane-entry-store.ts`; every function
  that needed more than a verbatim move and why; the test counts of the
  gate; whether `openclaw/index.js` changed; anything in this brief that
  did not match the code.

## Workflow follow-up

- Independent code review rounds of the result, fixes re-reviewed.
- Archive the change (`openspec archive lane-pages-split --yes`) inside its
  pull request, after the whole cycle is green.
