# Silence is not an answer - eight units on absence, staleness and integrity

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Eight kanban tasks were selected as one wave because they sit on one seam: what
this system does when it cannot answer. A read-only grounding pass over the
current code preceded any design and falsified a load-bearing claim in six of
the eight task bodies, so what follows is grounded state, not task prose.

The pattern underneath all eight is the same. A check that could not run reports
the same thing as a check that passed. An archive that omitted a file reports
the same thing as one that contained it. A search over a stale index returns the
same "nothing" as a search over a complete one. A rule dropped under budget
pressure is reported as dropped without saying which rule. A finding an operator
has judged benign has no state meaning "benign" - only a seven-day timer. A
retired preference leaves every decision built on it looking current.

None of these is a missing feature in the ordinary sense. In six of the eight,
the information needed to tell the two cases apart is already computed and then
discarded: the section budgeter returns the list of keys it dropped and its
caller keeps only the text; the manifest walker hashes a tree whose sibling
store it does not mention; the retirement path writes the alias that makes the
reverse lookup possible and nothing performs the lookup; the trigger store
computes a recurrence and holds it for the duration of one scan.

## Scope

One shared kernel, eight units, and the defects found in their blast radius.

**Kernel, before the units**

- One digest module. Ten byte-identical private SHA-256 helpers and three
  independent reimplementations of canonical JSON serialization collapse into one
  module. Two units in this wave persist a digest into a replicated vault, and
  under the additive-only rule two divergent encodings shipped together could
  never be reconciled. The sixteen further sites that inline a hash with an
  ad-hoc truncation length are out of scope, for the reason given below, so the
  module exports no truncation constant it has no caller for.
- One census test over every verdict vocabulary the wave introduces. It asserts
  the trio is complete and consistent: the companion `Set` holds exactly the
  frozen object's values, the guard accepts every member and rejects a
  non-member, and no vocabulary carries a duplicate value. It deliberately does
  not require code strings to be unique across vocabularies - an absent config
  file and an absent store file are both honestly named `absent`, and forcing
  them apart would buy nothing.

**The eight units**

- **U1** Schema-pack integrity reports `ok` / `modified` / `unverified` with a
  named reason, backed by a digest of the rendered schema block written at apply
  time. Four states that render identically today become four distinct answers.
- **U2** Negative recall is typed `not_found` / `unknown` / `did_not_happen`, and
  a complete negative is inadmissible without a digest-bound receipt over the
  document set actually searched. `did_not_happen` is grounded in stored
  retraction evidence, never inferred from absence.
- **U3** A reverse stale-dependency audit joins retirement time against consumer
  write time and names the context receipts, decision receipts and live artifacts
  that rest on a state which has since changed.
- **U4** The code-index health surface gains an exit code, and the cron-recipe
  renderer is generalized so a second consumer can emit a resync recipe without
  copying it.
- **U5** The trigger queue gains an indefinite `suppressed` status, an
  `unsuppress` edge that restores the prior state, and the recurrence ledger the
  audit trail needs.
- **U6** The snapshot archive can cover the derived store, off by default, with
  every omission named and every failure refused rather than skipped.
- **U7** Snapshots carry a typed reason, the event log gains the `snapshot` kind
  it has been missing since `rollback` was added, and `snapshot log` completes
  log / diff / revert.
- **U8** An operator-authored standing-rules block is injected first, is exempt
  from the adaptive budget, survives a memory-layer failure, is refused by the
  two write paths that can address it by name (inherited for the four
  caller-named note-write tools, an explicit named guard for the label writer),
  and names what it dropped when it is capped.

**Defects fixed in the same wave**

Found by grounding, all in the blast radius of the eight, all the same class as
the wave itself:

- A snapshot gzip fallback silently overwrites an existing archive while the
  zstd path refuses - and the run-id collision resolution depends on that
  refusal, so on a host without zstd two concurrent destructive operations can
  destroy each other's recovery point with no error.
- A schema sync verb returns a success report and performs no work at all.
- An absent config file is substituted with a valid empty schema pack, so "no
  ontology" is indistinguishable from "an ontology that declares nothing".
- An operator configuration error in the vault-instruction path is swallowed into
  `null`; the field vanishes from the response and the operator is told nothing.
- A malformed grounding-artifact list degrades to empty, so an unparseable
  finding presents as an ungrounded one.
- A decision-receipt directory that cannot be read reports as a vault with no
  decisions, which additionally defeats the duplicate-append guard directly above
  it.
- The snapshot diff classifier predates per-device log sharding and mislabels the
  log surface it is most likely to be displaying.
- The artifact directory documented as never backed up is archived in every
  snapshot and hashed into every manifest, so unrelated churn trips the drift
  gate.
- Three hand-maintained copies of one status partition, a fourth copy of the
  status list as a literal in a schema, and two copies of an identifier-prefix
  regex whose declared home already exists.

## Out of scope

Named here and in the release notes, because a deferral that is not written down
reads as an omission.

