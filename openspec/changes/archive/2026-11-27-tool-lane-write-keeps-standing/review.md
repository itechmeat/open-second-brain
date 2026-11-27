# Independent review

## Reviewer

Round 1: an agent of a different model family than the author, read-only,
before implementation, with the checks of the `osb` schema. It re-ran the
baseline (the two reproduction files: 4 pass, 4 fail), read the seven
sites and the two nets in the tree, and was briefed to attack first:

1. The principle check (`brainstorm.md`, Decision): that no stated
   purpose of the authority order covers lane entries.
2. The kept standing for blind overwrites and removals (design D1), not
   only for read-modify-writes that pass a base.
3. The race scenario of the spec is proven at the lane layer only
   (tasks 3.1 case h, 3.3): whether a tool-level test is possible
   without a production seam.
4. Every name in `design.md` and `tasks.md` against the tree.

Its verdict: not ready, two majors (findings 1 and 2), each a short
artifact fix; with them applied, "yes, with minor comments". The
principle check held (finding 9); the tool-level race needs a seam, so
the lane-layer proof stands (findings 12, 13). The author verified every
code fact below against the tree before resolving it.

Round 2: an independent reviewer, read-only, before implementation, over
this change and `lane-reach-residuals` together (the joint review of
release 2.0.5). Its verdict for both: "Ready for implementation: no".
The findings that touch this change are recorded below as 14 to 19; the
full list, with every resolution, is in
`openspec/changes/lane-reach-residuals/review.md`. The author verified
each code fact against the tree; all were confirmed.

Round 3: an independent closing review, read-only, before
implementation, by a reviewer of another model family than the author,
over this change alone. Its verdict: "Ready for implementation: no",
with two blockers and one major, all corrections to `tasks.md` and the
spec delta, none to the design of the code, and three minors (findings
20 to 25 below). The author verified every code fact against the tree;
all were confirmed. The lead's rulings on findings 20 to 22 and 25 are
recorded with their resolutions.

## Findings

1. design D2, tasks 3.1 and 3.2 (major): the version check was placed
   inside the store write builder, which runs inside `storeWrite`'s
   `try`; a `LaneEntryChangedError` thrown there reaches the caller as a
   `StoreWriteError` `store-error` with the doctor remedy, so test (h)
   could not pass as written. Fixed: the check runs in `writeLaneText`
   and `writeLanePage` as their first step on a store-held path, before
   the same-entry shortcut and `routeLaneWrite`, never in the builder
   (design D2 "Where the check runs", Context 12; the read-back of D3 is
   placed after `storeWrite`, outside its `try`); test (h) also asserts
   the error is not a `StoreWriteError` and names no doctor; spec
   requirement "A version that changed since the read is refused
   visibly" says the answer is the change's own error, never a generic
   store failure.
2. proposal, design D1 and D3, spec, tasks (major): a create over a key
   a person's removal holds (`add` through a tool after `remove` through
   the command line) is the same silent loss, and D1 as designed could
   not reach it because the lane fold records no authority for a removed
   key. Fixed, in scope: `laneStoreFold` keeps the winning authority of
   removed keys, `storeEntryRead` answers `removed`, every lane write,
   creates included, takes the holder's standing (design D1, Context
   10); `src/core/store/lane-fold-cache.ts` joins the editable files
   (tasks rule 8); new failing test file
   `tests/core/brain/lane-recreate-authority.test.ts` for the obligation
   and the pledge (task 1.6) and lane-layer case (n); the not-applied
   error names a removal holder as a removal (`removed`, D3; case n2);
   new spec requirement "A create over a removed entry keeps the
   removal's standing" and the scenario "A removal stamped ahead of this
   machine holds the path".
3. design D6 item 4 (minor): "under the append lock" was untrue; the
   builder runs before `appendStoreRecords` takes the shard lock. Fixed:
   D6 item 4 reworded; a record of another process in that window is
   either replaced as a sequential write or reported by D3.
4. design D1, spec (minor): a moved entry took only the source's
   standing, so a move onto a person's entry lost at the destination.
   Fixed: the moved record takes the stronger of the source holder and
   the destination holder, live or removed (D1 items 3 and 4); spec
   requirement "A removal or a move keeps the standing" and scenario "A
   move onto a path a person's entry holds"; test case (o).
5. design Risks (minor): D2's `whole` refuses on any gap in the fold,
   shared pending blobs included, and `unchanged()` reported a gap that
   opened after the base as `changed`. Fixed: Risk 2 states the
   consequence (a machine holding only `shared` after the migration
   refuses until the gap closes) and the `incomplete` message names
   `o2b brain doctor`; D2 step 2 reports a gap after the base as
   `incomplete`; spec scenario "A gap that opens after the read"; test
   case (i2).
