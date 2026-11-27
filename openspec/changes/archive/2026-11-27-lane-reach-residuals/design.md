# Design: the residuals of the lane reach rule

## Context

The rule is the write rule of 2.0.4 (archived change
`lane-private-partition-reach`, design D14): code that reads lane state to
decide a write decides from the fold of every partition; below local
reach a write the caller addresses is judged by that fold before its
first durable step, and machine maintenance runs as for a local caller
with only the answer narrowed. The guard module is
`src/core/store/lane-reach-guard.ts` (`assertLaneWriteAtReach`,
`assertWritableInFold`, `pathsAtReach`, `moveSourceAtReach`,
`treeMembersAtReach`, `assertCreateMatchAtReach`, `takenOnWholeFold`,
`assertNoPrivateLaneEntryAtReach`, the fixed answer
`LaneEntryWithheldError`).

"Below local reach" means `privateWithheld()` is true (a remote transport
caller). A "local reader" is a caller at local reach on the same machine.

The sequences were traced again after the last round of 2.0.4, which
changed `artifact-ref-view.ts` (the lane verdict before any disk match,
`unknown` included, now inside `artifactRefView` with `withholdsPrivate`),
`artifact-ref-resolve.ts` (`canonicalLaneSpelling` drops a trailing
slash; `storeLaneEntryAt` returns the canonical spelling),
`reach-view.ts` (passes `withholdsPrivate`), `write-session/engine.ts`
(`submitToSession` guards the target right after loading the session),
`write-session/panel.ts` (a guard for the review-required synthesis
only), `skill-proposals.ts` (one privacy verdict per verifier rejection),
`skill-learn-answer.ts` and `knowledge-lane-tools.ts` (the dismissal runs
in the caller's scope). The anchors below hold on that tree; what the
round closed is said per item.

## Verified sequences

Each item of groups A, B, C and F was traced in this tree. Severity:
D = discloses, loses or corrupts private data; H = duplicates or leaves a
call half done; T = wrong text, count or cost.

1. A1, pinned register (D). Store-only machine holding `private`;
   `pinnedPartition` (`src/core/brain/pinned.ts`) answers `private`. A
   local caller pins a text. A remote `brain_pinned_context` `read`
   (`readStorePinned`) returns that text; `brain_context` returns it too
   (`src/core/agent-context/pinned-block.ts`). A remote `write`, `append`
   or `clear`, and the `operations` batch mode (`applyPinnedOperations`,
   whose `replace` probes the current text for its target), replace it:
   `pinnedRecord` (`src/core/store/dual-write-records.ts`) writes with
   `private-when-held`, so the remote record lands in `private`, and a
   local reader then sees the remote text in its private register.
2. A2, idempotency receipts (D). Store-only machine. A local
   `brain_session_checkpoint` writes signals whose receipt row lands in
   `private`. A remote retry with the same `session_id` and payload:
   `lookupKey` (`src/core/brain/idempotency-ledger.ts`) reads the ledger
   of every partition (`readLedgerRows`, not narrowed) and the checkpoint
   answers `deduped` with the private receipt's signal and summary ids.
   With another payload it throws `IdempotencyPayloadMismatchError`
   carrying the key and twelve characters of the stored hash. The same
   lookup serves `brain_feedback`, `brain_apply_evidence` and
   `brain_write_batch`, so the fix sits in the ledger, not in the
   checkpoint. The callers of `lookupKey` and `rememberKey` are
   `session-checkpoint.ts`, `signal.ts`, `preference.ts`,
   `apply-evidence.ts`, `write-batch.ts`, `mcp/brain/feedback-tool.ts` and
   `idempotency-ledger.ts` itself; a local retry, and a remote retry on a
   store with no `private` receipt, keep their exact answer.
3. A3, procedural labels (D). `ensureEntityNode`
   (`src/core/brain/procedural-graph.ts`) titles an entity node with the
   first tag or trigger spelling it meets (`Tag: <tag>`), under a lossy
   id (`entityNodeId`). A private procedure tagged `Client Zeta` is read
   before a shared one tagged `client-zeta`; both link to
   `ent-tag-client-zeta`. `visibleProceduralGraph`
   (`src/mcp/brain/procedural-projection-filter.ts`) keeps the entity
   node because the shared node links to it, and `show` answers
   `Tag: Client Zeta`, a spelling only the private procedure carries.
4. A4, pledge identity (H, T). `brain_pledge add` passes
   `readableAtContextReach`, whose lane predicate rejects a private
   entry by `laneEntryInPrivate` whatever `withPrivateShown` says
   (`storeLaneReadable`, `src/mcp/brain/reach-readable.ts`). In
   `createPledgePage` (`src/core/brain/pledges.ts`) the title claim and
   the slot reservation are read with that predicate inside
   `withPrivateShown`, so a private pledge whose title is the new
   pledge's base slug (filed under another stem) is not seen: the remote
   create takes the base slot a local create would leave to it (an
   ambiguous slug). The `claim.kind === "base"` branch probes
   `withheldPrivateKey` on the base slot, which that pledge does not
   occupy, so when every other slot is taken the answer is
   "pledge already exists: <slug>" instead of the fixed refusal.
5. A5, panel default name (H). A private same-topic panel of the day sits
   under the other default name. A remote panel session opened with an
   explicit target equal to the fresh default name skips
   `defaultPanelTarget`; at commit, `heldPanelDefaultName`
   (`src/core/brain/write-session/panel-target.ts`, called from
   `panel.ts` and `engine.ts`) reads the caller's narrowed fold, misses
   the private panel, and the commit writes a second panel of the day. A
   private panel written between open and commit is missed the same way.
6. A6, batch id prediction (H). `nextUnallocatedPath`
   (`src/core/brain/entities/batch-allocation.ts`) suffixes the predicted
   stem: a prediction `<base>-2` already taken by an earlier create of
   the batch yields `<base>-2-2`, while the write ladder takes `<base>-3`;
   the staged-review check judges the wrong path, and a refusal met at
   the write leaves the earlier items of the batch written.
   The quarantined-alias half is refuted (see "Refuted").
7. A7, cleanup by source (H). A signal held in `private` derives solely
   from source S. A remote confirmed `brain_delete_by_source` S:
   `treeMembersAtReach` judges only store-held lane entries
   (`storeKeyOf` is null for a memory record), so the private signal
   refuses nothing; the reach predicate reads it as reserved
   (`readCachedFrontmatterEntry`), so it is left. The shared derivations
   are removed and the private one stays: the cleanup is half done
   where the rule says a private member refuses it whole.
8. A8, old review obligations (D, known). A review obligation written
   before 2.0.4 for a decision now held in `private` stays in `shared`
   with the decision's title in its own title. The narrowed fold shows
   it to a remote caller, and every peer holding `shared` keeps it.
9. A9, references.
   1. (D) `inspectExistingTarget` (`write-session/validate.ts`) reads the
      disk file at a target; a write-session open answers its bytes, hash
      and first heading (`engine.ts`, the open envelope). On a switched
      machine a frozen legacy file at a target whose store entry was
      removed by a record held in `private` is answered to a remote
      caller. `commitArtifact` (`engine.ts`) also reads the disk:
      `existsSync` refuses a `create` as an existing target and a `merge`
      reads the frozen file's bytes into the artifact. Not closed by the
      last round. (Once package 5 refuses a key whose winner is a private
      removal, the remote open and commit of this sequence get the fixed
      answer; the store-entry reading is still needed for a removal held
      in `shared`, at every reach.)
   2. (T) The claim graph caps its nodes before the caller's visibility
      filter (`claim-graph.ts`, `knowledge-claim-tools.ts`): with more
      than 5,000 claims, most withheld, the caller gets few or no shared
      claims and `truncated: true`.
   3. (D) A bare id with an inner space while the fold is incomplete, and
      a store-mode detection that throws, resolve to "none" and the row
      is shown (the fail-open side). Partly closed by the last round: a
      reference whose lane match is `unknown` is now withheld even when a
      disk file resolves. Still open: `idShaped` rejects an inner space,
      so the space case answers `none`, not `unknown`; `storeLanesOf`
      catches a throwing store-mode question and answers "lane pages are
      files", so `laneRefMatch` answers `none`. The throwing detection is
      to be produced by the package's test.
   4. (T) With no vault, an extensionless `Brain/` reference is hidden
      when its `.md` twin resolves. Not closed: the last round only adds
      a hiding verdict before the old one.
   5. (T) A shared lane id ending in `.md` is hidden as a miss (2.0.4
      claim test control, recorded). Not closed, for the same reason.
10. A10, skill-accept markers (D, loss). A remote
   `recover` with `discard_unreadable` deletes an unreadable marker a
   local recovery needs; an unreadable marker makes `recover` throw with
   its path, which names the proposal's slug. The cross-process
   conditional append is deferred.
11. A11, failed lane lookup (T, plausible). `artifactRefView`
   (`src/core/brain/artifact-ref-view.ts`) has no guard around
   `resolveArtifactRef`: a lookup that throws ends the whole report for
   every caller. Partly closed: `laneRefMatch` catches a throw of the
   lane lookup and answers `unknown`, which the view now withholds below
   local reach; `resolveArtifactRef` (its directory probes, the store
   memory read of `artifactPath`) is still unguarded. The listing that
   throws (an events
   directory that cannot be listed) is to be produced by the package's
   test first; if it cannot be, the package closes the item as refuted.
12. B1, ingest ledger order (H). `brain_ingest_source` under a permissions
   document: `resolveWriteDisposition` (`write-disposition.ts`) appends
   its decision ledger row, then `assertStagedTargetsAtReach` (in
   `ingest.ts`) or the intake's identity check (`assertUpsertsAtReach`
   and the staged check inside `intakeExtraction`,
   `src/core/brain/intake/extract-intake.ts`) refuses with the fixed
   answer. The row stays for a call that wrote
   nothing else.
