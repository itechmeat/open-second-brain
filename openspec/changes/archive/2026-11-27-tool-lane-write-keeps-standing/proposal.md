# Proposal: a tool's lane write over a human-written entry is kept

## Why

On a switched machine an agent's tool call that rewrites a lane entry an
`o2b` process wrote (an obligation completed, a pledge fulfilled, a
pledge re-anchored, an intention set, a handoff note re-derived, an entity
upserted, a page removed or moved), or that creates an entry again after
an `o2b` process removed it (an obligation or a pledge added again), is
discarded by the lane register, because the `human` record of the `o2b`
process, or its `human` removal, outranks the tool's `agent` record. The
tool still answers success: most sites with the state they computed in
memory, so the next read shows the old state and a retry "succeeds"
again; the entity upsert with the page it reads back, which is the old
entity, so the call reports no error while the alias it was asked to add
is missing. An unswitched machine, and the same action through the CLI,
keep the change. 2.0 switches machines by itself, so every agent on a
converted brain meets this.

## What Changes

- A lane record that replaces or removes the entry this device read, or
  creates an entry where this device read a removal, keeps the standing
  of the record that holds the key: its authority is the stronger of the
  writer's own and the holder's. A moved entry takes the stronger of its
  source's and its destination's holder. A machine that has switched
  behaves like one that has not for a sequential write; the authority
  order still arbitrates versions written apart on two devices.
- A read-modify-write lane writer (the obligation completion, the pledge
  fulfilment, the pledge intake's re-anchor, the intention chain set, the
  entity upsert, relation and archive) passes the version it read; the
  write is refused with a visible error of its own, writing nothing,
  when the store no longer holds that version (another device's version
  arrived in between) or could not be read whole. The check runs in the
  lane writers before the store write, so the caller receives this error
  and its remedy, not a generic store failure.
- Never silent: after every lane write on a switched machine the entry is
  read back; when the store does not hold what was written, the call
  fails with an error that names the entry and the record holding it (a
  version or a removal, and its authority), so no answer reports a state
  the next read will not show.
- A `lane-entry` or `lane-entry-remove` record that keeps a stronger
  standing than its writer's own carries the writer's authority in a new
  optional body field `acted_by`, so the entry's history says who acted.
  Optional field, no format version change.
- The intention chain set and the entity overwrites take the page's lane
  lock, as the other read-modify-write lane writers do, and the entity
  overwrites build on the entity as read under that lock.
- Release: 2.0.5, on top of 2.0.4 (`lane-private-partition-reach`), in
  one pull request and one changelog entry with the change
  `lane-reach-residuals`; the order of work across the two changes is in
  that change's `tasks.md`.
- Below local reach a tool's lane write that meets a holder in `private`
  gets the fixed answer of 2.0.4 and says nothing of the holder: the
  reach check runs before the version check, so the version check never
  tells a remote caller that a private entry changed. A completion or a
  fulfilment of an entry the caller's view does not hold still answers
  as for an absent one (2.0.4).

## Scope

Every lane writer gets the kept standing (D1) and the read-back (D3),
because both live in the lane store layer. The version check (D2) needs a
caller that reads the entry first and passes what it read, so only the
writers named above get it. These read-modify-write lane writers get the
kept standing and the read-back but no version check:

- the decision records (`src/core/brain/decisions/open-store.ts`,
  `src/core/brain/decisions/record.ts`);
- the tensions (`src/core/brain/tensions.ts`);
- the health thesis (`src/core/brain/health/thesis.ts`);
- the gap loop (`src/core/brain/gaps/gap-loop.ts`);
- the triggers (`src/core/brain/triggers/store.ts`).

For them a version another device wrote, arriving between their read
and their write, is overwritten without a refusal. That is acceptable for
this release: the loss this change fixes is the one on a single device,
where every sequential write now lands; the cross-device window is the
same one a machine that has not switched has when two devices edit one
file, the read-back still reports any write the store does not keep, and
giving each of these writers a base is a per-writer change for a later
release.

Out of scope: `src/core/brain/exact-state.ts` (it stores an operator's
exact-state write at `agent`; a different defect, a follow-up), and every
fold other than the lane entries.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lane-entry-fidelity`: what a lane file written on a store-only machine
  reads back as. New requirements: a sequential rewrite, a removal or a
  move keeps the standing of the entry it replaces; a create over a
  removed entry keeps the removal's standing; a retry does not repeat a
  completion or a fulfilment; a version that changed since the read is
  refused visibly; a write the store does not apply fails visibly;
  versions written apart on two devices are arbitrated by the authority
  order; the record names who acted; a machine that has not switched is
  unchanged, but for one improvement: an entity upsert that met a stale
  index keeps the alias another writer added in between there too. The authority rule itself lives in the `brain-store` spec of
  the change `brain-store-and-topics`, still in flight, so it cannot be
  modified from here; these requirements scope its effect on lane
  entries. Release 2.0.4 already holds the requirements of
  `lane-private-partition-reach` in the same capability, and
  `lane-reach-residuals` adds and modifies others in this release; the
  one requirement here about reach states how this change's errors meet
  the fixed answer of 2.0.4, and no requirement is shared.

## Impact

- `src/core/store/lane-standing.ts` (new): `strongerAuthority`,
  `readLaneBase`, the base check, the read-back check,
  `LaneEntryChangedError`, `LaneWriteNotAppliedError`.
- `src/core/store/lane-pages.ts`: call-site edits only. `writeLaneText`
  and `writeLanePage` gain the `replaces` option and call the base check
  first and the read-back last (`writeLanePage`'s `authority` option
  becomes the writer's own authority, still raised to the kept
  standing); `removeLanePage`, `moveLanePage`, `moveLaneTree`,
  `removeLaneTree` keep the standing of what they replace and read back.
- `src/core/store/lane-fold-cache.ts`: `authorities` also holds the
  authority of a removed key's tombstone.
- `src/core/store/lane-entry-store.ts`: `storeEntryRead` answers
  `removed`; `entryRecord`, `tombstoneOf` and `replacedShared` take the
  kept standing.
- `src/core/store/lane-dual-moves.ts` (`laneMoveRecords`,
  `destinationRecords`, `laneRemovalRecords`) passes it.
- `src/core/store/lane-records.ts`: the optional `acted_by` body field.
- Callers: `src/core/brain/obligations.ts` (`completeObligation`),
  `src/core/brain/pledges.ts` (`fulfillPledge`),
  `src/core/brain/pledge-intake.ts` (`rewritePledgeCounterparties`),
  `src/core/brain/intentions.ts` (`setIntention`),
  `src/core/brain/entities/registry.ts` (`upsertEntity`,
  `relateEntities`, `archiveEntity`, `writeEntityFile`), through
  `src/core/brain/entities/locked-write.ts` (new). The entity re-read
  under the lock runs in every mode, so it also changes a machine that
  has not switched: an upsert over a stale index keeps the other
  writer's alias there (the one exception to "unchanged").
- `tests/core/brain/entities/entity-read-census.test.ts`: one row in its
  exclusion table for the re-read in `locked-write.ts`.
- Not changed: the fold (`src/core/store/fold.ts`), the authority of a
  process (`authorityFromOrigin`), `src/core/store/store-write.ts`,
  `src/core/brain/exact-state.ts`, every other entity fold, anything
  under `src/mcp/` or `src/cli/`.
- Docs: `src/core/store/FORMAT.md` (lane-entry records), `docs/brain-store.md`
  (the lane register paragraph), `CHANGELOG.md`.
- Tests: the two existing reproduction files, one new file per other
  site, and one lane-layer file for the rule, the check and the
  read-back.
