# Design: split the lane page store, and keep private log events out of OKF exports

See proposal.md for why. Two independent parts, built in order: Part A
(D1, the split) changes no behaviour; Part B (D2, the log rule) changes
one observable behaviour of the export.

## Context

- `src/core/store/lane-pages.ts` (about 885 lines) is the one place the
  lane modules read and write their pages. About 60 files import it.
  Its sections: path helpers (`laneVaultRoot` to `context`, lines 81-162),
  "The store side" (lines 164-328), "Reads" (330-530), "Writes"
  (532-802), "Folders of lane files" (804-885). Inside "Writes" sit four
  private helpers that belong to the store side: `legacyPagePrivate`,
  `storedEntryPrivate`, `isLaneEntryPath` and `laneTextParts`.
- `src/core/store/read/log-events.ts` reads `log-event` records from both
  partitions, deduplicates them by record id (`shared` is read first, so
  a record present in both counts as shared) and returns
  `StoreLogEvent { entry, device, hlc }` without the partition.
- `src/core/brain/log-days.ts` `storeLogDays(vault, context)` groups those
  events by day; `null` on an unswitched machine. A read pass caches the
  days per store root and vault.
- `src/core/brain/portability/okf.ts` `buildLog(vault, filter?)` renders
  `log.md` from `storeLogDays(vault)` on a switched machine and from the
  `Brain/log/` day files otherwise, and returns
  `OkfLog { contents, days, droppedEntries }`. The manifest
  (`OkfManifest`) carries `log_days`. The import parses the manifest
  leniently: a missing numeric field reads as 0.
- `src/cli/brain/verbs/okf-export.ts` writes the bundle and prints the
  omission notices on standard error (`logOmissionNotice` and others).

## Goals / Non-Goals

Goals: every source file of this change under 700 lines; no caller of
`lane-pages.ts` edited for Part A; a private log event never reaches
`log.md`.

Non-goals: tasks 3.8 to 3.12, 3.15 and 3.16 of `brain-store-and-topics`;
any change to how log events are written; a flag that puts private events
back into `log.md`. No other egress path carries log events: the
knowledge pack (`buildOkfSubsetBundle`) has no `log.md` by contract, and
`buildOkfBundleFromPages` calls `buildLog` by default; the other readers of
the log days (MCP resources, briefs, status, backlinks) are reads on the
same machine, not egress.

## Decisions

### D1. The store side moves to `src/core/store/lane-entry-store.ts`

The new module holds, moved verbatim (doc comments included):

1. the path helpers the store side needs: `lanePagesInStore` (lines
   95-98; `heldInStore` calls it, so leaving it behind would make an
   import cycle), `heldInStore`, `insideBrain`, `brainRelOf`, `placeOf`,
   `isLaneEntryPath`, and the constant `PAGE_OPAQUE_FIELDS`;
2. everything under "The store side": `storeEntries`, `laneEntryClockMs`,
   `storeEntry`, `foldIncomplete`, `livesInPrivate`, `laneEntryInPrivate`,
   `partitionOf`, `tombstoneOf`, `replacedShared`, `fieldsCopy`,
   `sameEntry`, `authorityFor`, `isPrivateEntry`, `entryRecord`,
   `PRIVATE_WHEN_HELD_LANES`;
3. the keep-rule helpers from "Writes": `legacyPagePrivate`,
   `storedEntryPrivate`, `laneTextParts`, together with the doc comment
   that explains the two halves of the keep rule.

Functions that `lane-pages.ts` still calls are exported from the new
module; nothing else changes in their signatures or bodies. The module
gets a short header comment (what it holds, design D14 of
`brain-store-and-topics`). `lane-pages.ts` imports them, keeps every
export it has today, and re-exports `lanePagesInStore`,
`laneEntryClockMs` and `laneEntryInPrivate`
(`export { … } from "./lane-entry-store.ts"`) so no caller changes.
`lane-pages.ts` still needs `statSync` and `existsSync` (for example
`laneFileBytes`): remove only the imports the compiler reports unused. The new module must not import `lane-pages.ts` (no
import cycle). `routeLaneWrite`, `guardUserVaultWrite`, `context`,
`withCreateLock` and the lock helpers stay in `lane-pages.ts`.

Alternative considered: three modules (paths, fold, records). Rejected:
more files for no reader benefit; one store-side module of about 330
lines leaves `lane-pages.ts` at about 560.

### D2. `log.md` leaves out events of the `private` partition

One read of the store log, counted by partition; the read refuses when it
is not whole.

1. `src/core/store/read/log-events.ts`: `StoreLogEvent` gains
   `readonly partition: StorePartition`. A record id read from both
   partitions is `private` (private wins: the strict answer when devices
   disagree). Add
   `readStoreLogEventsReport(range, context): { events: StoreLogEvent[]; unreadable: ReadonlyArray<string> } | null`
   (`null` on an unswitched machine), and make `readStoreLogEvents` return
   its `events`, so existing callers are unchanged.
2. `src/core/brain/log-days.ts`: export `WHOLE_LOG`, and add
   `groupLogDays(entries): LogDay[]`, the values of the existing
   module-private `groupByDay` (oldest first, the same frozen days
   `storeLogDays` returns). `groupByDay` and `storeLogDays` are unchanged.
