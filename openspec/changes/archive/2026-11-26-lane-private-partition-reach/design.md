# Design: private-partition lane entries are withheld below local reach

## Context

See `proposal.md` (Why). Where the partition comes from: a lane writer
(`writeLaneText`, `writeLanePage` in `src/core/store/lane-pages.ts`, and
the lane modules built on them) builds a `lane-entry` record, `entryRecord`
judges its privacy with `isPrivateEntry` (frontmatter, or a row the judge
in `src/core/store/reference-privacy.ts` names private, for example text
with a `<private>` region), and `src/core/store/dual-write.ts` places a
private record in `private`. A raise from `shared` to `private` also
writes a tombstone in `shared` (`replacedShared` in
`src/core/store/lane-entry-store.ts`), so a device that holds only
`shared` sees the entry go.

Where it is read: every lane page read on a switched machine goes through
`laneStoreFold` (`src/core/store/lane-fold-cache.ts`), through the
accessors of `lane-entry-store.ts` (`storeEntries`, `storeEntry`,
`storeEntryRead`, `laneEntryClockMs`, `livesInPrivate`,
`laneEntryInPrivate`, `foldIncomplete`) and the read family of
`lane-pages.ts` (`readLanePage`, `lanePageExists`, `listLaneFiles`,
`laneStems`, `listLaneTree`, `listLaneDirs`, `readLaneText`,
`readLaneFile`, `parseLanePage`, `laneStoreStamp`). The fold reads every
partition the machine holds and caches the result per store root.

The MCP server runs every tool call and resource read of a transport
below local reach inside `withPrivateWithheld(true, …)`
(`src/core/store/caller-reach.ts`, called from `src/mcp/server.ts`
`callTool` and the `tools/call` and `resources/read` branches of
`handleRequest`). Two readers already narrow themselves under that scope:
the topic fold (`readablePartitions` in `src/core/topics/read.ts`) and the
preference counters (`src/core/store/read/store-entities.ts`). The lane
fold does not.

What is done: the shared readability rule (`storeLaneReadable` in
`src/mcp/brain/reach-readable.ts`) asks `laneEntryInPrivate` below local
reach (D1 below), with its tests
`tests/mcp/lane-private-partition-reach.test.ts` and
`tests/mcp/lane-private-partition-reach-readers.test.ts`. It covers every
reader that binds that rule. A review and a second reproduction then
proved, by failing tests, that several readers bind no rule at all, that a
remote transition writes, that projections and references carry entries
around the rule, and that receipts naming a private decision land in
`shared` (table in "The places and their tests").

## Goals / Non-Goals

Goals: one fail-closed choke point that answers every live lane read
below local reach as a machine holding only `shared` would, whatever
reader asks; a write rule below local reach that never touches a private
entry; the four places the choke point does not reach (projections,
references, the write-side judge, error wording) closed one by one, each
proven by a failing test first; a registry-wide probe whose clean answer
is evidence.

Non-goals: no change to how a write is judged at local reach, to the
command line, or to a machine whose lane pages are files; no migration of
rows already written to `shared`; no separation of the key spaces of the
two partitions (a follow-up, see Limits); no change to the ownership gate
at local reach.

## Decisions

### D1. The shared rule asks the partition (done) and its amendments

Done: `storeLaneReadable(reach, scope, root)` answers false below local
reach when `laneEntryInPrivate(root, page.path)` is true, a throw
answering false; at local reach it never asks. It stays as the second
layer behind D3: it reads the fold of every partition (D3 list), so it
withholds an entry the shared fold still shows while the entry lives in
`private` (a raise whose `shared` tombstone this machine has not read)
and keeps the fail-closed contract of D2 while a `private` shard is
unreadable, which the shared fold alone does not see. It does not
contradict D3.

Amendments (this revision):

1. `laneEntryInPrivate` reads the fold of every partition once per call
   (one `wholeLaneStoreFold` read, then `heldInStore`, the place, the
   incompleteness, the entry and `privateKeys` from that one value)
   instead of three fold reads.
2. The per-request `verdicts` memo in `storeLaneReadable` is removed.
   With one fold read per page (a cache hit after a fingerprint check) it
   saves nothing, and it is the only state that can go stale inside one
   request (a verdict cached as shared before the fold became incomplete).
3. Both predicates in `reach-readable.ts` check `lanePlaceOf` on the
   page's `Brain/`-relative path before `readLanePage`. A `Brain/` path
   that names no lane entry is judged by the vault rules (no vault: the
   store record rules), as any path outside `Brain/` is; today
   `readLanePage` throws there (`placeOf` in `lane-entry-store.ts`) and
   the request fails. Any other throw from the lane read answers false.
4. `ctx.configPath ?? undefined` is passed to `lanePagesInStore`,
   `readLanePage` and `laneEntryInPrivate` in both predicates, so an
   explicit config path selects the same store the server uses.

### D2. Fail closed

1. Incomplete fold: `laneEntryInPrivate` answers true for every held lane
   path while the fold of every partition is incomplete
   (`laneFoldIncomplete`), so every store lane entry is withheld below
   local reach until it is whole. The caller's fold below local reach
   holds no entry at all in that state (D13 item 1), so a reader that
   binds no rule lists nothing either. A local caller is not affected.
2. A failed question answers false (withheld) for that page, so one
   unreadable record does not fail a whole list.
3. A path the store does not hold, or a `Brain/` path naming no lane
   entry, is judged by the rules that apply to it today (D1 item 3).

### D3. The fold choke point

`lane-fold-cache.ts` builds two folds from one internal builder
(`foldOf(store, partitions)`):

1. `laneStoreFold(configPath?)`: the caller's fold. Under
   `privateWithheld()` it folds `shared` only, cached under its own key
   (`<store root>` plus a `shared` suffix), its fingerprint prefixed with
   a marker no whole fold carries and stamped over the `shared` shards
   only; otherwise it is the fold of every partition, as today. Its
   `privateKeys` is empty and its `unreadable` and `pendingBlobs` name
   `shared` gaps only.
2. `wholeLaneStoreFold(configPath?)`: the fold of every partition this
   machine holds, whatever the scope (today's `laneStoreFold`).

The caller's fold is the default, so a reader nobody listed is narrowed
by construction; a caller that needs every partition asks for it by name.
`laneStoreStamp` returns the caller's fold's fingerprint, so every memo
keyed by it (the entity index signature in
`src/core/brain/entities/index-builder.ts`, the person cache in
`src/core/brain/entities/registry.ts`) keeps a value built for one scope
away from the other: the two fingerprints never match, so the memo is
rebuilt when the scope changes.

Callers on the caller's fold (readers; below local reach they see only
`shared`):

