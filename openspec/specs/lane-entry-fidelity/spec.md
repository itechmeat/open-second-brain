# lane-entry-fidelity Specification

## Purpose
What a lane file written whole on a store-only machine reads back as, so
staged bytes survive the trip through a `lane-entry` record.

## Requirements

### Requirement: A lane file written whole reads back byte for byte

On a store-only machine a lane file written from its whole text SHALL read
back as exactly that text: a page without frontmatter, a quoted value that
would parse as a number or a boolean, CRLF line ends, a missing final
newline and the formatting of a JSON file are all kept.

#### Scenario: A page without frontmatter

- **WHEN** a lane page is written whole as `Just text.\n`
- **THEN** it reads back as `Just text.\n`, with no frontmatter added

#### Scenario: A quoted value

- **WHEN** a page is written whole with the frontmatter line `id: '123'`
- **THEN** it reads back with `id: '123'`, and its parsed `id` is the
  string `123`

#### Scenario: JSON formatting

- **WHEN** a JSON lane file is written whole as `{"a":1}\n`
- **THEN** it reads back as `{"a":1}\n`

### Requirement: The raw text is stored only when the parts lose it

A `lane-entry` record SHALL carry the file's text only when its fields and
text do not reproduce it, and only when that text parses back to them; a
file the parts reproduce SHALL be stored as before.

#### Scenario: A canonical page

- **WHEN** a page is written whole in the form the frontmatter writer
  itself produces
- **THEN** its record carries no raw text

### Requirement: The raw text counts for the entry's privacy

A reference to a private page, or a private region, that appears only in
the raw text (for example in a frontmatter comment) SHALL send the entry
to the `private` partition, as the same reference in its fields or text
does.

#### Scenario: A private reference in a frontmatter comment

- **WHEN** a page is written whole whose frontmatter comment names a page
  reserved as private
- **THEN** its record lands in the `private` partition

### Requirement: The writer's judge is the only privacy judge of the raw text

The writer's privacy judge SHALL be the only judge of the raw text,
exactly as it is the only judge of the text: the fold and the readers
SHALL NOT re-judge either. The read-side check that the raw text parses
back is not a privacy judge; it only stops the raw text from saying
something other than the record's own fields and text.

#### Scenario: A hand-appended shared record with a raw comment

- **GIVEN** a `lane-entry` record appended by hand to the `shared`
  partition, bypassing the writer's judge, whose raw text carries a
  frontmatter comment that names a private page and otherwise parses back
  to the record's fields and text
- **WHEN** the lane file is read
- **THEN** the reader serves the raw text, comment included, as written
  (the same trust a hand-appended `text` already gets)

### Requirement: A raw text that does not match its record is not served

A reader SHALL serve a record's raw text only when it parses back to the
record's own fields and text; otherwise it SHALL render the fields and
text as before, so a peer cannot serve content that differs from the
record's parts.

#### Scenario: A mismatched raw text

- **GIVEN** a synced record whose raw text parses to other fields than
  the record carries
- **WHEN** the lane file is read
- **THEN** the reader returns the rendering of the record's fields and
  text

### Requirement: Structured writes and moves

A structured write (fields and body) SHALL store no raw text and replace
an entry that had one; a move SHALL keep the entry's raw text; a whole-text
write that changes only bytes the parts do not carry SHALL be written, not
skipped as unchanged.

#### Scenario: A quoting-only change

- **GIVEN** an entry written whole with `id: '123'`
- **WHEN** it is written whole again with `id: "123"`
- **THEN** a new record is written and the file reads back with the
  double quotes

#### Scenario: A move

- **WHEN** an entry with raw text is moved
- **THEN** the moved file reads back byte for byte

### Requirement: The raw field is optional and never rejects a record

The raw text SHALL be an optional field of the existing record kind, with
no format version change and no change to the fold's rejection rules: a
record without it SHALL fold exactly as before, and a record whose raw
field is not a string SHALL fold without rejection, with no raw text in
its value.

#### Scenario: A record without raw text

- **WHEN** a `lane-entry` record without the field is folded
- **THEN** the entry's value has its fields and text and no raw text