13. B2, check-then-write windows (D). In `src/core/store/lane-pages.ts`:
   `writeLanePage` with `overwrite` checks reach on one read and builds
   its record later; a local writer that raises the entry to `private`
   between them lets a remote text replace a private entry.
   `moveLanePage` computes `isPrivate` before `storeWrite`; at local reach
   a source raised meanwhile is moved with the stale flag, its text
   written into `shared`; below local reach `moveSourceAtReach` returns
   null and the move silently writes nothing. `moveLaneTree` and
   `removeLaneTree` list members on one fold (`treeMembersAtReach`) and
   filter them silently on another (`pathsAtReach`), so a member raised
   meanwhile is left behind and the folder is split. A refusal thrown
   inside a builder reaches an MCP caller as `StoreWriteError`
   (`store-error`, doctor remedy), not as the fixed answer
   (`asStoreWriteError`, `src/core/store/store-write.ts`).
14. B3, exclusive create on an incomplete fold (D, deferred at local
   reach). Local reach, a
   `private` shard unreadable: `withCreateLock` tests only
   `storeEntryRead(...).value`, null for a key held by a record the fold
   cannot see, and the create appends over it (2.0.4 claim test 7: a
   second write session takes the first one's id). When the shard
   becomes readable the newer record wins and the private entry is lost.
   Below local reach `assertLaneWriteAtReach` runs first inside the lock
   and refuses on such a fold. See R6.
15. C1, hygiene (T). `brain_hygiene` apply and refresh call
   `assertNoPrivateLaneEntryAtReach`: below local reach they are refused
   whenever any lane holds a live private entry, whatever the action
   touches. Twelve census rows carry class `coarse`; the duplicate
   detector `document-dedup.ts` was never traced.
16. C2, error masking (T). In `assertCreateMatchAtReach` any error from
   `matches` becomes the fixed refusal when `privateLaneEntryMayExist`,
   which is always true on a machine whose lane pages are files; a remote
   caller on such a machine gets the fixed refusal instead of a
   `ResearchValidationError` or an `ObligationError` its own view raises
   too.
17. C3, counts and caps (T). A remote `brain_dead_ends record` leaves an
   overflow entry it cannot read active, so the cap holds only after a
   local record. `brain_trigger scan` counts in `candidates` a finding
   skipped because of a private trigger (`triggers/create-at-reach.ts`).
   A remote dry run of a cleanup by source answers as if no private
   member existed while the confirmed call is refused.
18. C4, recall feedback (T). The answer's `events` counts every feedback
   event the machine holds, private ones included (`learned.events`,
   `src/core/search/feedback.ts`; the tool is registered in
   `src/mcp/search-tools.ts`).
19. A private removal under a remote write (D). `assertLaneWriteAtReach`
   refuses a key only when it is live in `private` (`liveInPrivate`); a
   key whose winning record is a removal held in `private` is not in
   `fold.entries`, so it passes. A remote `brain_obligation add` of that
   title (`addObligation` → `writeLaneText` without `exclusive`) writes a
   record at the key, and so does a write-session open or commit on such
   a target. Today the `agent` record loses to a `human` removal; once
   `tool-lane-write-keeps-standing` keeps the removal's standing, the
   record wins and replaces the private removal. Found by the first
   review.
20. F1, lane path spelling (T). `storeLaneEntryAt`
   (`artifact-ref-resolve.ts`) rejects an empty segment before it
   canonicalizes, so a direct caller passing `Brain//decisions/<id>.md`
   gets `null`. Both callers normalize first, so no active path shows it.
21. F2, panel submit (H). `submitToPanelSession`
   (`write-session/panel.ts`) guards only the review-required synthesis;
   a persona step, an invalid step, a colliding synthesis or a
   direct-commit synthesis saves the session, a failed attempt or a
   metric before the refusal (the target itself stays guarded by
   `commitArtifact`). `submitToSession` guards right after loading.
22. F3, reference cost (T, cost). Below local reach on a store-only
   machine `artifactRefView` runs `laneRefMatch` for every distinct
   reference (each call asks `wholeLaneStoreFold`, a read with a stat of
   every shard), an unplaced reference a second time, and a bare id a
   third time through `artifactPath` → `laneIdPath`; a string that cannot
   be a lane reference still reads the fold.

## Refuted

1. A6, quarantined alias. `upsertMatches`
   (`src/core/brain/entities/registry.ts`) lists, when the resolution is
   ambiguous, every quarantined claimant of the name or of an alias; a
   private alias claimant is then a match and refuses the call with the
   fixed answer, and when the resolution is not ambiguous the local and
   the remote answer agree. No sequence remains. The test of the
   neutralized-alias half is owed under D3.

## Decisions

### R1. Registers and receipts follow the lane rule (A1, A2)

Lead's ruling on the first review for A1: the rule covers the
`operations` batch mode, and a remote write when no `private` row exists
goes to `shared`. For A2: below local reach a keyed call meets the fixed
refusal while the `private` ledger may miss a row; a local call is
unchanged.


Below local reach the pinned register of this machine is `shared` even
when the machine holds `private`: a read answers the `shared` register
(or nothing) and names it, and every writing form (`write`, `append`,
`clear`, and the `operations` batch with every operation, `replace`
included) gets the fixed refusal before it reads anything while the
`private` register holds a record, a clear included, or may hold one the
read could not fold (an unreadable `private` `events` shard, or a
`private` pinned record whose blob has not arrived: fail closed) (the
remote caller must not overwrite or learn of it). When it holds none, the record goes to `shared`:
`pinnedRecord` takes the partition from its caller (`private-when-held`
at local reach, `private` there for a text judged private, as today, and
`shared` below local reach). Below local reach the text is judged on what
the caller may read only: a text naming a private page goes to `shared`
like any other (landing in `private` would tell a private page from an
open one by the outcome, and would lock every remote writer out), and a
text carrying a private region is refused with the fixed answer before
anything is written; a pinned record never lands in `private` from below
local reach (lead ruling on the code review of packages 1 to 5). So the remote write is not lost to a local reader, a local
read on a machine holding `private` falls back to the `shared` register
while the `private` register holds no record (today it answers nothing
there). `lookupKey` gains the partition of the row it found (a sibling
reader over `readLedgerRowsByDevice`'s partition loop); below local
reach a match held in `private` throws `LaneEntryWithheldError` before
any answer or write, for every caller of the ledger. While the `private`
ledger may miss a row (an unreadable shard or a pending blob of that
partition) a keyed call below local reach is refused the same way (fail
closed: the caller's key may match the row that cannot be read); a
local call is unchanged. Rejected: answering "unseen" for a private
receipt (the retry would write a second copy of the operation).

### R2. A derived label comes from what the caller may read (A3)

`visibleProceduralGraph` retitles a kept entity node from its id
(`Tag: <slug>`, `Trigger: <slug>`) when any node it drops links to that
entity, and answers it under an id of that answer (`ent-retitled:<n>`, by
its place in the answer), since the stored id keeps the entity's spelling
as a slug; its kept edges are rewritten to that id (lead ruling on the
code review of packages 1 to 5). A local caller's ids are unchanged. Rejected: storing per-source titles in the persisted projection
(a format change for a label).

### R3. References fail closed below local reach and are not over-hidden (A9, A11)

A reference the resolver cannot judge (an incomplete fold for a bare id
with a space, a store-mode detection that throws, a lane lookup that
throws) is withheld below local reach and judged as today at local
reach; the lookup failure is caught per row in `artifactRefView`. The
claim graph filters before it caps. A shared lane id ending in `.md` and
an extensionless reference whose twin is shared are judged by the lane
match, not hidden as a miss. A lane-shaped string admits an inner space,
and a failed store-mode question answers `unknown`. `storeLaneEntryAt`
canonicalizes before it splits and rejects (F1). A write-session open on
a store-only machine answers the target's metadata from the store entry
at the caller's reach, never from a frozen file, and `commitArtifact`
takes a store-held target's existence (the `create` collision) and text
(the `merge`) from the store entry the same way. Rejected: withholding every
unjudgeable reference at local reach too (local answers would shrink).

### R4. Device-local markers the caller may not read are left (A10)

Below local reach the skill-proposal recovery neither discards nor names
an unreadable accept marker: it leaves it silently. The answer carries no
count of the markers left (a count would disclose that they exist), so
`src/mcp/brain/procedure-tools.ts` is not changed. Rejected: refusing the whole recovery
(a remote caller could not recover readable markers).

### R5. Reach and privacy are decided from the fold the write builds from (B2)

Lead's ruling. Inside the record builder of `writeLanePage` (overwrite),
`writeLaneText`, `moveLanePage`, `moveLaneTree` and `removeLaneTree`, the
reach check runs again on the one fold the records are built from, under
the lane lock of the addressed paths, and the partition of each record
comes from that fold. A member or source that became private since the
first check refuses the whole operation; `pathsAtReach` and
`moveSourceAtReach` no longer drop silently below local reach (new
throwing forms in `lane-reach-guard.ts`). A `LaneEntryWithheldError`
raised inside a builder reaches the caller as itself: a guard wrapper
(`storeWriteAtReach` in `lane-reach-guard.ts`) unwraps it from the
`StoreWriteError`, so `store-write.ts` is unchanged. Consequence: a
local caller whose move source is raised meanwhile writes the moved
entry into `private`. Lead's ruling on the first review: below local
reach `assertLaneWriteAtReach` and `assertWritableInFold` also refuse a
key whose winning record is a removal held in `private`
(`fold.privateRemovals`), before any store write (sequence 19). A
removal or a move source at such a key has nothing to remove and is left
to the live-entry rule. This refusal is the rule `tool-lane-write-keeps-standing`
D7 relies on, delivered here because this package may edit the guard
module and runs first. Lead's ruling during implementation: a local rule
that sent a write or a move onto a key whose winning record is a removal
held in `private` into `private` was considered and withdrawn, because it
would remove the operator's way to make an entry shared (remove it, then
write it anew), so at local reach such a key follows the ordinary
placement rule, as in 2.0.4. Rejected: a lock spanning check and append
across processes (that is the deferred conditional append).

### R6. An exclusive create on an incomplete lane fold stays as released at local reach (B3)

Lead's ruling on the first review: deferred at local reach. No repair
exists for an unreadable shard (the doctor reports
`store-shard-unreadable` and names no command; the shard quarantine
covers corrupt lines and aged pending blobs only), so a refusal would
stop every local create-once write with no remedy until the shard reads
again. The released behaviour stays at local reach until a shard repair
exists. Below local reach nothing changes: `assertLaneWriteAtReach` runs
first inside `withCreateLock` and already refuses on such a fold. What
the deferral needs is in "Deferred" 4.

### R7. A refused call leaves no durable trace (B1)

`ingestSource` resolves its disposition verdict without recording it,
runs every reach check (staged targets, the summary identity, and the
intake's identity pre-check, which `extract-intake.ts` exports for it),
then records the disposition row. `submitToPanelSession` checks its
target right after loading the session, before any step is saved (F2).
A hygiene apply that applied nothing because every action was refused
for reach appends no audit record (R11). Rejected: removing the row
after a refusal (a ledger is append-only).

### R8. Identity decisions use the caller's identity rule on the whole fold (A4, A5, A6)

`assertCreateMatchAtReach`'s widening of the reach predicate becomes an
export (`wideReadableAtReach`); the pledge title claim and slot
reservation run with it inside `withPrivateShown`; a base claim the
narrowed view does not make sets the private hold. The panel commit and
the engine commit ask `heldPanelDefaultName` through
`assertCreateMatchAtReach`. The batch prediction walks the write's own
ladder from the unsuffixed base: `nextUnallocatedPath` cannot tell a
collision suffix from an entity whose own slug ends in `-2`, so
`assertUpsertsAtReach` (`registry.ts`, call site only) passes it the
base stem. New logic lives in sibling modules
(`pledge-create-reach.ts`, `panel-target.ts`, `batch-allocation.ts`).

### R9. A cleanup by source counts memory records (A7)

The member check of a confirmed cleanup lists the derived memory records
(preferences, signals) beside the lane entries and refuses the whole
call below local reach when one is held in `private`; the dry run gives
the same refusal (C3). Rejected: removing the private record (a remote
caller would delete private data).

### R10. Old review obligations are named, not migrated (A8)

Lead's ruling. Moving a shared record into `private` is a migration over
every review obligation with a judge and a store write per machine,
not a few lines; and peers keep the shared history anyway. The doctor
gains an advice that counts, at local reach, shared review obligations
whose decision is held in `private`, and says that removing and
recording the review again locally writes it in `private`. The package
first checks whether a local update already re-places the record; if so
the advice says that instead.

### R11. Hygiene is judged per action (C1)

Lead's ruling. Each hygiene action lists its members on the whole fold
before its first durable step: merge (kept and dropped preference, the
pages whose links are retargeted), supersede (the claim's entity record),
recompile and refresh (the page and the pages it rederives or archives),
archive and forget (the page), retire (the copies, the canonical page and
every page whose links are retargeted), and a duplicate group from
`hygiene/detectors/document-dedup.ts` with every member it would have on
the whole fold. A member held in `private` (or a fold that may miss a
record) makes that action's entry in `errors` the fixed answer; other
actions proceed. `apply.ts` appends its audit record only when an
action was applied or an error other than a reach refusal occurred.
`assertNoPrivateLaneEntryAtReach` is removed, and each `coarse` census
row gets its traced class. Rejected: refusing the whole apply (the
released coarse rule).

### R12. Masking keeps the caller's own errors (C2)

Lead's ruling. On an error from `matches` inside `withPrivateShown`, the
guard runs `matches` once more with the caller's own predicate outside
that scope; when it raises an error of the same class, that error is
thrown; otherwise the fixed answer. A `LaneEntryWithheldError` stays the
fixed answer.

### R13. Counts and caps agree with what the caller may read (C3, C4, A9.2)

The dead-end trim runs on the whole fold as D14 kind 3 says and archives
a private overflow entry within `private`; the answer counts what the
caller reads. The trigger scan does not count in `candidates` a finding
skipped for a private trigger (`triggers/scan.ts` sets `candidates`,
`create-at-reach.ts` knows the skip). Recall feedback answers `events`
from the `shared` events below local reach (`src/core/search/feedback.ts`),
while the weights stay folded from every partition. The claim graph filters before its
cap. The cleanup dry run gives the confirmed call's refusal.

### R14. Tooling (D1, D2, D4)

Lead's ruling for D1 and D2. The census scan resolves `import { x as y }`
and namespace imports, records per row the number of calls of the
primitive in the function it reviewed (a later extra call fails the
census test), and follows a function passed as a value when its callee
is a statically known identifier. The write probe gives `:hidden` calls
a verdict, requires the paired successful control of every refused call,
compares the raw records of both partitions before and after each
refused call, and seeds identity twins for every creating verb. Both
probes compare list counts with a shared-only twin: every count, total
and list length a list or count verb answers below local reach equals
what the same verb answers at local reach on a store holding only the
fixture's `shared` records (the read probe,
`tests/mcp/lane-private-partition-reach-probe.test.ts`, joins package
18 for this and for the `attention_flows` operations). D4 moves
`addMatches`, `slotPlanOf` (`obligations.ts`), `pledgeCreateMatches`,
`sameIdentityAt` (`pledges.ts`), `upsertMatches`, `assertUpsertAtReach`,
`assertUpsertsAtReach` (`entities/registry.ts`),
`assertStagedTargetsAtReach` (`pending/pending-lanes.ts`) and
`verifierRejectionIsPrivate` (`skill-proposals.ts`) into sibling modules,
leaving re-exports.

### R15. A reference is judged with one fold read (F3)

Below local reach the view computes one lane match per distinct
reference and hands it on (to the unplaced fallback and to the bare-id
path of `artifactPath`), and a string that cannot name a lane entry
(empty, spanning lines, longer than any lane id, a path outside
`Brain/`) is judged without a fold read. A bare id with an inner space
stays lane-shaped (R3). Rejected: one fold for the whole answer (a
complete fold is asked again so a write the scope outlives is seen;
that choice of 2.0.4 stands).

## Deferred

1. The cross-process conditional append (A10, second half): it needs a
   store-level append that checks a fold fingerprint under the shard
   lock, a design and a format review of its own. R5 narrows the window
   to the interval between the builder and the append.
2. A migration of old review obligations into `private` (A8): see R10.
3. The 210 census rows with no handler ancestor (D1, last clause): they
   need a call graph through the MCP registration tables; this release
   records the count in the census header and keeps the rows reviewed by
   hand.
4. B3 at local reach (sequence 14, R6). What it needs: first a repair
   for an unreadable shard (a doctor fix or a shard quarantine command
   that releases it), then the refusal of a create-once write while the
   lane fold of every partition may miss a record, naming that remedy.
   The create-once writes it would stop (callers of `withCreateLock` with
   `createOnce`): `writeLaneText` with `exclusive: true` (write-session
   open, `write-session/store.ts`; the health thesis create,
   `health/thesis.ts`; pending review staging, `pending/pending-lanes.ts`;
   the trusted source archive capture, `provenance/source-archive.ts`,
   which a trusted `brain_ingest_source` needs) and `writeLanePage`
   without `overwrite` (dead ends, `dead-ends.ts`; entity create,
   `entities/registry.ts`; captures, `capture/capture-note.ts`; the gap
   loop, `gaps/gap-loop.ts`; attention flows, `attention-flows.ts`;
   design notes, `design-note.ts`; the foresight verb,
   `cli/brain/verbs/foresight.ts`; the portability import,
   `portability/okf.ts`; the skill-proposal creates,
   `skill-proposals.ts`). Obligations, pledges, decisions and open
   decisions add through `writeLaneText` without `exclusive`, so they are
   not create-once writes and the deferral does not concern them; the
   first version of this design listed them wrongly.

## Risks

1. R6 leaves the released loss in place at local reach: a create-once
   write on a machine with an unreadable shard may land on a key a record
   of that shard holds. Accepted until a shard repair exists ("Deferred"
   4); the doctor reports the shard.
2. R5 changes where a refusal is raised; a caller that caught
   `StoreWriteError` for a refusal now sees `LaneEntryWithheldError`.
   Only below local reach, where that is the answer the requirement asks
   for.
3. R11 runs more fold reads per hygiene action; the fold is cached by
   fingerprint, one read per apply.
4. R1 changes the answer of a remote pinned read on a machine with a
   private register (empty instead of the private text). That is the
   rule. A local reader on a machine holding `private` now reads the
   `shared` register while its `private` register holds no record (a
   remote write, or a pin from a peer holding only `shared`); with a
   `private` record it reads as before.
5. R1 refuses every keyed remote call (every checkpoint) while the
   `private` ledger may miss a row. Accepted: the key cannot be judged;
   the doctor reports the shard; a local call is unchanged.
6. R5 refuses a remote create at a key a private removal holds, which
   2.0.4 let through (its record then lost to a `human` removal, or
   replaced an `agent` one). A remote caller cannot tell that refusal
   from any other fixed answer.
7. Both changes of the release edit `lane-pages.ts`; the order of
   `tasks.md` ("Order across the two changes") keeps each edit on top of
   the one it needs.
8. R1 keeps the receipt of a keyed call below local reach with the
   call's own records: when they land in `private` (a checkpoint whose
   signal carries a private region), so does its receipt, and the
   caller's retry with the same key gets the fixed answer, with the first
   call's records in place and nothing written twice (lead's ruling on
   finding 3 of the code review of packages 1 to 5). Rejected: placing
   that receipt in `shared`, which would carry the id, the path and the
   payload hash of a private record.