6. design D2, proposal Why (minor): the entity upsert took its base after
   the index read and built aliases, status and confidence from the
   index. Fixed: the three entity overwrites (`upsertEntity`,
   `relateEntities`, `archiveEntity`) take the lane lock and the base,
   then re-read the entity with `parseEntityFile` and build the fields
   from that read, refusing a gone or different entity (D2 item 5, task
   3.3); spec scenario "An entity upsert builds on the entity it
   locked", verified by the caller order in the report (no seam).
7. tasks section 0, release steps, workflow follow-up (minor): the tree
   the brief expected was not the tree, and the change
   `lane-private-partition-reach` in the same branch also releases 2.0.3
   and modifies `lane-entry-fidelity`. Fixed: this change is implemented
   after that one; task 0.1 names the expected history and checks that
   its tests pass (0.2); tasks 5.2 and 5.3 add this change's lines to an
   unreleased 2.0.3 entry the branch already carries, or otherwise take
   the next patch version; the follow-up archives both changes and
   checks the merged spec (validation, requirement count, each heading
   once); proposal "Release" says the same.
8. tasks and design names (minor): (a) the "could not be read in full"
   fixture is `tests/core/brain/store-only/privacy-marker-restamp-store-only.test.ts`;
   (b) a far-ahead record is built with `appendRecord` and a chosen clock
   as the local `write` helper of
   `tests/core/store/streamed-partition-checks.test.ts` does; (c)
   `replacedShared`'s tombstone takes the standing too (D1 item 5, task
   2.2, test case p, spec scenario "A raise to private over a person's
   shared entry"); (d) "inside the `store:` builder, in both modes"; (e)
   Risk 3 says the lane fold has no tails and an isolated write pays one
   full rebuild. All fixed.
9. design Risks, spec (minor): what the authority order still protects
   was not stated, and the earlier-clock case was missing. Fixed: Risk 5
   states it and accepts the earlier-clock loss as parity with a sync
   conflict on an unswitched machine; new spec requirement "Versions
   written apart on two devices are arbitrated by the authority order"
   with the later-clock and earlier-clock scenarios; test cases (r) and
   (s).
10. design D6, tasks (minor): the lock notes. Fixed: D6 item 1 states
    the lock order and that no caller of the newly locked writers holds
    a lane lock; Risk 6 and tasks rule 10 carry the two notes (a `.lock`
    file left by a crash with no stale window answers `ELOCKED` until
    removed; `withLaneLock` has no wait-budget option).
11. `acted_by` (minor): tolerated by every reader the reviewer read; the
    only actor shown as the standing was `heldBy` for a removal holder.
    Fixed with finding 2 (D3 names a removal); D4 records that the
    envelope still names the actor; task 5.4 expects the OpenClaw bundle
    unchanged.
12. proposal Why, site 6 (minor): the entity upsert is not silent in
    memory: it answers the old entity with `created: false`. Fixed: the
    proposal, design Context 8 and D5 say so, and test 1.4 asserts the
    alias in both the answer and the next read.
13. proposal (scope): the five writers were presented as the
    read-modify-write lane writers, while decisions, tensions, the health
    thesis, the gap loop and the triggers also read and rewrite. Fixed:
    a Scope section names them as getting the kept standing and the
    read-back but no version check, and says why that is acceptable;
    design Non-Goal 5 and Risk 7; a follow-up in tasks.