#### Scenario: A raw field that is not a string

- **WHEN** a `lane-entry` record whose raw field is the number `5` is
  folded
- **THEN** the record is accepted and the entry's value has no raw text

### Requirement: A private-partition lane entry is withheld below local reach

On a machine whose lane pages live in the store, with or without a vault,
a lane entry the store holds in its `private` partition SHALL NOT be
readable by a caller below local reach, whatever its frontmatter says.
Every tool SHALL leave such an entry out of every list, count, total and
rendered text, and answer a request naming it exactly as for an entry
that does not exist.

#### Scenario: A pledge private by partition alone is not listed or shown

- **WHEN** the store holds a pledge in `private`, its frontmatter carries
  no `visibility:` field, and a caller below local reach lists pledges and
  then shows that pledge by its slug
- **THEN** the list carries neither its slug nor its title nor its text,
  the count excludes it, and the show answers as for an absent pledge

#### Scenario: An obligation private by partition alone is not listed or shown

- **WHEN** the store holds an obligation in `private` with no
  `visibility:` field, and a caller below local reach lists obligations
  and shows that obligation by its slug
- **THEN** the list carries neither its slug nor its title, the count
  excludes it, and the show answers as for an absent obligation

#### Scenario: The today brief neither shows nor counts it

- **WHEN** the store holds a pledge and an obligation in `private` and a
  caller below local reach asks for the today brief
- **THEN** neither entry's slug, title or text appears in any section or
  in the rendered text, and the pledge and obligation totals count only
  the readable entries

#### Scenario: An entity private by partition alone is not listed or read

- **WHEN** an entity is written by the entity registry with a `<private>`
  region in its body, the store holds it in `private`, a shared entity
  exists beside it, and a caller below local reach calls `brain_entity`
  with `view=list` and with `view=get` naming the private entity
- **THEN** neither answer carries its name or body, the list carries the
  shared entity, and the get answers as for an absent entity

#### Scenario: A write session private by partition alone is not listed and its status reads as unknown

- **WHEN** a write session is opened at local reach with a `<private>`
  region in its prompt, the store holds it in `private`, and a caller
  below local reach calls `brain_write_session` with `op=list` and with
  `op=status` naming that session's id
- **THEN** the list carries neither its target nor its prompt, and the
  status answer equals the answer for an id that does not exist, the id
  aside

#### Scenario: A trigger private by partition alone is not listed and not moved

- **WHEN** a trigger is created with a `<private>` region in its reason,
  the store holds its own lane page in `private`, a shared trigger exists
  beside it, and a caller below local reach calls `brain_trigger` with
  `operation=list`, `operation=history` and `operation=acknowledge`
  naming the private trigger's id
- **THEN** list and history carry neither its id nor its cooldown key nor
  its reason, the list carries the shared trigger, the acknowledge answer
  equals the answer for an absent id (the id aside), and a local read
  afterwards shows the private trigger still `pending`

#### Scenario: A dead end private by partition alone stays withheld

- **WHEN** `brain_dead_ends` records one dead end with a `<private>`
  region in its context and one without, and a caller below local reach
  lists dead ends
- **THEN** the list carries the shared one and nothing of the private one

#### Scenario: A machine with no vault withholds it the same way

- **WHEN** a server with no vault holds a lane entry in `private` and a
  caller below local reach lists or shows that lane
- **THEN** the entry is withheld exactly as on a machine with a vault

### Requirement: Lane reads below local reach see only the shared partition

On a machine whose lane pages live in the store, every lane read that
runs for a caller below local reach SHALL be answered from a fold of the
`shared` partition only, as a machine holding only `shared` would answer
it, whatever reader asks. A value derived from one of the two folds SHALL
NOT be served to a caller of the other scope.

#### Scenario: A reader with no reach check of its own withholds the entry

- **WHEN** a lane reader that binds no reach predicate reads a lane whose
  entry the store holds in `private`, for a caller below local reach
- **THEN** the reader does not see the entry, and its answer equals the
  answer of a machine that holds only `shared`

