# Brainstorm: the residuals of the lane reach rule (2.0.5)

## Source

The lead's list of residuals of `lane-private-partition-reach` (2.0.4),
collected from its closure reviews and reports, groups A to E. Every
item of groups A, B and C was checked against the tree before it was
specified (`design.md`, "Verified sequences"). The rule itself is the
write rule of 2.0.4 (archived design, D14) and its guard module
`src/core/store/lane-reach-guard.ts`.

## The lead's rulings (the design source)

1. Scope. In scope: every confirmed item of groups A, B and C; D1, D2 and
   D4 as tooling and structure work; D3 as tests owed; from D5 only the
   comments that are correct and cheap. Work packages run in one order:
   disclosure first, then loss and half-done writes, then the exact
   rules, then tooling. An item too large or too uncertain for a patch
   release goes to "Deferred" with what it needs.
2. B2. A write, a move or a tree operation decides reach and privacy
   from the same fold it writes from, under the lock: the check runs
   again inside the record builder, and a member that became private
   since the first check refuses the whole operation; nothing is dropped
   silently.
3. B3. First ruling: an exclusive create is refused when the fold of
   every partition may miss a record for that lane, at every reach, with
   an error that names the remedy (the doctor). Changed after the first
   review: deferred at local reach, because no repair exists for an
   unreadable shard and the refusal would stop every local create-once
   write with no remedy; below local reach the reach guard already
   refuses (design R6, "Deferred" 4).
4. C1. Hygiene below local reach: per action, the member list (pages
   merged, retired, recompiled, retargeted) is taken from the whole fold;
   a member held in `private` refuses that action before its first
   durable step; the other actions of the same apply proceed; the answer
   names nothing of the private member. The census class `coarse` goes.
5. C2. An error escaping an identity matcher becomes the fixed refusal
   only when the narrowed view does not raise the same class of error.
6. A1 and A2. The pinned register and the checkpoint idempotency ledger
   follow the lane rule: below local reach a private row is neither read
   back nor written over; a retry that meets a private receipt gets the
   fixed refusal.
7. A8. No migration of old review obligations in this release unless it
   is a few lines; otherwise the doctor names them.
8. D1. The census scan resolves import aliases, records the reviewed
   call count per row, and follows a function passed as a value where
   the callee is statically known. D2. The write probe gains a verdict
   for hidden calls, a required successful control, a raw-record
   comparison around a refused call, and identity twins for every
   creating verb.

9. After the first review: a key whose winning record is a removal held
   in `private` is refused below local reach before any store write, in
   `assertLaneWriteAtReach` (package 5); the pinned rule covers the
   `operations` batch mode, and a remote write with no private row goes
   to `shared`; an unreadable `private` idempotency shard fails closed
   below local reach; the three items of group F join (F1 with the
   reference package, F2 with the panel package, F3 as a cost
   requirement).

## What the verification changed

1. A7 (cleanup by source) discloses nothing: the reach predicate reads a
   memory record held in `private` as reserved, so the record is left in
   place. What remains is a half-done cleanup, so its package moves from
   the disclosure group to the loss and half-done group.
2. A6's quarantined-alias half is refuted: the final 2.0.4 code lists
   every quarantined claimant of the name or an alias when the
   resolution is ambiguous. Its test is owed (D3). The batch id half is
   confirmed.
3. A refusal thrown inside a record builder reaches the caller wrapped
   as a store write error with the doctor remedy, not as the fixed
   answer. 2.0.4 already throws there in rare races; B2 moves more checks
   there, so its package also unwraps the refusal.
4. The cross-process conditional append (A10, second half) is deferred:
   it needs a store-level compare-and-append.
