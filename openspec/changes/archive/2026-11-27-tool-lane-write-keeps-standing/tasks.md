# Tasks: a tool's lane write over a human-written entry is kept

First read `CLAUDE.md` and `openspec/project.md`, then this change folder:
`proposal.md`, `design.md`, the spec delta
`specs/lane-entry-fidelity/spec.md`; `brainstorm.md` says why the design
is what it is, `review.md` what the independent review changed. Work in
order, one section at a time. Before a section, read the design decision
and the spec requirement it names. Tick each box (`- [x]`) as soon as it
is done, so an interrupted run resumes from the first open box. Partial
edits from an earlier attempt may already be in the tree: review them,
keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code. Change nothing this list does not ask for.
When the code does not match what `design.md` or this list says (a name,
a signature, a test that should fail and passes, or one that should pass
and fails for a reason this list does not name), stop at that task,
write what you found into your report, and end your run.

This change ships in release 2.0.5, in one pull request with the change
`lane-reach-residuals`, on top of release 2.0.4 (the change
`lane-private-partition-reach`, archived; its code is in the tree). The
order of work across the two changes is in
`openspec/changes/lane-reach-residuals/tasks.md`, "Order across the two
changes": its packages 1 to 5 first, then sections 0 to 4 of this list,
then its packages 6 and 8 to 20 (its package 7 is withdrawn), then one
release. Its package 5 already refuses, below local reach, a write at a
key whose winning record is a removal held in `private`; this list
builds on that and does not repeat it. Do not edit, move or delete
the folder of `lane-reach-residuals` or its tests, do not undo its edits
in a file both changes touch, and do not count its files as yours.

## Environment and rules

1. Work only in this checkout. In every shell, before any `bun` command:

   ```sh
   export PATH="$HOME/.bun/bin:$PATH"
   export TMPDIR="$HOME/.cache/osb-lane-standing-tmp"
   mkdir -p "$TMPDIR"
   ```

   Delete that folder when you are done.
2. Never read or write the real `~/.config/open-second-brain`, any real
   vault, or the real `~/.local/state/open-second-brain`. Tests use the
   fixtures named below, which make temp directories and remove them.
3. Never stop a process you did not start. Do not commit, push or open a
   pull request. Do not start subagents.
4. English only in code, comments, docs and tests; no exclamation marks;
   the product is written "Open Second Brain" in full. No machine paths,
   host names or account names in the repository.
5. During a section run only the test files that section names:
   `bun test <file> [<file> ...] --timeout 30000` (add `-t "<name>"` for
   one case). The whole suite runs once, in section 6.
6. Do not edit `tests/core/brain/obligations-completion-authority.test.ts`
   or `tests/core/brain/pledges-fulfil-authority.test.ts`: they are the
   reproduction and must pass unchanged.
7. Files past 700 lines (`src/core/store/lane-pages.ts`,
   `src/core/brain/obligations.ts`, `src/core/brain/pledges.ts`,
   `src/core/brain/entities/registry.ts`, and any other file task 0.1
   finds past 700) get call-site edits only: an option, a call, an
   import, a re-export. Logic goes into `src/core/store/lane-standing.ts`
   (new), and the lock, base and re-read of the three entity overwrites
   into `src/core/brain/entities/locked-write.ts` (new). No other file
   may cross 700 lines. In `lane-pages.ts` (761 lines) every addition of
   tasks 2.2, 3.2 and 4.2 (the `replaces` option, the base-check call,
   the read-back calls, the authority arguments) stays a single call:
   the read-back of `moveLaneTree` and `removeLaneTree` over their
   members is one call into `lane-standing.ts`, which holds the loop,
   never a loop in `lane-pages.ts`.