#### Scenario: A stale shared value of a raised entry is not read

- **WHEN** the store holds an entry's earlier value in `shared` and a
  later record of that entry in `private` (a raise whose `shared`
  tombstone this machine has not read), and a caller below local reach
  lists the lane through a reader that binds no reach predicate
- **THEN** the entry is not listed and a status or show naming it
  answers as for an absent entry, while the lane's other shared entries
  are listed

#### Scenario: A local caller after a remote caller sees every entry

- **WHEN** a caller below local reach lists a lane holding a
  private-partition entry, and a local caller then lists the same lane on
  the same server process with no write in between
- **THEN** the local caller's list carries the private-partition entry,
  and a second remote list again does not

#### Scenario: A private store record id answers as an absent one

- **WHEN** a caller below local reach names a lane entry's store record
  by its id (`store:<id>`) and that record is held in `private`
- **THEN** the answer is the one an id that no record has gets

#### Scenario: A reader that reports store gaps names no private gap

- **WHEN** an `events` shard of the `private` partition cannot be read
  and a caller below local reach calls a reader that reports which
  shards the store could not read
- **THEN** the answer names no `private` shard and does not report the
  store as unreadable because of it, while a local caller is told as
  today

### Requirement: Work that needs every partition reads every partition

Work whose correctness depends on every partition (a privacy verdict, a
write's placement and its checks, a repair, a projection writer, the
reference resolver and the write-side judge) SHALL read the fold of every
partition explicitly, also when it runs for a caller below local reach.

#### Scenario: A write from below local reach is judged against every partition

- **WHEN** a caller below local reach writes a new lane entry whose text
  carries a `<private>` region
- **THEN** the entry is placed in `private` as a local write of the same
  text is, and a local read shows it, for every writer that does not
  answer with the entry read back (a pledge, for example)

#### Scenario: A projection rebuild below local reach builds from every partition

- **WHEN** a caller below local reach starts a rebuild of the procedural
  memory index, the procedural graph or its hints (directly, or through
  a skill proposal verb), and a procedure lives in `private`
- **THEN** the stored projection carries that procedure as a local
  rebuild would, and the caller's answer neither names nor counts it

#### Scenario: A skill-accept recovery below local reach leaves a private journal for a local caller

- **WHEN** a local accept of a skill proposal whose pages live in
  `private` stopped after stamping its journal (before or after the
  commit stamp), and a caller below local reach runs a recovery or an
  accept of an unrelated proposal
- **THEN** that journal is neither resolved, cleared nor named, the
  pages stay as they were, the unrelated accept completes, and a later
  local recovery finds the journal and rolls the sequence back

### Requirement: A write decided from lane state below local reach decides from every partition

Work that reads lane state to decide a write, a removal, a seeding, a
deduplication, a recovery or a rebuild SHALL decide from the fold of
every partition, also below local reach. The machine's own maintenance
SHALL run as for a local caller, with only the answer narrowed; a write
the caller addresses to an entry SHALL be judged by that fold before its
first durable step.

#### Scenario: A default page held in private is not seeded again

- **WHEN** the default attention flow lives in `private` and a caller
  below local reach lists the attention flows
- **THEN** the call succeeds, no default page is seeded over the private
  one, and the answer does not name it; while the fold of every
  partition may miss a record, nothing is seeded

#### Scenario: Learning dedups against a private proposal

- **WHEN** a person rejected a skill proposal with a note that keeps its
  rejected copy in `private`, new evidence of the same name arrives, and
  a caller below local reach learns
- **THEN** no new draft of that name is written, and the answer names no
  private proposal

#### Scenario: Bridge discovery keeps its private dismissals

- **WHEN** the bridge artifact and its dismissal list live in `private`
  and a caller below local reach discovers bridges
- **THEN** the call succeeds, a dismissed pair is not proposed again,
  every dismissal is kept, and the answer is filtered by the caller's
  view

#### Scenario: A remote bridge dismissal that meets a private dismissal list is refused

- **WHEN** the dismissal list lives in `private` and a caller below
  local reach dismisses a pair
