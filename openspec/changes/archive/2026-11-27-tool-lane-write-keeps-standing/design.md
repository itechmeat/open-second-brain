# Design

## Context

See `proposal.md` (Why) and `brainstorm.md` (the principle check). The
call chains, as read in the tree of release 2.0.4 (re-verified for the
2.0.5 release; items 9, 10, 12 and 14 changed with 2.0.4):

1. Authority of a write. `writeLaneText` (`src/core/store/lane-pages.ts`)
   builds its store record with `entryRecord`
   (`src/core/store/lane-entry-store.ts`), which stamps
   `authority ?? authorityFor(lane)`; `authorityFor` returns `human` for
   the `standing-rule` lane and `authorityFromOrigin()`
   (`src/core/store/dual-write.ts`) otherwise: `human` when the process
   claimed `cli` (`src/cli/main.ts`, `originChannelForArgv`: every verb
   but `mcp` and the imports, so `o2b tool-call` and hooks too), `agent`
   for `mcp-tool` (`src/mcp/stdio.ts`, `src/mcp/http.ts`) and for an
   unclaimed process.
2. The register. `RegisterSet.offer` (`src/core/store/fold.ts`) lets a
   later offer win only when `authorityRank(next) >= authorityRank(current)`
   (`beats`), order `human > agent > model`
   (`src/core/store/constants.ts`); pinned by
   `tests/core/store/lane-records.test.ts`. A tombstone is an offer of the
   same register: a removal holds its key at its own authority.
3. Obligation completion. MCP `brain_obligation` `done`
   (`src/mcp/brain/calendar-tools.ts`) → `completeObligation`
   (`src/core/brain/obligations.ts`): lane lock (`acquireLaneLock`), reads
   the page (`targetPage` → `parsePage` → `readLaneText`), computes the
   completed page, `writeLaneText(vault, prior.path, render(page))`,
   returns the computed page. The `agent` record loses to the `human`
   one the CLI's `addObligation` wrote.
4. Pledge fulfilment. MCP `brain_pledge` `fulfill`
   (`src/mcp/brain/pledge-tools.ts`) → `fulfillPledge`
   (`src/core/brain/pledges.ts`): lane lock, `parsePage`, refuses when
   already fulfilled, `writeLaneText(... rewritePledgeFrontmatter(...))`.
   Lost the same way; `prior.fulfilled` stays `null`, so a retry is not
   refused.
5. Pledge intake re-anchor. MCP `brain_intake_pledges` → `intakePledges`
   (`src/core/brain/pledge-intake.ts`) → `rewritePledgeCounterparties`:
   lane lock, `writeLaneText` of the rewritten `promised_to`; the result
   lists the pledge in `reanchored`. Lost the same way.
6. Intention set. MCP `brain_intention` `set`
   (`src/mcp/brain/workspace-tools.ts`) → `setIntention`
   (`src/core/brain/intentions.ts`): reads the chain (`parseChain`), no
   lane lock, `writeLaneText` of the next version; lost over a chain
   `o2b brain intention set` wrote.
7. Handoff note. MCP `brain_hygiene` `refresh`
   (`src/mcp/brain/hygiene-tools.ts`) → `executeRecompile`
   (`src/core/brain/recompile.ts`) → `writeHandoffNote`
   (`src/core/brain/handoff.ts`) → `writeLanePage(..., { overwrite: true })`
   over a note the SessionEnd hook or `o2b brain handoff` wrote; listed
   in `rederived`. A blind overwrite (built from the transcript), lost
   the same way.
8. Entity upsert. MCP `brain_entity` (`src/mcp/brain/entity-tools.ts`) →
   `upsertEntity` (`src/core/brain/entities/registry.ts`): resolves the
   target from `buildEntityIndex`, takes its aliases, status and
   confidence from that index read, reads the page (`parseLanePage`) only
   for the extra fields and the body, then `writeEntityFile` →
   `writeLanePage(..., { overwrite: true })` over a page
   `o2b brain entity upsert` wrote. The write is lost the same way, but
   the answer is not the computed state: `upsertEntity` re-reads the page
   (`parseEntityFile`) and answers the old entity with `created: false`,
   so the call reports no error while the alias it was asked to add is
   missing from both the answer and the next read. `relateEntities` and
   `archiveEntity` overwrite the same way, with the same index-first
   read.
