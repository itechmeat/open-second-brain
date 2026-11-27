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
  below local reach has a member held in `private`, a derived memory
  record (a preference or a signal) of the cleanup included, or a member
  is raised to `private` between the first check and the write
- **THEN** the caller gets the fixed answer before the first move or
  removal, no member is moved or removed, and a dry run of the same
  cleanup gives the same answer

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
  refreshes derived pages, not as a dry run, and one action's members on
  the fold of every partition (pages merged, retired, recompiled,
  archived or retargeted, the members of a duplicate group) include an
  entry held in `private`
- **THEN** that action is refused with the fixed answer before its first
  durable step, the other actions of the call are applied as for a local
  caller, and the answer names nothing of the private member

#### Scenario: Hygiene with no private member runs as before

- **WHEN** a caller below local reach applies hygiene findings none of
  whose members is held in `private`, while another lane holds a private
  entry
- **THEN** every action is applied as for a local caller

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
answer exactly as for an absent entry and change nothing in the store. A
folder operation with such a member, and a removal whose entry is raised
to `private` after its first check, SHALL be refused whole with the fixed
answer. This covers every such verb of the lane tools; `brain_decision
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
  answers as for an absent source, and a folder operation is refused
  whole with the fixed answer, moving or removing no member

#### Scenario: A removal whose entry is raised meanwhile writes no private tombstone

- **WHEN** a caller below local reach removes a lane entry or a folder of
  lane entries, and the entry is raised to `private` after the caller's
  own read and before the removal's records are built
- **THEN** the removal judges the entry again from the fold it builds its
  records from and is refused with the fixed answer: it writes no
  tombstone over the entry and none in `private`, removes no other member
  of the folder, and a local read afterwards shows the raised entry

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

### Requirement: A machine register and the receipt ledger follow the lane rule below local reach

Below local reach a `private` row of the pinned register or the receipt
ledger SHALL NOT be read, named or written over. A pinned read SHALL
answer `shared`; a pinned write SHALL land in `shared` only and get the
fixed answer while a `private` pinned row exists or may exist unread, or
if its text carries a private region. A keyed call's receipt SHALL lie
with its records; a keyed call meeting a `private` receipt (its own too)
or a `private` ledger that may miss a row SHALL get the fixed answer.

#### Scenario: A remote pinned read does not return the private register

- **GIVEN** a store-only machine holding `private` whose pinned context a
  local caller set
- **WHEN** a caller below local reach reads the pinned context, or the
  session context that embeds it
- **THEN** the answer carries none of the private text, and a local read
  still returns it

#### Scenario: A remote pinned write does not replace the private register

- **GIVEN** a store-only machine whose pinned context is held in `private`
- **WHEN** a caller below local reach writes, appends to or clears the
  pinned context, or applies a batch of operations to it (a `replace`
  operation included)
- **THEN** the call is refused with the fixed answer before any operation
  reads the private text, and a local read returns the private text
  unchanged

#### Scenario: A remote pinned write while a private pinned row may exist unread is refused

- **GIVEN** a store-only machine holding `private` whose `private` pinned
  register holds a record whose body blob has not arrived, or whose
  `private` `events` shard cannot be read
- **WHEN** a caller below local reach writes the pinned context
- **THEN** the call is refused with the fixed answer and no pinned record
  of it lands in `shared`

#### Scenario: A local clear held in private counts as a private pinned row

- **GIVEN** a store-only machine holding `private` whose pinned context a
  caller below local reach wrote to `shared`, then a local caller cleared
  (the clear is held in `private`)
- **WHEN** a local caller reads the pinned context, and the caller below
  local reach writes it again
- **THEN** the local read answers no pinned context, and the remote write
  is refused with the fixed answer

#### Scenario: A remote pinned write with no private register goes to shared

- **GIVEN** a store-only machine holding `private` whose `private` pinned
  register holds no record
- **WHEN** a caller below local reach writes a pinned text that carries no
  private region and names no private page
- **THEN** the record lands in `shared`, a remote read answers the text,
  and a local read answers it too while the `private` register holds no
  record

#### Scenario: A remote pinned write whose text is private

- **GIVEN** a store-only machine holding `private` whose `private` pinned
  register holds no record
- **WHEN** a caller below local reach writes a pinned text, or applies a
  batch whose result is a text, that carries a private region
- **THEN** the call is refused with the fixed answer, the answer carries
  none of the text, and the raw records of both partitions are unchanged

#### Scenario: A remote pinned write that names a private page goes to shared

- **GIVEN** a store-only machine holding `private` whose `private` pinned
  register holds no record, and a lane page held in `private`
- **WHEN** a caller below local reach writes a pinned text that names that
  page, or one that names an open page
- **THEN** in both cases the record lands in `shared`, a remote read
  answers the text, and the caller's next pinned write is not refused

#### Scenario: A remote checkpoint retry that meets a private receipt is refused

- **GIVEN** a session checkpoint whose idempotency receipt is held in
  `private`
- **WHEN** a caller below local reach retries a checkpoint with the same
  session id, with the same payload or another
- **THEN** the call is refused with the fixed answer, the answer carries
  no signal id, summary id, key or hash, and the raw records of both
  partitions are unchanged

#### Scenario: A remote checkpoint retry against its own private receipt is refused

- **GIVEN** a store-only machine holding `private`, and a session
  checkpoint a caller below local reach made whose signal carries a
  private region, so its signal and its receipt are held in `private`
- **WHEN** the same caller retries the checkpoint with the same session id
  and the same payload
- **THEN** the retry is refused with the fixed answer, the raw records of
  both partitions are unchanged by the retry, and the first call's signal
  is the only signal of that checkpoint

#### Scenario: A remote feedback retry that meets a private receipt is refused

- **GIVEN** a feedback call whose idempotency receipt is held in `private`
- **WHEN** a caller below local reach records feedback with the same
  idempotency key
- **THEN** the call is refused with the fixed answer, the answer carries
  no id, key or hash, and the raw records of both partitions are
  unchanged

#### Scenario: A keyed call while the private ledger cannot be read in full is refused

- **GIVEN** a store-only machine whose `private` ledger shard cannot be
  read
- **WHEN** a caller below local reach makes a checkpoint call, which
  carries an idempotency key
- **THEN** the call is refused with the fixed answer and nothing is
  written, and the same call at local reach answers as it does today

### Requirement: A derived label below local reach comes only from what the caller may read

A label, title or name that an answer below local reach shows for a node
of a persisted projection SHALL be computed only from entries that
caller may read; when the stored label may come from a withheld entry,
the answer SHALL show a label derived from the node's id, under an id of
that answer that carries no spelling of the entity, with its kept edges
rewritten to it. A local caller's ids are unchanged.

#### Scenario: A private tag spelling does not title a shared entity node

- **GIVEN** a private procedure tagged `Client Zeta` read before a shared
  procedure tagged `client-zeta`, both linked to one entity node
- **WHEN** a caller below local reach shows the procedural graph
- **THEN** the entity node is shown with a title derived from its id and
  the answer does not contain `Client Zeta`; the node's id in that answer
  contains no spelling of the tag, the answer does not contain the stored
  id, and the edge from the shared procedure names the new id

### Requirement: A reference below local reach is withheld when it cannot be judged and shown when it can

A reference in a row answered below local reach SHALL be withheld when
the resolver cannot judge it (the fold may miss a record for its id, the
store-mode question or a lookup fails), and the failure SHALL withhold
that row only. A reference judged as a shared lane entry SHALL be shown,
in any spelling of its path. A write-session open or commit on a
store-only machine SHALL judge a store-held target from the store entry
at the caller's reach, never from a file left at that path.

#### Scenario: A frozen file at a removed private target is not described

- **GIVEN** a switched machine with a legacy file at a lane path whose
  store entry was removed by a record held in `private`
- **WHEN** a caller below local reach opens a write session on that path
- **THEN** the answer carries no size, hash or heading of that file

#### Scenario: An open on a shared entry describes the entry, not a file at its path

- **GIVEN** a switched machine with a shared store entry at a lane path
  and a legacy file with other text at that path
- **WHEN** a caller opens a write session on that path, below local reach
  or at it
- **THEN** the size, hash and heading the answer describes are those of
  the store entry, and none of the file's

#### Scenario: A commit does not read a frozen file at its target

- **GIVEN** a switched machine with a legacy file at a lane path whose
  store entry was removed
- **WHEN** a local caller commits a write session on that path with
  `create` or `merge` intent
- **THEN** the create is not refused as an existing target and the merge
  carries none of the file's bytes

#### Scenario: An unjudgeable bare id is withheld below local reach

- **GIVEN** a lane fold of every partition that may miss a record
- **WHEN** a caller below local reach reads rows naming a bare id with an
  inner space
- **THEN** those rows are withheld, and a local caller sees them as today

#### Scenario: A failed store-mode question withholds the reference

- **WHEN** the question whether the machine's lane pages live in the
  store fails while a caller below local reach reads a row naming a
  lane-shaped reference
- **THEN** that row is withheld, and a local caller sees it as today

#### Scenario: A failed lane lookup withholds the row, not the report

- **WHEN** the lookup of one row's reference fails while a caller below
  local reach reads a report
- **THEN** that row is withheld and the other rows are answered

#### Scenario: A shared id ending in .md is shown

- **WHEN** a shared lane entry's id ends in `.md` and a caller below local
  reach reads a row naming it, on a machine with or without a vault
- **THEN** the row is shown

#### Scenario: An extensionless reference to a shared entry is shown without a vault

- **GIVEN** a store-only machine with no vault and a shared lane entry
  whose page path is a `Brain/` path ending in `.md`
- **WHEN** a caller below local reach reads a row naming that path without
  its extension
- **THEN** the row is shown

#### Scenario: A lane path with a redundant separator names its entry

- **WHEN** the store-held lane entry at a `Brain/` path spelled with a
  doubled separator or a trailing slash is looked up
- **THEN** the lookup answers the entry its canonical spelling names, with
  that entry's privacy

#### Scenario: The claim graph filters before it caps

- **GIVEN** more claims than the graph's node cap, most of them withheld
  from the caller
- **WHEN** a caller below local reach asks for the claim graph
- **THEN** the answer holds the shared claims up to the cap, and
  `truncated` describes only the claims the caller may read

### Requirement: A device-local marker the caller may not read is left for a local caller

Below local reach a recovery SHALL NOT discard, rewrite or name a
device-local marker it cannot read or that names an entry the caller may
not read; it SHALL leave the marker and answer without its path or slug.

#### Scenario: An unreadable skill-accept marker survives a remote recovery

- **GIVEN** an unreadable skill-accept marker
- **WHEN** a caller below local reach runs the skill-proposal recovery,
  with or without discarding unreadable markers, or accepts another
  proposal (an accept resolves outstanding markers first)
- **THEN** the marker is still there, the answer names no path, slug or
  count of such markers, an accept of an open proposal succeeds, and a
  later local recovery finds the marker

#### Scenario: A marker naming a private entry survives a remote recovery

- **GIVEN** a readable skill-accept marker whose proposal is held in
  `private`
- **WHEN** a caller below local reach runs the skill-proposal recovery,
  with or without discarding unreadable markers
- **THEN** the marker is still there, the answer names nothing of it,
  and a local recovery resolves it

### Requirement: A write decides reach and privacy from the fold it writes from

A lane write, a move and a tree operation SHALL judge reach and each
record's partition again from the one fold its records are built from.
Below local reach a key whose winning record is held in `private`, a
live entry or a removal, or an entry raised to `private` after the first
check, SHALL refuse the whole operation with the fixed answer, never a
store-error reason or doctor remedy.

#### Scenario: A remote write over a key a private removal holds is refused

- **GIVEN** a lane key whose winning record is a removal held in
  `private`
- **WHEN** a caller below local reach writes or creates an entry at that
  key, or moves an entry onto it
- **THEN** the call is refused with the fixed answer before any record is
  written, and the raw records of both partitions are unchanged

#### Scenario: An overwrite racing a raise to private is refused

- **GIVEN** a caller below local reach whose overwrite of a shared lane
  entry passed its first reach check
- **WHEN** a local writer raises the entry to `private` before the record
  is built
- **THEN** the overwrite is refused with the fixed answer and the private
  entry's text is unchanged

#### Scenario: A local move of a source raised meanwhile stays private

- **GIVEN** a local move whose source was shared when the move read it
- **WHEN** the source is raised to `private` before the record is built
- **THEN** the moved entry and its tombstone are written in `private`
  and the `shared` partition receives none of its text

#### Scenario: A remote move of a source raised meanwhile is refused, not dropped

- **GIVEN** a caller below local reach moving a shared lane entry
- **WHEN** the source is raised to `private` before the record is built
- **THEN** the move is refused with the fixed answer and nothing is
  written

#### Scenario: A remote folder operation with a member raised meanwhile is refused whole

- **GIVEN** a caller below local reach moving or removing a folder whose
  members were all shared at the first check
- **WHEN** one member is raised to `private` before the records are built
- **THEN** the operation is refused with the fixed answer and no member
  is moved or removed

### Requirement: A refusal below local reach comes before the call's first durable step

A call refused below local reach SHALL leave no durable trace of the
call: no ledger row, receipt, journal, marker, session record, metric,
audit record or entry written before the refusal.

#### Scenario: A refused ingest leaves no disposition row

- **GIVEN** a permissions document that decides the ingest lane, and a
  staged review entry held in `private` for the ingest's target
- **WHEN** a caller below local reach ingests the source
- **THEN** the call is refused with the fixed answer and the decision
  ledger has no new row

#### Scenario: An ingest whose intake meets a private entity leaves no disposition row

- **GIVEN** a permissions document that decides the ingest lane, and an
  entity held in `private` whose identity an extracted entity of the
  ingest claims
- **WHEN** a caller below local reach ingests the source
- **THEN** the call is refused with the fixed answer, the decision ledger
  has no new row, and no summary or entity page is written

#### Scenario: A batch refused at one item leaves no earlier item

- **GIVEN** an entity batch whose second new entity takes a suffixed id
  that a private staged review entry holds
- **WHEN** a caller below local reach submits the batch
- **THEN** the call is refused before its first create, and no entity of
  the batch is written

#### Scenario: A refused panel step leaves nothing of the step

- **GIVEN** a panel session whose target the store holds in `private`
- **WHEN** a caller below local reach submits a persona step, an invalid
  step, or a synthesis that commits directly or collides
- **THEN** the call is refused with the fixed answer, and no session
  record, failed attempt or metric of the step is written

#### Scenario: A hygiene apply whose every action is refused leaves no audit record

- **WHEN** a caller below local reach applies hygiene findings and every
  action is refused because a member is held in `private`
- **THEN** each action's error is the fixed answer and no hygiene audit
  record is appended

### Requirement: An identity decision below local reach applies the caller's identity rule to the whole fold

The title claims, slot reservations, default-name holds and id
predictions of a create SHALL be read on the fold of every partition with
the caller's own identity rule widened to every entry held in `private`,
so the create lands where a local caller's would, or is refused with the
fixed answer when only a private entry decides it.

#### Scenario: A private pledge's title holds its slug against a remote create

- **GIVEN** a private pledge whose title is the base slug of a new pledge
  and which is filed under another stem
- **WHEN** a caller below local reach adds that pledge
- **THEN** the call is refused with the fixed answer or lands on the slot
  a local caller's add takes, never on the held base slot

#### Scenario: Every slot held, one of them privately, gives the fixed answer

- **WHEN** every slot of a remote pledge add is taken and one of them is
  held by a private pledge's title
- **THEN** the answer is the fixed answer, not a message naming a slug

#### Scenario: A private same-topic panel holds the day at commit

- **GIVEN** a private panel of a topic for a day under one default name
- **WHEN** a caller below local reach commits a panel session of the same
  topic and day under the other default name, opened by default or with
  that name as explicit target
- **THEN** the commit is refused with the fixed answer and no second panel
  of the day is written

#### Scenario: A batch predicts the id its write takes

- **GIVEN** an entity batch where `<base>` is held and an earlier create
  of the batch takes `<base>-2`
- **WHEN** the batch predicts the id of the next entity of that slug
- **THEN** the prediction is `<base>-3`, the id the write takes, and an
  entity whose own slug ends in `-2` is predicted from its own base

### Requirement: Review obligations written before the reach rule are named by the doctor

At local reach the doctor SHALL count the review obligations held in
`shared` whose decision is held in `private`, and SHALL say how a local
caller moves them; below local reach it SHALL answer a count of zero
problems of that kind and name none.

#### Scenario: The doctor counts old shared review obligations

- **GIVEN** a review obligation in `shared` written before the reach rule
  for a decision now held in `private`
- **WHEN** a local caller runs the doctor
- **THEN** the advice counts one such obligation and says what moves it

#### Scenario: A remote doctor names no old review obligation

- **GIVEN** the same machine
- **WHEN** a caller below local reach runs the doctor
- **THEN** the answer counts no such obligation and names no obligation,
  decision or title

### Requirement: An identity matcher's error is masked only when the caller's own view does not raise it

When the identity decision of a create below local reach raises an error
on the fold of every partition, the caller SHALL receive that error when
its own narrowed view raises an error of the same class, and the fixed
answer otherwise.

#### Scenario: A validation error of the caller's own view is kept

- **GIVEN** a machine whose lane pages are files, holding two shared
  research reports for one slot and no private page
- **WHEN** a caller below local reach records a report for that slot
- **THEN** the answer is the research validation error, not the fixed
  answer

#### Scenario: An error only the private view raises is masked

- **GIVEN** a private obligation whose page cannot be read, at the slot a
  decision's review obligation takes
- **WHEN** a caller below local reach records that decision
- **THEN** the answer is the fixed answer

### Requirement: Counts and caps answered below local reach agree with what the caller may read

A count, total or cap answered below local reach SHALL count only what
that caller may read, and a cap SHALL be enforced on the fold of every
partition as for a local caller.

#### Scenario: The dead-end cap holds after a remote record

- **GIVEN** the dead-end lane at its cap with its oldest entry held in
  `private`
- **WHEN** a caller below local reach records a dead end
- **THEN** the lane's active entries stay within the cap, the overflow
  entry is archived within `private`, and the answer counts only shared
  entries

#### Scenario: A trigger skipped for a private trigger is not counted

- **WHEN** a trigger scan below local reach skips a finding because a
  private trigger holds it
- **THEN** `candidates` equals the count of what `created` and `skipped`
  show

#### Scenario: Recall feedback counts the caller's events

- **GIVEN** a feedback ledger holding events in `private`
- **WHEN** a caller below local reach records recall feedback
- **THEN** the answer's `events` counts only the `shared` events

### Requirement: Judging the references of an answer reads the lane fold once per reference

Below local reach on a store-only machine, judging the references of one
answer SHALL read the lane fold of every partition at most once for each
distinct reference that can name a lane entry, and SHALL read no fold for
a string that cannot (empty, spanning lines, longer than any lane id, or
a path outside `Brain/`). Each verdict SHALL stay the one the full
judgement gives.

#### Scenario: A report of many distinct references

- **GIVEN** a store-only machine and a report whose rows name many
  distinct bare ids that resolve to nothing, many distinct `Brain/`
  paths, and many strings that cannot name a lane entry
- **WHEN** a caller below local reach reads the report
- **THEN** the fold of every partition is read at most once for each
  distinct bare id or path and never for the other strings, and every row
  is shown or withheld as before

### Requirement: A sequential rewrite keeps the standing of the entry it replaces

On a store-only machine a lane write that replaces the entry this machine
holds SHALL be stored at the stronger of the writer's own authority and
the authority of the record that holds the entry, so the next read shows
it whoever wrote the entry before. This holds for the obligation, pledge,
intention, handoff and entity lanes and every other lane.

#### Scenario: An obligation completed by a tool

- **GIVEN** a store-only machine and an obligation added by an operator's
  command
- **WHEN** an agent completes it through the obligation tool
- **THEN** the next read shows the completion date, the next due date one
  cadence later and the completion in the list, as the tool answered

#### Scenario: A pledge fulfilled by a tool

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
- **WHEN** an agent fulfils it through the pledge tool
- **THEN** the next read shows it fulfilled on that date

#### Scenario: A pledge re-anchored by the intake

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
- **WHEN** the pledge intake tool re-anchors its counterparties
- **THEN** the next read shows the counterparties the intake answered

#### Scenario: An intention set by a tool

- **GIVEN** a store-only machine and an intention chain set by an
  operator's command
- **WHEN** an agent sets a new intention for the same scope through the
  intention tool
- **THEN** the next read shows the new text, the next version and the
  prior text in the history

#### Scenario: A handoff note re-derived in place

- **GIVEN** a store-only machine and a handoff note written by an `o2b`
  process
- **WHEN** an agent's process re-derives the note at the same path
- **THEN** the next read shows the re-derived note

#### Scenario: An entity upserted by a tool

- **GIVEN** a store-only machine and an entity page written by an
  operator's command
- **WHEN** an agent upserts the same entity with a new alias through the
  entity tool
- **THEN** the tool's answer and the next read both show the alias

#### Scenario: An entity related or archived by an agent's process

- **GIVEN** a store-only machine and entity pages written by an
  operator's command
- **WHEN** an agent's process relates two of them, or archives one
- **THEN** the next read shows the relation, or the entity archived

#### Scenario: A stronger writer is not lowered

- **GIVEN** a store-only machine and an entry written by an agent
- **WHEN** an operator's command rewrites it
- **THEN** the new record is stored at the operator's authority

### Requirement: A removal or a move keeps the standing of the entry it removes

On a store-only machine the tombstone of a removed or moved lane entry,
and the shared tombstone a write adds when it raises a shared entry to
`private`, SHALL be stored at the stronger of the writer's own authority
and the authority of the record that holds the entry. A moved entry SHALL
be stored at the stronger of that authority and the authority of the
record that holds its new path, an entry or a removal. The next read
finds the entry gone from its old path and present at its new one.

#### Scenario: An obligation removed by a tool

- **GIVEN** a store-only machine and an obligation added by an operator's
  command
- **WHEN** an agent removes it through the obligation tool
- **THEN** the next list of active obligations does not show it, and its
  archived page does

#### Scenario: An intention moved to history by a tool

- **GIVEN** a store-only machine and an intention chain set by an
  operator's command
- **WHEN** an agent moves it to history through the intention tool
- **THEN** the next read finds no active chain for that scope

#### Scenario: A move onto a path a person's entry holds

- **GIVEN** a store-only machine, an entry an agent wrote at one path and
  an entry an operator's command wrote at another
- **WHEN** an agent's process moves the first entry onto the second path
- **THEN** the next read finds no entry at the first path and the moved
  entry at the second

#### Scenario: A raise to private over a person's shared entry

- **GIVEN** a store-only machine and a shared entry written by an
  operator's command
- **WHEN** an agent's write replaces it with a private version
- **THEN** the shared tombstone written with it is stored at the
  operator's authority, so a device that holds only the `shared`
  partition no longer reads the old version

### Requirement: A create over a removed entry keeps the removal's standing

On a store-only machine a lane write that creates an entry at a path
whose last record is a removal SHALL be stored at the stronger of the
writer's own authority and the removal's, so the created entry reads back
as it does on a machine that has not switched, where the removal emptied
the place the create writes into.

#### Scenario: An obligation added again by a tool after an operator removed it

- **GIVEN** a store-only machine and an obligation an operator's command
  added and then removed
- **WHEN** an agent adds an obligation of the same title through the
  obligation tool
- **THEN** the next read shows the new obligation, as the tool answered

#### Scenario: A pledge added again by a tool after an `o2b` process removed it

- **GIVEN** a store-only machine and a pledge an `o2b` process wrote and
  then removed
- **WHEN** an agent adds the same pledge through the pledge tool
- **THEN** the next read shows the pledge, as the tool answered

### Requirement: A retry does not repeat a completion or a fulfilment

Because a kept rewrite reads back, a retry of a completion or a
fulfilment on a store-only machine SHALL compute from the state the first
call wrote, as on a machine that has not switched.

#### Scenario: A pledge fulfilled twice

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
  that an agent's tool call has fulfilled
- **WHEN** the agent fulfils it again
- **THEN** the call is refused as already fulfilled, naming the date

#### Scenario: An obligation completed twice on one date

- **GIVEN** a store-only machine and an obligation added by an operator's
  command that an agent's tool call has completed on a date
- **WHEN** the agent completes it again on the same date
- **THEN** the next read shows the next due date one cadence past that
  date, not two

### Requirement: A version that changed since the read is refused visibly

On a store-only machine a read-modify-write of a lane entry (a
completion, a fulfilment, a re-anchor, an intention set, an entity
upsert, relation or archive) SHALL write nothing and fail with an error
of its own that names the entry when the store no longer holds the
version the writer read, or could not be read whole, a gap that opens
after the read included; the answer SHALL report that error and its
remedy, never the computed state or a generic store write failure.

#### Scenario: A human version arrives between the read and the write

- **GIVEN** a store-only machine where an agent's completion has read an
  obligation
- **WHEN** another device's human version of that obligation is read into
  the store before the completion writes
- **THEN** the completion writes no record and its answer is an error
  that names the obligation, says it changed since it was read and tells
  the caller to read it again, not to repair the store, and the next read
  shows the other device's version

#### Scenario: A store that cannot be read whole

- **GIVEN** a store-only machine whose lane fold misses a record (an
  unreadable shard or a pending body blob)
- **WHEN** an agent completes an obligation
- **THEN** no record is written and the answer is an error that says the
  store could not be read in full and names `o2b brain doctor`

#### Scenario: A gap that opens after the read

- **GIVEN** a store-only machine where a write read an entry while the
  lane fold was whole
- **WHEN** the fold misses a record before the write
- **THEN** no record is written and the error says the store could not be
  read in full, not that the entry changed

#### Scenario: An entity upsert builds on the entity it locked

- **GIVEN** a store-only machine where an agent's upsert has resolved an
  entity from the registry index
- **WHEN** another version of that entity, with an alias of its own, is
  written before the upsert takes the entity's lock
- **THEN** the upsert writes the entity with both that alias and its own

### Requirement: A write the store does not apply fails visibly

On a store-only machine, after every lane write the entry SHALL be read
back, and when the store does not hold what the write wrote (a value, or
no entry after a removal), the call SHALL fail with an error that names
the entry, says whether a version or a removal holds it and names that
record's authority, so no answer reports a state the next read does not
show.

#### Scenario: A competing version stamped ahead of this machine

- **GIVEN** a store-only machine whose store holds a human version of an
  obligation stamped further ahead of this machine's clock than the
  clock accepts
- **WHEN** an agent completes the obligation
- **THEN** the answer is an error that names the obligation, a version
  and the `human` authority that holds it, and the next read shows that
  version

#### Scenario: A removal stamped ahead of this machine holds the path

- **GIVEN** a store-only machine whose store holds a human removal of an
  obligation stamped further ahead of this machine's clock than the
  clock accepts
- **WHEN** an agent adds an obligation at that path
- **THEN** the answer is an error that names the path, a removal and the
  `human` authority that holds it, and the next read shows no obligation
  there

### Requirement: Versions written apart on two devices are arbitrated by the authority order

The kept standing SHALL apply only to what the writing device read. A
lane version written on another device and read into the store after the
write SHALL be arbitrated by the authority order, then the clock, with
no refusal and no error on either device.

#### Scenario: A person's version with a later clock

- **GIVEN** an agent's completion kept on a store-only machine
- **WHEN** another device's human version of that obligation, stamped
  later, syncs in
- **THEN** that version wins, and the earlier answer stays true for the
  reads made before it arrived

#### Scenario: A person's version with an earlier clock

- **GIVEN** an agent's completion of an obligation an operator's command
  added, kept on a store-only machine at the operator's standing
- **WHEN** another device's human version of that obligation, stamped
  earlier than the completion, syncs in
- **THEN** the completion stays, by the clock between two human records,
  and neither device reports an error, as two edits of one file meet in
  a sync conflict on machines that have not switched

### Requirement: The record names who acted

A `lane-entry` or `lane-entry-remove` record stored at a stronger
authority than its writer's own SHALL carry the writer's own authority in
the optional body field `acted_by`; a record at the writer's own
authority SHALL carry no such field. The field SHALL NOT change the fold,
and a reader that does not know it SHALL ignore it.

#### Scenario: An agent's completion of a human entry

- **WHEN** an agent's tool call completes an obligation an operator's
  command added, on a store-only machine
- **THEN** the new record has `authority` `human` and `acted_by` `agent`

#### Scenario: An operator's rewrite

- **WHEN** an operator's command rewrites an entry an operator's command
  wrote
- **THEN** the new record has `authority` `human` and no `acted_by`

### Requirement: A tool's lane write below local reach that meets a private holder gets the fixed answer

Below local reach a lane write whose key is held in `private` (live or
removed), or whose fold may miss a record, SHALL get the fixed answer
before any record is written, the reach check before the version check;
no answer for such a key, the read-back's included, SHALL name a path,
holder, authority, gap or doctor (the write paths of the 2.0.4 scenario
"A write reported as not applied names no private holder"). A completion
of an entry the caller cannot see SHALL answer as for an absent one.

#### Scenario: Completing an obligation whose winning version is private

- **GIVEN** an obligation whose winning version is a `human` version held
  in `private`
- **WHEN** a caller below local reach completes it
- **THEN** no record is written, the raw records of both partitions are
  unchanged, and the answer is the one an absent obligation gets, naming
  nothing of the entry

#### Scenario: A create over a private removal

- **GIVEN** an obligation key held by a `human` removal held in `private`
- **WHEN** a caller below local reach adds an obligation at that key
- **THEN** the answer is the fixed answer, not an error naming the path,
  a removal or the `human` authority

#### Scenario: An entry raised to private after the base

- **GIVEN** a caller below local reach whose completion took its base
- **WHEN** a local writer raises the obligation to `private` before the
  write
- **THEN** the answer is the fixed answer, never an error saying the entry
  changed since it was read

#### Scenario: A read-back that meets a private holder

- **GIVEN** a caller below local reach whose write passed the reach check
- **WHEN** a `human` record held in `private`, stamped further ahead than
  the clock accepts, holds the key when the write is read back
- **THEN** the answer is the fixed answer, not an error naming the path,
  a version or the `human` authority

#### Scenario: A remote write while the store cannot be read whole

- **WHEN** a caller below local reach adds an obligation or a pledge, or
  completes an obligation, while the lane fold of every partition may
  miss a record
- **THEN** nothing is written, the add gets the fixed answer and the
  completion the answer an absent obligation gets, with no gap and no
  doctor text in either

### Requirement: A machine that has not switched is unchanged

On a machine that has not switched, a lane write SHALL behave as before:
the file is written, the answer and the next read come from the file,
and no refusal or read-back error of this change applies. The one
exception is the entity overwrites, which read the entity again under
its lock in every mode (scenarios below).

#### Scenario: The entity overwrites read the entity again under its lock in every mode

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an entity overwrite (`upsertEntity`'s update,
  `relateEntities`, `archiveEntity`) writes an entity
- **THEN** the written fields are built from the entity read again under
  its lock, not from the entity index entry, so an upsert that met a
  stale entity index keeps the alias another writer added in between,
  where it used to write over it from the index entry
- **AND** the overwrite takes the entity page's lane lock, which such a
  machine did not take before: it is what makes the read again sound,
  and while the write runs a lock file sits beside the page

#### Scenario: A completion through a tool on an unswitched machine

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an agent completes an obligation an operator's command added
- **THEN** the file shows the completion and the answer is the page it
  shows

#### Scenario: A fulfilment through a tool on an unswitched machine

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an agent fulfils a pledge an `o2b` process wrote
- **THEN** the file shows it fulfilled

#### Scenario: An entity upsert over a stale index on an unswitched machine keeps the other writer's alias

- **GIVEN** a machine with a legacy `Brain/` tree and an entity whose page
  another writer gave the alias B after this writer's entity index was
  read
- **WHEN** this writer upserts the entity with the alias C
- **THEN** the page holds both B and C (the one change of this release
  on a machine that has not switched)
