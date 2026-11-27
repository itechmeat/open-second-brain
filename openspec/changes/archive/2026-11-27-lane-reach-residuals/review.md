# Independent review

Change `lane-reach-residuals` (release 2.0.5, shipped in one pull request
with `tool-lane-write-keeps-standing`).

## Reviewer

Round 1: an independent reviewer, read-only, before implementation, over
both changes of the release. It traced every sequence of `design.md`
("Verified sequences") in the tree and confirmed each item marked
confirmed (A7 with a corrected reason, which the design already gave),
agreed that the quarantined-alias half of A6 is refuted, listed the
callers of the exclusive create (`withCreateLock`) and of the receipt
ledger (`lookupKey`, `rememberKey`), and attacked the order of the work
packages across the two changes.

Its verdict: "Ready for implementation: no", with six blockers, seven
majors and three minors (findings 1 to 16 below). The author verified
every code fact of each finding against the tree before resolving it;
every finding was confirmed. The lead's rulings on findings 1, 2, 8, 11,
13 and 16 are recorded with their resolutions.

Round 2: an independent closing review, read-only, before
implementation, by a reviewer of another model family than the author.
It traced every package against the tree and recorded, per package, the
code facts it confirmed and the notes it left. Its verdict: "Ready for
implementation: yes, with minor corrections", with no blocker, two
majors and twelve minors (findings 17 to 30 below). The author verified
every code fact of each finding against the tree before resolving it;
every finding was confirmed, finding 19 with a wider call-site list.
The lead's rulings on findings 17 and 18 are recorded with their
resolutions.

## Findings