8. Files you may edit: `src/core/store/lane-standing.ts` (new),
   `src/core/brain/entities/locked-write.ts` (new),
   `src/core/store/lane-pages.ts`, `src/core/store/lane-entry-store.ts`,
   `src/core/store/lane-fold-cache.ts`, `src/core/store/lane-records.ts`,
   `src/core/store/lane-dual-moves.ts`, `src/core/brain/obligations.ts`,
   `src/core/brain/pledges.ts`, `src/core/brain/pledge-intake.ts`,
   `src/core/brain/intentions.ts`, `src/core/brain/entities/registry.ts`,
   `src/core/store/FORMAT.md`, `docs/brain-store.md`, `CHANGELOG.md`,
   `package.json` and the files `bun run scripts/sync-version.ts`
   rewrites, `openclaw/index.js` (only by its build command), and the new
   test files this list names. Do not touch `src/core/store/fold.ts`,
   `src/core/store/store-write.ts`, `src/core/store/dual-write.ts`,
   `src/core/origin-channel.ts`, `src/core/brain/exact-state.ts`,
   `src/core/store/lane-reach-guard.ts` (import from it, never edit it),
   anything under `src/mcp/` or `src/cli/`.
9. New tests reuse the fixtures of the reproduction files:
   `makeStoreEnv` (`tests/core/store/fixtures/store-env.ts`),
   `switchDevice` (`tests/core/brain/store-only/fixtures.ts`), `runCli`
   (`tests/helpers/run-cli.ts`) for the operator's `o2b` process,
   `buildToolTable` and `findTool` (`src/mcp/tools.ts`) for the agent's
   tool call, `setOriginChannel(ORIGIN_CHANNEL.mcpTool)` before it, and a
   `switchedMachine` helper written like the one in
   `tests/core/brain/obligations-completion-authority.test.ts`. Each new
   file has one defect case per behaviour and one control on a machine
   that has not switched (`makeStoreEnv` alone, legacy `Brain/` tree).
10. Two facts about the locks this change adds (design D6 item 1, Risk
    6), so a failure that shows them is not mistaken for a defect of
    yours: on a machine that has not switched, `withLaneLock` now leaves
    a `.lock` file beside an intention or entity page while it writes,
    as obligations already do, and a run killed in the middle leaves one
    behind with no stale window (`src/core/brain/sync-lockfile.ts`), so
    the next write of that scope or entity answers `ELOCKED` until it is
    removed; `withLaneLock` has no wait-budget option. A test that kills
    a writer must remove its lock file in teardown.

## 0. Preconditions

- [x] 0.1 Confirm the tree. `package.json` `version` is `2.0.4` (the
  release bump to `2.0.5` is the last package of `lane-reach-residuals`).
  `openspec/changes/archive/` holds `2026-11-26-lane-private-partition-reach`,
  and `openspec/specs/lane-entry-fidelity/spec.md` carries its
  requirements (`grep -c "^### Requirement:"` gives 21; note the count).
  `git log --oneline` shows, from the newest down: the commits of
  `lane-reach-residuals` packages 1 to 5 (one or more, any subjects, or
  none when they are still uncommitted in the tree), the artifacts of the
  two changes and the two reproduction tests of this change, then the
  release commit of 2.0.4 (subject ending in `(v2.0.4)`). `git status
  --short` lists nothing of rule 8 except edits that packages 1 to 5 of
  `lane-reach-residuals` made (`src/core/store/lane-pages.ts`, its call
  sites only); write any other entry into the report and leave it alone.
  Record `wc -l` of every file under `src/` that rule 8 lets you edit;
  these are the base of task 6.8 (at 2.0.4: `lane-pages.ts` 761,
  `lane-entry-store.ts` 384, `lane-fold-cache.ts` 414, `lane-records.ts`
  222, `lane-dual-moves.ts` 382, `obligations.ts` 812, `pledges.ts` 1043,
  `pledge-intake.ts` 645, `intentions.ts` 226, `entities/registry.ts`
  1217). These names exist: `writeLaneText`, `writeLanePage`,
  `readLaneEntrySnapshot`, `removeLanePage`, `moveLanePage`,
  `moveLaneTree`, `removeLaneTree`, `withLaneLock` (`lane-pages.ts`);
  `entryRecord`, `tombstoneOf`, `replacedShared`, `storeEntryRead`,
  `authorityFor`, `storedEntryPrivate` (`lane-entry-store.ts`);
  `laneStoreFold`, `wholeLaneStoreFold`, `laneFoldIncomplete` and the
  fold's `authorities`, `privateKeys` and `privateRemovals`
  (`lane-fold-cache.ts`); `laneMoveRecords`, `destinationRecords` (not
  exported; edited in its own file) and `laneRemovalRecords`
  (`lane-dual-moves.ts`); `laneEntryRecord`,
  `laneEntryRemoveRecord`, `foldLaneEntries` (`lane-records.ts`);
  `storeWrite`, `routeWrite`, `StoreWriteError`
  (`src/core/store/store-write.ts`); `LaneEntryWithheldError`,
  `assertLaneWriteAtReach`, `removalRecordsAtReach`, `moveSourceAtReach`,
  `winnerHeldInPrivate`, `assertHolderReadableAtReach` and, from
  `lane-reach-residuals` package 5, `storeWriteAtReach` and the refusal
  of a key whose winning record is a removal held in `private` inside
  `assertLaneWriteAtReach` (`src/core/store/lane-reach-guard.ts`); `completeObligation`,
  `addObligation`, `removeObligation` (`obligations.ts`), `fulfillPledge`,
  `addPledge`, `removePledge` (`pledges.ts`),
  `rewritePledgeCounterparties` (`pledge-intake.ts`, not exported),
  `setIntention`, `moveIntentionToHistory` (`intentions.ts`),
  `writeHandoffNote` (`handoff.ts`), `upsertEntity`, `relateEntities`,
  `archiveEntity`, `writeEntityFile` (`registry.ts`), `parseEntityFile`
  (`src/core/brain/entities/index-builder.ts`). Stop and report on a
  mismatch.
