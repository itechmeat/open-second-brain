# Design: harden the brain store

See proposal.md for why and brainstorm.md for the alternatives. Four
independent decisions, built in two parts by two executors in parallel:
Part C (D1 to D6: tasks 3.17 and 3.15) and Part Z (D7, D8: tasks 3.16
and 3.8), then merged by an integrator (D9). A name marked (new) does not
exist yet; every other name exists in the tree this change was written
against.

## Context

- `src/core/store/read/log-events.ts` sets `fromPrivatePartition: true` on
  every `BrainLogEntry` read from the `private` partition (change
  `lane-pages-split`, D3). Every store log reader (`readLogEvents`,
  `readLogEventsReport`, `readStoreLogEvents`, `storeLogDays`,
  `logDayReader`, `logDaysWithDevices`, `readAllLogEntries`) returns
  entries with the mark. `logEntryAtReach` and `logEntriesAtReach`
  (`src/core/brain/log-events-at-reach.ts`) drop marked entries when the
  view's `withholdsPrivate` is set; `reachView` sets it below local reach,
  `readerRefView(vault, readable, withholdsPrivate = false)` only when
  asked.
- `requestRefView` (`src/mcp/brain/reach-events.ts`) calls
  `readerRefView(ctx.vault, readableAtContextReachOrUndefined(ctx))`
  without the third argument, so the analytics and brief tools that build
  on it never withhold. `normaliseLogEntry`
  (`src/core/brain/temporal/build-index.ts`) drops the mark, and
  `TemporalEvent` (`src/core/brain/temporal/types.ts`) has no field for
  it, so `eventAtReach` cannot see it; a `note` names nothing and passes.
- `src/core/store/reader.ts`: `readShard` returns records and
  diagnostics; `shardReadGap(read)` is the one place that decides a shard
  read only in part (a pending blob, any non-torn diagnostic). Its callers:
  `read/stream-read.ts`, `state-digest.ts` (`readPartition`, which feeds
  `store-migration/journal.ts` `readHeldRecords`), `view/catch-up.ts`,
  `brain/attestation/record.ts`.
- `src/core/store/held-ledger.ts` keeps one marker file per store root and
  held partition (`held-partitions/<sha256(resolve(root))[0:32]>.<partition>`
  under `storesStateDir()`); `lostHeldPartitions` makes
  `heldPartitionsChecked` (`store-open.ts`) throw `HeldPartitionLostError`;
  the doctor reports its message as `store-partition-lost`
  (`src/core/brain/doctor/store-check.ts`).
- `src/core/store/lane-pages.ts` (627 lines) `writeLaneText` splits a text
  into fields and text with `laneTextParts`
  (`src/core/store/lane-entry-store.ts`); `readLaneText` renders them back
  with `formatFrontmatter` or `JSON.stringify`, which loses bytes.
- Files already past the 700-line rule that this change must touch:
  `src/core/brain/digest.ts` (1234), `src/mcp/brain/query-tools.ts` (1456),
  `src/mcp/resources.ts` (994), `src/mcp/brain/brief-tools.ts` (818),
  `src/mcp/brain/context-tools.ts` (984), `src/mcp/brain/recall-tools.ts`
  (1766), `src/mcp/brain/knowledge-tools.ts` (1588) and the data table
  `src/cli/command-manifest.ts` (1516).

## Goals / Non-Goals

**Goals:** the four behaviours of the specs; no file under 700 lines
crosses 700 because of this change; the eight files already past it
(Context) grow by call-site edits only (an argument or an option added at
a call, an import line; any logic lives in a helper in another module);
`lane-pages.ts` stays under 700; Part C and Part Z build without each
other's code.

**Non-Goals:**