14. Round 2, blocker (its finding 1): task 3.4 used a read-back that task
    4.2 builds later, and case (o2), a remote `add` over a `human`
    removal held in `private`, could not pass: the reach guard judged
    live entries only, `addObligation` passes no base, and the kept
    standing of D1 would let the remote create win over the removal.
    Resolved (lead's ruling): `lane-reach-residuals` package 5 makes
    `assertLaneWriteAtReach` refuse such a key below local reach before
    any store write; task 3.4 covers the base check only, with (o2) as a
    guard that already passes; the read-back's reach rule moved to task
    4.2 with case (k2) and a new spec scenario "A read-back that meets a
    private holder"; Context 10 and 14 and D7 say so; both `tasks.md`
    files state the order again.
15. Round 2, blocker (its finding 6): the archive check expected 43
    requirements. Resolved: 21 + 11 + 10 = 42, recounted from the files;
    `lane-reach-residuals` now modifies two requirements (follow-up).
16. Round 2, major (its finding 7): task 3.2 called the base check the
    first step, against D2, D7 and task 3.4; task 2.2 kept a stale
    `removeLanePage` parenthetical. Resolved: task 3.2 says "right after
    `assertLaneWriteAtReach`"; task 2.2 says the tombstone comes from
    `laneRemovalRecords`.
17. Round 2, major (its finding 8): task 3.3 put the lock, the re-read
    and the field rebuilding inside `registry.ts`, past 700 lines, while
    rule 8 allowed no helper module. Resolved (lead's ruling): rules 7
    and 8 permit `src/core/brain/entities/locked-write.ts` (new);
    `registry.ts` gets call-site edits only; design D2 item 5.
18. Round 2, minor (its finding 15, second half): the reach requirement
    repeats the 2.0.4 scenario "A write reported as not applied names no
    private holder". Resolved: kept on purpose for this change's write
    paths, and the requirement and D7 name that scenario.
19. Round 2, minor (its finding 16, this change's part): `relateEntities`
    and `archiveEntity` had no section 1 case, and the scenario "An
    entity upsert builds on the entity it locked" was verified by
    reading only. Resolved: task 1.4 gains cases (b) and (c) with a spec
    scenario "An entity related or archived by an agent's process"; task
    3.3 gains `tests/core/brain/entities/entity-upsert-lock.test.ts`,
    which answers the registry's index read with an index taken before
    the other version (a test double in the test, no production seam).
20. Round 3, blocker (its finding 1): the scenario "Completing an
    obligation whose winning version is private" and case (o1) asked
    for the fixed answer, against the 2.0.4 rule and its test: a remote
    completion never reaches the lane write (`targetEntry` hides the
    page, `completeObligation` throws `noObligationError`, and
    `fulfillPledge` does the same). Resolved (lead's ruling): the
    scenario answers as for an absent obligation and writes nothing, the
    requirement says so for a completion the caller cannot see, and (o1)
    is a
    guard that passes by the 2.0.4 rule; D7 and the proposal say so.
21. Round 3, blocker (its finding 2): case (o4) expected the fixed
    answer for a completion while the fold may miss a record, where the
    narrowed view holds no entry and the answer is the absent one.
    Resolved (lead's ruling): (o4) expects the absent-one answer with no
    gap or doctor text; the scenario "A remote write while the store
    cannot be read whole" gives the add the fixed answer and the
    completion the absent one; the add is guarded by the 2.0.4 test.
22. Round 3, major (its finding 3): case (o3) raised the entry before
    the call, which the reach guard already refuses. Resolved (lead's
    ruling): (o3) raises it on the fold read of the base check, after
    the reach check, through the fold double of the builder-race test;
    (o3b) keeps the raise before the call as a guard.
23. Round 3, minor (its finding 4): `destinationRecords` is not
    exported. Resolved: task 0.1 says so.
24. Round 3, minor (its finding 5): case (f) checked only that the tree
    moved or was removed. Resolved: it asserts the `authority` and
    `acted_by` of each tombstone and moved record, as (d), (e) and (o).
25. Round 3, minor (its finding 6): the additions to `lane-pages.ts`.
    Resolved (lead's ruling): rule 7 keeps each a single call; the
    read-back of the tree operations loops in `lane-standing.ts`.

Round 3's per-package note on task 1.5 (the obligation removal is a move
to the archive) is taken into that task; its other notes confirmed the
names and found nothing.

## Revision for 2.0.5

Revised after round 1 for the 2.0.4 tree and release 2.0.5 with
`lane-reach-residuals`: section 0, the release steps and the follow-up
rewritten; Context 9, 10, 12 and 14, D1 items 2 and 3, D2 and D6 item 4
corrected; design D7, the reach requirement and task 3.4 added. Revised
again after round 2 (findings 14 to 19): Context 10 and 14, D2 item 5
and D7; tasks rules 7 and 8, 0.1, 0.2, 1.4, 2.2, 3.2, 3.3, 3.4, 4.1, 4.2
and the follow-up; two spec scenarios. Revised again after round 3
(findings 20 to 25): the reach requirement and two of its scenarios, D7,
the proposal's reach paragraph, and tasks rule 7, 0.1, 1.5, 2.1 and
3.4.

## Lead rulings during implementation

1. The entity re-read under its lock (D2 item 5) also changes a machine
   that has not switched: the stale-index race does not depend on the
   mode, and the re-read now keeps the other writer's alias there too
   (the unswitched case of `tests/core/brain/entities/entity-upsert-lock.test.ts`
   failed before the code). Accepted as an improvement; the requirement
   "A machine that has not switched is unchanged" names this one
   exception and gains its scenario, and D2, the site table and the
   proposal's impact say so.
2. The entity read census (`tests/core/brain/entities/entity-read-census.test.ts`)
   gains one row in its exclusion table for the `parseEntityFile` call
   in `locked-write.ts`: accepted.
3. The read-back's fold is read anew and not cached (a cached read-back
   fold hid a blob deleted after it was read). Measured: one store-held
   lane write builds the whole fold twice (once before), twenty writes
   40 times (20 before), on a store of 300 lane entries; at most twice
   and linear, so the code stays and
   `tests/mcp/lane-standing-write-cost.test.ts` keeps the bound. D6
   risk 3 is corrected to these numbers.

## Verdict

Ready for implementation: yes, once the corrections of round 3 (the
closing review) are in; this revision applies them.