- [x] 0.2 Baseline: run
  `bun test tests/core/brain/obligations-completion-authority.test.ts tests/core/brain/pledges-fulfil-authority.test.ts --timeout 30000`.
  Expected: 4 pass, 4 fail (the two "on a switched machine" cases of
  each file). Run the tests of 2.0.4 and of the packages already done:
  `bun test tests/mcp/lane-private-partition-reach.test.ts tests/mcp/lane-private-partition-reach-writes.test.ts tests/mcp/lane-reach-residuals-builder-race.test.ts tests/mcp/lane-reach-residuals-private-removal.test.ts --timeout 30000`:
  expected all pass. Also run
  `bun test tests/core/store/lane-records.test.ts tests/core/brain/obligations.test.ts tests/core/brain/pledges.test.ts`
  and record the counts. Stop and report when the baseline differs.

## 1. One failing test per remaining site (design D5; spec scenarios of "A sequential rewrite keeps the standing", "A removal or a move keeps the standing" and "A create over a removed entry keeps the removal's standing")

Each file below is written as the reproduction files are: the operator's
write through `runCli`, the agent's through the tool table at
`mcp-tool`, the read through the tool's `show` or `list`. Write them all
before any production code, run each, and record the failure: each
defect case must fail on this tree and each control must pass. A defect
case that passes here means the site is not lost the way `design.md`
says: stop and report the chain.

- [x] 1.1 `tests/core/brain/pledge-intake-reanchor-authority.test.ts`:
  a pledge written by `o2b tool-call brain_pledge` (as the pledge
  reproduction file does), then `brain_intake_pledges` at `mcp-tool`
  with an input that re-anchors its counterparties (read
  `src/core/brain/pledge-intake.ts` around `rewritePledgeCounterparties`
  for what triggers it); the pledge's `promised_to` reads back as the
  result's `reanchored` entry says. Control: unswitched machine.
- [x] 1.2 `tests/core/brain/intentions-set-authority.test.ts`: `o2b brain
  intention set --scope S --text A`, then `brain_intention` `set` scope
  S text B at `mcp-tool`; `show` gives text B, version 2, and a history
  line for A. Control: unswitched machine.
- [x] 1.3 `tests/core/brain/handoff-rederive-authority.test.ts`: a note
  written by `o2b brain handoff` (read `src/cli/brain/verbs/handoff.ts`
  for its arguments; give it a transcript file in the temp dir), then
  `writeHandoffNote` called in-process at `mcp-tool` with
  `targetPath` of that note and other turns (the recompile executor's
  call); the note reads back with the new turns. Control: unswitched.
