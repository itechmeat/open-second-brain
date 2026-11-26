# Independent review

## Round 1: the first artifacts

Reviewer: an independent agent of another model family than the author,
read-only, on the first version of `proposal.md`, `design.md`, the spec
delta and `tasks.md` (the shared rule alone), with the checks of the
`osb` schema.

Verdict of the round: not ready for implementation (three blockers and
majors; one minor).

Findings and their resolution in this revision:

1. Blocker: lane readers that bind no reach rule (`brain_entity`, the
   procedural graph and hints, the skill proposal and rewrite readers,
   `brain_write_session`) carry private-partition entries, contrary to
   the first design's "no sibling leaks". Confirmed by failing tests
   (paths file, path 1). Resolved by the fold choke point (design D3) for
   every live lane read, and by the read-time projection filter (D5) for
   the procedural graph and hints. The skill proposal, rewrite and
   recurrence readers are covered by D3 by construction; the reseeded
   probe (D9) is their evidence (recurrence reads a ledger, not lane
   pages).
2. Blocker: `brain_trigger` judges only a trigger's references, never its
   own page, and transitions a hidden trigger; bare-id references to
   store-held entries (receipts naming a decision) resolve to nothing and
   read as visible, with and without a vault. Confirmed (paths 2 and 3).
   Resolved: the trigger by D3 (the trigger is not in the caller's fold,
   so list, history and every transition answer as for an absent id and
   nothing is written) and D4; the references by D6 (the resolver finds
   store-held lane entries in the whole fold and the view judges them by
   their record) and D7 (the write-side judge counts them).
3. Major: the write-verb contract contradicted the code (create-over-slug
   verbs refuse, `compare` is a read, `resolve` and `discard` of open
   decisions missing), and a duplicate `open` names the hidden decision.
   Resolved by the verb table of D4: update, transition and removal verbs
   answer as for an absent entry; create-style verbs reach the guard and
   get one fixed answer naming nothing, with the residual stated in the
   design's limits and the follow-up named in the proposal; `compare` is a
   read; resolve and discard are update verbs. The duplicate refusal finds
   no duplicate under D3 (path 4, D8).
4. Major: table rows reading `ctx.vault` crash on a machine with no vault,
   and `brain_dead_ends` was missing. State of the done part: the readers
   test runs every row in both modes; for a reader that reads `ctx.vault`
   (the brief views, lifecycle, the knowledge readers that use it, the
   reach-event readers) the no-vault run answers with the vault-required
   refusal, which the row accepts, so that run is no evidence. The
   no-vault runs that are evidence are those of the readers that use the
   lane vault (pledges, obligations, decisions, tensions, intentions,
   triggers, procedural memory, design notes, bridges, clusters, dead
   ends). `brain_dead_ends` is covered (path 5, guard). This revision adds
   no-vault cases where the change depends on the mode: the cache split
   (task 2.1 item 1) and the reference judge (task 5.1 item 3); the fold
   choke point itself does not depend on a vault.
5. Major: the per-request memo can go stale after a write inside one
   request, and the cost bar was a wall-clock ratio. Resolved: the memo is
   removed (D1 item 2; with one fold read per page it saves nothing a
   cache hit does not); the cost check is deterministic (D10: the two
   folds are cached apart and reused, one fold read per verdict).
6. Minor: a `Brain/` path naming no lane entry throws in `readLanePage`
   rather than returning null; `ctx.configPath` is not passed; the bundle
   command pinned a runner version. Resolved: D1 items 3 and 4 with a test
   (task 7.1); the bundle is rebuilt with `bun run build:openclaw`, and it
   is needed now because the bundle contains the reference resolver
   (task 9.3).

Not checked by the round, now assigned: the transitive lane reads of the
brief views and the knowledge readers (covered by D3 by construction and
by the probe); non-listed callers of the shared rule (covered by D3).

## Round 2: the choke-point revision

Reviewer: an independent agent of another model family than the author,
read-only, on the revision built around the fold choke point (design D3),
against the code at the head of the branch.

