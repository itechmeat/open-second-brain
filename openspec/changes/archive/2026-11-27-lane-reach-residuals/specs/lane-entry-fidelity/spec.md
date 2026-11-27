## ADDED Requirements

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

## MODIFIED Requirements

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
