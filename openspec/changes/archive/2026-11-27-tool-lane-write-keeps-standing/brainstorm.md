# Brainstorm

## Problem

On a machine whose lane pages live in the store (a switched machine), a
lane entry is one register resolved by authority, then clock. Every `o2b`
process writes at `human` (the CLI dispatcher claims the `cli` channel for
every verb but `mcp` and the imports, `o2b tool-call` and hooks included),
every MCP tool call at `agent`. A tool call that rewrites a whole entry an
`o2b` process wrote (an obligation completed, a pledge fulfilled) appends
an `agent` record that the `human` one outranks: the fold keeps the old
version, the tool answers the state it computed in memory, the next read
shows the old state, and a retry "succeeds" again. The same call on a
machine that has not switched, and the same action through the CLI, work.
Reproduced by `tests/core/brain/obligations-completion-authority.test.ts`
and `tests/core/brain/pledges-fulfil-authority.test.ts` (4 cases fail, 4
controls pass).

## Related work

No other change in flight under `openspec/changes/` touches the lane
writers; `brain-store-and-topics` holds the store's base spec
(`brain-store`, "Mutable entities resolve by authority then time") and
stays as it is. The last two releases (2.0.1, 2.0.2) and the fix after
them do not touch `src/core/store/lane-pages.ts`,
`src/core/store/lane-entry-store.ts` or `src/core/store/fold.ts`. The one
writer that already keeps a replaced entry's standing is the privacy
restamp (`src/core/brain/privacy-marker-restamp.ts`, through the
`authority` option of `writeLanePage`).

Since this was written, the change `lane-private-partition-reach`
shipped as 2.0.4: it changes which lane entries a reader below local
reach sees and how a write addressed to a withheld entry answers, edits
the lane write primitives this change edits, and its requirements are in
`lane-entry-fidelity`. This change ships with `lane-reach-residuals` as
2.0.5 and builds on both; it does not edit the reach guard module (see
`tasks.md`, the opening note and section 0, and design D7).

## Doubts

1. Whether keeping the standing contradicts a stated purpose of the
   authority order (a human decision must not be undone by an agent).
2. The window between a caller's read and its write, when another
   device's human version arrives by sync inside it.
3. Removals and moves: the tombstone is a record of the same register
   and loses the same way.
4. Writes that do not read first (the handoff note re-derived in place).
5. A record stamped far ahead of this machine's clock, which the receive
   rule ignores, so a local write can still order before it.
6. Who acted, once the record carries a standing that is not the
   writer's own.
7. The unswitched machine and its dual-write mirror must not change.

## Approaches considered

1. Keep the standing (lead). A lane record that replaces or removes the
   entry this device read takes the stronger of the writer's own
   authority and the authority of the record that holds the entry; a
   read-modify-write passes the version it read and is refused, visibly,
   when the store no longer holds it. Evidence: `writeLanePage` already
   takes `authority` "for a rewrite that keeps the standing of the record
   it replaces", used by the privacy restamp with the authority of
   `readLaneEntrySnapshot`, whose `unchanged()` is the compare step. The
   store's clock already orders a write after every record it read
   (`clock-store.ts`, receive rule over the read floor). Cost: one rule in
   the lane store layer, one option, a few call sites.
2. Raise the tool's authority (author). Stamp an MCP tool call made on
   the user's explicit request as `human` (the format allows it: `human`
   is "a command, a tool call made on the user's explicit request").
   Rejected: the server cannot tell an explicit request from an agent's
   own decision, so every tool call would become `human`, an agent's
   write would outrank a person's on another device, and the topic tool's
   design (an agent's goal stays a proposal under the user's) would break.
3. A separate completion record kind (author). Store completions and
   fulfilments as their own records (a `lane-entry-event`), folded by
   clock alone, as the signal lifecycle already is ("a lifecycle is a
   sequence of moves"). Rejected for this release: a format addition,
   new folds and readers for two lanes, and it leaves the intake, the
   intention chain, the handoff note, the entity upsert and every
   removal broken; it is the right shape if a lane ever needs per-field
   merging across devices.
4. A visible refusal only (author). Keep the authority order as it is and
   make every lane write that the fold would not apply fail with an
   error, as the schema settings writers already refuse an agent change
   the fold would ignore. Rejected as the fix: a switched machine would
   still behave unlike an unswitched one, and an agent could never
   complete a pledge a hook or `o2b tool-call` wrote. Kept as the safety
   net under approach 1 (decision 3 below).

## Decision

Approach 1, with approach 4 as its net. The principle check holds for
lane entries: the stated purposes of the authority order are entity
specific (a preference field, a topic field, a schema setting entry, a
pinned context: `src/core/store/FORMAT.md` "Preferences", the topic tool
and settings decisions of `brain-store-and-topics`), and none of them is a
lane entry. For lane entries the design's stated goal is parity with an
unswitched machine (`lane-pages.ts`: "works the same in both modes"), and
the standing-rule lane is always `human` whoever writes it. The store
already resolves a lifecycle by clock alone for signals, for the same
reason. So the rule is scoped to `lane-entry` and `lane-entry-remove`
records and changes no other fold.

1. Every lane record that replaces or removes the entry this device holds
   when the record is built takes the stronger of the writer's own
   authority and that entry's authority; nothing is weakened.
2. A read-modify-write takes the entry's version under its lane lock
   before its own read and passes it; the write is refused with a visible
   error, writing nothing, when the store no longer holds that version or
   the read was not whole.
3. After every lane write on a switched machine the store layer reads the
   entry back; when the fold does not hold what was written the call
   fails, naming the entry and the authority that holds it.
4. A record that keeps a stronger standing than its writer's own names
   the writer's authority in an optional body field, so the entry's
   history says who acted.

## Rejected

1. Raise the tool's authority: the server cannot tell a user's explicit
   request from an agent's decision.
2. A completion record kind: a format and fold addition for two lanes,
   leaving five other sites broken.
3. A visible refusal alone: the switched machine would still differ from
   the unswitched one for an ordinary completion.
4. A rule in the fold (latest record wins for lane entries): it would
   also let a concurrent agent version from another device beat a human
   one, which the register exists to arbitrate.

## Process

Author only, inside the decisions of the change's lead; the reproduction
run that produced the two failing test files is the evidence base. No
independent partner round was run in this pass; the independent review
(`review.md`) is the first outside attack on the approach and must run
before implementation.
