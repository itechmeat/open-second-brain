# Tasks: private-partition lane entries are withheld below local reach

First read `CLAUDE.md` and `openspec/project.md`, then this change folder:
`proposal.md`, `design.md`, the spec delta
`specs/lane-entry-fidelity/spec.md`, `review.md`. Work in order, one
section at a time. Before a section, read the design decision and the
spec requirement it names. Tick each box (`- [x]`) as soon as it is done,
so an interrupted run resumes from the first open box. Partial edits from
an earlier attempt may already be in the tree: review them, keep what is
right, finish the rest. Search before reading whole files:
`zg "<meaning>"`, `zg --rg -F "<text>"` or `git grep -n "<text>"`.

For every behaviour: the failing test first (most already exist and fail
today, named below), run it and see it fail, then write the code. Change
nothing this list does not ask for. This change is implemented before
the change `tool-lane-write-keeps-standing`; do not edit that change's
folder.

STOP conditions: stop at the current task, write what you found into
your report and end your run when

1. the code does not match a name, signature or line this list or
   `design.md` gives, and the difference changes what the task does
   (a shifted line number alone is not a STOP);
2. a test this list says fails passes before the fix, or one it says
   passes fails for a reason this list does not name;
3. after section 2 a case this list assigns to the choke point still
   fails: report the reader and how it reads lane pages around the fold,
   do not fix it in place;
4. a whole-fold caller of the `design.md` D3 table cannot be pointed at
   the whole fold without changing its behaviour at local reach;
5. the reseeded probe (section 8) finds a token in any answer, or a
   lane's own reader does not show its hidden entry at local reach;
6. a projection of task 4.4 carries lane entry content below local reach
   and its fix is not a read-time filter of the D5 shape.

## Environment and rules

1. Work only in this checkout. In every shell, before any `bun` command:

   ```sh
   export PATH="$HOME/.bun/bin:$PATH"
   export TMPDIR="$HOME/.cache/osb-lane-reach-tmp"
   mkdir -p "$TMPDIR"
   ```

   Delete that folder when you are done.
2. Never read or write the real `~/.config/open-second-brain`, any real
   vault, or the real `~/.local/state/open-second-brain`. Tests use the
   fixture `makeLaneEnv` (`tests/core/lanes/fixtures/lane-env.ts`), which
   makes temp directories and removes them.
3. Never stop a process you did not start. Do not commit, push or open a
   pull request. Do not start subagents. Never use `git stash` (the stash
   is shared with other checkouts).
4. English only in code, comments, docs and tests; no exclamation marks;
   the product is written "Open Second Brain" in full. No machine paths,
   host names or account names in the repository. Test names, comments
   and the changelog say "private-partition lane entries are withheld
   below local reach"; no reproduction steps for an attacker and no
   advisory identifiers in any repository file.
5. During a section run only the test files that section names:
   `bun test <file> [<file> ...] --timeout 60000` (add `-t "<name>"` for
   one case). The whole suite runs once, in section 10.
6. Do not edit `tests/mcp/lane-private-partition-reach.test.ts`: it must
   pass unchanged. In `tests/mcp/lane-private-partition-reach-paths.test.ts`
   change only the intention case (task 3.1). The readers test is near 700
   lines: add nothing to it.