| Caller | Where |
|---|---|
| `storeEntries`, `storeEntry`, `laneEntryClockMs` | `lane-entry-store.ts` |
| `readLanePage`, `lanePageExists`, `parseLanePage`, `readLaneText`, `readLaneFile`, `laneFileBytes`, `listLaneFiles`, `laneStems`, `listLaneTree`, `listLaneDirs`, `laneStoreStamp` | `lane-pages.ts` |
| every lane module read built on them (entities, triggers, write sessions, open decisions, intentions, pledges, obligations, procedures, dead ends, tensions, theses, the lifecycle target reads `memory-target.ts` :248, :348, :438, :444, :821), the standing rule read (`standing-rules.ts` :195) | lane modules |
| the incompleteness check and the shard list of the two readers that report store gaps: `standing-rules.ts` :197-198 (`brain_active`) and `governance/store-unreachable.ts` :37-38 (`brain_delete_by_source`); below local reach they name `shared` gaps only and say nothing about `private` (finding 4 of round 2) | brain modules |
| the reads in the write primitives that decide what a caller addressed: `removeLanePage` (:575), the source of `moveLanePage` (:630), the `sameEntry` short cuts (:446, :503), the path lists of `moveLaneTree` and `removeLaneTree` | `lane-pages.ts` |

The last row is what makes an update, a transition and a removal of a
private entry below local reach find nothing and answer as for an absent
entry (D4). The two gap reporters read the caller's fold for both the
verdict and the names (`laneFoldIncomplete(laneStoreFold())`), so at
local reach they answer as today and below local reach a `private` gap
neither fails the read nor appears in an answer.

Readers outside the lane fold that answer whether a store record exists:

| Reader | Below local reach |
|---|---|
| `entityOfRecord` (`lifecycle/memory-target.ts` :179-197, the `store:<id>` address of `brain_lifecycle` and the lifecycle file tools) | reads the `events` records of `shared` only under `privateWithheld()`, so a `private` record id answers "no record of the brain store has this id" exactly as an absent id (finding 4 of round 2) |
| `exact-state.ts` (reads shards directly) | command line only; no tool reaches it; recorded, unchanged |

Callers on the whole fold (each named explicitly in code):

| Caller | Where | Why the whole fold |
|---|---|---|
| `laneEntryInPrivate`, `livesInPrivate`, `partitionOf`, `foldIncomplete` | `lane-entry-store.ts` | privacy verdicts: over the shared fold every entry reads as shared, the opposite of fail closed; used by the shared rule (D1), the reference view (`store-record-visibility.ts` :170), the exporter (`okf.ts` :503), `counterparty-brief.ts` :330, `entities/page-privacy.ts` :25, `tensions.ts` :682 |
| `storedEntryPrivate`, `replacedShared`, `tombstoneOf` | `lane-entry-store.ts` | a write's placement: a record built from the shared fold could land a private entry's successor in `shared` or omit its tombstone |
| `storeEntryRead`, `readLaneEntrySnapshot` | `lane-entry-store.ts`, `lane-pages.ts` | a writer's version check and repair: the privacy restamp (`privacy-marker-restamp.ts` :270) and the read-back and base checks of the change `tool-lane-write-keeps-standing` compare against what the store holds, not what one caller may see |
| the create-lock existence check (`withCreateLock`, :558) | `lane-pages.ts` | a create must not succeed over an entry it cannot see; runs after the D4 guard, so below local reach it never reports a private key |
| the record builders: `moveLaneTree` (:720), `removeLaneTree` (:738), every fold read in `lane-dual-moves.ts` (:100, :260, :332, :337, :368) | store side | records and tombstones are placed by where each entry lives |
| the D4 guard | `lane-reach-guard.ts` (new) | it must see the private key it refuses |
| the writer judges `storedEntryPrivate` in `memory-target.ts` :639 and `write-session/personas.ts` :175 | brain modules | placement of a write |
| the store record lookup the reach and owner views consult, the reference resolver and the write-side judge (D6, D7) | `store-record-visibility.ts`, `artifact-ref-resolve.ts`, `reference-privacy.ts` | a reference must be found to be judged; a miss in the shared fold reads as "names nothing", which is visible |
| projection writers (D5) | `procedural-memory.ts` reconcile, `procedural-graph.ts` and `procedural-hints.ts` rebuild, the procedural index listing (read whole, then filtered) | the projection is machine state or one store record every later caller reads |
| the skill-accept recovery (`journalWithheldAtReach`, then the resolution inside `withPrivateShown`) | `lane-reach-guard.ts`, `skill-proposals.ts` | the journal is device-local: below local reach a journal whose proposal, archive or procedure is held in `private` (live or removed there), or any journal while the whole fold may miss a record, is left for a local caller, unread and unnamed; one it resolves takes its commit witness and its rollback removals from the whole fold |
| the move records (`moveSourceAtReach`, `assertWritableInFold`) | `lane-reach-guard.ts`, `lane-pages.ts` | a single-page move takes its source, its moved value and its tombstone's partition from one whole fold inside the store write and judges its destination there again; a tree move judges its destinations against the fold it builds from |
| the disk fallback of the reach predicate (`storeLaneEntryAt`) | `mcp/brain/reach-readable.ts` | below local reach a file at a lane path answers only for an entry the whole fold definitively does not hold, never for a withheld one |
| the claim-source judge | `reference-privacy.ts` | a shared lane entry does not answer for a vault page the same reference names: the page is judged too, and either private verdict wins |

A projection writer and any other work whose result is kept for every
later caller run inside `withPrivateShown` when called below local reach
(as `src/core/brain/active.ts` does for the digest cache), so every fold
they read is whole; their answer to the caller is built by D5. The
projection writers do this themselves (D5 item 4), so every tool that
starts one (the table of D5) builds whole without a wrapper of its own.
Inside `withPrivateShown` the D4 guard does not apply: such work writes
exactly what the same work at local reach writes, and its answer to the
caller is filtered.

The dream: `brain_dream` already refuses, below local reach, every real
pass, every single step and the staged lifecycle with the fixed answer
`DREAM_LOCAL_REACH_ONLY` before anything is read or written
(`src/mcp/brain/dream-tools.ts` :178-187); it serves only a dry run,
planned over the records the caller may read (`previewReadable`), and
that plan's lane reads go through the caller's fold. No dream pass runs
for a caller below local reach, so no `withPrivateShown` rule is needed
for it; the probe (D9) keeps calling the dry run.

### D4. Writes below local reach

The guard lives in a new module, `src/core/store/lane-reach-guard.ts`,
because `lane-pages.ts` is already past the 700-line limit (739 lines
before this change): `lane-pages.ts` gets only the call sites. The
module exports:

1. `LaneEntryWithheldError`, whose message is exactly "this entry cannot
   be written at this reach" and which carries no path or key;
2. `assertLaneWriteAtReach(vault, paths, configPath?)`: only under
   `privateWithheld()`, reading the whole fold once, it throws
   `LaneEntryWithheldError` when the whole fold is incomplete or a target
   key (each path that names a lane entry the store holds) is in the
   whole fold's `privateKeys`; otherwise it does nothing. Nothing is
   written before it;
3. `assertLaneRemovalAtReach(vault, configPath?)`: only under
   `privateWithheld()`, throws the same error while the whole fold is
   incomplete (a `private` shard unreadable or a `private` body not
   arrived), because a stale `shared` value the caller's fold still shows
   could then be tombstoned over a `private` entry the fold cannot see;
4. `withheldPrivateKey(vault, path, configPath?)`: under
   `privateWithheld()`, whether the key of `path` is live in `private` in
   the whole fold (false outside the scope).

The call sites (each in `lane-pages.ts` unless named):

| Primitive | Below local reach |
|---|---|
| `writeLanePage`, `writeLaneText` (store-held branch, before the `sameEntry` short cut) and `withCreateLock` (before the existence check) | `assertLaneWriteAtReach` on the path |
| `removeLanePage` (store-held branch) | `assertLaneRemovalAtReach`; a key live in `private` returns `false` (the answer for an absent page) and writes nothing, also when the caller's fold still shows a stale `shared` value for it |
| `removeLaneTree` (store-held branch) | `assertLaneRemovalAtReach`; the paths whose key is live in `private` are left out of the removal records, so no tombstone is written over them |
| `moveLanePage` (store-held branch) | a source whose key is live in `private` throws the existing "no lane page to move" error of an absent source; `assertLaneWriteAtReach` on the destination; the source check runs first; inside the store write, source and destination are judged again from one whole fold (`moveSourceAtReach`): a source raised meanwhile is left alone |
| `moveLaneTree` (store-held branch) | `assertLaneRemovalAtReach`; sources whose key is live in `private` are left out; `assertLaneWriteAtReach` on every destination, and again against the fold the store write builds from (`assertWritableInFold`); nothing is tombstoned or superseded in `private` |
| `writeMemoryPatches` (`lifecycle/memory-target.ts`, the lifecycle tools' store writer, which calls `storeWrite` directly) | `assertLaneWriteAtReach` on the lane targets before the first record, so a stale `shared` target or an incomplete fold never yields a `located` record over a `private` entry |
| `recordDecision` (`decisions/record.ts`) | `assertLaneWriteAtReach` on the decision path and, when its review obligation is to be created, on that obligation's path, before the decision page is written: a review obligation live in `private` refuses the whole record, so no decision is left without its review obligation |
| entity create and update (`entities/registry.ts` `writeEntityFile`) | before the write, an entity record that would land in `private` (`storedEntryPrivate` of the path, or `isPrivateEntry` of the rendered page, the judge `entryRecord` applies) is refused with the fixed answer: the registry reads every write back through the caller's fold, which cannot show a `private` entry, so the write would land and the call fail; refused before the first write, nothing lands |

The write primitives the guard does not reach and why:

| Writer | Why it is not guarded |
|---|---|
| `brain_clusters run` (`materializeClusterNotes`, `writeLaneText` and `removeLanePage` of `Brain/clusters/`) | runs inside `withPrivateShown` below local reach (`knowledge-lane-tools.ts`): detection is over the whole search index and the notes are the ones a local run writes, so nothing is lost; the answer stays filtered by the reach and owner views as today (`written` by visible community, `removed` and `batches` withheld whole) |
| projection writers (D5) | run inside `withPrivateShown` by construction (D5 item 4) |

Allocated keys (a create that allocates `slug`, `slug-2`, … or an entity
id from the caller's fold) meet the guard as a refusal and stop when the
allocated key is live in `private`; they do not skip it (lead ruling (a):
skipping would reveal the same fact, and the key spaces stay shared
until the follow-up).

The verb contract that follows (finding 3 of the review):

| Verb kind | Examples | Below local reach on a private-partition entry |
|---|---|---|
| update, transition, removal | pledge fulfil and remove; obligation done and remove; intention move; trigger acknowledge, dismiss, act, suppress, snooze and their reverses; tension confirm, dismiss, resolve; open decision resolve and discard; decision rate and outcome; lifecycle actions; write-session submit, approve, abandon | the module's read sees the caller's fold, finds nothing, answers as for an absent entry; nothing reaches a write; a stale `shared` value the caller's fold still shows meets the removal and move guards above |
| create-style | intention set; decision record; open decision open on the same id; pledge, obligation, entity create on a taken key | the read finds nothing, the write reaches the guard, the guard refuses with the fixed answer before any record |
| read | decision compare, every list, show, history, status | the caller's fold |

While the whole fold is incomplete every lane write and removal below
local reach is refused with the fixed answer (lead ruling (c)); a local
write is judged as today.

The intention reproduction case (`brain_intention set on a withheld
chain`) asserted an answer identical to an absent scope; decision 2 of
the lead replaces that with the fixed refusal, and the case is rewritten
to assert: refused, the answer is the fixed text (with the tool's
prefix, if the handler adds one), carries no token of the chain, and the
chain is unchanged. The existing `cannot set scope` refusal in
`workspace-tools.ts` stays for a file-backed machine; on a store machine
the private chain is no longer found and the guard answers.

### D5. Persisted projections

The procedural graph and hints (`src/core/brain/procedural-graph.ts`,
`procedural-hints.ts`, read in `src/mcp/brain/procedure-tools.ts` `show`
and `hints`) are built from every procedure and stored as machine state.
Choice: filter at read time below local reach (smaller than a second
build per reach, which would need its own storage, invalidation and
rebuild path, and fail closed by an allow-list). The filter lives in a
new module beside the tool file, `src/mcp/brain/procedural-projection-filter.ts`.

How the graph names things (checked in the code): `rebuildProceduralGraph`
emits five node kinds. `procedure`, `skill` and `runbook` nodes come from
the procedural memory index, one per entry, with `sourcePath` the
entry's vault-relative page path; `proposal` nodes come from the skill
proposal lane, with `sourcePath` `Brain/skill-proposals/<status>/<file>`;
`entity` nodes are synthetic (`sourcePath: null`), titled
`Trigger: <t>`, `Tag: <t>`, `Path: <segment>` or `Proposal Path:
<segment>`, and are shared between the nodes that point at them. Edges go
from a non-entity node to an entity node (`trigger_matches`,
`tag_matches`, `source_mentions`, `proposal_mentions`) or from a
procedure to a proposal (`derived_from_proposal`). The hints projection
holds one entry `{ node_id, cues }` per non-entity node.

1. The filter, when the request's predicate
   (`readableAtContextReachOrUndefined(ctx)`) is defined, in two passes:
   1. a non-entity node (`procedure`, `skill`, `runbook`, `proposal`) is
      kept only when its `sourcePath` is a non-empty string, the
      predicate reads it readable, and, when it is a `Brain/` path that
      names a lane entry on a machine whose lane pages live in the store,
      the caller's fold holds it (`readLanePage(...) !== null`; the
      predicate alone falls back to the vault rule for an entry the
      caller's fold does not hold, which reads a missing file as
      readable);
   2. an `entity` node is kept only when at least one edge joins it to a
      kept non-entity node; every other edge is dropped (an edge is kept
      only when both ends are kept);
   3. a hint entry is kept only when its `node_id` is a kept non-entity
      node; its cues are left as they are (they are derived from that
      node alone);
   4. every count is computed from the kept sets, and the answer is
      built from the known fields only (`schema_version`,
      `generated_at`, `nodes`, `edges` for the graph; `schema_version`,
      `generated_at`, `entries` for the hints); an unknown top-level
      field is left out below local reach.
2. `show`, `hints` and the answer of `rebuild` pass through the filter.
3. The procedural memory index (`Brain/procedural-memory/index.json`) is
   one store `lane-entry` listing every procedure's `sourcePath`, title,
   triggers and tags. With D7, a single private-partition procedure makes
   the judge of `writeProjections` (`rowNamesPrivatePage` over the
   entries) place the index in `private` (with a `shared` tombstone), so
   a caller below local reach whose fold holds only `shared` would see no
   index at all, and every shared procedure would vanish from
   `brain_procedural_memory list` (finding 1 of round 2). Choice, the
   smaller fail-closed option: `listProceduralMemory` reads the index
   from the whole fold (inside `withPrivateShown`) and, under
   `privateWithheld()`, keeps an entry only when its `sourcePath` is not
   a `Brain/` lane path held in the store, or the caller's fold holds
   that lane entry and `laneEntryInPrivate` is false for it. The tool's
   own predicate filter (`readable(e.sourcePath)`) stays as the second
   layer. Every caller of the listing (`brain_procedural_memory list`,
   `mark_used`, `mark_outcome`, `brain_analytics` attention flows, the
   skill proposal readers) is thereby answered without the private
   procedures; the alternative (the index as machine state, like the
   graph and hints) would change what is synced and needs a migration,
   so it is not taken.
4. Every projection rebuild runs whole: `reconcileProceduralMemory`,
   `rebuildProceduralGraph` and `rebuildProceduralHints` run their body
   inside `withPrivateShown`, so whatever tool starts them below local
   reach, every fold they read is whole and what they store is what a
   local run stores. Per tool:

   | Tool, verb | Rebuild | Answer below local reach |
   |---|---|---|
   | `brain_procedural_memory reconcile` | whole (item 4) | counts over the entries the predicate reads readable (`include`), evaluated inside the whole build, where the predicate's partition check withholds every private entry |
   | `brain_procedural_graph rebuild` | whole (item 4) | counts from the item 1 filter |
   | `brain_skill_proposals learn`, `accept`, `reject`, `recover` | whole (item 4; `skill-proposals.ts` is not edited) | the verbs report proposals and slugs, no projection content; the proposal page writes themselves stay under the caller's scope and the D4 guard |

The same shape, looked at once (each needs a failing test first if it
carries lane entry content below local reach; otherwise it is recorded as
checked):

| Projection | Status |
|---|---|
| procedural graph and hints | confirmed leak; fixed by items 1 and 2 |
| procedural memory index (`Brain/procedural-memory/index.json`, a store lane entry) | fixed by item 3 (read whole, filtered) |
| claim graph and theses (`claim-graph.ts`, `truth/store.ts` state) | `brain_claims current` and `history` show the canary locally and not remotely in the probe: checked, clean |
| clusters and bridges | rows of the readers test, green: checked, clean; `brain_clusters run` writes whole (D4) |
| entity index and person cache (in-memory, keyed by `laneStoreStamp`) | per scope by D3; covered by the entity case of path 1 |
| link graph hub candidates (`link-graph/hub-candidates.ts`) | checked, clean (round 2 reviewer): reached only from the command line (`inbox-drain`, `repair-lane`), reads vault files through `listVaultPages`; no tool serves it below local reach |
| hallways (`link-graph/hallways.ts`) | checked, clean (round 2 reviewer): reached only from the command line (`cli/brain/verbs/hallways.ts`), reads non-private continuity mentions |
| communities (`link-graph/communities.ts`) | `brain_clusters run`: detection over the search index, notes written whole (D4), answer filtered by the reach and owner views |
| any other file under the state directory that a tool reads below local reach | task 4.4 greps the writers of machine state that read lane pages and lists each |

### D6. References to store-held lane entries

`artifactPath` and `pageCandidate` (`src/core/brain/artifact-ref-resolve.ts`)
probe the disk only, so on a store-only machine a bare id
(`decision-<slug>`, `src-<slug>`, an entity id) or an extensionless
`Brain/` path that names a store-held lane entry resolves to nothing and
reads as visible; with no vault `storeRecordRefView`
(`src/core/brain/store-record-visibility.ts`) judges only strings that
start with `Brain/`.

`artifactRefView(vault, pathVisible)` holds neither a reach nor a scope:
it only resolves a reference and hands the path to the rule of the view
that built it. The two views that hold them, `reachView`
(`reach-view.ts`) and `ownerScopeView` (`owner-scope-view.ts`), already
consult `storeRecordLookup(vault)` before their file rule. That lookup is
where a store-held lane entry is judged (finding 3 of round 2), so
neither view file and not `artifact-ref-view.ts` is edited:

1. The resolver, for a candidate under `Brain/` on a machine whose lane
   pages live in the store, asks the whole fold whether a lane entry
   lives there and returns its path when one does: a bare id in the
   directories it already probes (sources `src-<slug>`, decisions
   `decision-<slug>`), an entity id in any category
   (`Brain/entities/<category>/<id>.md`: the store is searched for an
   `entities` entry whose last segment is the id, since entities live
   under a category folder and the disk probe of the flat
   `entities/<id>.md` finds none; the disk probe of a file machine is
   unchanged), and the `.md` twin of an extensionless `Brain/` path.
   Amended by D12 item 3: a bare id resolves in every lane the store
   holds, not only these.
2. `StoreRecordLookup` (`store-record-visibility.ts`) returns a
   `VisibilityRecord | undefined`: after the memory records, a
   vault-relative `Brain/` path that names a lane entry the whole fold
   holds is answered with that entry's record (its fields as `meta`, and
   `private` from `laneEntryInPrivate`; a failed question answers
   `private: true`, fail closed). The lookup exists on a machine whose
   memory records or whose lane pages are read from the store. `reachView`
   and `ownerScopeView` then judge a store-held lane entry by its record,
   as they judge a preference, so a shared decision stays visible and a
   private one is withheld.