- **The full digest sweep.** The ten identical private helpers and all three
  canonical-JSON copies are absorbed - the third is the external-fetch cache
  key, which differed only in rendering an `undefined` object entry as
  `"key":null` instead of omitting it; nothing persists that key and the request
  it identifies goes out through `JSON.stringify`, which omits the entry, so the
  copy was distinguishing requests that are identical on the wire. The sixteen
  further sites that inline a
  hash with an ad-hoc truncation are not: they are correct today, they persist
  nothing this wave reads, and folding twenty-six call sites into a diff that
  also carries eight features trades a real regression risk for tidiness.
- **A maintenance-lane task that runs the external code indexer.** It would be
  the first lane task to spawn a foreign binary and the first to touch state
  outside the vault, and it would amend a module invariant that is currently
  absolute. The cron recipe delivers the capability without any of that. The lane
  entry is a separate decision.
- **Snapshots at session, plan and decision boundaries, and on demand.** U7 types
  the history and gives it a log surface; making snapshots *happen* at three new
  seams changes their frequency, which interacts with retention and, if the
  derived store is included, with disk in a way that should be measured before it
  is shipped. The `manual` reason is deferred with them and for the same reason
  it is declared at all - a peer running a later release may write it, and this
  build must read it - so no verb and no tool in this wave takes a recovery point
  on demand. Four of the nine members therefore have no producer here, which the
  vocabulary's own documentation states so `snapshot log --reason manual`
  listing nothing reads as the deferral it is.
- **Retention ordering under replication.** Snapshot listing and pruning both
  order by mtime, and a replicated archive arriving from another device carries
  its origin mtime, so pruning can evict a locally newer recovery point. This is
  real and it is a data-loss path, but the fix changes which snapshot a retention
  pass deletes, and that behavioural change deserves its own wave rather than a
  line in this one. It is recorded here so it is not rediscovered as new.
- **The doubled injection ceiling.** Two preamble sources are each budgeted
  against the full configured ceiling, so the effective limit is twice the
  configured number. U8 makes the truncation notice honest about what was
  dropped; it does not change the ceiling, because halving an operator's
  effective context window is a behavioural change that must be announced on its
  own terms.

## Chosen approach

Variant 2 of three, adopted with one override; the full audit trail is in
`variants.md`.

Share the two things whose divergence would be permanent - one digest encoding,
one enforced registration discipline for reason codes - and share nothing else.
Every unit keeps its own verdict vocabulary, because a suppression status with a
recurrence counter, a process exit code, a coverage receipt and an archive
inclusion decision are four types, not one, and a kernel asserting otherwise
would have to be widened for every arity it failed to anticipate.

The override concerns where the reason axis lives. The consultant proposed
widening the existing could-not-check condition vocabulary; grounding shows it is
consumed by exhaustive switches with `never` defaults, which makes adding a
member a compile-breaking edit for unrelated consumers. It is the wrong host
precisely because it is well-typed. The reason codes are also disjoint in
meaning across the eight, and a union of disjoint sets is a namespace rather than
an abstraction. So the reason axis is shared as a shape and a census: each unit
owns the frozen-object / `Set` / guard trio the project already uses, and one
test asserts that the trio is complete and that no member is unregistered.
Uniqueness ACROSS vocabularies is deliberately not asserted, for the reason
given under Scope.

## Design decisions

- **Refuse, do not skip.** Where an operation cannot be completed as requested,
  it fails loudly rather than completing partially and reporting success. The
  derived-store archive throws when it cannot include a store it was asked to
  include; because the destructive-snapshot gate already aborts before the
  operation when the snapshot throws, a mutation that cannot be fully protected
  simply does not run. No new plumbing is needed to get that property; it follows
  from refusing in the right place.

- **Never-checked is not clean, and measured-nothing is not found-nothing.** Both
  are established precedents in this codebase - one from the integrity scanner,
  one from the context-receipt fold, which ships a typed error asserting that no
  mechanism having run must never read as no findings. Every verdict this wave
  introduces inherits them. U3 reports `recorded: false` for a vault whose
  telemetry is off rather than a clean bill of health, and U6 renders a snapshot
  taken before this feature as `unknown` rather than `excluded`.

- **Additive-only on persisted formats.** The manifest sidecar reader rejects any
  schema version it does not recognize, so bumping it would make every older peer
  in a replicated set silently lose drift detection on new snapshots. U6 and U7
  both add optional keys at the existing version instead; an old reader ignores
  them and its own guarantee is untouched.

- **The authorized universe and the searched universe are different sets, and the
  receipt says so.** U2 digests the searched set, because that is what a negative
  claim can honestly attest to, and reports the divergence from the authorized
  set as a named reason that forces `unknown`. A receipt over the authorized set
  would overclaim; one over the index alone would hide the gap.