7. Files to edit: `src/core/store/lane-fold-cache.ts`,
   `src/core/store/lane-entry-store.ts`, `src/core/store/lane-dual-moves.ts`,
   the new `src/core/store/lane-reach-guard.ts`,
   `src/mcp/brain/reach-readable.ts`, `src/mcp/brain/procedure-tools.ts`,
   the new `src/mcp/brain/procedural-projection-filter.ts`,
   `src/core/brain/procedural-memory.ts`,
   `src/core/brain/procedural-graph.ts`,
   `src/core/brain/procedural-hints.ts`,
   `src/core/brain/artifact-ref-resolve.ts`, `src/core/brain/tensions.ts`
   (past 700 lines: task 7a.2's call site only),
   `src/core/brain/store-record-visibility.ts`,
   `src/core/store/reference-privacy.ts`, `src/core/brain/standing-rules.ts`,
   `src/core/brain/governance/store-unreachable.ts`,
   `src/mcp/brain/knowledge-lane-tools.ts`. Files already past 700 lines
   get only the call-site edits named here, nothing else:
   `src/core/store/lane-pages.ts` (tasks 2.3 and 3.3),
   `src/core/brain/lifecycle/memory-target.ts` (tasks 2.3 and 3.4),
   `src/core/brain/decisions/record.ts` and
   `src/core/brain/entities/registry.ts` (task 3.4). `openclaw/index.js`
   only by the build command (task 9.3); the test files named here, the
   new `tests/mcp/lane-private-partition-reach-writes.test.ts` and
   `tests/mcp/lane-private-partition-reach-refs.test.ts`, their shared
   fixture `tests/mcp/lane-private-partition-reach-writes-fixture.ts`,
   and the probe's writer table
   `tests/mcp/lane-private-partition-reach-probe-writers.ts`;
   `.github/windows-test-timings.json` only through
   `.github/scripts/windows-timings.sh`; `CHANGELOG.md`, `package.json`
   and what `scripts/sync-version.ts` rewrites. Not to touch:
   `openspec/changes/tool-lane-write-keeps-standing/`,
   `src/core/brain/artifact-ref-view.ts`, `reach-view.ts`,
   `owner-scope-view.ts`, `src/core/brain/skill-proposals.ts`, every
   other test, every other `src/` file unless a STOP report names it
   first.
8. Every `src/` and `tests/` file this change creates stays under 700
   lines, and every file it edits that was under 700 lines stays under
   it (`wc -l`). A file already past 700 lines before this change
   (`lane-pages.ts` 739, `memory-target.ts` 845, `record.ts` 814,
   `registry.ts` 1070) gets only its named call-site edits and grows by
   at most the lines those need (an import and a call each).

## 0. Preconditions

- [x] 0.1 `git grep -n "export function laneStoreFold" src/core/store/lane-fold-cache.ts`
  shows one definition; `git grep -n "export function privateWithheld\|export function withPrivateShown" src/core/store/caller-reach.ts`
  shows both; `git grep -n "function storeLaneReadable" src/mcp/brain/reach-readable.ts`
  shows the committed rule with its `verdicts` memo. Otherwise STOP.
- [x] 0.2 Baseline, recorded in the report:
  `bun test tests/mcp/lane-private-partition-reach.test.ts tests/mcp/lane-private-partition-reach-readers.test.ts --timeout 60000`
  all pass;
  `bun test tests/mcp/lane-private-partition-reach-paths.test.ts --timeout 60000`
  gives 1 pass (path 5) and 7 fail (path 1 three cases, path 2, path 3,
  path 4, the intention case);
  `bun test tests/mcp/lane-private-partition-reach-probe.test.ts --timeout 900000`
  fails on `brain_procedural_graph` show and hints only, and record its
  time. Otherwise STOP.

## 1. Done: the shared rule asks the partition

- [x] 1.1 `storeLaneReadable` in `src/mcp/brain/reach-readable.ts` asks
  `laneEntryInPrivate` below local reach, a throw answering false, at
  both construction sites (design D1, done part).
- [x] 1.2 `tests/mcp/lane-private-partition-reach-readers.test.ts`: one
  row per binder of the rule, in `store` and `no-vault`, plus the
  incomplete fold, file-backed lanes, the ownership gate and the
  fifty-pledge case; all pass with the reproduction file.

## 2. The fold choke point (design D3; spec "Lane reads below local reach see only the shared partition")

- [x] 2.1 Test first, new file
  `tests/mcp/lane-private-partition-reach-writes.test.ts`,
  `describe("private-partition lane entries are withheld below local reach")`,
  `makeLaneEnv("store")`, servers from the fixture module
  `tests/mcp/lane-private-partition-reach-writes-fixture.ts` (`server(e)`
  is below local reach, `localServer(e)` local):
  1. "a local list after a remote list sees the private-partition entry":
     seed one hidden and one shared entry through the lane's writer;
     remote list, local list, remote list on one server process each;
     assert the local list carries the hidden slug and both remote lists
     do not; in `makeLaneEnv("store")` (pledges) and
     `makeLaneEnv("no-vault")` (obligations: with no vault the judge
     counts every page a row names as private, so a pledge citing its
     source is never shared there). Today the remote lists already pass
     by the shared rule; the case guards the cache split.
  2. "the caller's fold and the whole fold are cached apart": inside
     `withPrivateWithheld(true, …)` two `laneStoreFold()` calls return the
     same object, outside two calls return the same object, and the two
     objects differ with different `fingerprint`s; the narrow fold has no
     `privateKeys`. Fails today (one fold).
  Run the file; record which case fails.
- [x] 2.2 `src/core/store/lane-fold-cache.ts`: split the body of
  `laneStoreFold` into `foldOf(configPath, partitions)`;
  `laneStoreFold(configPath?)` folds `["shared"]` under
  `privateWithheld()` (cache key `<root>` plus a NUL and the partition
  list, fingerprint prefixed `shared-only\n` and stamped over `shared`
  shards only), every held partition otherwise (today's behaviour and
  key); new `wholeLaneStoreFold(configPath?)` always folds every held
  partition under today's key. Keep the module comment true.
- [x] 2.3 Point every whole-fold caller of the `design.md` D3 table at
  `wholeLaneStoreFold`: in `lane-entry-store.ts` `storeEntryRead`,
  `foldIncomplete`, `livesInPrivate`, `laneEntryInPrivate` (one fold read
  for the whole function, design D1 item 1), `storedEntryPrivate` and
  `replacedShared` (through a private helper `wholeStoreEntry`); in
  `lane-pages.ts` the create-lock existence check (`storeEntryRead`) and
  the record builders of `moveLaneTree` and `removeLaneTree`; every fold
  read in `lane-dual-moves.ts` (`storedLanePathsBelow` takes a `whole`
  flag for the removal records of an unswitched folder). The two gap
  reporters read the CALLER's fold for both the verdict and the names:
  in `standing-rules.ts` (`readOperatorRuleFile`) and
  `governance/store-unreachable.ts` replace `foldIncomplete()` plus the
  shard list with one `laneStoreFold()` read and
  `laneFoldIncomplete(fold)` (an earlier attempt pointed them at the
  whole fold: undo that). In `lifecycle/memory-target.ts`
  `entityOfRecord` reads only `shared` under `privateWithheld()` (one
  call-site edit). Leave every read accessor of the D3 "caller's fold"
  table on `laneStoreFold`. Verify with
  `git grep -n "laneStoreFold\|wholeLaneStoreFold" -- src` that every use
  is in one of the two tables, and list them in the report.
- [x] 2.4 Verify: the writes file of 2.1 passes;
  `bun test tests/mcp/lane-private-partition-reach-paths.test.ts --timeout 60000`
  now passes path 1 entity, path 1 write session, path 4 and path 5, and
  path 2 (list, history, acknowledge answer and `status_after_remote_ack`
  `pending`); path 1 procedural graph, path 3 and the intention case still
  fail (sections 3 to 5). The reproduction and readers files pass except
  the two `brain_intention` rows, which need the write guard of section
  3, and the no-vault `brain_procedural_memory` row, which needs section
  4; all three are green again once sections 3 and 4 are done.
  `bunx tsc --noEmit -p .` is clean.

## 3. Writes below local reach (design D4; spec "An update below local reach … acts as on an absent one", "A create below local reach over a private-partition key is refused")

- [x] 3.1 Test first. In the paths file, rewrite only the body and name of
  the intention case to
  `test("refuses with the fixed answer and changes nothing", …)`:
  `refused` true, the answer contains
  "this entry cannot be written at this reach", carries no
  `zqintenttext` token, and the chain is unchanged. Update the comment
  above the assertion to the decided contract (no reproduction wording).
  In the writes file add:
  1. "recording over a private-partition decision is refused with the
     fixed answer": record a decision at local reach with a `<private>`
     region in its notes; at remote reach record one with the same title;
     the answer contains the fixed text and none of the hidden decision's
     tokens, and `e.laneRecords()` has the same count before and after.
  2. "a write below local reach while the fold may miss a record is
     refused": make the fold incomplete as the readers test does in its
     incomplete-fold case (remove the `private` partition's `events`
     shards after a fold, assert `foldIncomplete()` true); a remote pledge
     add answers the fixed text and writes nothing; a local pledge add is
     judged as today.
  3. "a removal below local reach while the fold may miss a record is
     refused": the same incomplete fold; a remote pledge remove of the
     shared pledge answers the fixed text and writes nothing.
  4. "fulfil, done and resolve of a private-partition entry answer as for
     an absent one": remote pledge fulfil, obligation done and open
     decision resolve on hidden entries answer exactly what the same verb
     answers for an absent slug (slug replaced), and a local read shows
     each unchanged.
  5. "the write primitives below local reach leave private-partition
     entries untouched": seed with `writeLaneText` at local reach one
     private entry (a `<private>` region) and one shared entry in one
     folder; inside `withPrivateWithheld(true, …)`: `removeLanePage` of
     the private entry returns `false`; `moveLanePage` from it throws
     the "no lane page to move" error; `moveLanePage` of the shared entry
     onto the private key throws `LaneEntryWithheldError`;
     `writeLaneText` onto the private key throws it; `removeLaneTree` of
     the folder removes the shared entry only; after each, the whole
     fold still holds the private entry unchanged.
  6. "the memory patch writer below local reach refuses a
     private-partition target": resolve the lifecycle target of a private
     lane entry at local reach, then call `writeMemoryPatches` inside the
     scope: `LaneEntryWithheldError`, record count unchanged.
  7. "a decision whose review obligation is withheld is refused before
     anything is written": add at local reach the review obligation a
     decision titled T would create, with a `<private>` region in its
     notes; record T at remote reach: the fixed answer, record count
     unchanged, no decision page.
  8. "an entity write below local reach that would land in private is
     refused before anything is written": remote `brain_entity` upsert
     with a `<private>` region in its body answers the fixed text and
     writes nothing; the same call without the region creates the entity.
  Run; record which fail.
- [x] 3.2 New module `src/core/store/lane-reach-guard.ts` (design D4):
  `LaneEntryWithheldError` (message exactly "this entry cannot be written
  at this reach", no path, no key field), `assertLaneWriteAtReach(vault,
  paths, configPath?)`, `assertLaneRemovalAtReach(vault, configPath?)`,
  `withheldPrivateKey(vault, path, configPath?)`; each does nothing
  outside `privateWithheld()` and reads the whole fold once.
- [x] 3.3 `src/core/store/lane-pages.ts`, call sites only (the file is past
  700 lines): `assertLaneWriteAtReach` at the start of the store-held
  branch of `writeLanePage` and `writeLaneText` and inside
  `withCreateLock` before the existence check; `removeLanePage`:
  `assertLaneRemovalAtReach`, then a key `withheldPrivateKey` answers
  for returns `false`; `moveLanePage`: a source `withheldPrivateKey`
  answers for throws the "no lane page to move" error, then
  `assertLaneWriteAtReach` on the destination; `moveLaneTree` and
  `removeLaneTree`: `assertLaneRemovalAtReach`, the sources
  `withheldPrivateKey` answers for left out, and (move) every
  destination through `assertLaneWriteAtReach`.
- [x] 3.4 Call sites outside the store layer (design D4 table):
  `lifecycle/memory-target.ts` `writeMemoryPatches`:
  `assertLaneWriteAtReach` on the lane targets before the first record;
  `decisions/record.ts` `recordDecision`: keep the plan of
  `planReviewObligation` and call `assertLaneWriteAtReach` on the
  decision path and (a new obligation) the obligation path before the
  decision page is written; `entities/registry.ts` `writeEntityFile`:
  refuse with `LaneEntryWithheldError` below local reach when the record
  would land in `private` (a guard-module helper over
  `storedEntryPrivate` and `isPrivateEntry`); `knowledge-lane-tools.ts`
  `brain_clusters run`: `materializeClusterNotes` inside
  `withPrivateShown`.
- [x] 3.5 Verify: the intention case and the writes cases pass; the paths,
  reproduction and readers files pass except path 1 procedural graph,
  path 3 and the no-vault `brain_procedural_memory` row (section 4, see
  2.4); `bunx tsc --noEmit -p .` is clean.

## 4. Persisted projections (design D5; spec "A persisted projection answers below local reach without private-partition entries")

- [x] 4.1 Test first: the paths case "brain_procedural_graph show and
  hints withhold a private-partition procedure" fails. New file
  `tests/mcp/lane-private-partition-reach-refs.test.ts` (same describe
  name, same fixture module) with:
  1. "a rebuild below local reach keeps the whole projection": remote
     `rebuild` answers counts that exclude the hidden procedure, then a
     local `show` carries it.
  2. "the graph keeps the shared procedure's entity nodes and drops the
     withheld one's": distinct triggers and tags per procedure; remote
     `show` carries the shared trigger and tag nodes and edges and none
     of the hidden ones; every hint `node_id` is a kept node.
  3. "a private-partition procedure does not hide the shared ones": after
     a local reconcile with one hidden and one shared procedure, remote
     `brain_procedural_memory list` carries the shared one only, a local
     list both; a remote `reconcile` then a local list still carries
     both.
  Run; record.
- [x] 4.2 New module `src/mcp/brain/procedural-projection-filter.ts`: the
  two-pass filter of design D5 item 1 (non-entity node kept by its
  `sourcePath`: non-empty, readable, and for a store-held `Brain/` lane
  path present in the caller's fold; an entity node kept only through an
  edge to a kept node; an edge kept only between kept nodes; a hint kept
  by its `node_id`; known fields only). `procedure-tools.ts`: `show`,
  `hints` and the `rebuild` answer pass through it when
  `readableAtContextReachOrUndefined(ctx)` is defined.
- [x] 4.3 `procedural-memory.ts`: `reconcileProceduralMemory` builds and
  writes inside `withPrivateShown` (its `include` counts unchanged);
  `listProceduralMemory` reads the index inside `withPrivateShown` and,
  under `privateWithheld()`, keeps an entry only when its `sourcePath` is
  no store-held `Brain/` lane path, or the caller's fold holds it and
  `laneEntryInPrivate` is false (design D5 item 3).
  `procedural-graph.ts` `rebuildProceduralGraph` and
  `procedural-hints.ts` `rebuildProceduralHints` run inside
  `withPrivateShown` (design D5 item 4). Verify: the paths case and the
  three cases of 4.1 pass.
- [x] 4.4 Look once at the remaining projections of the D5 table: grep
  `git grep -n "writeMachineStateText\|atomicWriteFileSync" -- src/core/brain`
  and keep the writers that read lane pages; for each, whether a tool
  reachable below local reach serves it and whether it carries lane
  entry content. One with content below local reach: a failing case in
  the refs file first, then the D5 filter (STOP condition 6 otherwise).
  One without: listed in the report as checked, with the evidence. The
  hub candidates and hallways are recorded clean from round 2.

## 5. References and the write-side judge (design D6, D7; spec "A reference to a store-held lane entry is judged by that entry", "A record naming a private-partition lane entry is itself private")

- [x] 5.1 Test first: the paths case "brain_decision history withholds
  receipts naming a private-partition decision" fails. Add to the refs
  file:
  1. "receipts naming a private-partition decision land in private":
     record a decision at local reach with a `<private>` region in its
     notes, rate it and give it an outcome; every decision-receipt row
     naming its slug is a record of the `private` partition and none is a
     record of `shared` (read each partition's `events` records with
     `readStreamRecords`, as `lane-fold-cache.ts` does).
  2. "receipts naming a shared decision stay visible": a plain decision,
     rated; remote `history` carries its slug.
  3. "history withholds receipts naming a private-partition decision with
     no vault": the path 3 sequence in `makeLaneEnv("no-vault")`.
  4. "the judge counts a store-held private entry named by an
     extensionless path or an entity id": `claimSourceIsPrivate` of the
     extensionless path of a private decision, and `refsNamePrivatePage`
     of a private entity's id, are true; of a shared one false.
- [x] 5.2 `src/core/brain/artifact-ref-resolve.ts`: on a machine whose
  lane pages live in the store, a bare id in the decisions and sources
  lanes, an entity id in any category, and the `.md` twin of an
  extensionless `Brain/` path resolve when the whole fold holds that
  lane entry (design D6 item 1).
- [x] 5.3 `src/core/brain/store-record-visibility.ts`: `StoreRecordLookup`
  returns `VisibilityRecord | undefined`; after the memory records, a
  store-held lane entry of the whole fold answers with its fields and
  `private` from `laneEntryInPrivate` (a throw: `private: true`); the
  lookup exists when memory records or lane pages are read from the
  store. `storeRecordRefView` maps a bare id or wikilink through the
  resolver against `laneVaultRoot(null)` and judges it by `laneVisible`
  (design D6 items 2, 3). `reach-view.ts`, `owner-scope-view.ts` and
  `artifact-ref-view.ts` are not edited.
- [x] 5.4 `src/core/store/reference-privacy.ts`: `refsNamePrivatePage`
  counts a reference resolved to a store-held lane entry as private when
  `laneEntryInPrivate` is true or its fields reserve it;
  `claimSourceIsPrivate` asks the whole fold first for the source and its
  `.md` twin (design D7 items 1, 2).
- [x] 5.5 Verify: path 3 and the four cases of 5.1 pass; the reproduction,
  readers, paths, writes and refs files pass; `bunx tsc --noEmit -p .`
  is clean.
- [x] 5.6 Rows already in `shared`: confirm by reading
  `src/core/brain/privacy-marker-restamp.ts` and `src/cli/store*.ts` that
  no existing pass re-judges ledger rows in `shared`; say so in the
  report (design D7 limit). Do not write a migration.

## 6. Error wording (design D8, D11; spec "An error below local reach names nothing the caller may not read")

- [x] 6.1 Path 4 passes since section 2. Add to the refs file:
  1. "a private store record id answers as an absent one": remote
     `brain_lifecycle` on `store:<id of the hidden entry's record>` and on
     `store:<an unused id of the same shape>` answer the same, the id
     aside.
  2. "the gap reporters name no private shard below local reach": with
     the `private` `events` shards removed, a remote call of a reader of
     `readOperatorRuleFile` and of `storeUnreachable` names no `private/`
     shard; a local call is told as today.
  Then look once at every error built from a lane read in the lane tools
  (`git grep -n "already exists\|already parked\|DuplicateError(" -- src/core/brain src/mcp/brain`):
  confirm each is built from a caller's-fold read or reaches the D4
  guard first, and list them in the report.
- [x] 6.2 Note for the integrator in the report (no code here): the
  requirements of design D11 (the reach guard before `checkLaneBase`;
  the not-applied error becomes `LaneEntryWithheldError` whenever the
  winning record, live or a removal, is in `private` or the whole fold is
  incomplete; the guard module is where to import from).

## 7. Amendments of the shared rule (design D1 items 1 to 4)

- [x] 7.1 Test first, refs file: "a Brain path that names no lane entry
  does not fail the request": a remote call of a reader that binds the
  predicate with a `Brain/` path that maps to no lane entry answers as
  for any absent path, not an internal error. Run; it fails today.
- [x] 7.2 `src/mcp/brain/reach-readable.ts`: remove the `verdicts` memo;
  check `lanePlaceOf` before `readLanePage` in both predicates (a non-lane
  `Brain/` path goes to the vault rules, no vault: the store record
  rules); any other throw of the lane read answers false; pass
  `ctx.configPath ?? undefined` to `lanePagesInStore`, `readLanePage` and
  `laneEntryInPrivate`. Update the doc comments. Verify: 7.1 passes, the
  reproduction, readers, paths, writes and refs files pass.

## 7a. Derived records (design D12; spec "A record derived from a private-partition lane entry is private")

- [x] 7a.1 Test first, refs file:
  1. "a decision's review obligation takes the decision's partition":
     record a decision at local reach with a `<private>` region in its
     notes; every `obligations` lane record of its review obligation is
     in `private`, none in `shared`; remote `brain_obligation list` does
     not carry the title; after a local `brain_obligation done` of that
     obligation the same holds.
  2. "a tension's log event takes the tension's partition":
     `persistTension` with a `<private>` region in a quote, then
     `transitionTension` at local reach; every `events` record naming
     the tension id is in `private`, none in `shared`; remote
     `brain_agent_query` carries neither the id nor a subject.
  3. "a bare id of any lane the store holds is judged by its entry":
     `logRefsNamePrivatePage` of the private tension's bare id and of a
     private write session's id is true, of a shared one false; a log
     event naming the private tension written to `shared` with
     reference judging off is not shown by remote `brain_agent_query`
     and is shown by a local one.
  Run; record which fail.
- [x] 7a.2 `src/core/store/lane-entry-store.ts`: `laneTextLandsPrivate`
  (design D12 item 1). Call sites only: `decisions/record.ts`
  `recordDecision` runs `ensureReviewObligation` inside
  `withOperationPrivacy` of that verdict, computed before the decision
  page is written; `tensions.ts` `persistTension` ORs it into the
  create's operation verdict.
- [x] 7a.3 `src/core/brain/artifact-ref-resolve.ts`: the bare-id index of
  design D12 item 3 replaces the sources, decisions and entity lookup.
- [x] 7a.4 Probe writer table: the write sessions row also ends one
  hidden session at local reach, so the terminal audit event is in the
  matrix. Verify: the three cases of 7a.1 pass; the reproduction,
  readers, paths, writes and refs files pass; `bunx tsc --noEmit -p .`
  is clean; `openspec validate lane-private-partition-reach --strict`.

## 8. The probe as the regression guard (design D9; spec "No tool hands a caller below local reach a private-partition lane entry")

- [x] 8.1 `tests/mcp/lane-private-partition-reach-probe.test.ts`: fix the
  lint error at about line 85 (unnecessary escape of `/` inside the
  character class).
- [x] 8.2 Seeding through a table of writers (design D9 item 1) in the
  sibling module `tests/mcp/lane-private-partition-reach-probe-writers.ts`:
  one row per lane a tool reads (lane, writer call, the hidden entry's
  id, path and title tokens, the lane's own reader call). Rows with a
  real writer: entities (local reach), triggers, open decisions,
  decisions, intentions, dead ends, write sessions, pledges, obligations,
  tensions, procedures (then reconcile and rebuild at local reach).
  Lanes left on `writeLaneText` and lanes not seeded are printed with
  the reason. Every hidden entry is asserted to be in `private` before
  any call.
- [x] 8.3 Call plan (design D9 items 2, 3): at local reach only each
  lane's own reader, once, asserting the hidden token is shown (STOP
  condition 5 if not); below local reach the full matrix once, identical
  calls deduplicated, per-lane id, path and title calls only for verbs
  whose argument names an entry. Keep resources.
- [x] 8.4 Verify: the probe passes (no token below local reach, every
  lane's own reader shows its hidden entry locally); record its time
  (target under 15 s on a development machine) and the counts (lanes
  seeded by writer, by `writeLaneText`, not seeded; tools called;
  calls made). `bun run lint` shows no error in the test files.

## 9. Release (`CLAUDE.md` Versioning)

The release is 2.0.4, in one pull request with the change
`tool-lane-write-keeps-standing` if that one is ready in time, alone
otherwise. Both orders work:

- [x] 9.1 `CHANGELOG.md`: if `git grep -n "^## \[2.0.4\]" CHANGELOG.md`
  finds no heading, add `## [2.0.4] - <today>` above `## [2.0.3]` and
  the link reference
  `[2.0.4]: https://github.com/itechmeat/open-second-brain/compare/v2.0.3...v2.0.4`
  above the `[2.0.3]:` line at the bottom. Under its `### Fixed`
  (create it if absent) add one line: "Private-partition lane entries are
  withheld below local reach: a lane entry the store holds in its private
  partition is no longer listed, shown, counted, named in an answer or
  written for a remote caller, and records naming it are kept private."
  If the heading exists, add only the line. Verify by reading both
  places.
- [x] 9.2 If `package.json` `version` is not `2.0.4`, set it to `2.0.4`
  and run `bun run scripts/sync-version.ts`; in both cases
  `bun run scripts/sync-version.ts --check` exits 0. Never hand-edit the
  mirrored manifests.
- [x] 9.3 OpenClaw bundle: `grep -c "resolveArtifactRef" openclaw/index.js`
  printed 2 when this list was written, so the bundle includes the edited
  resolver: run `bun run build:openclaw` and check that `git status`
  shows `openclaw/index.js` changed; also grep the bundle for
  `laneStoreFold` and the other edited modules and say which it contains.
- [x] 9.4 `package-files.txt`: the two new production modules
  (`src/core/store/lane-reach-guard.ts`,
  `src/mcp/brain/procedural-projection-filter.ts`) are packed;
  regenerated with `bun run scripts/pack-manifest.ts --write`, as every
  earlier release did.

## 10. The gate

- [x] 10.1 `bun run test`
- [x] 10.2 `bunx tsc --noEmit -p .`
- [x] 10.3 `bun run lint`
- [x] 10.4 `bun run fmt:check`
- [x] 10.5 `bun run check:paths`
- [x] 10.6 `bun run sync-plugin-mirrors:check`
- [x] 10.7 `bun run scripts/sync-version.ts --check`
- [x] 10.8 `wc -l` of every file this change touched under `src/` and
  `tests/`: none that was under 700 lines reaches it; the four files
  already past it (environment rule 8) grew only by their named call
  sites (`git diff --stat` of each).
- [x] 10.9 Windows shards: report the local time of each
  `lane-private-partition-reach*` file; the integrator folds the CI
  timings with `.github/scripts/windows-timings.sh <run-id>` after the
  first CI run of the branch (`CLAUDE.md`).

## 10a. The review round (three independent reviews of artifacts and code)

- [x] 10a.1 The caller's fold below local reach is judged by the whole
  fold (design D13 item 1): `fold` > the read boundary cases.
- [x] 10a.2 A removal reads its reach check, winner and placement from
  one fold inside the store write (D13 item 2): `fold` > removal binding.
- [x] 10a.3 The claim graph rebuild builds whole and answers its own
  build; the projections a tool below local reach can rebuild are listed
  (D13 item 3): `fold` > rebuilt projections.
- [x] 10a.4 One resolution of a lane reference for both views and both
  judges, `unknown` treated as private, the receipt's destination
  configuration passed through (D13 item 4): `resolve`.
- [x] 10a.5 Refusals and degraded answers (D13 item 5), the update verbs
  table, the write-session target guard at open and commit: `errors`.
- [x] 10a.6 The two label prune cases seed a genuinely shared pre-upgrade
  survivor; a third case covers the survivor private from its creation.
- [x] 10a.7 The probe fails on a timeout, an internal error or a writer
  lane whose shared control no remote call shows, and prints the
  recorded gap of the other lanes.

## 11. Report

- [x] 11.1 Report: every box ticked or why not; the baseline of 0.2; the
  `laneStoreFold` and `wholeLaneStoreFold` uses of 2.3, each with its
  table row; the cases that failed before each section and passed after;
  the projections of 4.4 with their evidence; the error list of 6.1; the
  probe's counts and time; deviations from `design.md` and why; the gate
  counts; anything in this list that did not match the code.

## Workflow follow-up

- Independent code review rounds and the security review (the
  integrator).
- Archive inside the pull request: `openspec archive lane-private-partition-reach --yes`
  (and `openspec archive tool-lane-write-keeps-standing --yes` when both
  ship together), then commit the archive and the updated
  `openspec/specs/` with the code; one pull request, one commit, version
  2.0.4.
- After the merge: `gh release create v2.0.4` on the merged commit.