- **THEN** the call gets the fixed answer before the list is read or
  written, the list is unchanged, and the answer is the same whether or
  not the pair is in the list

#### Scenario: A skill accept is judged before its journal

- **WHEN** a caller below local reach accepts a proposal whose archive or
  procedure target lives in `private`
- **THEN** it gets the fixed answer and no journal is written
- **WHEN** the archive such an accept writes lands in `private` and a
  later step fails
- **THEN** the compensation removes that archive and clears the journal,
  as it does for a local caller

#### Scenario: A create that meets a private entry of the same identity is refused

- **WHEN** an entry held in `private` has the identity of a create a
  caller below local reach makes under another key (the same title in an
  older or suffixed slot, a name its alias answers to, an open review
  entry for the same target on another day)
- **THEN** the caller gets the fixed answer, nothing is written, and the
  answer names nothing of that entry; a shared match is answered as at
  local reach, and an intake of several items that meets one is refused
  whole

#### Scenario: A ladder picks the key a local caller gets

- **WHEN** the base key of an archive slot, an id or a dated stem is held
  in `private` and a caller below local reach takes the next free one
- **THEN** the call proceeds with the free key on the fold of every
  partition, never the fixed answer

#### Scenario: Trigger creation keeps a private open trigger

- **WHEN** a trigger for a finding's key is held open in `private` and a
  caller below local reach creates triggers from the same finding
- **THEN** no trigger of that key is queued in `shared`, the sighting is
  recorded as a local call records it, and the answer counts none

#### Scenario: A tree or a cleanup with a private member is refused whole

- **WHEN** a folder move or removal, or a confirmed cleanup by source,
  below local reach has a member held in `private`
- **THEN** the caller gets the fixed answer before the first move or
  removal

#### Scenario: A remote tuning run leaves the machine's tuning

- **WHEN** a caller below local reach runs or resets the search tuning
- **THEN** a run is scored at the caller's reach and answered as at any
  reach, its winner is not saved, and a reset answers that nothing was
  removed; the tuning file stays byte-identical

#### Scenario: A remote feedback folds every contribution

- **WHEN** a caller below local reach records recall feedback while the
  feedback ledger holds events in `private`
- **THEN** the event is recorded with the attribution the caller was
  shown, and the learned weights are folded from the events of every
  partition

#### Scenario: A bulk lane verb is refused while a lane holds a private entry

- **WHEN** a caller below local reach applies hygiene findings or
  refreshes derived pages, not as a dry run, and any lane holds an entry
  in `private`
- **THEN** the caller gets the fixed answer before the first durable
  step; on a store without such entries the verb runs as before

### Requirement: The partition verdict below local reach fails closed

When the partition of a lane entry cannot be determined, the entry SHALL
be treated as private below local reach: while the store's lane fold of
every partition may miss a record, and when the question to the store
fails. A lane path the store does not hold, and a `Brain/` path that
names no lane entry, SHALL be judged by the rules that apply to it today,
without failing the request.

#### Scenario: An incomplete fold withholds every lane entry below local reach

- **WHEN** the store's lane fold may miss a record (a shard is unreadable,
  or a private record's body has not arrived) and a caller below local
  reach lists a lane
- **THEN** no entry of that lane is listed, shared ones included, and a
  local caller still sees every entry

#### Scenario: A reader with no predicate lists nothing while the fold may miss a record

- **WHEN** the store's lane fold of every partition may miss a record and
  a caller below local reach lists a lane through a reader that binds no
  reach predicate (the write-session list)
- **THEN** the list carries no entry and names no `private` shard, and a
  local caller still lists every entry

#### Scenario: A failed store question withholds the entry

- **WHEN** asking the store for an entry's partition fails for a caller
  below local reach
- **THEN** that entry is answered as absent and the request does not fail
  because of it

#### Scenario: A Brain path that names no lane entry does not fail the request

- **WHEN** a caller below local reach asks a reader that binds the shared
  predicate about a path under `Brain/` that maps to no lane entry
- **THEN** the path is judged by the vault rules (no vault: the store
  record rules), and the answer is not an internal error