3. `src/core/brain/portability/okf.ts` `buildLog`, on a switched machine:
   read once with `readStoreLogEventsReport(WHOLE_LOG, { vault })` (the
   same whole-log range `log-days.ts` uses). When `unreadable` is not
   empty, throw
   `okf export: cannot read log shard(s) <names>; the bundle would be short of their events`,
   the store side of the existing throw for an unreadable day file
   (okf.ts, "cannot read log shard"). A switched machine whose store
   cannot be opened reads no events and no unreadable shard, so `buildLog`
   first asks `protectionStore()` (`src/core/store/read/protection-store.ts`),
   which throws `StoreUnavailableError` there (added in the code review).
   Otherwise count the `private` events
   into `privateEntries`, and render the days of the `shared` events
   (`groupLogDays`) exactly as today. The content-class filter then applies
   to the shared events only, so the two counts never overlap. On an
   unswitched machine `buildLog` is unchanged and `privateEntries` is 0.
   `OkfLog` gains `readonly privateEntries: number`.
4. The manifest: `OkfManifest` gains `readonly log_private_omitted: number`.
   Every place that builds or carries one is updated: the two
   `Pick<OkfLog, "contents" | "days">` parameters of
   `buildOkfBundleFromPages` and `assembleOkfBundle` become
   `Pick<OkfLog, "contents" | "days" | "privateEntries">` (otherwise the
   export verb, which passes its own log through them, would write 0), the
   manifest built in `assembleOkfBundle` (`log_private_omitted:
   log?.privateEntries ?? 0`), `ManifestInput` and the parser (missing or
   not a finite number reads as 0, like `log_days`), and the literal
   manifest of `readSpecOkfBundle` (0). `renderOkfManifest` is
   `JSON.stringify` and needs nothing. `index.md` is unchanged.
5. `src/cli/brain/verbs/okf-export.ts`: when `log.privateEntries > 0`,
   print one line on standard error,
   `okf-export: left N private log entr(y|ies) out of log.md\n`,
   OUTSIDE the `--include-prompt-derived` branch (that flag is about
   content class, not partitions), so it prints with and without the flag.

Alternatives considered: a privacy marker inside each private entry of
`log.md` (rejected: a marker in prose is easy to strip and no consumer
reads it); refusing the export whenever a private event exists (rejected:
the operator loses the whole bundle over one event); a flag to keep them
(rejected: it re-opens the leak); two reads, full minus shared-only
(rejected: not atomic, so an append between them skews the count, and it
reads the log twice).

### D3. Private log events are withheld below local reach (added in review)

The final code review found the same leak on the MCP side: the
`osb://log/{date}` resource and `brain_query` render store log events to a
remote caller through `logEntriesAtReach`, which judged an event only by
the records it names, so a private event naming nothing reached a remote
client. The fix is general rather than per reader:

1. `BrainLogEntry` gains `fromPrivatePartition?: true`, set by
   `storeLogEvents` (`src/core/store/read/log-events.ts`) on every entry
   read from the `private` partition.
2. `ArtifactRefView` gains `withholdsPrivate?: boolean`. `reachView`
   sets it below local reach; `everyArtifactRefView` keeps it when any
   constituent has it.
3. `logEntryAtReach` returns nothing for a marked entry when the view
   withholds private ones, before its reference rule; `logEntriesAtReach`
   and every single-entry caller (`brain_event_trace`, the digest's agent
   summary, the lessons reader) inherit it.
5. The digest and the lessons reader build their own view from a
   `readable` predicate, which cannot say the caller is remote (an owner
   scope at local reach passes one too). Both take `withholdsPrivate`
   (`readerRefView`'s third argument); `osb://digest/latest`, the lessons
   resource and `brain_brief` pass it below local reach.
4. `readLog` in `src/mcp/resources.ts` filters before its empty-day check,
   so a day of only withheld events reads as absent (no existence
   oracle).

Readers of the log that may render it to a remote caller without the
reach helpers (the active-preferences digest's most-applied counts, the
morning brief, temporal citations, status, backlinks, analytics) are
audited in task 3.17 of `brain-store-and-topics`.

The same review found that a store-only machine that was never switched
(no legacy tree) with a corrupt `store.json` still exported an empty log.
`protectionStore` gains `openErrorFails`: a store that exists but cannot
be opened throws on any store-only machine; `buildLog` asks with it and
with the vault it exports (`vault`), so an explicit export vault that is
store-only is judged as such even when the configured vault still has its
legacy tree.

## Risks / Trade-offs

- [A moved function keeps a hidden dependency on a `lane-pages.ts`
  local] → the type check fails on it; move the dependency too only if it
  belongs to the store side, otherwise pass it in. Report every such case.
- [The write-site census (`tests/core/architecture/write-site-census.test.ts`)
  pins which files write] → the moved code only reads the file system, and
  every write call stays in `lane-pages.ts`, so the census must not change.
  A census failure means something moved that should not have: undo that
  move instead of editing the census.
- [An export that used to succeed now refuses on an unreadable log shard]
  → the operator gets the shard names and the same remedy as for an
  unreadable day file; a bundle silently short of events is worse.
- [The OpenClaw bundle includes a changed module] → rebuild it and commit
  `openclaw/index.js`; the gate compares it.

## Migration Plan

None: no format on disk changes. A bundle written before this change has
no `log_private_omitted`, which the parser reads as 0.