3. `storeRecordRefView` (no vault): a bare id or wikilink that names no
   memory record is mapped by the resolver of item 1 against
   `laneVaultRoot(null)` and, when it names a lane entry, judged by
   `laneVisible`.

This fixes path 3 at read time for every row, including rows already in
`shared` (D7).

### D7. The write-side judge

1. `refsNamePrivatePage` (`reference-privacy.ts`), on a machine whose
   lane pages live in the store, resolves a reference through D6 item 1
   and counts a resolved store-held lane entry as a private page when
   `laneEntryInPrivate` is true or its fields reserve it. Receipts
   (`decisions/receipts.ts` :398), log events and every other row judged
   by `rowNamesPrivatePage` naming a private decision then land in
   `private`. With no vault the judge already counts every page-shaped
   reference as private (`namesAPage`); unchanged.
2. `claimSourceIsPrivate` (same file) probes `statSync` only, so an
   extensionless `Brain/decisions/decision-<slug>` claim source names no
   file on a store machine and is judged shared. It asks the whole fold
   first: a candidate (the source, then its `.md` twin) that names a lane
   entry the store holds is private when `laneEntryInPrivate` is true or
   its fields reserve it; with no vault the lane root is
   `laneVaultRoot(null)`.
3. A consequence for the procedural memory index: see D5 item 3.

