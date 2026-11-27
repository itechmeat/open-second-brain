# Tasks: the residuals of the lane reach rule

First read `CLAUDE.md` and `openspec/project.md`, then this folder:
`proposal.md`, `design.md` (the sequences and the decisions R1 to R15),
the spec delta `specs/lane-entry-fidelity/spec.md`, and `brainstorm.md`
(the lead's rulings). Search with `zg --rg -F "<text>"` or
`git grep -n` before opening a file. Tick each box as soon as it is done.

Every package: write its failing test first, run it and see it fail for
the reason the package names, then write the code, then run the done
command. When the code does not match a sequence of `design.md`, stop at
that package and report. A package whose reproduction cannot be made to
fail closes its item as refuted, with the reason, and changes no code.

## Rules for every package

1. English only; no exclamation marks; "Open Second Brain" in full; no
   machine paths, host or account names in the repository.
2. Files past 700 lines get call-site edits only (an option, a call, an
   import, a re-export): `src/core/store/lane-pages.ts`,
   `src/core/brain/obligations.ts`, `src/core/brain/pledges.ts`,
   `src/core/brain/entities/registry.ts`,
   `src/core/brain/pending/pending-lanes.ts`,
   `src/core/brain/skill-proposals.ts`, `src/core/brain/source-cleanup.ts`,
   `src/core/brain/ingest/ingest.ts`, and any other file `wc -l` shows past
   700. New logic goes into the sibling module the package names. No file
   under 700 lines may cross 700.
3. New tests live in `tests/mcp/lane-reach-residuals-<topic>.test.ts` and
   reuse `tests/mcp/lane-private-partition-reach-store-fixture.ts`,
   `-writes-fixture.ts` and `-maintenance-fixture.ts`. Each test pairs the
   remote case with a local control, and every refused call compares the
   raw records of both partitions before and after.
4. Do not edit the tests of 2.0.4 except where a package names them. Do
   not touch `src/core/store/fold.ts` or `src/core/store/dual-write.ts`.
5. Done command of a package: `bun test <its test files> --timeout 30000`
   and `bunx tsc --noEmit -p .`. The whole suite runs once, in the release
   package.

## Order across the two changes

Both changes ship as 2.0.5 in one pull request on top of 2.0.4. Run, in
this order:

1. This change, packages 1 to 5 (disclosure). Package 5 changes the
   record builders of `lane-pages.ts` that `tool-lane-write-keeps-standing`
   then extends, adds `storeWriteAtReach`, and makes
   `assertLaneWriteAtReach` and `assertWritableInFold` refuse, below local
   reach, a key whose winning record is a removal held in `private`. It
   uses nothing of the other change.
2. `tool-lane-write-keeps-standing`, sections 0 to 4. It delivers
   `LaneEntryChangedError`, `LaneWriteNotAppliedError` and
   `src/core/store/lane-standing.ts`. Its task 3.4 (the reach rule of the
   base check) uses `winnerHeldInPrivate` and `assertHolderReadableAtReach`
   (2.0.4) and relies on package 5's refusal of a private removal; its
   task 4.2 adds the reach rule of the read-back it builds there.
3. This change, packages 6 and 8 to 20 (package 7 is withdrawn: B3 is
   deferred). None of them uses a name of the other change.
4. The release package (21) of this change, which also runs section 5 and
   section 6 of `tool-lane-write-keeps-standing` as one release.

No package needs a name a later one delivers: package 5 needs only 2.0.4
names; tool-lane task 3.4 needs package 5 and 2.0.4; tool-lane task 4.2
needs its own task 4.1; packages 6 and 8 to 20 need only 2.0.4 names and
packages 1 to 5.

## Group 1. Disclosure

- [x] 1. Registers and receipts (A1, A2; design R1; spec "A machine
  register and the receipt ledger follow the lane rule below local
  reach").
  1. Failing test first: `tests/mcp/lane-reach-residuals-registers.test.ts`:
     the six scenarios of that requirement. The pinned write scenario
     runs each single operation (`write`, `append`, `clear`) and the
     `operations` batch mode with a `write`, an `append` and a `replace`
     (the `replace` must be refused before it reads the private text).
     The scenario of a remote pinned write of a private text: with no
     `private` pinned record, the record lands in `private`, a remote read
     answers none of the text, and a local read answers it (it fails today
     on the remote read only). Superseded by the lead ruling on the code
     review of packages 1 to 5: below local reach a text carrying a
     private region is refused before anything is written, and a text
     naming a private page lands in `shared` like one naming an open
     page; a pinned record never lands in `private` from below local
     reach. The keyed-call scenario makes the `private` ledger shard unreadable
     the way `tests/mcp/lane-private-partition-reach-store-fixture.ts`
     makes a shard unreadable, and runs the local control on the same
     store.
  2. Create `src/core/brain/idempotency-reach.ts` (the partition of a
     matching row, whether the `private` ledger may miss a row, and the
     reach check). It reads the idempotency ledger of each partition
     itself with `readStreamRecords` (`src/core/store/read/stream-read.ts`),
     keeping each row's partition and each partition's `unreadable` shards:
     `readLedgerRowsByDevice` (`src/core/store/read/ledger-rows.ts`)
     answers no partition and drops `unreadable` unless `strict`, which
     throws for an unreadable `shared` shard too, so it is neither used
     nor edited here. Edit
     `src/core/brain/idempotency-ledger.ts` (`lookupKey` calls it),
     `src/core/brain/pinned.ts` (below local reach: the read and the name
     use the `shared` register; `writePinnedContext`, `appendPinnedContext`,
     `clearPinnedContext` and `applyPinnedOperations` refuse before their first
     read while the `private` register holds a record; at local reach on
     a machine holding `private`, the read falls back to the `shared`
     register while the `private` one holds no record) and
     `src/core/store/dual-write-records.ts` (`pinnedRecord` takes the
     partition its caller decides: `private-when-held` at local reach,
     `shared` below it, `private` for a text judged private). Keep a
     compatible form: the boolean third argument is still accepted with
     today's meaning (`true` gives `private`, `false` gives
     `private-when-held`), so its second caller, `pinnedText` in
     `src/core/store-migration/row-records.ts` (the migration's import of
     the legacy pinned file), is not edited.
  3. Do not touch the callers of `lookupKey` or the ledger format.
     `brain_feedback` reads the marker pair again after a deduped signal
     (`src/mcp/brain/feedback-tool.ts`); a marker receipt held in
     `private` is refused there too, with nothing written: expected.
- [x] 2. Procedural labels (A3; R2; spec "A derived label below local
  reach comes only from what the caller may read").
  1. Failing test: `tests/mcp/lane-reach-residuals-procedural-label.test.ts`;
     the remote case asserts the exact title derived from the node's id
     (`Tag: client-zeta` for `ent-tag-client-zeta`), not only the absence
     of the private spelling.
  2. Edit `src/mcp/brain/procedural-projection-filter.ts` only (retitle a
     kept entity node any dropped node links to). Do not change the
     persisted projection.
- [x] 3. References (A9.1, A9.3, A9.4, A9.5, A11, F1, F3; R3, R15; spec
  "A reference below local reach is withheld when it cannot be judged and
  shown when it can" and "Judging the references of an answer reads the
  lane fold once per reference").
  1. State of the tree (the last round of 2.0.4): `artifactRefView` now
     asks `laneRefMatch` first below local reach (`withholdsPrivate`) and
     withholds `unknown` and private matches even when a disk file
     resolves; `laneRefMatch` catches a throw of the lane lookup itself
     and answers `unknown`. What is still open: a bare id with an inner
     space is not lane-shaped (`idShaped`), so it answers `none` on an
     incomplete fold; `storeLanesOf` turns a throwing store-mode question
     into "lane pages are files" (`none`); a throw of `resolveArtifactRef`
     (its directory and store memory reads) is not caught; the `.md` id
     and the extensionless twin are judged after the lane verdict as
     before; `storeLaneEntryAt` rejects an empty segment before it
     canonicalizes (F1); the view calls `laneRefMatch` twice for an
     unplaced reference and `artifactPath` a third time for a bare id
     (F3).
  2. Failing tests: `tests/mcp/lane-reach-residuals-refs.test.ts` (bare id
     with a space on an incomplete fold; a store-mode question made to
     throw; a shared `.md` id with and without a vault; an extensionless
     reference to a shared entry with no vault; `storeLaneEntryAt` of
     `Brain//decisions/<id>.md` and of a path with a trailing slash; a
     throw of `resolveArtifactRef` made by a directory that cannot be
     listed), `tests/mcp/lane-reach-residuals-session-target.test.ts` (the
     frozen file at a removed private target, for the open; a remote and
     a local open on a shared entry whose legacy file differs, which must
     describe the entry, not the file; the frozen file at a removed target
     for a local `create` and a local `merge` commit) and
     `tests/mcp/lane-reach-residuals-ref-cost.test.ts` (the
     cost scenario: count the calls of `wholeLaneStoreFold` with `spyOn`
     on the imported module namespace, no production seam; when the spy
     cannot see the calls, stop and report).
  3. Edit `src/core/brain/artifact-ref-view.ts` (one lane match per
     reference, passed on; the `resolveArtifactRef` call guarded per
     row), `src/core/brain/artifact-ref-resolve.ts` (a lane-shaped test
     that admits an inner space and rejects what cannot name a lane entry
     before any fold read; the store-mode failure answers `unknown`;
     `storeLaneEntryAt` canonicalizes, then splits and rejects),
     `src/core/brain/write-session/validate.ts` (target metadata from the
     store entry at the caller's reach on a store-only machine: `bytes`,
     `content_hash` and `first_heading` of the entry's text as
     `readLaneText` answers it, none for an absent entry) and
     `src/core/brain/write-session/engine.ts` (`openArtifactSession` and
     `submitToSession` call it; `commitArtifact`'s create collision check
     and merge read take a store-held target's existence and text from
     the store entry, not from `existsSync` and `readFileSync` of the
     path). Lead's ruling during implementation: also edit
     `src/core/brain/reach-view.ts` (below local reach a failed store-mode
     question no longer throws while the view is built: the lane verdict
     withholds every lane-shaped reference, a `Brain/` page is withheld,
     and a page outside `Brain/` is judged by its own file; at local reach
     nothing changes) and `src/core/brain/store-record-visibility.ts`
     (below local reach with no vault, a `Brain/` path is judged as the
     page of the entry its lane match names, so an extensionless spelling
     is judged as its `.md` twin). Where the commit writes is not changed
     here; the test records where a committed artifact lands on a
     store-only machine, and a
     store-held target written as a file is reported, not fixed. A11
     closes as refuted when no lookup can be made to throw.
     `artifact-ref-resolve.ts` (557 lines) stays under 700. The open at a
     target a private removal removed is refused after package 5 by the
     reach guard `openArtifactSession` already calls
     (`assertLaneWriteAtReach`, before the target is described), so in
     the finished tree that case does not prove the `validate.ts` edit:
     the open on a shared entry whose legacy file differs is the case only
     that edit fixes, and the edit is kept for it.
  4. Do not change local answers: the local control of each case must
     pass before and after, except the two local commit cases and the
     local open on a shared entry whose legacy file differs, of the
     session-target test, which change on purpose (proposal, "Behaviour
     for local callers").
- [x] 4. Skill-accept markers (A10 first half; R4; spec "A device-local
  marker the caller may not read is left for a local caller").
  1. Failing test: `tests/mcp/lane-reach-residuals-accept-markers.test.ts`.
     It also holds a readable marker naming a proposal held in `private`
     (the second half of the requirement): a guard of the 2.0.4 rule
     (`journalWithheldAtReach`) that passes already and must keep passing.
  2. Create `src/core/brain/skill-accept-reach.ts`; call it from both
     entry points in `src/core/brain/skill-proposals.ts` (call sites
     only): `recoverSkillProposalAccepts` and
     `discardUnreadableSkillAcceptJournals`, which the MCP handler calls
     first when `discard_unreadable` is set.
     The answer carries no count of the markers left (design R4); do not
     edit `src/mcp/brain/procedure-tools.ts`.
- [x] 5. Builders judge from the fold they write from (B2; R5; spec "A
  write decides reach and privacy from the fold it writes from").
  1. Failing tests: `tests/mcp/lane-reach-residuals-builder-race.test.ts`:
     the four race scenarios, the raise injected between the first check
     and the builder by a hook the fixture installs on the fold read (no
     production seam: a test double of the fold cache module through the
     existing fixture, or a second writer process); and
     `tests/mcp/lane-reach-residuals-private-removal.test.ts`: the
     scenario "A remote write over a key a private removal holds is
     refused" through the MCP tools (`brain_obligation add` of a title
     whose key a removal held in `private` holds, a `writeLaneText`
     create, a move onto that key), each with a local control that
     succeeds, and the raw records of both partitions compared before and
     after each refused call. The local controls assert the 2.0.4
     placement (a shared text lands in `shared`), and one local case
     removes a private persona and sets it again as shared, which is
     shared: the operator's way to make an entry shared (lead's ruling
     during implementation, `review.md`).
  2. Edit `src/core/store/lane-reach-guard.ts`: `assertLaneWriteAtReach`
     and `assertWritableInFold` refuse a key whose winning record is held
     in `private`, a live entry or a removal (`fold.privateKeys` for a
     live entry, `fold.privateRemovals` for a removal); throwing forms of
     `pathsAtReach` and `moveSourceAtReach` for the tree and move
     builders; a privacy-from-fold helper (the rule of
     `storedEntryPrivate`, read from that fold); and `storeWriteAtReach`
     (unwraps a `LaneEntryWithheldError` from a `StoreWriteError`:
     `storeWrite` wraps
     anything a builder throws into a `StoreWriteError` with the
     store-error reason and the doctor remedy, the original as `cause`).
     Edit `src/core/store/lane-pages.ts` call sites only: `writeLanePage`,
     `writeLaneText`, `moveLanePage`, `moveLaneTree`, `removeLaneTree`,
     `removeLanePage` use them inside their builders. The call sites of
     `storeWriteAtReach`: the one routed call, `routeLaneWrite`'s
     `routeWrite(spec)`, through which `writeLanePage` and `writeLaneText`
     build, and each direct `storeWrite` call of `removeLanePage`,
     `moveLanePage`, `moveLaneTree` and `removeLaneTree`. A throwing
     `moveSourceAtReach` turns `moveLanePage`'s `source === null` branch
     from a drop into a refusal for a source raised meanwhile; a source
     already private at the first read keeps the 2.0.4 answer for an
     absent source, and its 2.0.4 test stays a separate case.
  3. Do not touch `src/core/store/store-write.ts`. Run the tests of 2.0.4
     that create below local reach (`tests/mcp/lane-private-partition-reach-*.test.ts`
     whose names say create, writes or identity); a case that created
     over a private removal and now gets the fixed answer is listed in
     the report with its reason, and changed only when it asserted the
     create.

## Group 2. Loss and half-done writes

- [x] 6. Ingest ledger order (B1; R7; spec "A refusal below local reach
  comes before the call's first durable step", first scenario).
  1. Failing test: `tests/mcp/lane-reach-residuals-ingest-ledger.test.ts`,
     both scenarios of that requirement about an ingest: the staged
     target held in `private`, and an extracted entity whose identity an
     entity held in `private` claims (the refusal raised inside
     `intakeExtraction` today, after the row). The intake case also
     asserts that no summary or entity page is written.
  2. Edit `src/core/brain/ingest/ingest.ts` (call sites: resolve the
     verdict, run the reach checks, then record), the disposition module
     that appends the row (`src/core/brain/write-disposition.ts`: split
     "decide" from "record"; read `resolveWriteDisposition` first), and
     `src/core/brain/intake/extract-intake.ts` (export its reach
     pre-check of the extracted entities, `assertUpsertsAtReach` and the
     staged-target check, as one function `ingest.ts` calls before it
     records the row; `intakeExtraction` keeps calling it, a second call
     on an unchanged fold refusing nothing new). `refuseDocumentDeny`
     (`write-disposition.ts`) records a row too; confirm, and say in the
     report, that no path below local reach meets a reach refusal after
     it.
7. Withdrawn. B3 (an exclusive create on a fold that may miss a record)
   is deferred at local reach (design R6 and "Deferred" 4); below local
   reach `assertLaneWriteAtReach` already refuses such a create. The
   number is kept so the review's references stay valid. No test, no
   code.
- [x] 8. Pledge identity (A4; R8; spec "An identity decision below local
  reach applies the caller's identity rule to the whole fold", first two
  scenarios).
  1. Failing test: `tests/mcp/lane-reach-residuals-pledge-claim.test.ts`
     through the MCP tool (`brain_pledge add`), so the predicate is the
     transport's one. Where the first scenario allows success, the remote
     add must land on the slot a local caller's add takes on the same
     store (the local control records that slot).
  2. Create and export `wideReadableAtReach` in
     `src/core/store/lane-reach-guard.ts` (it does not exist; the widened
     predicate is inline in the identity matcher today);
     create `src/core/brain/pledge-create-reach.ts`; edit
     `src/core/brain/pledges.ts` call sites only.
- [x] 9. Panel default name and panel submit (A5, F2; R8, R7; the third
  scenario of "An identity decision below local reach applies the
  caller's identity rule to the whole fold" and "A refused panel step
  leaves nothing of the step").
  1. Failing tests: `tests/mcp/lane-reach-residuals-panel-hold.test.ts`
     (the default-name hold, opened by default and with an explicit
     target) and `tests/mcp/lane-reach-residuals-panel-submit.test.ts`
     (a persona step, an invalid step, a colliding synthesis and a
     direct-commit synthesis below local reach on a target held in
     `private`: the fixed answer, and the session record, the failed
     attempts and the metrics file unchanged; a local control each).
  2. Edit `src/core/brain/write-session/panel-target.ts` (a reach-judged
     form of `heldPanelDefaultName`), `panel.ts` (its call; and in
     `submitToPanelSession` one unconditional `assertLaneWriteAtReach` on
     the target right after the session is loaded, as `submitToSession`
     does, replacing the guard of the review-required synthesis only; it
     runs before `validateStepText`, as the spec scenario "A refused panel
     step leaves nothing of the step" intends: an invalid step on such a
     target gets the fixed answer, not its validation errors) and
     `engine.ts` (its call in `commitArtifact`).
- [x] 10. Batch id prediction (A6; R8; fourth scenario and "A batch
  refused at one item leaves no earlier item").
  1. Failing test: `tests/mcp/lane-reach-residuals-batch-id.test.ts`,
     with a case whose entity slug itself ends in `-2` (its own base,
     not a collision suffix), and the scenario "A batch refused at one
     item leaves no earlier item": the raw records of both partitions
     compared before and after the refused batch.
  2. Edit `src/core/brain/entities/batch-allocation.ts`
     (`nextUnallocatedPath` takes the unsuffixed base stem and walks the
     write's ladder from it; a new sibling there computes the base id of a
     category and name, the one `allocateEntityId` starts its ladder
     from) and `src/core/brain/entities/registry.ts` (call sites only:
     `allocateEntityId` takes its base from that sibling, and
     `assertUpsertsAtReach` passes the base of the identity it predicted
     from that sibling, never a suffix stripped from the predicted path:
     a slug that ends in `-2` keeps it in its base; `allocateEntityId`
     answers only the final id).
- [x] 11. Cleanup by source members (A7, and the dry run of C3; R9; the
  modified scenario "A tree or a cleanup with a private member is refused
  whole").
  1. Failing test: `tests/mcp/lane-reach-residuals-cleanup-members.test.ts`:
     a member held in `private`, a member raised to `private` between the
     first check and the write, a derived memory record (a preference or
     a signal) held in `private`, and the dry run of each, with the raw
     records of both partitions compared and a local control each.
  2. Create `src/core/brain/source-cleanup-reach.ts`; edit
     `src/core/brain/source-cleanup.ts` call sites only. `deleteBySource`
     is the one entry point; today it judges lane paths only and a dry
     run is not gated. The derived memory records are store records,
     judged by their partition, not through `treeMembersAtReach`.
     `refuseDocumentDeny` runs first; the row it records is the
     document's.
- [x] 12. Old review obligations (A8; R10; spec "Review obligations
  written before the reach rule are named by the doctor").
  1. First establish whether a local update of such an obligation
     re-places it in `private` (a test in
     `tests/mcp/lane-reach-residuals-old-review.test.ts`); write the advice
     text from the answer.
  2. Failing tests in the same file: the local doctor case, and the
     remote doctor case on the same store (zero such obligations, no
     name, title or path of the obligation or the decision in the
     answer).
  3. Add one doctor check module beside the existing store checks
     (`src/core/brain/doctor/`), registered where the others are.

## Group 3. The exact rules

- [x] 13. Error masking (C2; R12; spec "An identity matcher's error is
  masked only when the caller's own view does not raise it").
  1. Failing test: `tests/mcp/lane-reach-residuals-masking.test.ts`; it
     asserts the error class by name.
  2. Edit `src/core/store/lane-reach-guard.ts` only.
- [x] 14. Hygiene per action (C1; R11; the modified requirement "A write
  decided from lane state below local reach decides from every
  partition", its scenario "A bulk lane verb is refused while a lane
  holds a private entry" (kept heading, per-action body) and "Hygiene
  with no private member runs as before").
  1. Trace `src/core/brain/hygiene/detectors/document-dedup.ts` and record
     its rows.
  2. Failing test: `tests/mcp/lane-reach-residuals-hygiene.test.ts`, one
     case per action (merge, supersede, recompile, archive, forget,
     retire with retarget, refresh, a duplicate group); a remote apply
     whose findings have no private member while another lane holds a
     private entry (every action applied, as for a local caller); and a
     remote apply whose every action is refused (no hygiene audit record
     appended).
  3. Create `src/core/brain/hygiene/members-at-reach.ts`; edit
     `src/core/brain/hygiene/apply.ts` (the per-action check, and no
     `appendAuditRecord` when nothing was applied and every error is a
     reach refusal; `applyHygienePlan` keeps only `error.message`, so the
     loop records whether each error is an `instanceof
     LaneEntryWithheldError` where it catches it) and
     `src/mcp/brain/hygiene-tools.ts` (the `refresh` mode does not go
     through `apply.ts`: its per-action member check over `plan.entries`
     sits in the refresh branch of `hygiene-tools.ts`, before
     `executeRecompile`); remove `assertNoPrivateLaneEntryAtReach` and its
     test `tests/mcp/lane-private-partition-reach-coarse.test.ts`; give the
     twelve `coarse` rows of `tests/mcp/lane-private-partition-reach-census.tsv`
     (they cite `-coarse.test.ts`) their traced class in the same commit
     as the removal.
- [x] 15. Counts and caps (C3, C4, A9.2; R13; spec "Counts and caps
  answered below local reach agree with what the caller may read" and
  "The claim graph filters before it caps").
  1. Failing test: `tests/mcp/lane-reach-residuals-counts.test.ts`.
  2. Edit `src/core/brain/dead-ends.ts` (`trimActive` skips today an
     overflow entry the caller cannot read, and `moveLanePage` refuses a
     withheld source: the trim runs as the machine's maintenance under
     `withPrivateShown`, as `triggers/create-at-reach.ts` runs its create,
     and only the answer is narrowed),
     `src/core/brain/triggers/create-at-reach.ts` and
     `src/core/brain/triggers/scan.ts` (where `candidates` is set; it is
     composed from the raw candidate list, so the edit may belong in
     `create-at-reach.ts`), the recall feedback answer in
     `src/core/search/feedback.ts` (the answered `events` counts the
     `shared` events below local reach while the weights stay folded from
     every partition: `learned` is the persisted weights record read
     back, so `events` is narrowed on the outcome of
     `captureRecallFeedback` only, never in the weights it writes, or a
     remote call would narrow them for a local caller),
     `src/mcp/brain/knowledge-claim-tools.ts` and
     `src/core/brain/claim-graph.ts`. `src/mcp/search-tools.ts` (past 700
     lines, where the tool is registered) is not edited.

## Group 4. Tooling and structure

- [x] 16. Helpers out of long files (D4; R14). Move `addMatches`,
  `slotPlanOf`, `pledgeCreateMatches`, `sameIdentityAt`, `upsertMatches`,
  `assertUpsertAtReach`, `assertUpsertsAtReach`,
  `assertStagedTargetsAtReach`, `verifierRejectionIsPrivate` and
  `continuityPrivacyJudge` into
  sibling modules (`obligation-create-reach.ts`, the
  `pledge-create-reach.ts` of package 8, `entities/upsert-reach.ts`,
  `pending/staged-reach.ts`, `skill-learn-reach.ts`), with re-exports.
  Done: the identity tests of 2.0.4 (`tests/mcp/lane-private-partition-reach-identity-*.test.ts`)
  and the type check; `wc -l` of each source file shrinks.
- [x] 17. Census scan (D1; R14). Failing test first in
  `tests/mcp/lane-private-partition-reach-census.test.ts`: an aliased
  import, a second call in a listed function, a function passed as a
  value. Edit `tests/mcp/lane-private-partition-reach-census-scan.ts` and
  the `.tsv` (a reviewed call count column; the header records the rows
  with no handler ancestor).
- [x] 18. Write and read probes (D2; R14). Edit
  `tests/mcp/lane-private-partition-reach-probe-write.test.ts`,
  `-probe-write-plan.ts`, `-probe-writers.ts`, `-probe-identity.ts` and
  the read probe `tests/mcp/lane-private-partition-reach-probe.test.ts`:
  a verdict for `:hidden` calls, the required successful control, the
  raw-record comparison, twins for every creating verb, the
  `attention_flows` `evaluate` and `render` operations of the read probe,
  and the shared-only list-count comparison: for every list or count verb
  the probes call below local reach, a twin store holding only the
  `shared` records of the fixture answers the same call at local reach,
  and each count, total and list length of the remote answer must equal
  the twin's (a mismatch fails naming the verb and the field; a verb
  that may differ on purpose is listed in the plan with its reason, and
  that list is written before the twin comparison).
- [x] 19. Tests owed by 2.0.4 (D3): the feedback check on an unswitched
  vault, the neutralized-alias half of the staged intake, the pledge
  reservation, `brain_truth state` with a private lexicon (finish
  `tests/mcp/lane-private-partition-reach-prove-truth.test.ts` if it is in
  the tree, else a new file), the design note at local reach. Each test
  passes; one that fails is a defect: stop and report.
- [x] 20. Review comments on the 2.0.4 tests (D5): take these, each
  re-checked against the code first and dropped with a one-line reason
  when wrong:
  1. `tests/mcp/lane-private-partition-reach-fold.test.ts`: assert the
     remote session list succeeds; assert the remote claim history keeps
     the shared claim.
  2. `tests/mcp/lane-private-partition-reach-refs.test.ts`: require the
     private obligation record, not only the decision record.
  3. `tests/mcp/lane-private-partition-reach-identity-spelling.test.ts`:
     reject private paths in the remote answer.
  4. `tests/mcp/lane-private-partition-reach-probe.test.ts`: scan resource
     listing metadata for canaries; fail the resource probe when listing
     fails.
  5. `tests/mcp/lane-private-partition-reach-probe-write.test.ts`: match
     the complete refusal message; wait for timed-out calls before
     cleanup.
  6. `tests/mcp/lane-private-partition-reach-probe-writers.ts`: fail
     seeding when the recorded decision has no id.
  7. `tests/mcp/lane-private-partition-reach-probe-write-plan.ts`:
     separate call targets for the private proposal states; register the
     private attention flow's title as a canary.
  8. `tests/mcp/lane-private-partition-reach-census-scan.ts`: scan calls
     on the function declaration line.
  9. `tests/mcp/lane-private-partition-reach-writes.test.ts`: reuse the
     shared incomplete-fold fixture.
  10. `tests/mcp/lane-private-partition-reach-readers.test.ts`: compare
      private state before and after each refused write.
  11. `tests/mcp/lane-private-partition-reach-maintenance-fixture.ts`:
      assert proposal learning succeeds.
  Not taken: the comments on `batch-allocation.ts` and
  `triggers/create-at-reach.ts` (carried by packages 10 and 15), on
  `src/mcp/brain/procedure-tools.ts` (a product change that needs its own
  sequence), on the 2.0.4 changelog entry and on archived artifacts
  (history is not rewritten).

## 21. Release (both changes, version 2.0.5)

- [x] 21.1 `CHANGELOG.md`: one entry `## [2.0.5] - <date>` above
  `## [2.0.4]`, with the lines of this change and of
  `tool-lane-write-keeps-standing` (its section 5.2), and the link
  reference `[2.0.5]: https://github.com/itechmeat/open-second-brain/compare/v2.0.4...v2.0.5`
  above the `[2.0.4]` line at the bottom. One line says, under package 1,
  that while a `private` idempotency ledger shard cannot be read in full
  (unreadable, or a record whose blob has not arrived) every keyed call
  below local reach is refused with the fixed answer, keys never seen
  included, so a `brain_write_batch` carrying a keyed item aborts whole:
  by design (fail closed; the caller's key may match the row that cannot
  be read). Another line under package 1 says that a keyed call below
  local reach whose text carries a private region keeps its receipt in
  `private` with its records, so the caller's retry with the same key
  gets the fixed answer and writes nothing twice: by design (a `shared`
  receipt would carry the id, the path and the payload hash of a private
  record).
- [x] 21.2 Set `package.json` `version` to `2.0.5`, run
  `bun run scripts/sync-version.ts`, then
  `bun run scripts/sync-version.ts --check` exits 0.
- [ ] 21.3 The gate of `tool-lane-write-keeps-standing` section 6, once,
  for both changes.
- [x] 21.4 Archive inside the pull request, this change first:
  `openspec archive lane-reach-residuals --yes`, then
  `openspec archive tool-lane-write-keeps-standing --yes`. Both add
  requirements to `lane-entry-fidelity`, and this change modifies two.
  Check the merged spec: `openspec validate lane-entry-fidelity --type spec --strict`
  passes; `grep -c "^### Requirement:" openspec/specs/lane-entry-fidelity/spec.md`
  equals the count before the archives (21) plus 11 (this change's
  ADDED) plus 10 (the other change's ADDED), that is 42; each of the two
  modified requirements appears once, "A write decided from lane state
  below local reach decides from every partition" with the per-action
  hygiene scenario and without the coarse text, and "An update below
  local reach of a private-partition lane entry acts as on an absent one"
  with the folder refused whole; each requirement heading of both deltas
  appears exactly once.
- [ ] 21.5 Report: every package's failing-then-passing output, items
  closed as refuted, files past 700 lines and their line counts before
  and after, the tests of 2.0.4 that changed and why.
