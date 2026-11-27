# Proposal: close the residuals of the lane reach rule

## Why

Release 2.0.4 (`lane-private-partition-reach`) withholds lane entries held
in the `private` partition from callers below local reach and makes a
write decided from lane state decide from every partition. Its closure
reviews left a list of paths where that rule is not yet exact: a caller
below local reach can still read back a private pinned text or a private
idempotency receipt, see the spelling of a private tag, write over an
entry that became private between a check and the write, or leave a
refused call half recorded, or write over a key a private removal holds;
and hygiene is refused whole below local reach whenever any lane holds a
private entry. Each item was checked against the tree before it was
specified (`design.md`, "Verified sequences").

## What changes

1. Disclosure. The pinned register and the idempotency receipt ledger
   follow the lane rule below local reach (no read-back, no overwrite of
   a private row, the `operations` batch included; a remote write with
   no private row goes to `shared`; a retry that meets a private
   receipt, or a private ledger that cannot be read in full, gets the
   fixed refusal). The procedural graph names an entity node that a withheld
   node also reaches by its id, not by a withheld tag's spelling. A
   reference the resolver cannot judge is withheld below local reach,
   one it can judge is not over-hidden, a lane path with a redundant
   separator names its entry, a write-session open and commit read
   their target from the store, and a failed lookup withholds the row
   instead of ending the report. Unreadable skill-accept markers
   are left for a local caller. A write, a move and a tree operation
   judge reach and privacy again inside the record builder, from the fold
   they write from, and a refusal raised there reaches the caller as the
   fixed answer; a key whose winning record is a removal held in
   `private` refuses a remote write like a live private entry.
2. Loss and half-done writes. An ingest records its disposition only
   after its reach checks, the intake's included, and a panel step is
   judged before anything of it is saved. The pledge
   title claim and slot reservation, the panel default-name hold and the
   batch id prediction decide on the whole fold the way the write does. A
   cleanup by source counts memory records among the members that refuse
   it whole. The doctor names review obligations written before 2.0.4
   whose shared copy carries a private decision's title.
3. Exact rules. Hygiene below local reach is judged per action, from the
   action's member list on the whole fold; the census class `coarse`
   goes. The identity matcher masks an error only when the caller's own
   view does not raise the same class of error. Counts and caps answered
   below local reach (dead-end cap, trigger scan candidates, recall
   feedback events, claim graph truncation, the cleanup dry run) agree
   with what the caller may read. Judging the references of an answer
   reads the lane fold once per reference, and not for a string that
   cannot name a lane entry.
4. Tooling and structure. The census scan resolves import aliases,
   records the reviewed call count, and follows functions passed as
   values. The write probe gains a verdict for hidden calls, a required
   successful control, a raw-record comparison around each refusal, and
   identity twins for every creating verb. Tests owed by 2.0.4 are
   written. Helpers 2.0.4 added inside files past 700 lines move to
   sibling modules. Correct and cheap review comments on the 2.0.4 tests
   are taken.

## Scope

In scope: every confirmed item of groups A, B and C of the lead's list
except B3, the three items of group F, the private-removal rule found by
the first review, D1, D2 and D4, D3 as tests owed, and the D5 comments
listed in `tasks.md`. Out of scope and recorded in `design.md`
("Deferred"): the cross-process conditional append, a migration of old
review obligations into `private`, B3 at local reach (no repair exists
yet for an unreadable shard), and the A9 item of a store-mode detection
that throws when its failure cannot be produced in a test (the package
then closes it as refuted).

## Non-scope

No change of the store format, of the fixed answer's text, or of any
tool's argument schema. The partition rules for local callers change
only where "Impact" item 3 says.

## Impact

1. Code: `src/core/store/lane-reach-guard.ts`, `src/core/store/lane-pages.ts`
   (call sites only), `src/core/brain/pinned.ts`,
   `src/core/brain/idempotency-ledger.ts`, `src/core/brain/procedural-graph.ts`
   or `src/mcp/brain/procedural-projection-filter.ts`, the reference
   resolver (`src/core/brain/artifact-ref-view.ts`,
   `artifact-ref-resolve.ts`), `src/core/brain/write-session/` (validate,
   panel, engine), `src/core/brain/ingest/ingest.ts` (call sites),
   `src/core/brain/pledges.ts` and `src/core/brain/entities/registry.ts`
   (call sites, new sibling modules), `src/core/brain/source-cleanup.ts`
   (call sites), `src/core/brain/intake/extract-intake.ts`,
   `src/core/brain/write-disposition.ts`,
   `src/core/store/dual-write-records.ts` (`pinnedRecord`), the doctor,
   the hygiene tool and its actions, the claim graph tool, the dead-end
   trim, the trigger scan, the recall feedback answer
   (`src/core/search/feedback.ts`), the skill-proposal recovery.
2. Tests: one failing test per verified sequence, under `tests/mcp/` with
   the prefix `lane-reach-residuals-`, and the census and probe files of
   2.0.4.
3. Behaviour for local callers: unchanged, except: (a) on a machine
   holding `private` whose `private` pinned register holds no record, a
   local read answers the `shared` register (A1); (b) the doctor gains
   an advice counting shared review obligations of a private decision
   (A8); (c) on a store-only machine a write-session open and commit
   judge a store-held target from the store entry, so a frozen legacy
   file at a removed target no longer blocks a `create` or feeds a
   `merge`, and an open on a shared entry describes the entry, not a
   legacy file left at its path (A9.1); (d) a local move whose source is
   raised to `private` while it builds writes the moved entry in
   `private` instead of `shared` (B2). An exclusive create on a fold that
   may miss a record behaves as released (B3 is deferred).
4. Release: 2.0.5, one pull request and one changelog entry together
   with `tool-lane-write-keeps-standing`.