- **Uneditability is mostly inherited, and the rest is one named guard.** U8's
  standing-rules file lives under the tree whose first path segment the
  note-target resolver already refuses for the four caller-named note-write
  tools, so for that class choosing the directory is the whole enforcement
  mechanism and the new code is the test that asserts it, plus the assertion
  that no tool description mentions the path. It is not the whole class:
  `brain_labels` also takes a caller-named path and reaches the file through the
  containment-only resolver, so it gets an explicit guard that refuses this one
  file by name. The guard is not the Brain-root refusal moved down a layer -
  several legitimate callers write inside `Brain/` through that resolver (marker
  write-back, tombstones, temporal replace) - and every claim in the docs is
  scoped to these two mechanisms rather than to "any tool".

- **Operator bytes are opaque.** The standing-rules reader performs exactly three
  operations on the operator's text: read, trim, and truncate at a line boundary.
  It never splits on headings, never inspects words, never classifies. The
  truncation notice is built from integers only, so it is identical whatever
  language the operator writes in.

- **Trigger suppression is restore-with-state by construction.** Suppressing
  stamps the prior status and leaves the delivery and resolution instants
  untouched, so unsuppressing restores the original state and the original
  cooldown arithmetic without any bookkeeping. A missing prior status on a
  hand-edited file throws naming the field rather than defaulting to pending.

- **The recurrence ledger is written for every candidate an existing record
  silenced, not only suppressed ones.** One code path, no special case, and it
  is precisely the event worth recording: the finding fired again and the
  system stayed silent. What silenced it - suppression, an open twin, a
  cooldown window, the per-kind cap - changes nothing about that. Two limits
  are stated rather than implied: the count is per scan, so one scan seeing the
  same finding twice counts once, and a candidate silenced before any record
  for its cooldown key existed has no ledger to write to and is reported in the
  skipped list alone. Every writer in the store - creation, the transitions and
  brief delivery - takes the trigger-directory lock, because each persists the
  whole record and two of them interleaving would otherwise lose an increment.

- **U4 writes nothing.** The resync recipe is text on stdout; every write in it is
  a shell command run by the operator's own crontab on the operator's own host.
  The module invariant that this project never writes into the external tool's
  store is preserved exactly. The recipe's health pre-flight aborts when its JSON
  parser is absent rather than falling back to a looser match, because a gate
  that cannot parse its input must not pass.

## File changes

Kernel: a new digest module under the integrity tree, absorbing ten private
helpers and two canonical-JSON copies; a new census test.

U1: a new schema-integrity module; the mutation-audit writer gains a pack digest;
the two schema read surfaces and the CLI report gain a status. U2: a new
negative-recall module; the recall-gate output schema gains an optional block;
the continuity record kind union gains a member. U3: a new stale-dependency
collector plus a doctor check module; registry and diagnostic-signal entries; one
extraction into the identifier-vocabulary module with two call sites repointed.
U4: a new shared cron-recipe kernel extracted from the search template, which
keeps every exported name and must produce byte-identical output; a new codegraph
recipe module; a new verb and a new flag in the partner CLI plus their manifest
nodes; the partner CLI vocabulary hoisted into one frozen constant. U5: the
status partition moves to the types module and three copies are deleted; the
store gains a status, four persisted fields, a recurrence writer and two
transitions; both verb tables and both JSON projections follow. U6: two path
constants, one snapshot path helper, an optional manifest field with a named
exclusion vocabulary, an archive step gated on the existing writer lock and
integrity scanner, two config keys, and the list and restore surfaces. U7: a
snapshot-reason vocabulary and one new log event kind; an optional manifest
field; the destructive-snapshot gate splits out a reusable take-snapshot entry
point; a new CLI subcommand. U8: two path constants, a new standing-rules module,
a widened notice type on the section budgeter, the injection hook composing the
block outside the fail-open boundary, and the pull surface prepending it.

Documentation: the how-it-works surface table, the CLI reference, the changelog
entry, and the version bump propagated through the manifest sync script.

## Risks and open questions

- **The wave is large.** Eight units plus a kernel, plus the defects found in
  their blast radius, in one pull request. The mitigation is ordering: the kernel lands first and is proved
  by the two units that persist a digest, then the units land in dependency order
  with the full check suite green at every commit.
- **The cron-recipe extraction must not change a byte of existing output.** It is
  guarded by the existing template test, extended with a pinned fixture. If the
  output moves, the extraction is wrong.
- **U6 introduces a SQLite fixture into the snapshot test surface**, which has
  none today. If the fixture proves flaky under the writer lock, the unit ships
  with the archive step covered by a smaller integration test rather than being
  weakened.
- **U2's `did_not_happen` arm depends on the claim graph** for retraction
  evidence. If that projection turns out not to expose an instant that can be
  compared against the coverage receipt, the arm ships as a refusal with the
  reason recorded, and the other two states plus the receipt ship regardless.
- **U5 changes a persisted frontmatter shape.** Records written before this wave
  carry no recurrence count and parse as one, which is the true number of
  recorded occurrences rather than a papered-over unknown. That reading needs to
  be stated in the field's documentation so it is not later mistaken for a
  default.