#### Scenario: A file on disk does not answer for a withheld lane entry

- **WHEN** a store-only machine still has a file at the path of a lane
  entry the store holds in `private` (or may hold there, while the fold
  of every partition may miss a record), and a caller below local reach
  asks whether that path is readable
- **THEN** the path is not readable, and a file at a lane path the store
  definitively does not hold is judged by the vault rules

#### Scenario: A local caller keeps its rows while the fold may miss a record

- **WHEN** the store's lane fold of every partition may miss a record and
  a local caller reads a report whose rows carry references the store
  cannot place
- **THEN** those rows are kept as before, and a caller below local reach
  does not see them

### Requirement: An update below local reach of a private-partition lane entry acts as on an absent one

An update, a transition or a removal a caller below local reach
addresses to a lane entry the store holds in `private` SHALL find nothing,
answer exactly as for an absent entry and change nothing in the store.
This covers every such verb of the lane tools, each of which loads its
entry through the caller's fold before it writes. `brain_decision
compare` is a read.

#### Scenario: Decision and write-session verbs on a withheld entry change nothing

- **WHEN** a caller below local reach rates a decision the store holds in
  `private`, records its outcome, or submits, approves or abandons a
  write session the store holds in `private`
- **THEN** each answer equals the answer for an absent entry, the id
  aside, no record is written, and the same verbs at local reach find the
  entries (pledge fulfil, obligation done, trigger acknowledge,
  open-decision resolve and the lifecycle tombstone are covered by the
  scenarios of their own)

#### Scenario: Fulfilling a withheld pledge changes nothing

- **WHEN** a caller below local reach fulfils or removes a pledge the
  store holds in `private`
- **THEN** the answer is the one an absent pledge gets, and a local
  caller afterwards reads the pledge unchanged

#### Scenario: Completing a withheld obligation changes nothing

- **WHEN** a caller below local reach marks done or removes an obligation
  the store holds in `private`
- **THEN** the answer is the one an absent obligation gets, and the
  obligation is unchanged

#### Scenario: Removing or moving a withheld entry writes nothing

- **WHEN** a caller below local reach removes a lane entry, removes or
  moves a folder of lane entries, or moves a lane entry, and an entry
  addressed is held in `private` (also when the caller's fold still shows
  an older shared value of it)
- **THEN** the private entry is neither tombstoned nor superseded: a
  removal answers as for an absent entry, a move whose source is private
  answers as for an absent source, and a folder operation leaves the
  private entries where they are

#### Scenario: A removal whose entry is raised meanwhile writes no private tombstone

- **WHEN** a caller below local reach removes a lane entry or a folder of
  lane entries, and the entry is raised to `private` after the caller's
  own read and before the removal's records are built
- **THEN** the removal judges the entry again from the fold it builds its
  records from, writes no tombstone over it and none in `private`, and a
  local read afterwards shows the raised entry

#### Scenario: A removal while the fold may miss a record is refused

- **WHEN** the lane fold of every partition may miss a record and a
  caller below local reach removes or moves a lane entry
- **THEN** the call is refused with the fixed answer "this entry cannot
  be written at this reach" and nothing is written

#### Scenario: Resolving a withheld open decision changes nothing

- **WHEN** a caller below local reach resolves or discards an open
  decision the store holds in `private`
- **THEN** the answer is the one an absent open decision gets, and the
  open decision is unchanged

### Requirement: A create below local reach over a private-partition key is refused

A create-style write from a caller below local reach (intention set,
decision record, any create of a key) whose key is live in `private`, and
any lane write from such a caller while the fold of every partition may
miss a record, SHALL be refused before any record is written, with the
one fixed answer "this entry cannot be written at this reach", which
names no key, title, path, count or content. The refusal SHALL NOT
supersede the private entry and SHALL NOT report success.

#### Scenario: Setting a withheld intention is refused with the fixed answer

- **WHEN** the store holds the intention chain of a scope in `private`
  and a caller below local reach sets that scope
- **THEN** the call is refused with the fixed answer, the answer carries
  none of the chain's text, and a local read shows the chain unchanged

#### Scenario: Recording a decision over a withheld slug is refused with the fixed answer

- **WHEN** the store holds a decision in `private` and a caller below
  local reach records a decision whose title yields the same slug
- **THEN** the call is refused with the fixed answer, nothing is written,
  and the private decision is unchanged

#### Scenario: A decision whose review obligation is withheld is refused whole

- **WHEN** the store holds the review obligation a new decision would
  create in `private`, and a caller below local reach records that
  decision
- **THEN** the call is refused with the fixed answer before the decision
  is written, so no decision is left without its review obligation

#### Scenario: An entity that would land in private is refused before it is written

- **WHEN** a caller below local reach creates or updates an entity whose
  record would be placed in `private` (its body carries a `<private>`
  region, or the entry it replaces lives in `private`)
- **THEN** the call is refused with the fixed answer and nothing is
  written, while the same write at local reach lands as today

#### Scenario: A lifecycle change of a withheld target writes nothing

- **WHEN** the lifecycle store writer is handed, below local reach, a
  lane target whose key is live in `private`
- **THEN** it refuses with the fixed answer before the first record

#### Scenario: An allocated key that is live in private is refused

- **WHEN** a create below local reach allocates a key (a slug ladder or
  an entity id) from what the caller's fold shows, and that key is live
  in `private`
- **THEN** the create is refused with the fixed answer and does not move
  on to another key

#### Scenario: A write while the fold may miss a record is refused

- **WHEN** the lane fold of every partition may miss a record and a
  caller below local reach creates a lane entry
- **THEN** the call is refused with the fixed answer and nothing is
  written, while a local caller's write is judged as today

#### Scenario: An ordinary write below local reach still works

- **WHEN** a caller below local reach creates or updates a lane entry
  whose key is not live in `private`
- **THEN** the write lands as it does today

### Requirement: A persisted projection answers below local reach without private-partition entries

A projection built from every lane entry and kept as machine state (the
procedural graph and its hints) SHALL be answered to a caller below
local reach without any element derived from a lane entry that caller may
not read, or whose entry cannot be determined: no node, edge, hint entry
or count over them. The stored projection SHALL stay built from every
partition.

#### Scenario: A claim graph rebuild below local reach keeps the stored graph whole

- **WHEN** a caller below local reach rebuilds the claim graph while a
  thesis lives in `private`, and a local caller then reads the claim
  history
- **THEN** the local history carries the private thesis, and the rebuild
  answer's count and truncation describe only what the caller may see

#### Scenario: A stored projection row that cannot be judged is dropped

- **WHEN** a stored procedural index row has no source path, or the
  stored graph holds a node that is no object, and a caller below local
  reach lists or shows the projection
- **THEN** the row is left out and the request does not fail

#### Scenario: The procedural graph and hints withhold a private-partition procedure

- **WHEN** the store holds one procedure in `private` and one in
  `shared`, the projections are rebuilt at local reach, and a caller
  below local reach asks `brain_procedural_graph` for `show` and `hints`
- **THEN** neither answer carries the private procedure's id or any form
  of its title, and `show` carries the shared procedure

#### Scenario: The graph keeps shared entity nodes and drops withheld ones

- **WHEN** a shared and a private procedure carry different triggers and
  tags, and a caller below local reach asks for `show`
- **THEN** the trigger and tag nodes of the shared procedure and their
  edges are in the answer, those reached only from the private procedure
  are not, a hint entry is answered only for a kept node, and every count
  is taken over what is kept

#### Scenario: A private-partition procedure does not hide the shared ones

- **WHEN** the procedural memory index names one procedure the store
  holds in `private` and one in `shared`, and a caller below local reach
  lists procedural memory
- **THEN** the list carries the shared procedure and not the private
  one, and a local list carries both

#### Scenario: A rebuild below local reach keeps the whole projection

- **WHEN** a caller below local reach asks `brain_procedural_graph` to
  rebuild, then a local caller asks for `show`
- **THEN** the remote answer's counts exclude the private procedure, and
  the local `show` carries it

### Requirement: A reference to a store-held lane entry is judged by that entry

When a log event, a receipt or any record names a lane entry by id, by
wikilink or by an extensionless `Brain/` path, and that entry is held in
the store rather than as a file, the reference view SHALL judge the
reference by the entry's own record (its fields and its partition), on a
machine with a vault and on one with none. A reference naming a
private-partition lane entry SHALL be withheld below local reach.

#### Scenario: Decision history withholds receipts naming a private-partition decision

- **WHEN** a decision is recorded at local reach with a `<private>`
  region in its notes, rated and given an outcome, and a caller below
  local reach asks `brain_decision` for `history` and `brain_analytics`
  for `view=timeline`
- **THEN** neither answer carries the decision's slug, id, title, chosen
  text or notes, while a local `history` names it

#### Scenario: Receipts naming a shared decision stay visible

- **WHEN** a decision without any private marker is recorded and rated,
  and a caller below local reach asks for `history`
- **THEN** the answer carries that decision's receipts as today

#### Scenario: An entity id and an extensionless path are resolved in the store

- **WHEN** a record names a store-held lane entry by an entity id (the
  entity lives under its category folder) or by an extensionless
  `Brain/` path, and the entry lives in `private`
- **THEN** the reference is judged by that entry's record: withheld below
  local reach, and counted as private by the write-side judge

#### Scenario: One resolution serves both views and both judges

- **WHEN** a reference names a store-held lane entry by its bare id, by
  its exact path (a `.json` session file included) or by its path without
  an extension, on a machine with a vault or without one
- **THEN** both reference views and both write-side judges resolve it to
  that entry and judge it by that entry's record

#### Scenario: A reference the store cannot resolve counts as private

- **WHEN** the store's lane fold of every partition may miss a record and
  a reference could name a lane entry the fold does not show (a bare id,
  or a lane path)
- **THEN** a caller below local reach is not shown a row carrying it, and
  a new record carrying it is placed in `private`

#### Scenario: An earlier shared receipt is withheld when its decision's shard is unavailable

- **WHEN** a receipt naming a private-partition decision was placed in
  `shared` before this change, the `private` shard holding the decision
  cannot be read, and a caller below local reach reads the decision
  history, with a vault or without one
- **THEN** the receipt is not shown, and a local caller still sees it

#### Scenario: A machine with no vault judges the reference the same way

- **WHEN** a server with no vault holds a decision in `private` and a
  receipt names it by bare id, and a caller below local reach asks for
  `history`
- **THEN** the receipt is withheld exactly as on a machine with a vault

### Requirement: A record naming a private-partition lane entry is itself private

When a ledger row or a log event names a lane entry the store holds in
`private`, the write-side privacy judge SHALL count that entry as a
private page, so the row is placed in `private`. Rows written to `shared`
before this rule are not moved by this change.

#### Scenario: Receipts of a private-partition decision land in private

- **WHEN** a decision the store holds in `private` is rated and given an
  outcome
- **THEN** every decision-receipt row naming it is in the `private`
  partition and none is in `shared`

#### Scenario: Receipts of a shared decision stay shared

- **WHEN** a decision the store holds in `shared` is rated
- **THEN** its receipt rows are in `shared` as today

### Requirement: A record derived from a private-partition lane entry is private

A record a writer writes in the same operation as a lane entry, carrying
facts of that entry, SHALL take the entry's privacy, decided before
either is written, for a create and for a later rewrite. On a store
machine a bare id SHALL resolve to the store-held lane entry of that id
in every lane the store holds.

#### Scenario: A private decision's review obligation is private

- **WHEN** a decision is recorded at local reach with a `<private>`
  region in its notes, and its review obligation is later rewritten at
  local reach
- **THEN** the review obligation's records are in the `private`
  partition and none is in `shared`, and `brain_obligation list` below
  local reach does not carry the decision's title

#### Scenario: A private tension's log event is private

- **WHEN** a tension whose quote carries a `<private>` region is
  persisted, and then moved to another status
- **THEN** every log event naming the tension is in the `private`
  partition, and `brain_agent_query` below local reach carries neither
  its id nor its subjects

#### Scenario: A row already in shared naming a private entry by id is withheld

- **WHEN** a log event in `shared` names a private-partition tension by
  its bare id
- **THEN** a caller below local reach is not shown that event, and a
  local caller is

### Requirement: An error below local reach names nothing the caller may not read

An error or refusal answered to a caller below local reach SHALL NOT
carry the id, slug, path, title, text, holder or authority of a lane
entry that caller may not read.

#### Scenario: A duplicate open decision refusal names nothing private

- **WHEN** the store holds an open decision in `private` and a caller
  below local reach opens a decision with the same question and another
  title
- **THEN** the answer carries neither the private decision's id, slug,
  path nor title, and the private decision is unchanged

#### Scenario: A write reported as not applied names no private holder

- **WHEN** a write from a caller below local reach is reported as not
  applied or as computed from a changed entry, and the winning record of
  the key, a live entry or a removal, lives in `private`, or the lane
  fold of every partition may miss a record
- **THEN** the answer is the fixed answer "this entry cannot be written
  at this reach" and carries no path, holder, authority, gap or doctor
  text, and the reach check runs before the version check

#### Scenario: A change outranked by a private record gets the fixed answer

- **WHEN** a caller below local reach changes a lane entry through the
  lifecycle tool and a human record held in `private` outranks the change
  (a removal whose `shared` tombstone this machine has not read)
- **THEN** the answer equals the answer for an absent entry, the path
  aside, and names no human holder

#### Scenario: A move of an absent source while the fold may miss a record names no path

- **WHEN** a caller below local reach moves a lane entry its fold does not
  show while the store's lane fold of every partition may miss a record
- **THEN** the move is refused with the fixed answer, which names no path

#### Scenario: A pending private body is not reported below local reach

- **WHEN** a record of the `private` partition waits for its body and a
  caller below local reach asks a reader that reports which records the
  store could not read
- **THEN** the answer does not report a body still on its way, while a
  local caller is told as today

### Requirement: No tool hands a caller below local reach a private-partition lane entry

Every tool of the registry and every resource SHALL withhold, below
local reach, every lane entry the store holds in `private`, for every
lane a tool reads, seeded through that lane's own writer.

#### Scenario: The registry-wide probe finds no private token

- **WHEN** every lane a tool reads holds one private-partition entry and
  one shared entry written by the lane's own writer, and every read verb
  of every tool and every resource is called below local reach, with the
  hidden entry's id, path and title where a verb takes one
- **THEN** no answer carries a token of a private-partition entry that
  the call did not pass in, and each lane's own reader shows its hidden
  entry at local reach

### Requirement: Local readers and file-backed lanes are unchanged

The partition verdict SHALL apply only below local reach on a machine
whose lane pages live in the store. A local caller, with or without the
ownership gate, the command line, and a machine whose lane pages are
files SHALL read and write lane entries as they do today; an entry that
reserves itself in its frontmatter and an ordinary shared entry SHALL be
judged as today at every reach.

#### Scenario: A local caller sees a private-partition entry

- **WHEN** a local caller lists and shows the lane of an entry the store
  holds in `private`
- **THEN** the entry is listed and shown as today

#### Scenario: A local caller under the ownership gate keeps its own entries

- **WHEN** the ownership gate is on and a local caller lists a lane whose
  entry it owns is held in `private`
- **THEN** the entry is listed, and the gate alone decides what is hidden

#### Scenario: A shared entry stays readable below local reach

- **WHEN** a caller below local reach lists a lane whose ordinary entry
  the store holds in `shared` with no `visibility:` field
- **THEN** the entry is listed and shown as today

#### Scenario: An entry reserved in its frontmatter stays withheld

- **WHEN** an entry carries `visibility: private` in its frontmatter
- **THEN** a caller below local reach does not see it and a local caller
  does, as today

#### Scenario: A machine whose lane pages are files is unchanged

- **WHEN** a machine has not switched its lane pages to the store and a
  caller below local reach lists a lane
- **THEN** each page is judged by its file's frontmatter and owner, as
  today