Verdict of the round: not ready for implementation (three blockers,
three majors, one minor). Round-1 findings 3 to 6 are closed; findings 1
and 2 are partly closed (their open parts are findings 1 to 3 below).

Each code fact was checked by the author before this revision.
Findings and their resolution:

1. Blocker: the procedural memory index (`Brain/procedural-memory/index.json`)
   is one store lane entry naming every procedure; once the judge counts
   store-held private entries (D7) one private procedure places it in
   `private`, and under D3 a caller below local reach then lists no
   procedure at all; and the projection rebuilds that `brain_procedural_memory
   reconcile` and the skill proposal verbs start below local reach ran
   on the narrowed fold. Confirmed (`procedural-memory.ts`
   `writeProjections`, `skill-proposals.ts` `rebuildProceduralProjections`
   and the `learn` rebuild). Resolved by design D5 items 3 and 4: the
   listing reads the index whole and, below local reach, keeps only the
   entries whose page the caller's fold holds and that are not private
   (the smaller option; the index as machine state would change what is
   synced); every rebuild (`reconcileProceduralMemory`,
   `rebuildProceduralGraph`, `rebuildProceduralHints`) runs inside
   `withPrivateShown` itself, so every tool that starts one builds whole
   and answers filtered counts (table per tool in D5 item 4).
2. Blocker: the D5 graph filter did not handle the synthetic `entity`
   nodes (`sourcePath: null`) and `proposal` nodes, and misdescribed the
   hint entries. Confirmed (`procedural-graph.ts`, `procedural-hints.ts`).
   Resolved: the two-pass filter as the reviewer specified (D5 item 1,
   task 4.2), with a test for the entity nodes (task 4.1 item 2).
3. Blocker: D6 wired the lane rule into `artifact-ref-view.ts`, which
   holds no reach and no scope, while the views that hold them were not
   to be edited. Confirmed. Resolved: the store record lookup the reach
   and owner views already consult returns a `VisibilityRecord` for a
   store-held lane entry of the whole fold (D6 item 2, task 5.3); the
   resolver finds store-held decisions, sources and entities (by id in
   any category folder) and extensionless `Brain/` paths (D6 item 1);
   `claimSourceIsPrivate` asks the whole fold too (D7 item 2). No view
   file is edited.
4. Major: `entityOfRecord` reads every partition's shards outside the
   fold (an existence answer for a private record id); the two gap
   reporters (`standing-rules.ts`, `store-unreachable.ts`) were pointed at
   the whole fold and would name `private` shards below local reach; the
   dream text asked for a pass inside `withPrivateShown` that the code
   already refuses. Confirmed. Resolved: `entityOfRecord` reads `shared`
   only under the scope; the gap reporters read the caller's fold for the
   verdict and the names (D3); the dream text now states the existing
   refusal (`DREAM_LOCAL_REACH_ONLY` in `dream-tools.ts`). `exact-state.ts`
   is command line only (recorded).
5. Major: removals, tree removals, moves, the memory patch writer and
   cluster materialization bypassed the guard; a private create through
   the entity registry fails its own read-back after landing; a decision
   is written before its review obligation can be refused. Confirmed.
   Resolved by the D4 call-site table: removals and moves treat a key live
   in `private` as absent and are refused while the whole fold is
   incomplete; the memory patch writer goes through the guard; cluster
   materialization runs whole (it loses nothing and its answer is already
   filtered); the decision checks its review obligation's key before the
   first write; an entity write that would land in `private` is refused
   before it is written (lead ruling: all-or-nothing by checking before
   the first write).
6. Major: `lane-pages.ts` is already 739 lines, so the guard could not go
   there under the size rule; the interaction with
   `tool-lane-write-keeps-standing` missed the order of the checks and
   private removal tombstones. Confirmed (`lane-fold-cache.ts`
   `privateKeys` holds live entries only). Resolved: the guard and its
   error live in the new `lane-reach-guard.ts`; the size rule is restated
   for files already past the limit (named call sites only); D11 states
   the two requirements for that change's integrator.