9. Removal and move. On a store-held path `removeLanePage`
   (`src/core/store/lane-pages.ts`) checks reach
   (`assertLaneRemovalAtReach`, `withheldPrivateKey`), then builds its
   records inside `storeWrite` with `removalRecordsAtReach`
   (`src/core/store/lane-reach-guard.ts`), which reads one fold of every
   partition and calls `laneRemovalRecords(vault, fold, paths)`
   (`src/core/store/lane-dual-moves.ts`). `moveLanePage` builds inside
   `storeWrite` from `moveSourceAtReach(vault, wholeLaneStoreFold(), from, to)`
   (the source's value and partition from that fold); `moveLaneTree` and
   `removeLaneTree` list members with `treeMembersAtReach` and build from
   one fold (`laneMoveRecords`, `laneRemovalRecords`). The tombstone is
   built with `tombstoneOf` (`lane-entry-store.ts`), stamped
   `authorityFor(value.lane)`, and the moved entry with `entryRecord` at
   the writer's own authority. The change `lane-reach-residuals`
   (packages 1 to 5, done before this change) makes these builders judge
   reach and privacy again from that fold and refuse instead of dropping
   a member. An agent's tombstone loses to a `human`
   entry: MCP `brain_obligation` `remove` → `removeObligation` →
   `moveLanePage` leaves the obligation active and also archived, and the
   answer names the archive path. MCP `brain_intention` `move` and
   `brain_pledge` `remove` follow the same path.
10. Create over a removal. `o2b brain obligation add`, then
    `o2b brain obligation remove` (`removeObligation` → `moveLanePage`:
    a `human` tombstone holds the active key), then MCP
    `brain_obligation` `add` of the same title: `addObligation` finds the
    slot free (`lanePageExists` is false for a removed key), the create
    lock sees no entry (`withCreateLock`: `assertLaneWriteAtReach`, then
    `storeEntryRead(...).value` is null), and the
    `agent` record the create appends loses to the `human` tombstone. The
    tool answers the page; the next `show` finds nothing. An unswitched
    machine moved the file, so the add lands there; the product's own
    refusal says "remove it first to recreate". `brain_pledge` `add`
    after a pledge `remove` is the same. `upsertEntity` of an entity
    whose page a person's command removed already fails today ("entity
    file unreadable after write"), visibly. The lane fold cannot name the
    holder of a removed key: `laneStoreFold`
    (`src/core/store/lane-fold-cache.ts`) skips a removed key before it
    records its authority (it records only whether the removal is held
    in `private`, `privateRemovals`), so `storeEntryRead` answers
    `authority: null` for it. `assertLaneWriteAtReach` judges a key by
    `liveInPrivate` only, so in 2.0.4 a remote create over a removal held
    in `private` passes the guard; `lane-reach-residuals` package 5 makes
    the guard refuse it below local reach, before this change runs.
11. The precedent. `writeLanePage` takes `authority` "for a rewrite that
    keeps the standing of the record it replaces";
    `privacy-marker-restamp.ts` passes `readLaneEntrySnapshot(...).authority`
    after checking `snapshot.whole` and `snapshot.unchanged()`, in the
    caller, before it calls `writeLanePage`.
12. Where a throw lands. `storeWrite` (`src/core/store/store-write.ts`)
    runs the record builder inside its `try` and turns anything thrown
    there into a `StoreWriteError` with reason `store-error` and the
    remedy "Run `o2b brain doctor` for the store's state, then retry";
    `routeWrite` rewraps the same way. A check that must reach the caller
    as its own error runs before the store write, not inside the builder.
    The one exception is the reach refusal: since `lane-reach-residuals`
    package 5 the lane primitives call `storeWriteAtReach`
    (`lane-reach-guard.ts`), which rethrows a `LaneEntryWithheldError`
    raised inside a builder as itself.
13. The clock. Every shard read raises the process's clock floor, and the
    next tick takes the receive rule over it (`clock-store.ts`), so a
    record written after a read orders after every record read, except
    one stamped more than `HLC_MAX_DRIFT_MS` ahead.
14. The other changes. Release 2.0.4 (`lane-private-partition-reach`,
    archived) added `src/core/store/lane-reach-guard.ts` and changed the
    files this change edits: `lane-pages.ts` calls the reach guard at
    every write primitive (`assertLaneWriteAtReach` first in
    `writeLaneText` and in `writeLanePage` with `overwrite`, inside
    `withCreateLock` for a create, `assertLaneRemovalAtReach` for a
    removal or a move); `lane-entry-store.ts` gained `storedEntryPrivate`
    and `laneEntryInPrivate`; `lane-fold-cache.ts` gained
    `wholeLaneStoreFold`, `laneFoldIncomplete`, `privateKeys` and
    `privateRemovals`; `obligations.ts` and `pledges.ts` decide their
    identity checks on the fold of every partition
    (`assertCreateMatchAtReach`). The change `lane-reach-residuals` ships
    with this one as 2.0.5; its packages 1 to 5 run before this change
    (package 5 adds `storeWriteAtReach` and the refusal of a key whose
    winner is a private removal), and none of its later packages uses a
    name of this change. Both add requirements to `lane-entry-fidelity`.

## Goals / Non-Goals

**Goals:**

1. One rule in the lane store layer that makes every sequential lane
   write, removal, move and create over a removal read back on a
   switched machine.
2. A visible refusal for a read-modify-write whose version changed.
3. A read-back check so no lane write on a switched machine can answer
   success while the store keeps another version.

**Non-Goals:**

1. The authority a process claims (`authorityFromOrigin`): unchanged.
2. Any other fold (preferences, topics, settings, signals, pinned
   context): unchanged, and their writers' refusals stay.
3. `src/core/brain/exact-state.ts`: it writes `laneEntryRecord` directly
   with a hard-coded `agent` authority, so an operator's exact-state
   write is stored as an agent's. Every exact-state record is `agent`,
   so none is lost to another; the mislabel is a separate defect and a
   follow-up.
4. The duplicate date an obligation retry on one date adds to
   `completions`: the same on both machine kinds, left as it is.
5. A version check for the lane writers outside the D2 list (see
   `proposal.md`, Scope): they get D1 and D3 only.

## Decisions

### D1. The kept standing (one rule, in the record builders)

The holder of a key is the record that wins it in the lane fold: a live
entry's record or a removal's tombstone. Two changes make the holder's
authority readable:

1. `laneStoreFold` (`src/core/store/lane-fold-cache.ts`) records in
   `authorities` the winning record's authority for every key the fold
   holds a record for, live or removed (today the removed keys are
   skipped before the authority is recorded). The doc comment of
   `authorities` says so.
2. `storeEntryRead` (`lane-entry-store.ts`) returns, besides `value`,
   `whole` and `authority`, a new `removed: boolean` (a tombstone holds
   the key). `authority` is the holder's authority, live or removed, and
   `null` only when no record holds the key. `readLaneEntrySnapshot` is
   unchanged: it still returns `null` when no live entry is there, so the
   restamp sees what it sees today.

`entryRecord` and `tombstoneOf` (`lane-entry-store.ts`) take a new
optional argument, the authority of the key's holder
(`replacedAuthority`). The record's authority is
`stronger(own, replacedAuthority)`, where `own` is the explicit
`authority` argument when given, else `authorityFor(lane)`, and
`stronger` picks the lower index in `AUTHORITIES`
(`src/core/store/constants.ts`; `strongerAuthority` in
`lane-standing.ts`). When the result differs from `own`, the body gets
`acted_by: own` (D4).

The builders' callers pass the holder's authority from the SAME fold
read that gave the replaced value. Inside the `store:` builder, in both
modes (the store-only write and the dual-write mirror of an unswitched
machine, which run the same builder):

1. `writeLaneText` and `writeLanePage`, every kind of write (an
   overwrite, an exclusive create, an `overwrite: false` create): read
   `storeEntryRead(vault, path)` inside the builder and pass its
   `authority` whenever it is not null. A create over a removed key so
   takes the removal's standing and wins by clock, as the create on an
   unswitched machine lands in the folder the removal emptied.
   `writeLanePage`'s `authority` option becomes the writer's own
   authority (the restamp passes the snapshot's), still raised to the
   holder's.
2. `removeLanePage`: its tombstone is built by `laneRemovalRecords`
   from the fold `removalRecordsAtReach` reads inside the builder, so
   item 4 gives it the holder's authority; the `storeEntry` read before
   `storeWrite` only decides whether there is anything to remove.
3. `moveLanePage`: from the fold `moveSourceAtReach` reads inside the
   builder (`fold.authorities.get(key)`), the source's tombstone takes the
   source holder's authority; the moved entry takes `stronger(source holder, destination
   holder)`, the destination holder being a live entry or a removal at
   the destination key; the `replacedShared` tombstone of a destination
   takes the destination holder's.
4. `laneMoveRecords`, `destinationRecords` and `laneRemovalRecords`
   (`lane-dual-moves.ts`): from the fold they already take
   (`fold.authorities.get(key)`): the source's tombstone the source's,
   the moved record `stronger(source, destination)`, a replaced
   destination's tombstone (the `moved === null` case and the raise to
   `private`) the destination's.
5. `replacedShared` (`lane-entry-store.ts`): its `onlyIfApart`
   tombstone takes the replaced shared entry's authority from the same
   `storeEntryRead`. Without it a raise to `private` over a `human`
   shared entry leaves a device that holds only `shared` reading the old
   value: its `agent` tombstone loses there.

The mirror's winner then matches the file of an unswitched machine;
nothing a user of that machine sees changes.

Alternative rejected: computing the standing in the fold (a lane entry
resolved by clock alone). It would let a version written apart on
another device beat a human version, which the register exists to
arbitrate.

### D2. The version a read-modify-write read (`replaces`)

`lane-pages.ts` is already past 700 lines, so the new logic of D2 and D3
lives in a new module `src/core/store/lane-standing.ts` (the base read,
the base check, the read-back check, the two errors, `strongerAuthority`)
and `lane-pages.ts` gets call-site edits only (an option, a call, an
import, a re-export). The same holds for `obligations.ts`, `pledges.ts`
and `entities/registry.ts`, all past 700 lines: call-site edits only.

A new export of `lane-standing.ts`, re-exported from `lane-pages.ts`:

```ts
export function readLaneBase(vault: string, path: string): LaneEntrySnapshot | null;
```

It returns `readLaneEntrySnapshot(vault, path)` on a store-held path and
`null` otherwise. `writeLaneText` and `writeLanePage` gain the option
`replaces?: LaneEntrySnapshot | null`.

Where the check runs: in `writeLaneText` and `writeLanePage` themselves,
on a store-held path with a non-null `replaces`, right after the reach
guard (`assertLaneWriteAtReach`, which 2.0.4 put first in both functions)
and before the same-entry shortcut, `withCreateLock` and
`routeLaneWrite`, never inside the `store:` builder (D7). A throw from the
builder reaches the caller as a `StoreWriteError` `store-error` with the
doctor remedy (Context 12); a throw before the store write reaches it as
itself, with its own remedy. The restamp checks in the same place, in
its caller before the write (Context 11). The check
(`checkLaneBase(vault, path, replaces)` in `lane-standing.ts`):

1. `replaces.whole` false → throw `LaneEntryChangedError` with reason
   `incomplete`.
2. `replaces.unchanged()` false → read the entry once more
   (`storeEntryRead`): when that read is not whole, reason `incomplete`
   (a gap that opened after the base is a gap, not a change); otherwise
   reason `changed`.
3. Otherwise the write goes on, and its record keeps the standing as in
   D1.

The messages: `incomplete`: "the lane store could not be read in full;
nothing was written; run `o2b brain doctor` to see what it is missing,
then run this again"; `changed`: "<Brain-relative path> changed since it
was read; nothing was written; read it again".

`LaneEntryChangedError` extends `Error`, carries `path` (Brain-relative)
and `reason`, and is defined in `lane-standing.ts`, re-exported from
`lane-pages.ts`. A `null` `replaces` (no entry, or an unswitched
machine) changes nothing.

Between the check and the append the caller still holds its lane lock,
so no writer of this device can come in; a version of another device
read into the store inside that window is a competing version (D6 item
3), and D3 reports the write if that version holds the entry.

Each read-modify-write caller takes the base under its lane lock and
BEFORE its own read, then passes it: a version that arrives after the
base is caught by the check, one that arrived before is what the caller
read too. Callers:

1. `completeObligation`: `const base = readLaneBase(vault, lockPath)`
   right after `acquireLaneLock`; pass `{ replaces: base }`.
2. `fulfillPledge`: right after `acquireLaneLock(vault, path)`.
3. `rewritePledgeCounterparties`: right after its `acquireLaneLock`.
4. `setIntention`: wrap the read and the write in
   `withLaneLock(vault, path, ...)` (new: today it holds no lock), take
   the base first.
5. `upsertEntity` (update arm), `relateEntities` and `archiveEntity`
   (`registry.ts`, the three calls of `writeEntityFile` with
   `overwrite: true`): the index (`buildEntityIndex`) is still read first
   to resolve the target and check names and alias claims; then, inside
   `withLaneLock` on the target's path (new: the registry holds no lane
   lock today), the base is taken, the entity is read again
   (`parseEntityFile(path, vault)`) and the written fields (aliases,
   status, confidence, source agent, name, creation time) come from that
   read, not from the index entry; the extra fields and the body come
   from `parseLanePage`, as today, after the base. A re-read that finds
   no entity, or one with another `entity_id`, refuses with
   `LaneEntryChangedError` `changed`. The base reaches `writeLanePage`
   through a new `replaces` field of `writeEntityFile`'s options. The
   lock, the base, the re-read and the refusal live in a new sibling
   module `src/core/brain/entities/locked-write.ts` (one function the
   three overwrites call with the field change each makes), so
   `registry.ts`, past 700 lines, gets call-site edits only. A
   version that lands between the index read and the lock is so in the
   re-read and kept (in every mode: on a machine that has not switched
   the re-read under the lock keeps another writer's alias too, the one
   change there; lead ruling during implementation, `review.md`); one that lands after the base is refused by the
   check.

The handoff note (`writeHandoffNote`) is a blind overwrite: it passes no
base and is covered by D1 and D3.

### D3. The read-back check

`writeLaneText`, `writeLanePage`, `removeLanePage`, `moveLanePage`,
`moveLaneTree` and `removeLaneTree`, on a store-held path only, read the
entry back after `storeWrite` returns (`storeEntryRead`, a fresh fold),
outside its `try`, so the error reaches the caller as itself:

1. A write: the fold's value must satisfy `sameEntry(value, fields, text, raw)`
   with what the record carried.
2. A removal or the source of a move: the fold must hold no entry there;
   the destination of a move: the moved value.

Otherwise throw `LaneWriteNotAppliedError` (defined in
`lane-standing.ts`, re-exported from `lane-pages.ts`), carrying `path`,
`heldBy` (the holder's authority from the same read) and `removed`
(whether the holder is a removal): "<path> was not changed: the store
keeps a version written at authority <heldBy>", or, when a removal holds
the key, "<path> was not changed: the store keeps a removal written at
authority <heldBy>". A `writeLanePage` that wrote nothing (unchanged
entry) skips the check.

With D1 the check fires on a correct write only for a competing record
stamped more than `HLC_MAX_DRIFT_MS` ahead, for another device's later
version read into the store between the append and the read-back (a
retry then computes from that version), or for a defect; it is the
guarantee that no answer reports a state the next read does not show.
What the caller sees: the MCP handlers turn a thrown `Error` into an
error answer (`calendar-tools.ts`, `pledge-tools.ts`, `entity-tools.ts`),
the pledge intake rethrows, the recompile executor lists the failure in
its result's `errors`, CLI verbs exit 1; no handler changes.

### D4. Who acted (`acted_by`)

`laneEntryRecord` and `laneEntryRemoveRecord` (`lane-records.ts`) take
an optional `actedBy?: Authority` and write `acted_by` into the body only
when it is given. The fold ignores the field: `foldLaneEntries` and its
`rejection` check (`lane-records.ts`) read only `lane`, `entry`,
`fields`, `text`, `raw` and the authority, so a record with `acted_by`
folds as before under this release and the previous one. `FORMAT.md`
documents it on both kinds. The envelope's `agent` and `device` still
name the actor; the only readers of a lane record's authority besides
the fold (the restamp and `lane-id-repair.ts`) both take the higher one,
so nothing that should show the actor shows the standing.

### D5. Sites

| # | Site | Decision | Why | Proof (test that fails today) |
|---|---|---|---|---|
| 1 | Obligation completion | in scope | silent loss, chain 3 | `tests/core/brain/obligations-completion-authority.test.ts` cases 1, 2 |
| 2 | Pledge fulfilment | in scope | silent loss, chain 4 | `tests/core/brain/pledges-fulfil-authority.test.ts` cases 1, 2 |
| 3 | Pledge intake re-anchor | in scope | silent loss, chain 5 | new `tests/core/brain/pledge-intake-reanchor-authority.test.ts` |
| 4 | Intention set | in scope | silent loss, chain 6 | new `tests/core/brain/intentions-set-authority.test.ts` |
| 5 | Handoff note re-derived | in scope | silent loss, chain 7 (blind overwrite) | new `tests/core/brain/handoff-rederive-authority.test.ts` |
| 6 | Entity upsert | in scope | lost write answered as an unchanged entity, chain 8 | new `tests/core/brain/entities/entity-upsert-authority.test.ts` |
| 7 | Remove and move tombstones | in scope | silent loss, chain 9 | new `tests/core/brain/lane-remove-authority.test.ts` (obligation remove, intention move) |
| 8 | Create over a removal | in scope | silent loss, chain 10 | new `tests/core/brain/lane-recreate-authority.test.ts` (obligation add, pledge add) |
| 9 | Exact state | out of scope | not a loss: every record is `agent`; the mislabel of an operator's write is a different defect | follow-up |
| 10 | Standing-rule lane | unaffected | always `human` | existing tests |
| 11 | Unswitched machine | unchanged, but for the entity re-read | the file is the truth; the entity overwrites build from the entity read again under its lock in every mode, so an upsert over a stale index keeps the other writer's alias there too | the two control cases of each existing file; the unswitched case of `tests/core/brain/entities/entity-upsert-lock.test.ts` |

The sites 3 to 8 are reached by the same rule (D1); each gets its own
failing test so a regression in one call path shows.

### D6. Concurrency and locks

1. Two writers on one device: every read-modify-write in D2 runs under
   the entry's lane lock (`acquireLaneLock` or `withLaneLock`, a
   device-local lock on a store-only machine); the store write itself is
   serialised by the store's append lock. `setIntention` (on a
   store-held page, risk 6) and the three entity overwrites gain their
   lock here. Lock order, unchanged: the
   lane lock, then the create lock (a salted key), then the store lock,
   never the reverse; no caller of the newly locked writers already
   holds a lane lock, and no session-start hook reaches them.
2. Another device's version arrives between the base and the check
   (read into the fold by any shard read): the check fails, the write is
   refused with `LaneEntryChangedError` `changed`, nothing is appended,
   the answer says so; the next read shows that version.
3. Another device's version written apart, read into the store after
   the check: a competing version. The register arbitrates by authority,
   then clock. A `human` version beats an `agent`-standing record. Two
   `human` versions (a person's edit and an agent's write that kept a
   human standing) are decided by the clock: the later wins, whichever
   device wrote it. This is the arbitration the authority order exists
   for; the earlier answer was true for every read made before the
   version arrived. Risk 5 states what this leaves.
4. A blind overwrite (handoff) and a removal read the replaced entry
   inside the store write builder (a removal through
   `removalRecordsAtReach`); both read before `appendStoreRecords` takes
   the shard lock. A record another
   process of this device appends inside that window either is replaced
   by ours, as a later sequential write replaces a file on an unswitched
   machine, or holds the entry, and then D3 reports our write. No write
   is lost without an error.
5. The kept standing never weakens a record (`stronger`), so an
   operator's command over an agent's entry is still `human`.

### D7. Reach before the base

Below local reach (`privateWithheld()`), a holder in `private` is never
named. The order in `writeLaneText` and `writeLanePage` is the reach
guard first, then the base check. With `lane-reach-residuals` package 5
the guard refuses a key whose winning record is held in `private`, a
live entry or a removal, and any lane write while the fold may miss a
record, with the fixed answer (`LaneEntryWithheldError`, "this entry
cannot be written at this reach") before any store write and before
`checkLaneBase` can say `changed` or `incomplete`; so a create over a
removal held in `private` never reaches the store, and the kept standing
of D1 never lets it win over that removal. What the guard cannot see is
a raise between the guard and a later read: the base check (task 3.4)
and the read-back (task 4.2, where the read-back is built) therefore
judge the fold they read, and below local reach answer
`LaneEntryWithheldError` instead of `LaneEntryChangedError` or
`LaneWriteNotAppliedError` whenever the winning record of the key, a
live entry or a removal, is held in `private` there
(`winnerHeldInPrivate`) or that fold may miss a record
(`assertHolderReadableAtReach`). At local reach nothing changes. A
completion or a fulfilment whose entry the caller's view does not hold
(a private winner, or a fold that may miss a record) never reaches the
lane write: it answers as for an absent entry, the 2.0.4 rule, which
this change keeps; the fixed answer belongs to the write paths that
reach the reach guard. The
capability spec of 2.0.4 already states the answer's side of this rule
(requirement "An error below local reach names nothing the caller may
not read", scenario "A write reported as not applied names no private
holder"); this change's reach requirement states the write paths it
covers, on purpose, so both are kept. Rejected: running the base check
first (its `changed` answer would tell a remote caller that a private
entry changed).

## Risks / Trade-offs

1. [An agent's sequential rewrite, removal or create can now replace a
   human-written lane entry, or a person's removal, on a switched
   machine] → that is the unswitched behaviour the lane layer promises;
   preferences, topics and settings, whose human protection is a stated
   purpose, are untouched.
2. [D2 refuses on any gap in the lane fold, not only one in this entry]
   → `whole` counts every unreadable `events` shard and every pending
   blob, shared ones included (stricter than `laneFoldIncomplete`). A
   machine that holds only `shared` right after the migration, whose
   blob-lane records wait in `shared` for their blobs, refuses every
   completion, fulfilment, re-anchor, intention set and entity write
   until the gap closes, which an agent cannot make happen. The error
   says why and names `o2b brain doctor`, which lists the unreadable
   shards and pending blobs and their remedies; the restamp already
   refuses the same way. Accepted.
3. [The read-back check costs one fold read per lane write] → the lane
   fold has no tails: after an append the next read rebuilds it from
   every `events` shard. The read-back's fold is read anew and left out
   of the cache (a stored fold is not rebuilt for a blob that goes after
   it was read), so the next writer's read rebuilds again: measured on a
   store of 300 lane entries, one store-held lane write builds the whole
   fold twice where it built it once before (603 records folded, 301
   before), and twenty writes 40 times where 20 before (12480 records,
   6230 before): twice, and linear in the batch
   (`tests/mcp/lane-standing-write-cost.test.ts` keeps that bound).
   Accepted (lead ruling during implementation, `review.md`).
4. [`acted_by` is a format addition] → optional, ignored by readers that
   do not know it, no format version change, like `raw`.
5. [What the authority order still protects for lane entries] → after
   D1, on one device it protects no lane entry against a sequential
   rewrite; across two devices that have not synced it protects only
   entries whose standing is `agent`. A person's edit on device B,
   stamped earlier than an agent's write on device A that kept a human
   standing, syncs in and loses: two `human` records, the clock decides,
   and neither D2 nor D3 fires, because B's record was in neither fold
   when A wrote. Accepted as parity with a machine that has not
   switched, where the same two edits meet as a sync conflict of one
   file. The principle check holds: the order's stated purposes
   (`src/core/store/FORMAT.md`, "Order and folds") name no lane entry;
   lane entries imported by the migration are `agent` unless the page
   records a human decision (`src/core/store-migration/lane-entry-records.ts`),
   so `human` lane records come from `o2b` writes after the switch,
   hooks included.
6. [New lane locks for intentions and entities] → an intention set takes
   the page's lane lock only where the page is a store entry; on an
   unswitched machine it writes as before, without it (review of the
   second batch, finding 3). So two concurrent sets of one intention on a
   machine that has not switched can still lose one of the two versions,
   as before this change; the base check and the lock apply to
   store-held pages. The entity overwrites take it in every mode,
   the stated exception: on an unswitched machine `withLaneLock` now
   leaves a `.lock` file beside the entity page while it writes (as
   obligations already do), and a crash in the middle leaves one with no
   stale window (`src/core/brain/sync-lockfile.ts`): every later write
   of that entity answers `ELOCKED` until the operator removes it after
   `o2b brain doctor` reports it. `withLaneLock` has no wait-budget
   option; the default store lock budget applies.
7. [Lane writers outside the D2 list get no version check] → see
   `proposal.md`, Scope.
8. [Alias claims of an upsert are checked against the index read before
   the lock] → a claim another entity makes in between is not refused;
   unchanged from today, and a cross-entity question this change does
   not touch.
9. [A kept human standing against a device behind in time] → a tool's
   write that kept a human standing can win over a later human edit made
   on a device whose clock is behind and that had not synced it. The
   read-back and the visible refusal do not cover that device.

## Migration Plan

None: records already written keep their authority; the rule applies to
new writes. The fold's `authorities` map is built in memory on every
read, so recording removed keys needs no rebuild of anything stored.
Rollback is the previous release; records with `acted_by` fold the same
under it.
