# Proposal: harden the brain store (private log reads, partial shards, leaving a partition, lane page bytes)

## Why

Four follow-ups from the phase 2 review of `brain-store-and-topics`
(tasks 3.17, 3.15, 3.16 and 3.8 there) each leave a store-only machine
either leaking or stuck:

1. A remote MCP caller still reads private log events, their counts and
   their timestamps through readers that bypass the rule of change
   `lane-pages-split` (design D3): analytics, briefs, the preference mode
   of `brain_query`, agent provenance, backlinks, status and others.
2. A shard with one bad line in the middle, a record of a newer format or
   a blob that never arrives makes every protection read fail closed, with
   no doctor finding and no repair short of hand-editing a shard another
   device owns.
3. A machine that stops syncing `private/` refuses every store operation,
   because held partitions are sticky, and no verb clears that on purpose.
4. A lane file written whole on a store-only machine reads back changed:
   a page without frontmatter gains an empty one, `'123'` turns into a
   number, CRLF and JSON formatting are lost (OCR F291).

## What Changes

- Every reader that shows log events, or numbers derived from them, to a
  caller below local reach withholds events of the `private` partition;
  `brain_query` preference mode also applies the reference rule its
  sibling modes apply. A census test fails on any new log reader that has
  not been classified.
- `brain_doctor` names each shard read only in part, by kind, offset and
  repair command. A new verb `o2b store shard quarantine|list|release`
  releases one bad line on this machine without touching the shard;
  a newer-format line is never released, a pending blob only after seven
  days and never in `settings`.
- A new verb `o2b store partition leave <partition>` takes a partition off
  this machine on purpose; the error that names a lost partition and the
  doctor finding name the verb.
- A `lane-entry` record keeps the file's text in an optional `raw` field
  when its fields and text do not reproduce it, so a text-written lane
  file reads back byte for byte. `FORMAT.md` documents the field; the
  format version does not change.

## Capabilities

### New Capabilities

- `store-shard-gaps`: how the store reports a shard it reads only in part
  and how an operator releases one bad line on one machine.
- `held-partitions`: which partitions a machine holds, how a lost one fails
  closed, and how the operator takes one off the machine on purpose.
- `lane-entry-fidelity`: what a lane file written whole on a store-only
  machine reads back as.

### Modified Capabilities

- `remote-log-reads`: adds requirements; every reader with a remote surface
  withholds private events, counts and timestamps ignore them, and
  `brain_query` preference mode applies the reference rule.

## Impact

- Code: `src/mcp/brain/reach-events.ts`, `src/core/brain/log-events-at-reach.ts`,
  the timeline (`src/core/brain/temporal/`), the readers listed in
  design D1 and D2, `src/core/store/reader.ts`, a new
  `src/core/store/shard-quarantine.ts`, the doctor's store section, the
  held-partition ledger and its open, the lane page store
  (`src/core/store/lane-*.ts`), and two new CLI files under `src/cli/`
  (`store-shard.ts`, `store-partition.ts`).
- CLI: two new `o2b store` verbs; `src/cli/command-manifest.ts`,
  `docs/cli-reference.md` and `docs/brain-store.md`.
- Format: `src/core/store/FORMAT.md` gains the optional `raw` field of
  `lane-entry`; no format version bump, older readers ignore the field.
- The OpenClaw bundle (`openclaw/index.js`) is rebuilt: it carries the
  shard reader and the held-partition ledger.
- `openspec/changes/brain-store-and-topics/tasks.md`: tasks 3.8, 3.15,
  3.16 and 3.17 point here; tasks 3.18 (dream and evidence over
  private apply-evidence) and 3.19 (split the files past 700 lines) are
  added to that change's `tasks.md` in this change's tree.
- No new dependency, no migration. No version bump in this pull request.