7. Minor: the hub candidates and hallways were checked clean by the
   reviewer; the probe file is 575 lines. Resolved: recorded as checked
   in D5; the probe's writer table goes to a sibling module (D9, task
   8.2).

Not checked by the round, now assigned: every remaining machine-state
writer (task 4.4); the command line and hook processes run outside the
scope and are unchanged by design.

## Found during implementation

1. Found by the reseeded probe during implementation: a record derived
   from a private-partition entry in the same operation (a decision's
   review obligation, a tension's log event) was judged on its own text
   and landed in `shared`. Resolved: design D12, task section 7a.

## Round 3: three independent reviews of the artifacts and the code

Three reviewers of three model families other than the author's read the
artifacts and the implemented code, read-only, after the change was
implemented and its 61 tests passed. The first reviewer: not ready
(findings 1 to 10 major, 11 to 14 minor, 15 the gate, 16 the wording).
The second reviewer: not ready (three majors, four minors; its majors
are the first reviewer's 2, 7 and 8). The third reviewer: ready, with
five minor comments. Every finding was checked against the code; each
fix below has a test that fails before the fix and passes after, unless
it says otherwise. Test files are named by their suffix
(`lane-private-partition-reach-<suffix>.test.ts`).

The first reviewer:

1. A removal checked one fold and placed its tombstone from a later one,
   so an entry raised in between could be tombstoned in `private`.
   Accepted. Resolved: the reach check, the winner and the placement of
   a single and a tree removal come from one fold read inside the store
   write, judged again there (design D13 item 2); a folder move filters
   its paths the same way. Tests: fold > "a removal whose entry is raised
   meanwhile ...", "a tree removal ...", "a winner that changed before
   the build ...". Not closed: a writer in another process appending to
   the same key between that read and the shard append (no conditional
   append exists to bind to).
2. An incomplete fold turned an unknown reference into a visible one.
   Accepted. Resolved by the one resolution (D13 item 4): `unknown` is
   private for both views and both judges, and `storeLaneEntryAt`
   answers private before it looks the key up. Tests: resolve > "a
   pre-fix shared receipt is withheld, with its decision's shard
   unavailable too" (with and without a vault), "while the fold is
   incomplete an unresolvable lane reference is private".
3. Procedural graph labels from colliding synthetic ids. Accepted as a
   path; deferred to the next patch release (see the report of this
   round): displayed labels from retained sources only and a fail-closed
   join of hints on duplicate ids need a fixture of two procedures whose
   distinct labels share an id.
4. Review obligations written before the fix carry a private decision's
   title in `shared`. Accepted as a path; deferred to the next patch
   release: a read-time association of the obligation with its decision
   (or a targeted restamp) and a corrected placement on reuse, with a
   test that seeds an obligation as the earlier writer placed it.
5. A reader that binds no rule saw shared values while the whole fold
   was incomplete, and a stale shared value of a raised key. Accepted.
   Resolved: the caller's fold is judged by the whole fold, and holds no
   entry while the whole fold may miss a record; the verdict is part of
   its fingerprint (D13 item 1). Tests: fold > the read boundary cases
   (the write-session list, which binds no predicate; the entity list).
6. Skill-accept recovery below local reach. Accepted as a path; deferred
   to the next patch release: the recovery must never read, clear or
   answer from a journal whose proposal is private or indeterminate, and
   the commit witness must be judged from the whole fold.
7. A remote claim graph rebuild persisted the narrowed graph. Accepted.
   Resolved: the rebuild runs inside `withPrivateShown`, and the answer
   (`node_count`, `truncated`) comes from the caller's own build (D13
   item 3). Test: fold > "a remote claim-graph rebuild keeps the local
   history whole". The other projections are listed in D13 item 3.
8. Reference placement missed bare ids with no vault, an explicit `.json`
   path and a bare id in the claim-source judge; receipt placement used
   the default configuration. Accepted. Resolved by the one resolution
   and by passing the receipt's `configPath`. Tests: resolve > "the
   judge resolves a bare lane id with no vault", "the judge and the views
   resolve a store-held .json path as written", "the claim-source judge
   resolves a bare lane id through the id index". The configuration pass
   has no test of its own (it needs a second store).
9. Write-session target commits bypassed the lane guard. Accepted.
   Resolved in part: the reach guard runs before a session is created
   and again at commit. Test: errors > "a session is not opened on, nor
   committed to, a target held in private". Deferred: target inspection
   through the lane-aware path (an open on a switched vault that still
   holds a legacy target file).
10. A lifecycle refusal named a private human holder. Accepted.
    Resolved: the authority check answers with the fixed refusal when the
    outranking human record is held in `private` (D13 item 5); the
    caller's fold also leaves the stale shared target out. Test: errors >
    "a lifecycle change outranked by a private human removal gets the
    fixed answer".
11. A single move's missing-source error came before the removal guard;
    projection rows were dereferenced unchecked. Accepted. Resolved (D13
    item 5). Tests: errors > "a move of an absent source while the fold
    is incomplete ...", "stored rows that cannot be judged are dropped,
    not dereferenced".
12. The probe could pass on silence. Accepted. Resolved in part: every
    writer lane's shared control must reach a remote call, a timeout or
    an internal error fails the probe, and the lanes no remote reader
    reaches are printed as the recorded gap. Count equality, mutation
    safety and the skipped verbs remain outside the probe.
13. Independent observability. Accepted. Resolved: a pre-fix shared
    receipt is seeded in both vault modes (resolve), the primitives are
    run on a stale shared winner and through a direct overwrite (writes >
    "the write primitives below local reach leave a raised entry's stale
    shared value untouched"; it passes before the fix too, since the
    guard already covered it, and now pins it), and the remote proposal
    array is asserted empty (`lane-tools-no-vault.test.ts`).
14. The id tie-break compared unlike paths; the forget reporter reported
    a pending body of every partition. Accepted. Resolved: canonical
    paths on both sides (resolve > "an id held in two lanes ...", which
    passes before the fix too: the fold's own order hid the defect in
    this fixture), and the pending body judged from the caller's
    partitions (errors > "a pending body of the private partition is not
    reported below local reach").
15. The gate. Accepted. Resolved: the two new production modules are in
    `package-files.txt`; the two label prune cases seed a genuinely
    shared pre-upgrade survivor, and a third case covers the survivor
    that is private from its creation; the bundle is rebuilt and the
    version is 2.0.4.
16. The wording. Accepted. Resolved: the proposal and the changelog say
    that new records receive the placement fix and that earlier shared
    copies remain on peers, and disclose the create refusal.

The second reviewer:

1. Major, references fail open on an incomplete fold: the first
   reviewer's 2, resolved there.
2. Major, the claim graph rebuild: the first reviewer's 7, resolved
   there.
3. Major, bare ids with no vault and `.json` paths: the first reviewer's
   8, resolved there.
4. Minor, the move's removal guard: the first reviewer's 11, resolved.
5. Minor, the id tie-break: the first reviewer's 14, resolved.
6. Minor, a private human removal over a stale shared target: the first
   reviewer's 10, resolved.
7. Minor, unguarded reads and the configuration path in the projection
   and lookup helpers. Accepted. Resolved: the projection filter and the
   index listing judge inside their guarded block and take the caller's
   `configPath`; `storeLaneEntryAt` answers private on a throw. The
   reach view's own lookup still takes no configuration path (its
   callers have none).

The third reviewer:

1. The write-session commit bypassed the guard: the first reviewer's 9,
   resolved there.
2. A stale shared value for readers that bind no rule: the first
   reviewer's 5, resolved there; the state is now built by a test
   (`raiseWithoutTombstone`).
3. The probe is evidence for 12 of its 73 seeded lanes; timeouts were
   not asserted. Accepted. Resolved as the first reviewer's 12; a writer
   row for skill proposals is not added (the next patch release).
4. Wording that ships. Accepted. Resolved: the changelog names the three
   refusals, the limit of earlier rows and the no-vault effect; this
   file ends on a verdict; design D2 now covers the readers that bind no
   rule.
5. Verbs the spec names that nothing runs. Accepted. Resolved: a table
   test runs decision rate and outcome and write-session submit, approve
   and abandon on withheld entries with a local control (errors >
   "decision and write-session verbs on a withheld entry ..."), the
   direct overwrite has its row, and the spec names only the verbs a test
   runs; the others load through the fold by construction.

## Closure round

Two closure reviews of the implemented change. Both answered "ship: no".
Every blocker and major was resolved before release:

1. Skill-accept recovery below local reach (blocker in both). The
   narrowed fold read a private proposal's pending copy as absent, so a
   remote recovery or accept took a stopped sequence for committed (or
   removed nothing on rollback) and deleted the journal. Resolved: below
   local reach a journal whose proposal, archive or procedure is held in
   `private`, or any journal while the whole fold may miss a record, is
   left for a local caller, unread and unnamed; a journal that is
   resolved is judged by the whole fold. Tests for a stop before and
   after the commit stamp, each followed by a local recovery that rolls
   back, and for an unrelated remote accept.
2. A file on disk answered for a withheld lane entry (blocker). Resolved:
   the reach predicate falls back to a file only for an entry the whole
   fold definitively does not hold.
3. A claim source matching a shared lane entry and a private vault page
   (blocker). Resolved: both are judged and either private verdict wins;
   the claim writer passes its configuration.
4. Local callers lost rows while the fold was incomplete (major in both).
   Resolved: the `unknown` verdict hides a row only for a view that
   restricts reach; the owner view and a local reader keep the released
   behaviour.
5. Cost (major in one, minor in the other). Resolved: the shared view
   checks its memo first and memoizes the unchanged view; a resolution
   scope reads a degraded whole fold once (a counted test).
6. A lifecycle refusal that depended on an earlier private human record
   of the key (moderate). Resolved: the fixed answer is given only when
   the key's winning record is held in `private`.
7. Minors: the single-page move builds from one whole fold inside the
   store write, the tree move judges its destinations there again, the
   panel session opens through the same guard as the artifact session,
   and the changelog and the proposal's limits say what this release
   does not do.

Left for the next patch release, each no worse than the released version:
the procedural graph's labels, review obligations written before this
release, the write-session target inspection of an older file, the claim
graph's answer cap, bare ids with an internal space, unreadable accept
markers below local reach, and the probe's skill-proposal writer row.

## Second closure round

A further closure review answered "ship: no": four tools decided a write
from the narrowed fold where the released version did not fail. A skill
accept stamped its rollback flags before judging its targets and
compensated on the narrowed fold, which left an archive it had written
into `private`; learning drafted again a name a person had rejected in
`private`; bridge discovery and dismissal read and wrote their private
artifact and dismissal list on the narrowed fold and failed; the
attention flows failed when their default page was private. Resolved by
one rule (design D14): maintenance runs on the whole fold and narrows
only its answer, an addressed write is judged before its first durable
step. Each sequence has a test that failed before and passes after, with
the same sequence at local reach as its control. The class is guarded
by a census of every durable write reachable from a tool handler, kept
true by a test, and by a differential probe of every verb on a store
with private entries and a twin without; on the tree before the fixes
the probe failed on three of the four, and the fourth (the accept) keeps
its own tests. The census rows that could not be settled in this round
are listed as open in the table.

## Third closure round

An independent census, reproduction tests and a trace of the tools that
census left untraced found creates that deduplicated by identity on the
narrowed fold, so a remote call wrote a second entry beside one held in
`private` under another key (an obligation, a pledge and a pledge
intake, a decision and its review obligation, an entity found by its
alias, a staged entry for a target on another day, a source summary or
distillation under an older slug), trigger creation that queued again a
finding held open in `private`, a dead-end trim that counted only shared
entries, a source archive that failed on its private entry, and a few
tools that rewrote shared machine state from the narrowed fold. Resolved
by six rulings recorded in design D14: identity decisions read every
partition and refuse when the match is private, ladders pick the free
key on every partition, machine maintenance runs on every partition with
its answer narrowed, report snapshots stay at local reach, tree and
derivation operations refuse when a member is private, and a row that
needs a product decision stays open. Each reproduction fails on the tree
before and passes after; the census scan now follows calls across files
to a fixed point, and the differential probe calls every tool with
hand-written arguments and a private identity twin. The rows not traced
in this round stay open in the table with what each needs.

## Fourth closure round

The two questions left open in the third round were answered (design D14
kinds 7 and 8), and the 59 rows the third round left open were closed.
Three were writes decided from the narrowed fold and are fixed with a
test that fails before and passes after: a skill proposal drafted from a
page beside a private proposal of the same name, a lifecycle target whose
case-folding lookup stood a shared spelling in for a private entry, and
a feedback that minted a second rule beside a private rule filed under
an older slug. A remote tuning run no longer persists its winner. Most
other rows were settled by a named gate or read (command-line only
paths, a dry-run-only dream at remote reach, whole-fold writers). The
hygiene apply and refresh rows were closed by the coarse rule (D14 kind
9) and are reopened in the next release.

## Fifth closure round

A closure review of the fourth round's code found writes and answers
still decided or composed from a view the caller may not read; each is
fixed with a test that fails before and passes after. A trigger whose
cooldown key a batch sighting adopted from a private trigger is placed
by the key's ids too, and a trigger answer leaves out a row whose key
names a private preference. An error raised while the identity decision
of a create reads every partition becomes the fixed refusal whenever a
lane may hold a private entry, which also covers a review obligation
that cannot be read and a research report whose two pages other titles
hold. The same-topic lookups of a design note and of a write-session
panel list the lane instead of the disk folder. An untrusted entity
upsert counts archived and quarantined claimants of its name, and a
batch of entities predicts the ids its creates take across its items. A
forced feedback, a tension detection and a pledge add whose every slot
is held privately refuse before their first write. A preference merge
the entity guard refuses with only shared entities answers the guard's
own refusal, a folder operation refuses while the fold may miss a
private record, and a dead-end trim archives past a slot held in
private. One smaller path, a ledger row written before an ingest's
refusal, is deferred to the next patch release.

## Sixth closure round

A review of the fifth round's code turned nine claims into tests and
fixed eight, each with a test that fails before and passes after: a
dead-end archive move never lands on an occupied slot; verifier
rejections drawn from private turns are not named in a remote learn
answer; a remote bridge dismissal that meets a private dismissal list
is refused; a review-required session is not parked on a target held in
private; a trusted entity upsert is not refused by a quarantined
namesake and an ambiguous quarantined alias refuses an untrusted one; a
reference is judged in one canonical spelling; and a private lane entry
is not shown through a legacy file of the same id. The ninth claim, an
exclusive create on a fold that may miss a private record, is left for
the next patch release, unchanged from the released behaviour.

## Eighth closure round

A focused review of what a remote call leaves behind raised seven
findings; this round settles three, each fix with a test that fails
before and passes after. A lane path whose winning record is a removal
held in `private` now answers as a private entry with no fields, so a
file left at that path no longer answers for it below local reach: the
`removed` count of a remote procedural-memory reconcile leaves the
private procedure out, and the reference view of a remote caller hides
the path as the per-request read check does (the ownership view still
judges such a path by the vault, as before). The `scanned` count and the
two watermark times of a remote skill-proposal learn are taken over the
continuity records the caller may read, while the learn, its watermark
on disk and its ledger rows stay on the fold of every partition. The
lessons digest needed no change: no call below local reach renders it
outside the whole-fold scope the resource reader already applies (a
remote dream pass is served only as a dry run, which regenerates no
digest). The other four findings are left for the next patch release.

## Verdict

Ready for implementation: yes

The change is implemented; the three reviews above were of its artifacts
and its code, and the first reviewer's findings 3, 4 and 6 (and the
inspection half of 9) are further paths deferred to the next patch
release.