- [x] 1.4 `tests/core/brain/entities/entity-upsert-authority.test.ts`:
  `o2b brain entity upsert` of a person, then `brain_entity` upsert of
  the same person with an alias at `mcp-tool`; both the tool's answer
  and the next read carry the alias. Today the call returns no error and
  answers the old entity (`created: false`, no alias): the defect case
  fails on the alias, not on an error. In the same file: (b)
  `o2b brain entity upsert` of two people, then `relateEntities` called
  in-process at `mcp-tool` (the call the entity intake makes) relating
  them: the next read of the first entity carries the relation; (c)
  `o2b brain entity upsert` of a person, then `archiveEntity` called
  in-process at `mcp-tool`: the next read shows it archived. Control:
  unswitched, for each case.
- [x] 1.5 `tests/core/brain/lane-remove-authority.test.ts`: (a)
  `o2b brain obligation add`, then `brain_obligation` `remove` at
  `mcp-tool`: `list` no longer shows it and the archived page exists
  (on a store-only machine the removal is `moveLanePage` from the active
  page to the archive, not `removeLanePage`: its standing comes from the
  `moveLanePage` edit of task 2.2);
  (b) `o2b brain intention set`, then `brain_intention` `move` at
  `mcp-tool`: `show` finds no active chain. Control: unswitched.
- [x] 1.6 `tests/core/brain/lane-recreate-authority.test.ts`: (a)
  `o2b brain obligation add` of a title, `o2b brain obligation remove`
  of it, then `brain_obligation` `add` of the same title at `mcp-tool`:
  the tool answers the page, and `show` and `list` find the obligation;
  (b) `o2b tool-call brain_pledge` `add`, then `o2b tool-call
  brain_pledge` `remove` of that pledge, then `brain_pledge` `add` of
  the same title, due date and source at `mcp-tool`: `show` finds the
  pledge. Today both defect cases fail on the read (`show` finds
  nothing) while the tool answered the page. Control: unswitched.

## 2. The kept standing (design D1, D4; spec "A sequential rewrite keeps the standing", "A removal or a move keeps the standing", "A create over a removed entry keeps the removal's standing", "Versions written apart on two devices are arbitrated by the authority order", "The record names who acted")