1. Splitting the files past 700 lines: task 3.19 of
   `brain-store-and-topics` (added to that change's `tasks.md` in this
   change's tree, unchecked; task 14.5 confirms it is there).
2. Dream and evidence computations (`evidence.ts`, `dream-refresh.ts`,
   the review candidates of the operator snapshot) that let private
   apply-evidence move a shared preference's confidence or status: task
   3.18 (added the same way, unchecked). They keep reading every event.
3. The token footprint's page buckets: they count private pages, a page
   aggregate, not a log reader. Only its log bucket follows D2.
4. Raw text in the migration's lane entries (D8 explains why).
5. Pages the human view rendered from a partition before it was left: the
   view is a user-facing folder, not device-local state; the view writer
   re-renders from the held partitions.
6. Any change to how log events are written, or to the store format
   version.

## Decisions

### D1. The two roots (Part C, task 3.17)

1. `requestRefView(ctx)` passes
   `contextReach(ctx) !== TRANSPORT_REACH.local` as `readerRefView`'s
   third argument. Every caller (`analytics-tools.ts`, `brief-tools.ts`,
   `recall-tools.ts`) then withholds through `eventAtReach`,
   `eventsAtReach` and `logEntriesAtReach` with no edit of its own.
2. `TemporalEvent` gains `readonly fromPrivatePartition?: true`, set by
   `normaliseLogEntry` from the entry. `eventAtReach` returns `null` for a
   marked event when `refs.withholdsPrivate === true`, as its first line,
   the same placement as in `logEntryAtReach`.
3. `BuildTimelineIndexOptions` gains `readonly withholdsPrivate?: boolean`;
   `collectLogEvents` skips marked entries when it is set (store-only
   machines only; day files carry no mark). For the builders whose output
   no view filters (D2 item 9).
4. `src/core/brain/log-events-at-reach.ts` gains (new)
   `withoutPrivateEntries<T extends { readonly fromPrivatePartition?: true }>(entries: ReadonlyArray<T>, withholds: boolean): ReadonlyArray<T>`,
   the one filter every counting reader of D2 calls.

Alternatives: a seam filter or an ambient per-request scope (brainstorm,
Rejected).

### D2. Each reader with a remote surface (Part C, task 3.17)

Each core reader gains an optional `withholdsPrivate?: boolean` (default
false: local callers and the CLI are unchanged) and skips marked entries
through `withoutPrivateEntries`; each MCP call site passes
`contextReach(ctx) !== TRANSPORT_REACH.local`, or the view's
`withholdsPrivate === true` where it already holds a view.

| # | Core reader (option added) | MCP call sites (call-site edit) |
|---|---|---|
| 1 | `brain_query` preference mode: no core change | `query-tools.ts`: `const evidence = logEntriesAtReach(queryView, res.evidence)`; telemetry counts `evidence.length`; return `evidence.map(serializeLogEntry)` |
| 2 | `computeMostApplied` (`most-applied.ts`, `ComputeMostAppliedOptions`); `renderActive` (`active.ts`, `RenderActiveOptions.withholdsPrivate`, passed to `computeMostApplied`); `renderActiveForReader` sets it from `opts.restricted === true` | none for `brain_context`, `osb://active`, the pre-compress pack (they pass `restricted`); `digest.ts` passes `refs.withholdsPrivate === true` to `computeMostApplied` |
| 3 | `buildMorningBrief` (`morning-brief.ts`, `MorningBriefOptions.withholdsPrivate`): its view is `readerRefView(vault, opts.readable, opts.withholdsPrivate === true)`, and `scanRecentLog` skips every entry for which `logEntryAtReach(refs, e) === null` before the reconcile and note branches; `discoverIdeas` (`idea-discovery.ts`, `DiscoverIdeasOptions.withholdsPrivate`) passes it on | `brief-tools.ts` (view=morning); `knowledge-tools.ts` (`discoverIdeas`) |
| 4 | Agent provenance: `AgentSourceContribution` (`agent-source/types.ts`) gains `readonly fromPrivatePartition?: true`, set by `logContribution` and `noteWriteContribution` (`vault-provider.ts`); `queryAgentSources` (`agent-source/query.ts`) drops a marked contribution when `opts.view?.withholdsPrivate === true`, and strips the field from every contribution it returns (no output change) | none (`brain_agent_query` and `brain_agent_diff` already pass `reachView`) |
| 5 | `buildBacklinkIndex(vault, ownerScope?, opts: { withholdsPrivate?: boolean } = {})` (`backlinks.ts`): `collectLog` skips marked entries; `buildConceptCluster` (`link-graph/concept-cluster.ts`, `BuildConceptClusterOptions.withholdsPrivate`) and `auditMoc` (`link-graph/moc-audit.ts`, `AuditMocOptions.withholdsPrivate`) pass it to their index; the doctor's broken-backlinks check (`doctor/link-checks.ts`, `brokenBacklinkCheck`) passes `DoctorCheckContext.withholdsPrivate`, which `runDoctor` copies from the new `RunDoctorOptions.withholdsPrivate` (its `sources` name `log-<date>` and its target is the id a private event named); `collectDoctorIssues` (`diagnostics.ts`, the repair path's own doctor pass) gains a `withholdsPrivate` parameter it passes to `runDoctor`: `applyRepair` passes `view.withholdsPrivate === true` (its view already joins `reachView(vault, opts.reach)` when a transport set `reach`), `planRepair`'s own call passes `false`, so the remote plan's `unfixable` count of `broken-backlinks` is taken over the same entries | `resources.ts` (`osb://backlinks`, `view.refs.withholdsPrivate === true`); `query-tools.ts` (`brain_backlinks`); `digest.ts` (inbound counts, `refs.withholdsPrivate === true`); `analytics-tools.ts` (`brain_analytics` view=concept_synthesis: take `requestRefView(ctx)` before `buildConceptCluster` and pass `refs.withholdsPrivate === true`; its log linkers carry the event's kind and timestamp); `knowledge-tools.ts` (`brain_moc_audit`: `auditMoc` gets `contextReach(ctx) !== TRANSPORT_REACH.local`; its member `backlinkCount` and buckets count log references); `health-tools.ts` (`brain_doctor`: its `runDoctor` call passes `contextReach(ctx) !== TRANSPORT_REACH.local`; the repair branch needs no edit, it already passes `reach: contextReach(ctx)` to `applyRepair`); the operator summary and the operator snapshot pass their own option to `runDoctor` (rows 8 and 9) |
| 6 | `computeBrainStatus` (`ComputeBrainStatusOptions.withholdsPrivate`) and `computeMaintenanceOverdueFlag(vault, opts = {})` (`status.ts`): `statusLog` and `recentStatusLog` filter entries, and a day with no entry left is not a log day | `tools.ts` (`second_brain_status`); `resources.ts` (`osb://status`); `context-tools.ts` (the overdue flag) |
| 7 | `computeMemoryCostMeter` and `summarizeMemoryWrites` (`memory-cost-meter.ts`, `MemoryCostMeterOptions.withholdsPrivate`, `MemoryWriteFilter.withholdsPrivate`) | `recall-tools.ts` (operation `cost`) |
| 8 | `computeTokenFootprint(vault, opts)` (`token-footprint.ts`): `sumStoreLog` skips marked entries; `collectMaintenanceActions` (`maintenance/collect.ts`, `CollectMaintenanceActionsOptions.withholdsPrivate`) passes it; `buildOperatorSummary` (`trust/operator-summary.ts`, `BuildOperatorSummaryOptions.withholdsPrivate`) passes it to `collectMaintenanceActions` in `safeTopActions` and to `runDoctor` in `safeDoctor` (row 5) | `health-tools.ts` (`brain_doctor` suggested actions); `digest.ts` (its `actions` list, which `osb://digest/latest` and `brain_brief` view=digest render: `collectMaintenanceActions` gets `refs.withholdsPrivate === true`); `brief-tools.ts` (`brain_brief` view=operator: `buildOperatorSummary` gets `withholdsPrivate: view.withholdsPrivate === true`, outside the `view.filtersNothing` spread; `everyArtifactRefView` carries the flag from `reachView`) |
| 9 | `buildTimelineIndex` (D1 item 3) for the builders no view filters: `traceIdeaLineage` passes its `withholdPrivate` into `preferenceLineage`; `buildOperatorSnapshot` (`BuildOperatorSnapshotOptions.withholdsPrivate`) passes it to its own `buildTimelineIndex` call for its stale count and to its `runDoctor` call (row 5; its doctor-warnings count) | `review-tools.ts` (`brain_stale_scan`): its own `buildTimelineIndex(ctx.vault, {})` call, feeding `findStaleEntries`, passes `withholdsPrivate: reviewView(ctx).withholdsPrivate === true` (the tool already builds that view from `reachView(ctx.vault, contextReach(ctx))` below the call; take it before the index), with no `buildOperatorSnapshot` involved; `analytics-tools.ts` (`brain_analytics` view=belief_evolution: take `requestRefView(ctx)` before the index and pass `refs.withholdsPrivate === true`; its evidence rows and transitions are derived from the index, carry the event's time, result and running counts, and never pass `eventAtReach`); `brief-tools.ts` (`brain_brief` view=daily and view=weekly: both index calls pass `requestRefView(ctx).withholdsPrivate === true`; their `status_transitions`, `retired` and `contradictions` are derived from the index and the reference view asks them only what they name); `health-tools.ts` (`brain_status`) passes the option to `buildOperatorSnapshot`; idea lineage needs none (`synthesis-tools.ts` already passes `withholdPrivate`) |
| 10 | `listNoteWrites` (`notes/write-log.ts`, `ListNoteWritesFilter.withholdsPrivate`) and `listWriteDestinations` (`notes/write-destinations.ts`, `WriteDestinationsFilter.withholdsPrivate`); `planNoteRevert` (`notes/revert.ts`, `PlanNoteRevertOptions.withholdsPrivate`) passes it to its selected read only: the universe read, which feeds only the interleaving and creation rules, keeps every write, private ones included, so a private write between two selected shared writes still refuses the plan (`interleaved`), and the refusal names only the selected writes; `ApplyNoteRevertOptions` omits the option, so an apply always reads in full | `query-tools.ts` (`brain_writes`, `brain_write_destinations`; `brain_writes` action `plan_revert`: take `reachView(ctx.vault, contextReach(ctx))` before `planNoteRevert` and pass `view.withholdsPrivate === true`. The CLI apply re-plans in full, so a plan that withheld a private write is refused with `digest_mismatch`, as a plan that withheld an entry is today) |

Settled "verify" rows: a note-write event on a shared target is private
when its operation was private; it is withheld (row 10), because the rule
is "whatever it names". The orphan-session check
(`doctor/orphan-session-check.ts`) quotes no event text: it names a signal
path and its `session_ref`, both from a page the path filter already
judges; it keeps reading every event, because withholding a private
lifecycle event would report a false orphan whose repair detaches a valid
reference. The two evidence lints (`doctor/log-checks.ts`,
`orphanEvidenceCheck` and `evidenceRangeCheck`) do quote an
`apply-evidence` event's timestamp and artifact, so below local reach
(`DoctorCheckContext.withholdsPrivate`) they leave out the events of the
`private` partition (`withoutPrivateEntries`); neither has a fixer
(`orphan-evidence` is `autoRepairable: false`, `malformed-evidence-range`
is on the no-exit list), so the withheld finding changes no repair. The
log snapshot itself stays unfiltered. The
broken-backlinks check does withhold (row 5): withholding hides a
dangling reference from the remote caller only, it creates no finding,
and the code has no fixer (`autoRepairable: false`).

Settled callers without a remote surface (no call-site edit): the CLI
verbs; `o2b brain explorer` (`explorer.ts`: `buildBacklinkIndex` and
`buildOperatorSnapshot`; a server bound to `127.0.0.1` that refuses
non-loopback `Host` headers, and its export is a CLI write);
`profile-doc.ts` (`buildMorningBrief`, reached only from
`o2b brain profile`); the `active.md` stamp and write in `active.ts`
(`renderActive`, a vault file). Settled remote callers that need no
edit: `stale-dependency.ts` (`buildBacklinkIndex` inside the doctor) skips
every log-sourced reference already (`LOG_SOURCE_KIND_PREFIX`);
`brain_health` (`health-tools.ts`) and `scanTriggers` (`triggers/scan.ts`,
`brain_trigger`) run the doctor for `semantic_health` only, which reads
no broken-backlinks finding; `today-dashboard.ts` and `monthly-review.ts`
build a timeline index whose events `brief-tools.ts` filters through
`eventAtReach` (D1 item 1) before any row is derived from them (the today
dashboard regroups the index over the visible events; the monthly review
counts transitions and contradictions over them); `brain_analytics`
view=timeline renders the events themselves through `eventsAtReach`.

### D3. The log-reader census (Part C, task 3.17)

(new) `tests/core/architecture/log-reader-census.test.ts`, in the shape of
`write-site-census.test.ts`: walk `src/**/*.ts`, find every call
`\b(logDayReader|storeLogDays|readStoreLogEvents|readStoreLogEventsReport|readLogEvents|readLogEventsReport|logDaysWithDevices|readAllLogEntries|buildTimelineIndex)\(`
outside a `function <name>(` declaration, and require each calling module
to be a key of a closed table `{ class: "at-reach" | "local-only" | "computation"; reason: string }`.
A calling module missing from the table fails, naming it; a table key
that no longer calls fails as stale. The definers
(`src/core/brain/log-days.ts`, `src/core/store/read/log-events.ts`,
`src/core/brain/temporal/build-index.ts` for its own `readLogEvents`
call) are listed as `computation` with "defines the reader". The table at
the time of writing:

| Module | Class | Reason |
|---|---|---|
| `cli/brain/verbs/temporal-{daily,evolution,stale,timeline,weekly}.ts` | local-only | CLI |
| `core/brain/agent-source/vault-provider.ts` | at-reach | D2 row 4 |
| `core/brain/backlinks.ts` | at-reach | D2 row 5 |
| `core/brain/digest-agent-summary.ts`, `core/brain/digest.ts`, `core/brain/lessons.ts`, `core/brain/event-trace.ts` | at-reach | `logEntryAtReach` with the caller's view |
| `core/brain/doctor/orphan-session-check.ts`, `core/brain/doctor/records.ts` | computation | D2, settled rows |
| `core/brain/dream-refresh.ts`, `core/brain/evidence.ts` | computation | dream and evidence (task 3.18) |
| `core/brain/governance/forget-plan.ts`, `core/brain/profile-doc.ts`, `core/brain/temporal/citations.ts`, `core/discipline/log-counts.ts` | local-only | CLI only |
| `core/brain/idea-lineage.ts`, `core/brain/operator-snapshot.ts` | at-reach | D2 row 9 |
| `core/brain/memory-cost-meter.ts`, `core/brain/most-applied.ts`, `core/brain/morning-brief.ts`, `core/brain/status.ts`, `core/brain/token-footprint.ts`, `core/brain/notes/write-log.ts`, `core/brain/notes/write-destinations.ts` | at-reach | D2 rows 2, 3, 6, 7, 8, 10 |
| `core/brain/monthly-review.ts`, `core/brain/today-dashboard.ts` | at-reach | the caller's `eventAtReach` (D1) |
| `core/brain/portability/okf.ts` | at-reach | private events leave `log.md` (spec `okf-export`) |
| `core/brain/query.ts` | at-reach | `brain_query` filters every mode (D2 row 1) |
| `mcp/brain/analytics-tools.ts`, `mcp/brain/brief-tools.ts` | at-reach | `requestRefView` (D1); derived rows: an index built withholding (D2 row 9) |
| `mcp/brain/review-tools.ts` | at-reach | D2 row 9 |
| `mcp/resources.ts` | at-reach | `osb://log` filters (D3 of `lane-pages-split`) |

Behaviour proof: (new) `tests/mcp/log-private-reach-surfaces.test.ts`,
one test per row of D2 and per root of D1, each with one private event
that names nothing, asserting the remote answer and the local one (the
setup of `tests/mcp/log-private-reach.test.ts`: `makeStoreEnv`,
`switchDevice`, `withOperationPrivacy(true, ...)`, `appendLogEvent`; tools
through `new MCPServer({ vault, configPath }, { reach }).callTool(...)`
as in `tests/helpers/reach-log-fixture.ts` `reachServer`).

### D4. The quarantine ledger and the reader (Part C, task 3.15)

(new) `src/core/store/shard-quarantine.ts` (the read side; the two writes live in
`shard-quarantine-write.ts`, so a reader of the ledger loads no lock module):

1. The ledger file is
   `<storesStateDir()>/shard-quarantine/<sha256(resolve(root))[0:32]>.json`
   (keyed by the store root like `held-ledger.ts`; device-local, never
   synced): `{ "version": 1, "root": "<resolved root>", "lines": [ { "partition", "shard": "<partition-relative path>", "offset": <n>, "sha256": "<hex>", "kind": "corrupt-line" | "blob-pending", "reason": "<text>", "quarantined_at": "<ISO>" } ] }`.
   `sha256` is the hash of the line's bytes from `offset` through its
   newline, newline included, read from the file. A line over the line cap
   is a corrupt line too, so it is hashed as well, up to
   `QUARANTINE_HASH_CAP_BYTES` (64 times the line cap, 1 MiB); past that
   the hash is `null`, the line cannot be quarantined and stays a gap. The
   reader hashes from the descriptor its read holds (`lineSha256AtFd`);
   every other caller (`lineSha256At(path, offset, partitionRoot)`) opens
   the shard through the reader's guarded open (`openRegularFileForRead`
   with the partition root: no symbolic link, special file or linked
   folder), and a failure answers `null`, which matches no entry. Writes
   are read-modify-write under `withLocalLock(<ledger path>, ...)`
   (`local-lock.ts`) with `atomicWriteFileSync` (`fs-atomic.ts`); the
   write side parses the ledger strictly and throws
   `QuarantineLedgerUnreadableError` when the file exists but cannot be
   read (its own detail: removed while it was read, or the read error),
   does not parse, has a `version` other than 1, or holds an entry it does
   not read, instead of rewriting it; `addQuarantine` answers `already`
   only for an entry with the same offset, bytes and kind, and replaces an
   entry of the other kind, and it leaves the file untouched when a
   change is a no-op (`already`, `not-quarantined`). Reads are cached by
   the file's size and mtime, as `seen-shards.ts` caches its ledger. The
   read side (`load`, through `appliedLines`) fails closed: it applies
   entries only from a JSON object whose `version` is
   `QUARANTINE_LEDGER_VERSION` (1) and whose `lines` is a list; a ledger
   that cannot be read, does not parse, has another or no `version`, is
   not an object or has no list of lines quarantines nothing. Within an
   accepted ledger each entry stands on its own: one `isLine` rejects (a
   newer build's kind, a missing field) applies nothing and the others
   still apply. Either way a skipped entry only leaves its line a gap, so
   no ledger the release cannot vouch for makes a shard read as whole;
   the write side stays strict and refuses the same file instead.
2. Exports of `shard-quarantine.ts`: `quarantinedLines(partitionRoot, rel)`
   (offset to line hash and kind, for the reader), `lineSha256AtFd(fd,
   offset)`, `lineSha256At(path, offset, partitionRoot)`,
   `QUARANTINE_HASH_CAP_BYTES`, `probeLineHashAtFd` and `probeLineHashAt`
   (the same hash, or why there is none: `too-long` past the cap,
   `unreadable` otherwise; `lineSha256AtFd` and `lineSha256At` answer
   `null` for both), `listQuarantine` (each shard parsed at most once per
   call, and only when one of its entries still matches; the staleness
   probe hashes each entry's line on its own, opening the shard once per
   entry; a shard whose read throws leaves its matching entries `held`),
   `pendingRecordWrittenMs`, `quarantineStamp`,
   `PENDING_BLOB_QUARANTINE_AGE_MS` (7 days) and
   `PENDING_BLOB_QUARANTINE_AGE_TEXT`; of `shard-quarantine-write.ts`:
   `addQuarantine`, `releaseQuarantine` and
   `QuarantineLedgerUnreadableError`.
3. `readShard` (`reader.ts`): when `options.partitionRoot` is set and the
   ledger names the shard, after the read it marks an item only when both
   its byte offset and the hash of its line's bytes match one ledger
   entry of the matching kind. This holds for every mark alike: a
   non-torn `corrupt-line` diagnostic is marked only by a `corrupt-line`
   entry, and a `pending` record only by a `blob-pending` entry and never
   in a `settings` shard, each on an offset-and-hash match, never on the
   shard or the offset alone, so a
   second corrupt line at another offset of the same shard, or other bytes
   at a quarantined offset, stay gaps. `ShardDiagnostic` and `ReadRecord`
   gain `readonly quarantined?: true`. `shardReadGap` skips a quarantined
   diagnostic and does not count a quarantined pending record, exactly as
   it skips `torn`. Everything else is unchanged: a quarantined pending
   record is still left out by every reader (they keep `bodyState !==
   "pending"`), and when its blob arrives it reads as `blob`, so the entry
   no longer matters. An `unknown-version` diagnostic is never marked.
4. Rollback, the late import, the migration preflight and the legacy
   removal all go through `readHeldRecords` (`store-migration/journal.ts`):
   it adds every shard outside the digest stream whose
   `PartitionShard.pending` is not empty to `partial`, so they refuse on
   any such pending blob, quarantined or not, and still never wait (a
   digest-stream shard is left out of `partial` altogether, as it is of
   `unreadable`: a published digest is no record any of them imports or
   restores). The legacy removal keeps its existing `--force`: it goes
   past a `partial` shard, the pending blob included (a bad line may never
   read again), while a shard that cannot be read at all still refuses
   even with `--force`.
5. The index's `corrupt_lines` counter (`search/schema.ts`) keeps counting
   every bad line; no reader treats it as a gap (the executor confirms by
   search before relying on it, and stops if one does).
6. A partition left on this machine (D7) keeps its ledger entries; they
   are harmless by design: an entry is consulted only when that exact
   shard is read, and matches only the same bytes at the same offset, so
   on a rejoin it releases exactly the line the operator released.

### D5. Doctor findings (Part C, task 3.15)

(new) `src/core/brain/doctor/store-gap-check.ts` exports
`storeGapFindings(store, partial, nowMs, out)`. `readHeldPartitions` in
`store-check.ts` collects the shards its `onUnreadable` reports with
`incomplete: true` (today ignored) and `storeFindings` calls the new
function with them (call-site edits). For each such shard it reads the
shard with `readShard(path, { partitionRoot })` and reports one finding
per gap, path `<partition>/<rel>`:

1. `store-shard-corrupt-line`, error: the offset, the reason, what fails
   closed (capture, settings reads and writes, lane privacy, exact state,
   attestations, the OKF export, migration), and
   `o2b store shard quarantine <partition>/<rel> --offset <n>`. The
   command is named only for a line the verb can hash: the doctor probes
   the line with `probeLineHashAt`, and a `too-long` answer (past
   `QUARANTINE_HASH_CAP_BYTES`, which the verb always refuses as
   `line-too-long`) is reported instead as `store-shard-line-too-long`,
   error, with the same offset and reason and repair at the line's source
   (the shard of the device that wrote it). That code registers no
   command (`doctor-exits.ts` gives the reason), so the finding carries
   no `next_command`. An `unreadable` probe keeps `store-shard-corrupt-line`:
   the shard changed under the doctor, and the verb's own check answers
   `shard-changed`.
2. `store-shard-newer-format`, warning: upgrade Open Second Brain on this
   machine; no quarantine command.
3. `store-shard-blob-pending`, warning while the record (by its clock's
   physical time) is younger than `PENDING_BLOB_QUARANTINE_AGE_MS`, error
   from then on, with the quarantine command once it is allowed and never
   for a `settings` shard. A record whose clock stamp does not parse as a
   time (`pendingRecordWrittenMs` in `shard-quarantine.ts` answers `null`:
   no stamp, or a physical part no date can hold) has no age: the finding
   is an error that says the clock stamp does not parse and offers no
   quarantine by age; the current time is never put in its place.

A shard removed since the partition read (`ENOENT` on the second read) is
skipped: no gap is left. Any other failure of the second read is a
`store-shard-unreadable` error naming the shard and the error code. A
diagnostic other than `corrupt-line` and `unknown-version` (a shard
swapped for a link, an offset past its end) is a `store-shard-unreadable`
error too: that code's next step names no command, since a quarantine
cannot release it.

Below local reach (`StoreSideCheckContext.withholdsPrivate` true, or
`reach` set and not `local`; the context carries both, from `runDoctor`'s
vault pass and from `runStoreSideDoctor`, so `brain_doctor`,
`brain_brief view=operator`, `brain_status` and the repair pass's
`collectDoctorIssues` are covered alike), `storeFindings` removes the
`private` partition from the store it inspects once, before any check
runs (`storeAtReach`). Every store finding is then computed without it:
no unreadable shard, gap or held tail, no record id conflict, clock-ahead
or digest finding, no cross-partition id, loose mode or reserved name of
`private`, and the removal backlog counts only `shared`. Its paths,
offsets, record ids and times are private metadata, so the caller's `ok`,
counts and `trust_verdict` read as if this machine did not hold it. A
lost `private` identity file is still an error (the store is not opened,
so `shared` fails closed too), with a message that does not name the
partition (`lostPartitionFinding`). A store that does not open for any
other reason (a partition's `store.json` that does not parse or carries
no valid store id, partitions of two stores) is still reported as
`store-root-invalid` with the store root, but below local reach with a
generic message instead of the error text, which can name
`private/store.json` or the store ids (`storeOpenFailureDetail`). The write failure counters follow
the same rule, though they are read before the store is: the dual-write
and fail-open status files count every failure, with the last error text
and time, and beside them (`shared_failures`, `shared_last_error`,
`shared_last_failure_at`) only the failures known to concern only
`shared`. A failure is known to concern only `shared` when
`appendStoreRecords` threw it for an operation whose records were all
placed in `shared` (`failedOnlyInShared` in `dual-write.ts`, which looks
at the error and the error it wraps); a failure before placement (device
id, store open, identity check, a builder) or in an operation with a
record in `private` may concern `private`. Below local reach
`store-dual-write-failures` and `store-write-fail-open` report only the
`shared_*` counters, so a failed private write shows no count, time,
error text or path (the error text can name a private shard), and the
skipped dual writes are reported without their count. Local reach and
the CLI doctor are unchanged.

### D6. The operator verb (Part C, task 3.15)

(new) `src/cli/store-shard.ts`, on the model of `src/cli/store-device.ts`:

```
o2b store shard quarantine <partition>/<shard> --offset <n> [--config <file>] [--json]
o2b store shard list [--config <file>] [--json]
o2b store shard release <partition>/<shard> --offset <n> [--config <file>] [--json]
```

Exit 0 for an answer, 1 for a refusal, 2 for a usage error; under
`--json` every refusal and usage error is `{ ok: false, reason, error }`.
Refusal reasons: `no-store` (no partition holds a store identity),
`partition-lost` (`HeldPartitionLostError`: a partition this machine has
held lost its identity file), `store-open-error` (any other
`StoreOpenError`, such as a corrupt identity file),
`store-root-in-vault`, `config`, `not-held`, `unknown-shard`, `no-gap`
(nothing at that offset is a gap), `line-too-long` (the line's hash,
taken before and after it is judged, cannot be taken both times because
the line runs past the hash cap; permanent until the bytes change, so the
refusal gives no advice to retry), `shard-changed` (the two hashes differ,
or one cannot be read, or the shard was removed between the listing and
the read: the shard changed while it was checked; running the command
again checks it once more), `ledger-busy` (another process held the
ledger's device-local lock past the wait budget, `ELOCKED`; transient,
run the command again), `newer-format`, `blob-too-young`,
`settings-blob`, `ledger-unreadable` (the ledger file exists but this
release cannot rewrite it, D4 item 1; it is left as it is),
`blob-clock-unreadable` (a pending record whose clock
stamp does not parse as a time, D5 item 3: it is never quarantined by
age), `own-tail` (the last line of a shard in this device's own folder:
its writer may still be appending; decided from the reader's held tail
too, before `no-gap`, so an unverified last line the reader holds back
answers `own-tail` rather than `no-gap`; another device's held last line
stays `no-gap`, as the reader retries it). The store is inspected read-only
(`inspectStore`); the device id is read without minting
(`readDeviceId`). Answers: `quarantine` `{ ok, status: "quarantined" | "already", partition, shard, offset, kind }`;
`release` `{ ok, status: "released" | "not-quarantined", ... }` (a
release removes the mark; the line is a gap again only if it still is
one, so a `resolved` or `stale` entry reopens nothing);
`list` `{ ok, lines: [{ partition, shard, offset, kind, state: "held" | "resolved" | "stale", quarantined_at }] }`.
Part C adds to the shared files only its own lines (D9).

### D7. Leaving a partition (Part Z, task 3.16)

1. `src/core/store/held-ledger.ts` gains `isHeldPartitionMarked(root, partition): boolean`
   (new) and `forgetHeldPartition(root, partition): boolean` (new: removes
   the marker; `true` when one was there). Both use the existing
   `markerPath(ledgerDir(), root, partition)`, the key function that wrote
   it, so a root spelled as configured finds its own marker on every OS.
   The module docblock says the verb is the one way to take a partition
   off.
2. `src/core/store/seen-shards.ts`: the file-name logic of `ledgerPath`
   moves into (new) `seenLedgerFile(storeRoot, storeId)`, which
   `ledgerPath` calls; (new)
   `forgetSeenPartition(storeRoot, storeId, partition): number` removes the
   partition's entries through `update` and returns how many there were.
   It takes the store id from `shared`, because the left partition has no
   `store.json` any more.
3. `src/core/brain/compiled-digest-path.ts` gains (new)
   `digestCacheRoot(storeId): string`, `join(deviceStateDirFor(storeId), DIGESTS_DIR)`.
4. (new) `src/core/store/partition-leave.ts`: `PartitionLeaveRefusal`
   (`reason: "shared" | "still-held" | "files-left" | "no-store-id" | "clear-failed"`), and
   `leavePartition({ root, partition, force }): LeavePartitionResult` with
   `{ left, partition, cleared: { heldMarker, seenShards, digestCaches } }`,
   in this order: refuse `shared`; refuse while
   `<root>/<partition>/store.json` exists (`still-held`); answer
   `left: false` when the marker is absent (nothing to leave, even with
   files left); refuse a folder that still holds any entry unless `force`
   (`files-left`); read the store id from `shared/store.json`
   (`readStoreId`) BEFORE anything is removed, and refuse `no-store-id`
   when it cannot (the file is missing, or `readStoreId` throws on a
   corrupt one), changing nothing, with a message that says to restore the
   shared partition's identity file first; then remove
   `digestCacheRoot(storeId)`, clear the seen-shard entries
   (`forgetSeenPartition` checks that its write landed, because the
   ledger's `update` never throws), and remove the marker LAST: a failure
   before it refuses `clear-failed` and leaves the machine still holding
   the partition. Leaving
   fails closed: without the store id the seen-shard entries and the
   digest caches, which may hold the partition's text, cannot be found,
   so the verb never reports a leave it could not clear. No lock: a
   writing open re-marks only a partition whose `store.json` is present,
   which the verb refuses, so a concurrent open cannot undo it.
5. (new) `src/cli/store-partition.ts`:
   `o2b store partition leave <partition> [--force] [--config <file>] [--json]`.
   Exit 0 left or nothing to leave, 1 refusal (`shared`, `still-held`,
   `files-left`, `no-store-id`, `clear-failed`, `store-root-in-vault`,
   `config`), 2 usage
   (a partition name not in `STORE_PARTITIONS`, a missing or extra
   argument, an unknown verb). Under `--json` a refusal answers
   `{ ok: false, reason, error }` on stdout and a usage error
   `{ ok: false, reason: "usage", error }` on stdout, the shape
   `src/cli/store-device.ts` already uses; the message also goes to
   stderr as `error: <message>`, followed by the usage text for a usage
   error. The text
   answer names what was cleared, says the search index drops the
   partition's records on its next catch-up, and says that a
   `store.json` that returns by sync or a restore makes the machine hold
   the partition again from its next writing open. JSON:
   `{ ok: true, left, partition, root, cleared: { held_marker, seen_shards, digest_caches } }`.
6. `HeldPartitionLostError` (`store-open.ts`) keeps its text and appends
   `, or run \`o2b store partition leave <p>\` to stop holding it on this machine`
   (one command per lost partition; "them" for two). The doctor finding
   `store-partition-lost` prints that message, so it names the verb with no
   edit of `store-check.ts`.
7. The index: nothing in the verb. After the leave the store opens without
   the partition, `ShardScanner` lists only held partitions, the
   partition's watermarks vanish and `settleOrphans` removes their
   records. A test proves it (tasks).
8. No "partitions left" record (brainstorm, Rejected): shards that come
   back without `store.json` are not held, exactly as on a machine that
   never held the partition, and a `store.json` that comes back is held
   again by the existing rule.

### D8. Raw text of a lane entry (Part Z, task 3.8)

1. (new) `src/core/store/lane-raw.ts` holds `laneTextParts` (moved
   verbatim from `lane-entry-store.ts`, which re-exports it so no importer
   changes) and:
   - `renderLaneText(path, fields, text)`: the store branch of
     `readLaneText` today (`.md`: `formatFrontmatter`; `.json` with empty
     text: `JSON.stringify(fields, null, 2) + "\n"`; else `text`);
   - `rawParsesBack(path, raw, fields, text)`: `laneTextParts(path, raw)`
     gives a body equal to `text` and fields whose `canonicalJson` equals
     that of `fields`;
   - `rawToKeep(path, raw, fields, text)`: `raw` when it is defined,
     differs from `renderLaneText(path, fields, text)` and parses back;
     otherwise `undefined`;
   - `lanePrivacyRow(fields, text, raw?)`: `{ fields, text }`, plus `raw`
     when defined: the one row the write-time privacy judge reads.
   It imports only from `node:*`, `../vault.ts` (`parseFrontmatterText`,
   `formatFrontmatter`), `../integrity/digest.ts` (`canonicalJson`) and
   `../types.ts` (the `FrontmatterMap` type), never `lane-records.ts`,
   `lane-paths.ts`, `lane-entry-store.ts` or `lane-pages.ts` (no import
   cycle).
2. `lane-records.ts`: `laneEntryRecord` input gains `raw?: string`, written
   as `body.raw` after `text` only when defined; `LaneEntryValue` gains
   `readonly raw?: string`; `foldLaneEntries` copies `body.raw` into the
   value when it is a string and ignores it otherwise; `rejection` is
   unchanged, so a record with `raw` folds under the old rules too.
3. `lane-entry-store.ts`: `sameEntry(value, fields, text, raw?)` also
   requires `value.raw === raw`; `isPrivateEntry(vault, fields, text, raw?)`
   judges `lanePrivacyRow(fields, text, raw)`; `entryRecord` gains a last
   parameter `raw?: string` and writes `rawToKeep(path, raw, fields, text)`.
   The dual write already sends a body with a private region anywhere,
   `raw` included, to `private` (`valueCarriesPrivateRegion(record.body)`).
4. `lane-pages.ts`: `readLaneText` returns `value.raw` when it is defined
   and `rawParsesBack(path, value.raw, value.fields, value.text)`, else
   `renderLaneText(path, value.fields, value.text)`. `writeLaneText`
   computes `raw = rawToKeep(path, text, fields, body)` where it computes
   the parts, passes it to `sameEntry`, `isPrivateEntry` and
   `entryRecord`. `moveLanePage` passes `value.raw` when there is no
   rewrite; `moveLaneTree` passes `value.raw`. `writeLanePage` and
   `exact-state.ts` pass none: a structured write replaces an entry that
   had `raw`, since `sameEntry` sees the difference.
5. Privacy at fold: `storedEntryPrivate` judges the entry's partition and
   its fields' visibility markers; a served `raw` parses back to those
   same fields, so its markers are the fields' markers, and references in
   `raw` were judged at write by the same row (item 1).
   The trust boundary, stated: the writer's privacy judge is the only
   judge of `raw`, exactly as it is the only judge of `text`. The fold
   and the readers re-judge neither: a peer that appends records by hand
   can already put any text into `text`, and can put the same into `raw`.
   The read-side guard of item 4 (`rawParsesBack`) does not judge
   privacy; it only stops `raw` from saying something other than the
   entry's own fields and text. Parts of `raw` that the parse drops (a
   frontmatter comment line: `parseFrontmatterText` skips every line that
   starts with `#`) pass that guard, so a hand-appended shared record
   whose `raw` comment names a private page is served as written; the
   spec `lane-entry-fidelity` states this and task 3.4 case 11 pins it.
6. Readers that strip private regions for a caller do it on the string
   `readLaneText` or `readLaneFile` returns, so they strip `raw` as they
   strip `text`; no lane reader strips the fold's `text` itself.
7. A `raw` makes a body larger, so more entries spill into a blob: a
   peer then reads them as pending until the blob syncs, the gap D4
   reports and can release.
8. `FORMAT.md`, lane-entry bullet: the optional `"raw"`, when it is
   written, that a reader serves it only when it parses back and ignores
   it otherwise, that an older reader ignores it, and that it counts for
   privacy and spills into a blob with the body. The format version
   marker stays.
9. Not in the migration (`store-migration/lane-entry-records.ts`,
   `legacy-scan.ts`): a record that gained `raw` would change its sum, and
   the next transition run would re-append every lane entry already
   imported. The rollback export serves `raw` under the reader's rule
   (`exporters.ts` `laneEntryText`): it writes `raw` when it parses back
   to the record's own fields and text, and the rendering otherwise, so
   the byte loss D8 fixes does not come back on rollback.

### D9. Parts, ownership, overlaps, integration

Part Z owns: `src/core/store/held-ledger.ts`, `store-open.ts`,
`seen-shards.ts`, `partition-leave.ts` (new), `lane-raw.ts` (new),
`lane-records.ts`, `lane-entry-store.ts`, `lane-pages.ts`, `FORMAT.md`;
`src/core/brain/compiled-digest-path.ts`; `src/cli/store-partition.ts`
(new); and its tests.

Part C owns: every file of D1 to D6 (`src/mcp/brain/*`, `src/mcp/resources.ts`,
`src/mcp/tools.ts`, the core readers of D2, `src/core/store/reader.ts`,
`shard-quarantine.ts` (new), `store-migration/journal.ts`,
`src/core/brain/doctor/store-check.ts`, `store-gap-check.ts` (new),
`src/cli/store-shard.ts` (new)); and its tests.

Overlaps, each part adding only its own lines at the named place, the
integrator keeping both when they meet:

1. `src/cli/store.ts`: an import, the usage constant joined into `USAGE`,
   one `case` after `case "device"` (Part Z `partition`, Part C `shard`).
2. `src/cli/command-manifest.ts`: one `command(...)` after the `device`
   entry of `store` (Part Z `partition`, Part C `shard`).
3. `docs/cli-reference.md`: one line after `o2b store device list|retire`.
4. `docs/brain-store.md`: Part Z a section "Leaving a partition" at the
   end of "## Setup"; Part C a section "Shards read only in part" before
   "## What the partitions protect, and what they do not".
5. Integrator only: `openclaw/index.js` (it carries `reader.ts`,
   `held-ledger.ts`, `store-open.ts`), `CHANGELOG.md`, the parent
   `tasks.md`. No version bump: this pull request ships no release.

## Risks / Trade-offs

- [A caller of a changed core reader is missed] → the option defaults to
  the old behaviour, so a missed caller stays as leaky as today, never
  breaks; the census names every reader and the surface tests catch the
  known ones.
- [A shared note naming an unreadable page now drops from the remote
  morning brief] → intended: the reference rule every sibling reader
  applies (brainstorm, partner finding).
- [A quarantined pending blob hides a record on this machine for good]
  → only past seven days, never in `settings`, reversible with `release`,
  and the record returns by itself when the blob arrives.
- [The ledger is device-local, so every machine releases its own line]
  → by design: a synced verdict would drop a line another machine reads.
- [Stores keep their copy of `FORMAT.md` without the `raw` paragraph,
  because the version marker does not move] → the copy only describes;
  readers do not parse it.
- [Leaving with `--force` while shards remain] → the shards are ignored
  on this machine as on one that never held the partition; the operator
  asked for it.

## Migration Plan

None on disk: the ledger and the markers are device-local, `raw` is an
optional field. Rollback of the release leaves `raw` ignored and the
quarantine ledger unread (a shard gap fails closed again).