1. Blocker. The other change's task 3.4 used a read-back that its task
   4.2 builds later, and its test of a remote `add` over a `human`
   removal held in `private` could not pass: `assertLaneWriteAtReach`
   judges only live private entries, `addObligation` passes no base, and
   the kept standing would let the remote create win over the private
   removal. Resolved (lead's ruling): package 5 makes
   `assertLaneWriteAtReach` and `assertWritableInFold` refuse, below
   local reach, a key whose winning record is a removal held in
   `private`, before any store write (design sequence 19, R5; spec
   requirement "A write decides reach and privacy from the fold it
   writes from", new scenario "A remote write over a key a private
   removal holds is refused"; test
   `tests/mcp/lane-reach-residuals-private-removal.test.ts`). The other
   change's task 3.4 now covers the base check only, and its read-back
   reach check moved to its task 4.2 (case k2). The order across the two
   changes is stated again in both `tasks.md` files.
2. Blocker. A1 omitted the `operations` batch mode
   (`applyPinnedOperations`, whose `replace` probes the private text),
   and `pinnedRecord` sent a remote write into `private`
   (`private-when-held`). Resolved (lead's ruling): the requirement
   covers every writing form, the batch and `replace` included; a remote
   write with no `private` row goes to `shared`; package 1 edits
   `src/core/store/dual-write-records.ts`. So the remote write is not
   lost to a local reader, a local read falls back to the `shared`
   register while the `private` one holds no record (design R1, Risk 4;
   new scenarios for the batch and the write to `shared`).
3. Blocker. Package 10 could not tell a collision suffix from an
   entity's own `-2` slug inside `batch-allocation.ts`. Resolved:
   package 10 gets a call-site edit in `registry.ts` passing the
   unsuffixed base stem; its test adds an entity whose own slug ends in
   `-2` (design R8; scenario "A batch predicts the id its write takes").
4. Blocker. Package 6 omitted `extract-intake.ts`: an identity refusal
   inside `intakeExtraction` still came after the disposition row.
   Resolved: `extract-intake.ts` exports its reach pre-check, which
   `ingest.ts` calls before it records the row; new scenario "An ingest
   whose intake meets a private entity leaves no disposition row"
   (design sequence 12, R7).
5. Blocker. Fixing only `inspectExistingTarget` left `commitArtifact`
   reading the frozen file (`existsSync`, `readFileSync`). Resolved:
   package 3 also makes the commit's `create` collision check and
   `merge` read take a store-held target from the store entry; new
   scenario "A commit does not read a frozen file at its target"
   (design sequence 9.1, R3). Where the commit writes is not changed;
   the package records it (open point of the author's report).
6. Blocker. The counts were wrong: this change had 11 ADDED requirements
   and 1 MODIFIED, not 12 and 1, so the archive gates expected 43
   instead of 42. Resolved after this round's edits, recounted from the
   files: 11 ADDED (B3's requirement removed, the cost requirement of F3
   added) and 2 MODIFIED (finding 15); the merged capability spec has
   21 + 11 + 10 = 42 requirements; package 21.4 and the other change's
   follow-up say so.
7. Major (the other change). Task 3.2 said the base check is the first
   step, against D2, D7 and task 3.4; task 2.2 kept a stale
   `removeLanePage` parenthetical. Resolved in that change's `tasks.md`.
8. Major (the other change). Task 3.3 put locking, re-read and field
   rebuilding inside `registry.ts` (past 700 lines) while its rules
   allowed no helper module. Resolved (lead's ruling): a sibling module
   `src/core/brain/entities/locked-write.ts` is permitted;
   `registry.ts` gets call-site edits only (that change's rules 7 and
   8, task 3.3, design D2 item 5).
9. Major. Package 15 named the wrong place for the recall feedback
   answer and omitted `triggers/scan.ts`. Resolved: it names
   `src/core/search/feedback.ts` and `src/core/brain/triggers/scan.ts`,
   and leaves `src/mcp/search-tools.ts` untouched (design R13).
10. Major. Package 14 gave a wrong path for the duplicate detector, and
    `apply.ts` appends an audit record when every action is refused.
    Resolved: the path is `src/core/brain/hygiene/detectors/document-dedup.ts`;
    no audit record when nothing was applied and every error is a reach
    refusal (design R7, R11; new scenario "A hygiene apply whose every
    action is refused leaves no audit record").
11. Major. R6 listed obligations, pledges and decisions as exclusive
    creates (they add without `exclusive`) and called the doctor a
    repair (none exists for an unreadable shard). Resolved by the lead's
    ruling: B3 is deferred at local reach. The requirement "An exclusive
    create while the lane fold may miss a record is refused at every
    reach", its two scenarios and package 7 are removed (the package
    number is kept as withdrawn); R6 records the deferral; "Deferred" 4
    lists the real create-once writes and what the deferral needs (a
    shard repair, then the refusal); the proposal, the brainstorm and
    the other change's Context 14 no longer name package 7 or its use of
    `LaneEntryChangedError`.
12. Major. R4 asked for a count of the markers left, which the spec and
    the package did not carry and which would disclose them. Resolved:
    the count is dropped (design R4; spec scenario names no count;
    package 4 leaves `procedure-tools.ts` alone).
13. Major. D2's shared-only list-count comparison was neither specified
    nor deferred, and package 18 omitted the read probe file. Resolved
    (lead's ruling): package 18 specifies the comparison against a twin
    store holding only the `shared` records and edits
    `tests/mcp/lane-private-partition-reach-probe.test.ts` (design R14).
14. Minor. The proposal said local callers were unchanged except for B3.
    Resolved: "Impact" item 3 lists the local changes (the pinned
    fallback, the doctor advice, the store-only write-session target,
    the local move race), and says B3 now behaves as released.
15. Minor. The 2.0.4 requirement "An update below local reach of a
    private-partition lane entry acts as on an absent one" still let a
    folder operation leave private members and a racing removal end
    silently, against B2; and the other change's reach requirement
    repeats a 2.0.4 scenario. Resolved: that requirement is MODIFIED
    here (a folder with a private member, and a removal whose entry is
    raised meanwhile, are refused whole); the other change keeps its
    requirement and names the 2.0.4 scenario it applies to its write
    paths (its design D7).
16. Minor. Missing scenarios and tests. Resolved: scenarios for a
    failed store-mode question (A9.3) and an extensionless reference
    with no vault (A9.4); a remote doctor case (package 12) with its
    scenario; a remote hygiene case with an unrelated private lane
    (package 14); a feedback retry scenario (package 1); in the other
    change, section 1 cases for `relateEntities` and `archiveEntity`
    with a scenario, and a test of the entity re-read under the lock
    through a test double of the index read. A2's rule for an unreadable
    `private` idempotency shard (lead's ruling): below local reach a
    keyed call gets the fixed refusal (fail closed); a local call is
    unchanged (design R1, Risk 5; scenario "A keyed call while the
    private ledger cannot be read in full is refused").

Also in this revision, from the lead's list (group F): F1 joins package
3 (`storeLaneEntryAt` canonicalizes before it rejects), F2 joins package
9 (`submitToPanelSession` guards right after loading the session), and
F3 is a new cost requirement with a test counting whole-fold reads
(design sequences 20 to 22, R3, R7, R15). The anchors of the packages
that touch the files changed by the last round of 2.0.4 were checked
again (design, "Context"); A9.3 and A11 are partly closed by that round.

### Round 2

17. Major. The remote open at a target a private removal removed is
    also refused by package 5, since `openArtifactSession` calls
    `assertLaneWriteAtReach` before it describes the target, so in the
    finished tree the `validate.ts` edit of package 3 had no case of its
    own (package 3 runs before package 5, but the finished tree has both
    causes). Resolved (lead's ruling): the edit is kept, with the case
    only it fixes, a remote and a local open on a shared entry whose
    legacy file differs, described as the entry (new scenario, package 3,
    session-target test, proposal "Impact" 3 (c)).
18. Major. The local controls of the private-removal test asserted only
    success, and a local create or move onto a key a private removal
    holds lands in `shared` today (`storedEntryPrivate` answers false for
    a removed key). Resolved (lead's ruling): both local cases assert the
    entry is held in `private`; package 5 says the privacy-from-fold
    helper reads the fold's `privateRemovals`; design R5 and proposal
    "Impact" 3 (e).
19. Minor. `storeWrite` wraps a builder's throw into a `StoreWriteError`;
    name where `storeWriteAtReach` sits. Resolved: package 5 names the
    routed call (`routeLaneWrite`'s `routeWrite(spec)`) and the four
    direct `storeWrite` calls of the move, tree and removal functions.
20. Minor. The batch's base stem must be `allocateEntityId`'s own base.
    Resolved: package 10 adds a sibling in `batch-allocation.ts` that
    computes it; `registry.ts` gets call-site edits only.
21. Minor. Narrowing the recall feedback `events` in the written weights
    would narrow them for a local caller. Resolved: package 15 narrows
    the outcome of `captureRecallFeedback` only.
22. Minor. The dead-end trim skips an overflow entry the caller cannot
    read. Resolved: package 15 runs the trim under `withPrivateShown`
    and narrows the answer only.
23. Minor. The hygiene `refresh` mode does not go through `apply.ts`,
    and `applyHygienePlan` keeps only the message. Resolved: package 14
    names the refresh check in `hygiene-tools.ts` and an `instanceof`
    test where the error is caught.
24. Minor. `wideReadableAtReach` does not exist. Resolved: package 8
    says create and export.
25. Minor. `readLedgerRowsByDevice` answers no partition and hides an
    unreadable shard. Resolved: package 1 reads the ledger per partition
    with `readStreamRecords`; `ledger-rows.ts` is not edited.
26. Minor. `pinnedRecord` has a second caller. Resolved: package 1 keeps
    a compatible form, so the migration's `pinnedText` is not edited.
27. Minor. The discard of unreadable markers is a second entry point.
    Resolved: package 4 calls the reach module from both.
28. Minor. The procedural-label test did not assert the derived title.
    Resolved: it asserts `Tag: client-zeta`; package 2 says so.
29. Minor. Package 21.4 said this change modifies one requirement.
    Resolved: two.
30. Minor. Statements without a test. Resolved: a new scenario and case
    for a remote pinned write of a private text (package 1); a new
    scenario and a guard case for a readable marker naming a private
    entry (package 4, passes already by the 2.0.4 rule); package 11's
    test lists the raised member and the derived memory record; package
    10's test compares raw records for the refused batch; package 9
    says its guard comes before `validateStepText` on purpose.

The per-package notes that asked for something were taken into
`tasks.md`: packages 1 (the marker pair of `brain_feedback`), 3 (the
size of `artifact-ref-resolve.ts`), 5 (the 2.0.4 private-source test
stays a separate case), 6 (no summary or entity page; the row of
`refuseDocumentDeny`), 8 (the local add's slot), 11 (one entry point,
records judged by partition), 13 (the error class by name), 14 (the
census rows in the same commit), 15 (where `candidates` is composed) and
18 (the verbs allowed to differ, listed first).

### Lead's rulings during implementation

31. Package 5, the local rule of finding 18 withdrawn. The first batch
    of the implementation found that it contradicts a product message: a
    removal of a private entry always leaves its removal in `private`, so
    a write or a move onto that key at local reach landed in `private`,
    and the operator's documented way to make a private entry shared
    (remove it, then write it anew; the persona refusal names it) no
    longer worked. Resolved (lead's ruling): at local reach such a key
    follows the ordinary placement rule, as in 2.0.4; below local reach
    nothing changes, and the key is refused with the fixed answer before
    any store write. The privacy-from-fold helper no longer reads the
    fold's `privateRemovals`; the two 2.0.4 tests changed for that rule
    (the persona store test, the setup of the prove-archive test) are
    restored; the local cases of the private-removal test assert the
    2.0.4 placement, and one more local case pins the operator's path.
    The spec requirement "A write decides reach and privacy from the
    fold it writes from" loses its local clause, design R5 records the
    withdrawal, proposal "Impact" 3 (e) is removed, and package 5 says
    so.
32. Package 3, the two scenarios blocked by the files it could edit (a
    failed store-mode question, which threw while the reach view was
    built; an extensionless reference to a shared entry with no vault,
    judged by the view `storeRecordRefView`). Resolved (lead's ruling):
    package 3 also edits `src/core/brain/reach-view.ts` and
    `src/core/brain/store-record-visibility.ts`; below local reach the
    failed question withholds the rows that name a lane-shaped reference
    or a `Brain/` page and the view is still built, and at local reach
    nothing changes.
33. Finding 3 of the code review of packages 1 to 5 (a keyed call below
    local reach whose own records land in `private`, then its retry).
    Resolved (lead's ruling): no code change. A caller below local reach
    that sends a text with a private region gets its records and its
    receipt placed in `private`, as implemented; a retry with the same
    key is answered with the fixed refusal; the first call's records are
    in place and nothing is written twice. Moving the receipt to `shared`
    is rejected: it would carry the id, the path and the payload hash of
    a private record. The `test.failing` case of
    `tests/mcp/lane-reach-residuals-registers.test.ts` is replaced by a
    test that asserts this; the requirement "A machine register and the
    receipt ledger follow the lane rule below local reach" states it with
    one scenario, design "Risks" 8 records it, and task 21.1 names its
    changelog line. That requirement's text was already past the 500
    characters `openspec validate --strict` allows; it is tightened to its
    rules, and its two edge cases (a `private` pinned row that may exist
    unread, a local clear held in `private`) are scenarios of their own,
    each pinned by an existing test of the registers file.

## Verdict

Ready for implementation: yes, once the corrections of round 2 (the
closing review) are in; this revision applies them.