- [x] 2.1 Test first: new `tests/core/store/lane-standing.test.ts`, on a
  switched machine, through the lane page API with the origin channel
  set: (a) an entry written while the channel is `cli`, rewritten by
  `writeLaneText` while it is `mcp-tool`, reads back the new text, and
  its winning record has `authority` `human` and `acted_by` `agent`;
  (b) the same with `writeLanePage` `overwrite: true`; (c) an entry
  written at `agent` rewritten at `cli` is stored at `human` with no
  `acted_by`; (d) `removeLanePage` at `mcp-tool` of a `cli` entry leaves
  no entry, the tombstone has `authority` `human`, `acted_by` `agent`;
  (e) `moveLanePage` at `mcp-tool` of a `cli` entry: gone at the source,
  present at the destination; (f) `moveLaneTree` and `removeLaneTree` of
  a folder holding one `cli` entry, at `mcp-tool`: moved, removed, and,
  as in (d), (e) and (o), the tombstone of each and the moved record
  have `authority` `human` and `acted_by` `agent` (the records come from
  `laneMoveRecords` and `laneRemovalRecords`, which today stamp the
  writer's own authority);
  (g) a `lane-entry` record with an `acted_by` body field folds with the
  same value as one without (`foldLaneEntries`); (n) an entry written
  and then removed at `cli`, created again by `writeLaneText` with
  `exclusive: true` at `mcp-tool`: reads back, its record has
  `authority` `human` and `acted_by` `agent`, and `storeEntryRead`
  before the create answered `removed: true`, `authority` `human`;
  (o) `moveLanePage` at `mcp-tool` of an `mcp-tool` entry onto a path
  whose entry was written at `cli`: the destination reads the moved
  value, the source is gone, the moved record has `authority` `human`;
  (p) a shared entry written at `cli`, rewritten at `mcp-tool` with a
  private marker (`visibility: private` in its frontmatter): the
  shared tombstone written with it (`replacedShared`) has `authority`
  `human`; (r) an entry written at `cli`, rewritten at `mcp-tool`, then
  a `human` record of the same entry from another device with a clock
  between the two appended to the store (with `appendRecord`,
  `src/core/store/appender.ts`, through a store handle opened for a
  second device id and a chosen clock, as the local `write` helper of
  `tests/core/store/streamed-partition-checks.test.ts` does; copy the
  helper into this file, do not import from a test file): the next read
  shows the `mcp-tool` rewrite; (s) the same with the other device's
  clock after the rewrite: the next read shows the other device's
  version. Read the winning record through the fold the existing
  `tests/core/store/lane-records.test.ts` uses. Run it: (a), (b), (d),
  (e), (f), (n), (o), (p), (r) fail ((f) on the record assertions); (c),
  (g) and (s) pass.
- [x] 2.2 Code: `src/core/store/lane-standing.ts` with
  `strongerAuthority(a, b)` (lower index in `AUTHORITIES`).
  `laneStoreFold` records in `authorities` the winning authority of
  every key, removed ones included (move the `authorities.set` above the
  `continue` of a removed key, and update its doc comment);
  `storeEntryRead` answers `removed`. `laneEntryRecord` and
  `laneEntryRemoveRecord` take `actedBy?` and write `acted_by` only when
  given. `entryRecord` and `tombstoneOf` take
  `replacedAuthority?: Authority | null`, stamp
  `strongerAuthority(own, replacedAuthority)` and pass `actedBy: own`
  when it differs. Pass the holder's authority from the same fold read
  at every builder call, inside the `store:` builder in both modes (the
  store-only write and the dual-write mirror run the same builder):
  `writeLaneText` and `writeLanePage` for every kind of write, creates
  included (`storeEntryRead`, its `authority` whenever not null);
  `replacedShared` (its `onlyIfApart` tombstone); `removeLanePage` (its
  tombstone comes from `laneRemovalRecords`, below; the `storeEntry` read
  before `storeWrite` only decides whether anything is removed);
  `moveLanePage` (the
  source's tombstone the source's, the moved record the stronger of
  source and destination, the destination's `replacedShared` tombstone
  the destination's); `laneMoveRecords`, `destinationRecords` and
  `laneRemovalRecords` (`fold.authorities.get(key)`, the same split).
  Verify: 2.1 all pass; `tests/core/store/lane-records.test.ts` and the
  existing lane page tests under `tests/core/store/` that import
  `lane-pages.ts` (`git grep -l "lane-pages" tests/core/store`) pass.
- [x] 2.3 Run the reproduction files and every file of section 1: the
  obligation cases 1 and 2, the pledge cases 1 and 2 and every defect
  case of 1.1 to 1.6 now pass, the controls still pass.

## 3. The base and the visible refusal (design D2, D6; spec "A version that changed since the read is refused visibly")

- [x] 3.1 Test first, in `tests/core/store/lane-standing.test.ts`:
  (h) `writeLaneText` with `replaces: readLaneBase(...)` taken before a
  second record of the same entry is appended (write it with
  `writeLaneText` at `cli` after taking the base) throws an error that
  is a `LaneEntryChangedError` with reason `changed`, is not a
  `StoreWriteError`, and whose message says to read the entry again and
  does not name `o2b brain doctor`; the entry keeps the second record's
  value; (i) a base whose `whole` is false throws reason `incomplete`,
  with a message that names `o2b brain doctor`, and writes nothing: make
  the fold miss a record as the restamp's store-only test does for its
  "could not be read in full" case
  (`tests/core/brain/store-only/privacy-marker-restamp-store-only.test.ts`,
  the case whose expected reason is "the lane store could not be read in
  full; run the restamp again once it reads"); (i2) a base taken while
  the fold is whole, then the fold made to miss a record the same way,
  then the write: reason `incomplete`, not `changed`, nothing written;
  (j) `replaces: null` and an unswitched machine change nothing. Run:
  (h), (i), (i2) fail.
- [x] 3.2 Code: `readLaneBase`, the base check and
  `LaneEntryChangedError` in `lane-standing.ts`, re-exported from
  `lane-pages.ts`; the `replaces` option of `writeLaneText` and
  `writeLanePage`. The check runs in those two functions on a store-held
  path with a non-null `replaces`, right after `assertLaneWriteAtReach`
  (design D2, D7): before the same-entry shortcut, before
  `withCreateLock` and `routeLaneWrite`, never inside the `store:`
  builder (`storeWrite` turns anything thrown there into a
  `StoreWriteError` `store-error` with the doctor remedy; design D2).
  Verify: 3.1 passes.
- [x] 3.3 Callers pass the base, each taken under its lane lock before
  its own read (design D2 list): `completeObligation`, `fulfillPledge`,
  `rewritePledgeCounterparties`, `setIntention` (wrap its read and write
  in `withLaneLock` on `intentionPath(vault, scope)`), and the three
  entity overwrites in `registry.ts` (`upsertEntity`'s update arm,
  `relateEntities`, `archiveEntity`): keep the index read first; then,
  inside `withLaneLock` on the target's path, take the base, re-read the
  entity with `parseEntityFile(path, vault)`, refuse with
  `LaneEntryChangedError` `changed` when it is gone or has another
  `entity_id`, build the written fields from that re-read instead of the
  index entry, read the extras and body with `parseLanePage` after the
  base, and pass the base through a new `replaces` field of
  `writeEntityFile`'s options. That logic lives in
  `src/core/brain/entities/locked-write.ts` (one function the three
  overwrites call with the field change each makes); `registry.ts` gets
  call-site edits only. Test first, in
  `tests/core/brain/entities/entity-upsert-lock.test.ts` (spec "An
  entity upsert builds on the entity it locked"): on a switched machine,
  `o2b brain entity upsert` of a person with alias A; take the entity
  index; a second `o2b brain entity upsert` of that person with alias B;
  then `upsertEntity` at `mcp-tool` with alias C while the registry's
  index read is answered by the index taken before B (a test double of
  `buildEntityIndex` through `mock.module` in the test, no production
  seam): the answer and the next read carry B and C. Run it: it fails
  before this task's code. A record cannot be injected between a
  caller's base and its write without a production seam, so that race
  is proven at the lane layer (3.1 cases h, i2) and by reading: write
  into the report, for each caller, the order you implemented (lock,
  base, re-read, write).
  The handlers already turn a thrown `Error` into an error answer
  (`src/mcp/brain/calendar-tools.ts`, `pledge-tools.ts`,
  `entity-tools.ts` wrap it into an MCP error; the pledge intake
  rethrows; the recompile executor lists it in `errors`); confirm that
  for `brain_intention` (`workspace-tools.ts`) too, and stop and report
  any handler that swallows it. Verify: the reproduction files and
  every file of section 1 pass.

- [x] 3.4 Reach before the base (design D7; spec "A tool's lane write
  below local reach that meets a private holder gets the fixed answer").
  Test first, in `tests/mcp/lane-standing-reach.test.ts`, through the MCP
  tools at remote reach with a local control each: (o1) an obligation
  whose winning version is a `human` version held in `private`, completed
  by a remote caller: no record is written, the raw records of both
  partitions are unchanged, and the answer is the one an absent
  obligation gets, naming nothing of the entry (a remote completion
  never reaches the lane write: `targetEntry` in `obligations.ts` hides
  the page and `completeObligation` throws `noObligationError`;
  `fulfillPledge` does the same through `locatePledge`; this is the
  2.0.4 rule its test `tests/mcp/lane-private-partition-reach-writes.test.ts`
  guards, "fulfil, done and resolve of a private-partition entry answer
  as for an absent one", and it stands); (o2) a remote `add` of an
  obligation whose key is held by a `human` removal held in `private`:
  the fixed answer, not the removal error; (o3) a base taken by a remote
  caller on a shared entry, then the entry raised to `private` by a
  local writer after the write's reach check and before its base check:
  the fold double of `tests/mcp/lane-reach-residuals-builder-race.test.ts`
  (`spyOn(foldCache, "wholeLaneStoreFold")`) makes the raise on the fold
  read of the base check (`checkLaneBase`), after
  `assertLaneWriteAtReach` has read its fold: the fixed answer, never
  `LaneEntryChangedError`; (o3b) the same with the raise made before the
  call: the fixed answer (a guard, `assertLaneWriteAtReach` refuses an
  entry live in `private`); (o4) a remote completion while the lane fold
  of every partition may miss a record: no record is written, no gap and
  no doctor text, and the answer is the one an absent obligation gets
  (the narrowed view holds no entry while the whole fold is incomplete,
  `lane-fold-cache.ts`); the fixed answer on such a fold belongs to the
  write paths that reach `assertLaneWriteAtReach`, already guarded by
  the 2.0.4 test "a write below local reach while the fold may miss a
  record is refused" (a pledge add), not repeated here. Run: (o3) fails
  (the base check answers `LaneEntryChangedError` `changed`); (o1),
  (o2), (o3b) and (o4) pass already ((o1) and (o4) by the 2.0.4 rule
  for an absent entry, (o3b) by the reach guard of 2.0.4, (o2) by the
  private-removal refusal of `lane-reach-residuals` package 5), and stay
  as guards of the order. Code: in `lane-standing.ts`, the base check answers
  `LaneEntryWithheldError` below local reach whenever the winning record
  of the key on the fold it reads is held in `private` or that fold may
  miss a record (`winnerHeldInPrivate`, `assertHolderReadableAtReach`);
  the call order in `writeLaneText` and `writeLanePage` stays
  `assertLaneWriteAtReach` first, then `checkLaneBase`. The read-back
  does not exist yet; its reach rule is task 4.2. Verify: 3.4 passes;
  3.1 passes.

## 4. The read-back check (design D3; spec "A write the store does not apply fails visibly")

- [x] 4.1 Test first, in `tests/core/store/lane-standing.test.ts`: (k)
  a `human` record of an entry stamped further ahead than
  `HLC_MAX_DRIFT_MS` (`src/core/store/hlc.ts`) is appended to the store
  with the local `write` helper of 2.1 (r); a `writeLaneText` of that
  entry at `mcp-tool` throws `LaneWriteNotAppliedError` whose `heldBy`
  is `human`, whose `removed` is false and whose message names a
  version; (l) the same for `removeLanePage`; (n2) a `human` tombstone
  of an entry stamped as far ahead, then a `writeLaneText` with
  `exclusive: true` of that entry at `mcp-tool`: throws
  `LaneWriteNotAppliedError` with `heldBy` `human`, `removed` true and a
  message that names a removal; the error is not a `StoreWriteError` in
  any of these cases; (m) on an unswitched machine no check runs; (k2)
  in `tests/mcp/lane-standing-reach.test.ts`, below local reach: a
  `human` record held in `private` and stamped as far ahead is appended
  to the store after the write passed its reach guard (with the fold
  hook of `tests/mcp/lane-reach-residuals-builder-race.test.ts`, or a
  second process), then the read-back runs: the answer is the fixed
  answer, not `LaneWriteNotAppliedError`, and names no path, holder or
  authority; when no hook can place the record there without a
  production seam, prove it by reading and say so in the report. Run:
  (k), (l), (n2), (k2) fail.
- [x] 4.2 Code: the read-back in `lane-standing.ts`, called after
  `storeWrite` returns (outside it) in `writeLaneText`, `writeLanePage`
  (skipped when nothing was written), `removeLanePage`, `moveLanePage`,
  `moveLaneTree`, `removeLaneTree`, store-held paths only. Below local
  reach the read-back answers `LaneEntryWithheldError` instead of
  `LaneWriteNotAppliedError` whenever the winning record it reads is
  held in `private`, live or a removal, or its fold may miss a record
  (`winnerHeldInPrivate`, `assertHolderReadableAtReach`; design D7).
  Verify: 4.1 passes; 3.4 passes; every test file touched so far passes.

## 5. Docs and release (design D4; `CLAUDE.md` Versioning)

- [x] 5.1 `src/core/store/FORMAT.md`: on `lane-entry` and
  `lane-entry-remove`, the optional `acted_by`, and one paragraph under
  "Order and folds" or beside the lane-entry kinds: a lane record that
  replaces or removes the entry the writer read, or creates an entry
  where the writer read a removal, takes the stronger of the writer's
  authority and that holder's; a moved entry the stronger of its source
  and its destination; the authority order decides between versions
  written apart. `docs/brain-store.md`: the same in user words where
  lane pages on a switched machine are described (find it with
  `git grep -n "lane page" docs/brain-store.md`), the two errors a tool
  or verb may now answer and what to do about each (read again; run
  `o2b brain doctor` when the store could not be read in full).
  Verify: `bun run fmt:check`.
- [x] 5.2 `CHANGELOG.md`: this change's lines go into the one entry
  `## [2.0.5]` that `lane-reach-residuals` package 21.1 writes for both
  changes, under its `### Fixed`: the tool's lane write kept on a
  switched machine, per site; the create after a removal; the visible
  refusal and the read-back error; `acted_by`; the fixed answer below
  local reach. When this section runs before package 21.1, write the
  entry `## [2.0.5] - <today>` above `## [2.0.4]` with these lines and the
  link reference `[2.0.5]: https://github.com/itechmeat/open-second-brain/compare/v2.0.4...v2.0.5`
  above the `[2.0.4]` line, and package 21.1 adds its own lines to it.
  Never a second heading. Verify by reading both places.
- [x] 5.3 The version: `2.0.5`, set once by `lane-reach-residuals`
  package 21.2 (`package.json`, then `bun run scripts/sync-version.ts`,
  then `--check` exits 0). This section changes no version. Never
  hand-edit the mirrored manifests.
- [x] 5.4 If any file under `src/` that the OpenClaw bundle includes
  changed, rebuild it with `bunx bun@1.4.4 run build:openclaw` and check
  `git status` shows `openclaw/index.js` changed; otherwise say it did
  not. Expected: not changed, the bundle holds no lane module.

## 6. The gate

- [ ] 6.1 `bun run test` (the tests of `lane-private-partition-reach` and
  of `lane-reach-residuals` included: they must pass too). Section 6 runs
  once for both changes, as `lane-reach-residuals` package 21.3.
- [x] 6.2 `bunx tsc --noEmit -p .`
- [x] 6.3 `bun run lint`
- [x] 6.4 `bun run fmt:check`
- [x] 6.5 `bun run check:paths`
- [x] 6.6 `bun run sync-plugin-mirrors:check`
- [x] 6.7 `bun run scripts/sync-version.ts --check`
- [x] 6.8 `wc -l` of every file this change touched under `src/`,
  against the counts of task 0.1: none under 700 lines before crosses
  700; the files already past 700 grew by call-site lines only.
- [x] 6.9 Windows shards: if a new test file runs longer than a few
  seconds, say so in the report (the integrator folds the CI timings
  with `.github/scripts/windows-timings.sh`, `CLAUDE.md`).

## 7. Report

- [ ] 7.1 Report: every box ticked or why not; the failing-then-passing
  output of each new test file (or the note that its failure was not
  observed, section 1); deviations from `design.md` and why; the order of
  each caller of task 3.3; the case of task 5.2; the gate counts;
  anything in this list that did not match the code.

## Workflow follow-up

- Independent code review rounds and the security review (the
  integrator), over both changes together.
- Archive inside the pull request, `lane-reach-residuals` first, then
  this change: `openspec archive lane-reach-residuals --yes`, then
  `openspec archive tool-lane-write-keeps-standing --yes`; commit the
  archives and the updated `openspec/specs/` with the code. Both add
  requirements to `lane-entry-fidelity` (11 and 10) and
  `lane-reach-residuals` modifies two, so the order matters only for
  reading the result. Check the merged capability spec:
  `openspec validate lane-entry-fidelity --type spec --strict` passes;
  `grep -c "^### Requirement:" openspec/specs/lane-entry-fidelity/spec.md`
  equals the count of task 0.1 (21) plus 11 plus 10, that is 42; each
  requirement heading of both deltas appears exactly once
  (`grep -n "^### Requirement:"`); the modified "A write decided from
  lane state below local reach decides from every partition" carries the
  per-action hygiene scenario, and the modified "An update below local
  reach of a private-partition lane entry acts as on an absent one"
  refuses a folder whole. One pull request, one commit, version
  2.0.5, one changelog entry.
- After the merge: `gh release create v2.0.5` on the merged commit.
- Follow-up changes: `src/core/brain/exact-state.ts` stores an
  operator's exact-state write at `agent`; a version check for the lane
  writers `proposal.md` Scope lists.