Rows already written to `shared` before this rule: no existing pass moves
them. The privacy restamp (`privacy-marker-restamp.ts`) rewrites page
frontmatter only, and store shards are append-only. On this machine D6
withholds them below local reach at read time; a peer that holds only
`shared` already has them. Stated as a limit; the follow-up is a pass
that re-judges ledger rows in `shared` and supersedes those naming a
private entry (out of this change).

### D8. Error wording

With D3 every error built from a lane read under the scope sees only the
shared fold, so it cannot name a private entry: the duplicate refusal of
`openDecision` (`open-store.ts` :640) finds no duplicate; the "already
exists" refusals of pledges, obligations, theses and decisions
(`pledges.ts`, `obligations.ts`, `health/thesis.ts`, `decisions/record.ts`
:545, `pledge-intake.ts`) find nothing and reach the guard. The only
whole-fold reads that can raise an error under the scope are the D4 guard
(fixed text) and the record builders (no entry-naming errors). Two
further readers answered from outside the lane fold are narrowed by D3:
the gap reporters of `standing-rules.ts` and `store-unreachable.ts` name
`shared` gaps only below local reach, and `entityOfRecord` answers a
`private` record id as an absent one. The interaction with
`tool-lane-write-keeps-standing` (D11) is the one further case.

### D9. The registry-wide probe

`tests/mcp/lane-private-partition-reach-probe.test.ts` keeps its
enumeration (lanes from the migration catalogue and the source tree;
tools from `buildToolTable()`; resources) and changes its seeding and
its call plan:

1. Seeding: a table of writers, one row per lane a tool reads, each
   seeding one hidden entry (a `<private>` region, no `visibility:`) and
   one shared control through the lane's real writer (the ones the paths
   file uses: `upsertEntity`, `createTriggers`, `openDecision`,
   `setIntention`, the `brain_decision record`, `brain_dead_ends record`
   and `brain_write_session open` tools at local reach; the pledge,
   obligation, tension and procedure writers), and the projections
   rebuilt at local reach. A lane with no real writer is seeded with
   `writeLaneText` in its page format; a lane it cannot seed either way is
   printed with the reason. The writer table lives in a sibling helper
   module, `tests/mcp/lane-private-partition-reach-probe-writers.ts`,
   since the probe file is already 575 lines.
2. Proof per lane, run once: at local reach only the lane's own reader
   (from the writer table) is called and must show the hidden token; a
   lane whose own reader does not show it fails the probe, so a "no
   canary" below local reach is evidence.
3. Below local reach the full matrix runs once; identical calls are
   deduplicated; a per-lane id, path or title call is made only for verbs
   whose argument names an entry.
