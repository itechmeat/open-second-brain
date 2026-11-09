# Proposal: split the lane page store, and keep private log events out of OKF exports

## Why

Two follow-ups from the phase 2 review of `brain-store-and-topics` (tasks
3.13 and 3.14 there) are small, bounded and independent of the topics
work, so they ship first as their own pull request.

1. `src/core/store/lane-pages.ts` is about 885 lines, past the 700-line
   limit for a source file. It grew there with the fix that keeps a
   replaced private entry private, and every later fix in it makes the
   file harder to review.
2. On a switched machine, `o2b brain okf-export` renders `log.md` from
   every `log-event` record the machine holds, the `private` partition
   included. A page from the private partition gets a
   `visibility: [private]` stamp in the bundle, but a log entry has no
   frontmatter to carry it, so a private event leaves the machine
   unmarked inside `log.md` (review finding F333, log side).

## What Changes

- The store side of the lane page store (the fold accessors, the rule
  that keeps an entry in its partition, the record builders) moves out of
  `lane-pages.ts` into a module of its own. No behaviour changes, and
  every caller keeps importing from `lane-pages.ts`.
- `log.md` in an OKF bundle built on a switched machine leaves out every
  log event of the `private` partition. The manifest and the export verb
  name how many were left out. An unswitched machine is unchanged: its
  legacy day files carry no partition.

## Capabilities

### New Capabilities

- `remote-log-reads`: what a remote MCP caller may read of the log; a
  private log event is withheld from it (found in review, design D3).
- `okf-export`: what an Open Knowledge Format bundle written by
  `o2b brain okf-export` carries, starting with the rule for private log
  events.

### Modified Capabilities

None.

## Impact

- Code: `src/core/store/lane-pages.ts` and a new
  `src/core/store/lane-entry-store.ts`; `src/core/store/read/log-events.ts`
  (the event's partition), `src/core/brain/log-days.ts` (a shared-only
  read), `src/core/brain/portability/okf.ts` (`buildLog`, the manifest)
  and `src/cli/brain/verbs/okf-export.ts` (the notice).
- The OpenClaw bundle (`openclaw/index.js`) is rebuilt if it includes any
  of these modules.
- `openspec/changes/brain-store-and-topics/tasks.md`: tasks 3.13 and 3.14
  point here.
- No new dependency, no format change on disk, no migration.