4. Time: the local matrix (half of today's roughly 9,000 calls) goes, and
   with deduplication the probe targets under 15 s on a development
   machine; its CI time is folded into `.github/windows-test-timings.json`
   (`CLAUDE.md`, Windows test shards).
5. The lint error at about line 85 (an unnecessary escape in a character
   class) is fixed.

### D10. Cost, checked deterministically

The wall-clock bar is replaced (finding 5). The checks: two calls of
`laneStoreFold` under the scope with no write between return the same
object, two whole folds return the same object, and the two are distinct
objects with distinct fingerprints (the cache serves each scope from its
own key, no rebuild per entry); `laneEntryInPrivate` reads the fold once
(D1 item 1, by review of the diff). The existing fifty-pledge case of the
readers test keeps asserting its result only.

### D11. Interaction with `tool-lane-write-keeps-standing`

That change edits the same write primitives in `lane-pages.ts` (base
check, read-back, kept standing). This change is implemented first; the
other rebases onto it. Its base check and read-back use `storeEntryRead`,
which reads the whole fold (D3); that read-back is sound. Its
`LaneWriteNotAppliedError` and `LaneEntryChangedError` name a path, a
holder's authority and, for an incomplete fold, the gap and doctor text.
Requirements for its integrator (the spec requirement "A write reported
as not applied names no private holder"):

1. the reach guard of D4 (`assertLaneWriteAtReach`) runs before that
   change's version check (`checkLaneBase`) at every write primitive, so
   below local reach an incomplete whole fold or a key live in `private`
   is refused with the fixed answer before `LaneEntryChangedError`
   (`incomplete`) can report a `private` gap or its doctor text;
2. under `privateWithheld()`, its not-applied error becomes
   `LaneEntryWithheldError` whenever the winning record of the key, live
   or a removal, is in the `private` partition, or the whole fold is
   incomplete: the fold's `privateKeys` holds live entries only
   (`lane-fold-cache.ts` :191), so a `private` removal tombstone written
   by a human must be found from the winning record itself, or the error
   would still report the path, the removal and the `human` authority.

The guard module of D4 (`lane-reach-guard.ts`) is where that change
imports the error and the scope check from; it adds no code to this
change.

### D12. A record derived from a private-partition entry is private

Found by the reseeded probe during implementation (D9): a writer that, in
the same operation, writes a second record carrying facts of a lane entry
lets that record be judged on its own text, so it lands in `shared` while
the entry it describes lands in `private`. Two sequences were confirmed:
the review obligation `recordDecision` opens is titled
"Review decision: <decision title>" and names no page, so a private
decision's title is listed by `brain_obligation list` and `brain_brief
today`; the "tension detected" log event names its tension by
`[[tension-<slug>]]` and its two subjects, and the judge resolved no
tension id, so `brain_agent_query` and `brain_agent_diff` show it.

Rule: a derived record takes the privacy of the entry it derives from,
decided before either is written, for a create and for a later rewrite
of the derived record. Per site the smaller of two mechanisms:

1. Placement passed down: the writer runs the derived write inside
   `withOperationPrivacy(verdict)`, where `verdict` is the new
   `laneTextLandsPrivate(vault, path, text)` (`lane-entry-store.ts`):
   the entry there lives in `private` or reserves it, the legacy page
   there reserves it, or the judge every lane write applies
   (`isPrivateEntry`) finds the text private; a failed judgement answers
   true. A later rewrite keeps the partition by the store's own rule
   (`storedEntryPrivate`: nothing lowers an entry's partition).
2. A reference the write-side judge resolves: the derived record names
   the entry by id or path; D7 judges it by the entry (item 3).
3. Generic id resolution (amends D6 item 1 and D7): on a machine whose
   lane pages live in the store, a bare id or `[[id]]` resolves to every
   store-held lane entry whose page name is that id (the last segment,
   `.md` dropped, or a `.json` record's stem), in every lane of the
   whole fold, derived from the lane map (`lane-paths.ts`
   `brainRelOfEntry`) and not from a list of lanes. Of several entries
   with one id the one in `private` is chosen (fail closed), then
   sources, decisions, entities, then by path. The index is kept per
   fold object, so a write in the same operation is seen. So a record
   naming such an entry is judged private at write time, and rows
   already in `shared` are withheld at read time on this machine (D6
   items 2, 3).

The sweep: every writer that writes a secondary record in the same
operation as a lane entry write (from `git grep` of the lane write
primitives against log, receipt, ledger, audit, metric, obligation and
trigger appenders):

| Writer | What the secondary record carries | Before, entry private | Now | Proof |
|---|---|---|---|---|
| `recordDecision` review obligation | the decision title | `shared` | `private` (item 1) | refs > "a decision's review obligation takes the decision's partition"; probe |
| `recordDecision`, `backfillOutcome`, `updateRating` log events and receipts | `[[decision-<slug>]]`, title, chosen | `private` (D7) | `private` | refs > receipts cases; probe |
| `persistTension` create event | `[[tension-<slug>]]`, subject ids | `shared` | `private` (items 1, 3) | refs > "a tension's log event takes the tension's partition"; probe |
| tension transitions | `[[tension-<slug>]]`, status | `private` (`laneEntryInPrivate` passed down already) | `private` | refs > same case |
| `openDecision`, resolve, discard log events, resolve receipt | `[[open-<slug>]]`, title, choice | `private` (decisions lane resolved by D6) | `private` | probe |
| write session terminal audit event (`auditTerminal`) | `session_id`, target path | `shared` (a `.json` session id resolved nowhere) | `private` (item 3) | probe (write sessions row ends one hidden session) |
| entity merge audit row and log event | entity ids, aliases | `private` (`entityPagesPrivate` passed down already) | `private` | unchanged (existing merge tests) |
| pending approval resolution row (`recordResolutionRow`) | publish target path, pending id in free text | target judged by reference; operator door, local reach only | unchanged | none (no tool below local reach resolves) |
| triggers created by scans and tools | source paths | judged by reference (separate operation) | unchanged | probe (triggers row) |
| metrics (`appendMetric`: dream stage, bridges, communities) and the recompile audit row | counts only | carries nothing | unchanged | none needed |
| procedural index, graph, hints; hallways; hub candidates | projections | D5 | unchanged | refs > D5 cases |

`tensions.ts` (794 lines) and `decisions/record.ts` (past 700) get only
the call sites of item 1 and their imports.

### D13. The review round: one view, one binding, one resolution

Three independent reviews of the artifacts and the code found places
where a verdict was taken from one read and acted on from another. Each
is closed by reading the verdict and the value from one place.

1. The caller's fold is judged by the whole fold. Below local reach
   `laneStoreFold` folds `shared` (cached as before) and then judges it
   by `wholeLaneStoreFold`: a key whose winning record is held in
   `private` (a live entry, or a removal, kept in the new
   `privateRemovals`) is left out, so a stale `shared` value of a raised
   or privately removed entry reaches no reader, the readers that bind no
   rule (the write-session list, the entity list) included. While the
   whole fold may miss a record (`laneFoldIncomplete`) the view holds no
   entry, is marked `partitionUnknown`, and still names only the
   `shared` gaps, so the gap reporters name no `private` shard; the
   standing-rule reader treats such a view as "the store could not be
   read whole", never as "no rules". The verdict (the left-out keys, or
   `withheld=all`) is appended to the view's fingerprint, so a memo keyed
   by `laneStoreStamp` (the entity index) is rebuilt when the verdict
   changes. A reader below local reach that binds no rule therefore gets
   nothing while the whole fold is incomplete.
2. A removal is bound to the fold it builds from. `removeLanePage` and
   `removeLaneTree` build their tombstones inside the store write with
   `removalRecordsAtReach` (`lane-reach-guard.ts`): the reach check, the
   winning value of each entry and the partition its tombstone goes to
   come from one fold of every partition, read when the write builds its
   records. A winner that changed after the caller's own read (an entry
   raised meanwhile) is judged again there, so below local reach no
   tombstone is built over a `private` entry and none lands in
   `private`. A folder move filters its paths the same way
   (`pathsAtReach`). What remains is a writer in another process
   appending to the same key between that read and the shard append; the
   append path has no conditional write to bind to, and a protocol-level
   condition is a follow-up.
3. Every rebuild a tool can start below local reach builds whole and
   answers filtered. Checked once: the claim graph (`brain_claims
   rebuild`: now built inside `withPrivateShown`, and the answer's
   `node_count` and `truncated` come from the caller's own in-memory
   build); the procedural index, graph and hints (D5); the active page
   and its recompile (`active.ts`, whole); the topics (`topics/write.ts`,
   whole); the anticipatory cache (a caller below local reach builds its
   own context and never refreshes the stored cache); the entity index
   memo (keyed by the caller's fold stamp, which carries the verdict of
   item 1); cluster materialization (whole, D4); hub candidates and
   hallways (no lane reads).
4. One resolution of a reference. `laneRefMatch`
   (`artifact-ref-resolve.ts`) resolves a reference against the fold of
   every partition: a bare id in any lane (the id index, its last
   tie-break comparing canonical `Brain/` paths), a `Brain/` path as
   written (a `.json` session file too), then its `.md` twin. It answers
   an entry (private when held in `private` or while the fold may miss a
   record), `unknown` (the fold may miss a record and the reference could
   name an entry it does not show, or the question failed) or `none`.
   Both reference views (`artifactRefView` with a vault, the no-vault
   `storeRecordRefView`), both write-side judges (`refsNamePrivatePage`
   with and without a vault, `claimSourceIsPrivate`) and
   `resolveStoreLaneRef` use it, and every one treats `unknown` as
   private. `storeLaneEntryAt` answers private for a lane path while the
   fold may miss a record, before it looks the key up, and a throw there
   answers private. A receipt is judged against the store it is appended
   to (its `configPath`).
5. Refusals and degraded answers. A single move runs the removal guard
   before its missing-source error. The lifecycle authority check
   refuses with the fixed answer when the human record that outranks a
   change below local reach is held in `private`. The forget reporter
   names a pending body below local reach only from `shared`. A stored
   procedural index row or graph node that is no object, or has no
   string id or `sourcePath`, is dropped below local reach instead of
   being dereferenced, and the projection filters and the index listing
   take the caller's `configPath`.

### D14. The write rule: a write decided from lane state decides from every partition

Code that reads lane state to decide a write, a removal, a seeding, a
deduplication, a recovery, a compensation or a rebuild decides from the
fold of every partition. Below local reach it then does one of two
things. (a) Maintenance of the machine's own state (a projection or index
rebuild, a default page, a journal recovery, a deduplication against
existing entries, a dismissal list) runs inside `withPrivateShown`
exactly as for a local caller, and only the answer is narrowed and
filtered; the one exception is a bridge dismissal that meets a dismissal
list held in `private`, which below local reach gets the fixed answer
before the list is read or written, while discovery still reads every
dismissal. (b) A write the caller addresses to an entry goes through the
guard of D4, judged by that fold before its first durable step, so no
journal, marker or flag is written from a narrowed read. A narrowed read
never feeds a decision that deletes, clears, overwrites, recreates,
reseeds, advances a watermark, or fails where the released version
succeeded.

Every durable write reachable from an MCP tool handler is listed with its
class in `tests/mcp/lane-private-partition-reach-census.tsv`; the
census test beside it re-derives the list from the source text and fails
on a writer the table does not name, and the differential write probe
(`tests/mcp/lane-private-partition-reach-probe-write.test.ts`) calls
every verb on a store with private entries and on a twin without them.

The rule is applied by kind of write:

1. Identity deduplication on a create the caller addresses (an obligation,
   a pledge and a pledge intake, a decision with its review obligation, an
   entity upsert and an entity intake, the same-topic design note, a source
   distillation, a staging for a publish target, an open decision, a
   research report): the deduplication, the title or identity reservation
   and the slot choice read the fold of every partition
   (`assertCreateMatchAtReach`). When the entry they match is held in
   `private`, the call gets the fixed refusal before any durable step and
   the answer carries nothing of that entry; a shared match behaves as at
   local reach. A call of several items (a pledge or entity intake) is
   judged item by item first, and one item that meets a `private` entry
   refuses the whole call.
2. An allocation ladder (a free id, an archive slot, a dated stem) picks
   the free key on the fold of every partition (`takenOnWholeFold`, and
   the dead-end create passes over a name a `private` entry holds) and the
   call proceeds; a ladder never ends in the fixed refusal.
3. Machine maintenance a remote call starts (triggers created from
   findings with their cooldown and dismissal, the source archive of an
   ingest, the trim of dead ends, the procedure usage counters, the learned
   entity lexicon, the shared lessons digest, the entity guard of a merge)
   runs on the fold of every partition as released; the answer names and
   counts only what the caller can read.
4. A report snapshot of a brief view is written at local reach only: a
   remote view returns before the snapshot write, so its baseline is never
   a private snapshot and a private snapshot stays byte-identical.
5. An operation over a tree or over derivations (`moveLaneTree`,
   `removeLaneTree`, a confirmed cleanup by source) lists its members on
   the fold of every partition (`treeMembersAtReach`); a member held in
   `private` refuses the whole call before the first move or removal.
6. A row that needs a product decision stays OPEN in the census table with
   its question.
7. Search tuning (`brain_tune`): a remote run scores the grid at the
   caller's reach and answers as at any reach, but does not persist its
   winner, so the machine's one tuning file stays byte-identical; a remote
   reset leaves the file and answers the no-op of a reset with nothing to
   remove (`removed: false`).
8. Recall feedback (`brain_recall_feedback`): the feedback event is the
   call's own record, written with the attribution computed at the
   caller's reach (what that caller was shown). The fold into the shared
   learned weights reads the feedback ledger of every partition, as in
   kind 3, so a remote feedback never rewrites the weights from a narrowed
   set of contributions.
9. The coarse rule, for rows not traced one by one (class `coarse` in the
   census table, reopened in the next release): a write of derived
   machine state below local reach is computed for the answer and not
   persisted; a verb that removes, moves, merges or rewrites lane entries
   the caller did not address one by one (a hygiene apply, a derived-page
   refresh) gets the fixed refusal below local reach, before its first
   durable step, while any lane holds an entry in `private`
   (`assertNoPrivateLaneEntryAtReach`), and behaves as before on a store
   without such entries and in a dry run.

The census scan follows calls across files: a call resolves through the
file's relative imports and the re-exports of the imported module, the
readers of the caller's fold are found to a fixed point over that graph,
and a row lists the reads of every function above it on a call chain.

## The places and their tests

| # | Place | Test (file > case) | Fixed by |
|---|---|---|---|
| 1 | shared rule (pledges, obligations, today brief and every binder) | `lane-private-partition-reach.test.ts`, `lane-private-partition-reach-readers.test.ts` (green) | D1 (done) |
| 2 | `brain_entity` get and list | paths > "brain_entity get and list withhold a private-partition entity" | D3 |
| 3 | `brain_procedural_graph` show and hints | paths > "brain_procedural_graph show and hints withhold a private-partition procedure"; probe | D5 |
| 4 | `brain_write_session` list and status | paths > "brain_write_session list and status withhold a private-partition session" | D3 |
| 5 | `brain_trigger` list, history, acknowledge (and the write) | paths > "list, history and the transition verbs withhold a private-partition trigger" | D3, D4 |
| 6 | `brain_decision history` receipts | paths > "brain_decision history withholds receipts naming a private-partition decision" | D6 |
| 7 | duplicate `brain_decision open` | paths > "a duplicate open refuses without naming the private-partition decision" | D3, D8 |
| 8 | `brain_dead_ends` list | paths > "list withholds a private-partition dead end" (passes; guard) | D1 |
| 9 | `brain_intention set` | paths > "brain_intention set on a withheld chain" (rewritten to the D4 contract) | D4 |
| 10 | receipts placed in `shared` | new: refs > "receipts naming a private-partition decision land in private" | D7 |
| 11 | decision record over a private slug | new: writes > "recording over a private-partition decision is refused with the fixed answer" | D4 |
| 12 | write while the whole fold is incomplete | new: writes > "a write below local reach while the fold may miss a record is refused" | D4 |
| 13 | cache separation | new: writes > "a local list after a remote list sees the private-partition entry" (store and no vault), "the caller's fold and the whole fold are cached apart" | D3, D10 |
| 13a | update verbs answer as absent | new: writes > "fulfil, done and resolve of a private-partition entry answer as for an absent one" | D3, D4 |
| 13b | rebuild below local reach | new: refs > "a rebuild below local reach keeps the whole projection" | D5 |
| 13c | shared references stay visible | new: refs > "receipts naming a shared decision stay visible" | D6 |
| 14 | no-vault references | new: refs > "history withholds receipts naming a private-partition decision with no vault" | D6 |
| 15 | non-lane `Brain/` path | new: refs > "a Brain path that names no lane entry does not fail the request" | D1 item 3 |
| 16 | every other tool | probe > "no tool hands a caller below local reach a private-partition lane entry" (reseeded) | D3 to D8 |
| 17 | write primitives on a private key (round 2, finding 5) | new: writes > "the write primitives below local reach leave private-partition entries untouched" | D4 |
| 18 | removal while the fold is incomplete | new: writes > "a removal below local reach while the fold may miss a record is refused" | D4 |
| 19 | the lifecycle store writer on a private target | new: writes > "the memory patch writer below local reach refuses a private-partition target" | D4 |
| 20 | decision whose review obligation is private | new: writes > "a decision whose review obligation is withheld is refused before anything is written" | D4 |
| 21 | entity create that would land in private | new: writes > "an entity write below local reach that would land in private is refused before anything is written" | D4 |
| 22 | a store record id below local reach | new: refs > "a private store record id answers as an absent one" | D3 |
| 23 | gap reporters | new: refs > "the gap reporters name no private shard below local reach" | D3 |
| 24 | procedural memory index | new: refs > "a private-partition procedure does not hide the shared ones" | D5 item 3 |
| 25 | graph entity nodes | new: refs > "the graph keeps the shared procedure's entity nodes and drops the withheld one's" | D5 item 1 |
| 26 | judge of claim sources and entity ids | new: refs > "the judge counts a store-held private entry named by an extensionless path or an entity id" | D6 item 1, D7 item 2 |
| 27 | review obligation of a private decision | new: refs > "a decision's review obligation takes the decision's partition" | D12 item 1 |
| 28 | tension log event | new: refs > "a tension's log event takes the tension's partition" | D12 items 1, 3 |
| 29 | a row already in `shared` naming a private entry by a bare id | new: refs > "a bare id of any lane the store holds is judged by its entry" | D12 item 3 |
| 30 | a reader with no predicate, incomplete fold | fold > "a reader with no predicate lists nothing while the fold is incomplete" | D13 item 1 |
| 31 | a stale shared value of a raised entry | fold > "a reader with no predicate does not see a stale shared value of a raised entry", "an entity list below local reach leaves out a raised entity's shared value" | D13 item 1 |
| 32 | remote claim graph rebuild | fold > "a remote claim-graph rebuild keeps the local history whole" | D13 item 3 |
| 33 | removal raced by a raise | fold > "a removal whose entry is raised meanwhile writes no private tombstone", "a tree removal ...", "a winner that changed before the build ..." | D13 item 2 |
| 34 | one resolution | resolve > every case | D13 item 4 |
| 35 | refusals, gap reporters, projection rows | errors > every case | D13 item 5 |

## Sibling check (readers outside the lane fold)

| Surface | Below local reach | Rule |
|---|---|---|
| Search | withholds | `isPathReadableAtReach` (`src/core/search/result-filters.ts`) withholds every `.brain-store/` record path below local reach |
| Context packs, MCP resources | withholds | `reachView` (`src/core/brain/reach-view.ts`); after D6 a store-held lane entry named by id is judged by its record |
| Exports (OKF, rollback) | command line only | `okf.ts` asks `laneEntryInPrivate` (whole fold) |
| Hermes | local transport | `o2b mcp` over stdio |
| OpenClaw | withholds | `listVaultPages` walks files; a store-held lane entry is no file. The bundle `openclaw/index.js` contains `resolveArtifactRef`, so D6 requires a rebuild (tasks) |

## Risks / Trade-offs and limits

1. [Residual: a key's existence] A caller below local reach that tries to
   create an exact key live in `private` is refused, so it can infer that
   some entry holds that key. Content, titles, counts and paths never
   cross. The true fix is to keep the keys of the two partitions apart (a
   private entry and a shared entry of the same lane and key coexist,
   each folded in its own partition); that is a follow-up change.
2. [Rows already in `shared`] New records receive the placement fix.
   Receipts, events and lane entries written before D7 that name a
   private entry stay in `shared` and stay on every peer that holds
   `shared`; this machine withholds them below local reach at read time
   (D6, D13 item 4), also while the referenced entry's shard is
   unavailable. Follow-up: a re-judging pass over shared ledger rows.
3. [Writes refused while the fold is incomplete] Below local reach, every
   lane write is refused while a `private` shard is unreadable or a
   `private` body has not arrived; local writes are judged as today.
4. [Cache thrash between scopes] A memo keyed by `laneStoreStamp` is
   rebuilt when calls alternate between scopes; correct, at the cost of a
   rebuild.
5. [A stale shared value] If a raise's `shared` tombstone is missing, the
   `shared` partition still holds the old shared value (what every
   `shared` peer holds); the caller's fold leaves it out because the
   whole fold knows the key as private (D13 item 1), for every reader,
   and the D4 guard refuses any write to it.
5a. [Fewer lane answers while a private shard is unreadable] Below local
   reach a lane read answers as an empty lane, and an id-shaped reference
   the store cannot resolve counts as private, until the fold is whole
   again; a local caller is not affected.
6. [Allocation ladders stop at a private key] see D4.
6a. [A private entity is not written from below local reach] an entity
   create or update below local reach whose record would land in
   `private` is refused (D4), because the registry answers with the
   entity read back through the caller's fold; a local caller writes it
   as today.
6b. [Clusters run whole] `brain_clusters run` below local reach writes
   the same notes a local run writes (D4); its answer stays filtered.
7. [Two changes in one release touch the same write primitives] D11; this
   change lands first.

## Migration Plan

None: no format or data change. Rollback is reverting the source files of
this change.
