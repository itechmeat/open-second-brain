# Provenance at the boundary - what enters the vault, under what authority, backed by what proof

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Ten kanban tasks were selected together because they sit on one seam: the
boundary where content, authority and claims enter the vault. Open Second Brain
can say a great deal about what it holds and almost nothing about where any of
it came from, who was entitled to put it there, or what backs a claim made about
it. An entity extracted from a scraped page becomes a first-class Brain entity
on the same terms as one the operator typed. A write names any path it likes. A
note is created with whatever frontmatter the caller assembled. A record is
ranked by when its file was touched rather than by what it is about. An agent
posts its own success and nothing recomputes it.

A reconnaissance pass over the actual code preceded this document, and it
changed the work substantially. Load-bearing premises were falsified in nine of
the ten tasks. Two tasks describe a capability that cannot be built honestly on
this architecture at all. Three describe gaps that are already closed, while the
gap that is genuinely open sits one layer away and goes unmentioned. What
follows is scoped to what is true.

## Scope

Ten units, one branch, one release.

| Unit | Task | Ships |
| --- | --- | --- |
| A | t_444349f2 | A trust level originated at intake, a `quarantine` entity status that read paths honour, and a census that keeps it non-vacuous |
| B | t_a3c4b13b | A config-declared path-prefix write binding over caller-named write ops, plus a write-site census recording every path it cannot cover |
| C | t_c0fce0b9 | `if_exists: "skip"` with a discriminated result, `strict` pre-write validation over the existing validator, and template-mode creation with a closed two-construct grammar |
| D | t_ac1c4176 | A body-derived date anchor materialised at index time, schema v11, with provenance recorded for the anchor it chose |
| E | t_39ec3fef | A per-request token budget alongside the count cap, on both batching providers |
| F | t_76b89833 | One named capability-tier resolver shared by the four sites that compute those facts separately, a registered code in place of call-site prose, a capability predicate in place of a stringly-typed sentinel, and a vector-only backfill verb |
| G | t_77efc212 | A caller-declared scope on the continuity envelope, honoured by the read model, plus a census of which readers honour it |
| H | t_50033859 | Dry-run preview for schema mutations, so nothing mutates the vault schema sight-unseen |
| I | t_b654e25d | A second ledger record carrying the kernel's own on-disk evidence against the acting agent's claim |
| J | t_ccb05134 | An identified skill offer that an invocation can be joined back to, a discriminating-term ranking floor, and retained provenance where a skill is currently shadowed silently |

## Out of scope

Stated here rather than discovered at review, with the reason for each.

- **An independent verifier (part of t_b654e25d, and stage four of t_ccb05134).**
  Agent identity in this system is a string from an environment variable, else a
  config key, else the literal `agent`; fifteen modules under `src/mcp/brain/`
  declare twenty-two tool schemas that additionally accept a caller-supplied
  `agent` argument overriding it, accepted verbatim. There
  is no token, key, signature or channel binding anywhere, and the MCP server is
  a child process of the agent it labels. Two records asserting two names,
  chosen by one process from one config in one session, are not two actors.
  Shipping that under the word "independent" would be a false claim in a ledger
  whose entire purpose is to be trustworthy.
- **`fsync`-backed ledger persistence and refusal on persistence failure (part of
  t_b654e25d).** Continuity appends are deliberately unfsynced and the emit path
  is deliberately fail-open, on a documented invariant that telemetry must never
  fail the primary operation. Inverting that is a regression wearing a feature's
  clothes.
- **Fetching and installing a schema pack from a URL (part of t_50033859).** A
  schema pack is not an artifact. It is the `schema:` block inside the vault's
  `_brain.yaml`, and the pack listing returns one hardcoded entry. There is no
  registry, no packs directory, no second pack, no name-to-pack resolution, and
  no signature verification anywhere in the repository. Fetching a thing that has
  no portable representation is not implementable; inventing the distribution
  format is a different task. The preview half, which the task itself says must
  ship first and be required, is what ships.
- **Extending the write binding to derived-destination writes (part of
  t_a3c4b13b).** Most write operations do not name a page - daily logs, dream
  runs, continuity records and all telemetry derive their destination. A prefix
  fence can only refuse those wholesale, which is not a fence but an off switch.
  The census records the boundary instead of pretending it is not there.
- **Auditing the twenty continuity readers that bypass the read model (part of
  t_77efc212).** Nineteen of them predate this wave. The twentieth is unit I's
  own `context-pack-evidence.ts`, which calls `listContinuityRecords` on the
  store directly and is enumerated as such in the census
  (`tests/core/brain/continuity/reader-census.test.ts`). So this wave does not
  only make a pre-existing gap visible through the census in unit G - it adds
  one reader to that gap and defers the audit, because closing it is a
  judgement per reader.
- **Splitting an oversized embedding batch and retrying it (part of t_39ec3fef).**
  The error category is a closed five-member union with wait-or-fail semantics,
  consumed on a second surface that renders it to the operator. A sixth,
  orthogonal disposition is a two-surface change. The token budget prevents the
  oversized request instead, which is the actual fix.
- **A schema change for vectors, a deferred provider class, and a NULL-vector
  concept (part of t_76b89833).** Vectors live in a virtual table that cannot
  hold a null vector, and it never needs to: a chunk without a vector is a chunk
  row with no embeddings row, which is already a first-class, already-queried,
  already-resumable state.
- **A new command-line verb for note creation (part of t_c0fce0b9).** The task
  asks for command-line and tool parity. No command-line verb reaches note
  creation today; inventing one is wider than the task.

## Chosen approach

The consultant produced three variants and recommended the third; the audit
trail with the full text and the orchestrator's two amendments is in
[`variants.md`](variants.md). The wave is factored into two substrates and one
rail, because the six cross-cutting concerns cluster into two and not one.

**Substrate one - the intake boundary.** Provenance, authority and validation
genuinely meet where content arrives. One trust level originated where content
enters (unit A), one path-prefix authority decision for writes that name their
destination (unit B), one validation gate before a note lands (unit C). Unit D's
anchor provenance and unit G's declared scope consume the same vocabulary
without being dragged into the same code path.

**Substrate two - the attestation ledger.** Claim and proof meet at the outcome
record. One witnessed-record shape keyed by the sample id that already joins two
records today, carrying evidence the acting agent cannot author (unit I), and one
receipt chain that can actually advance because the offer it starts from now has
an identity (unit J).

**The capability rail.** Whether a capability is configured is a different
question from whether a call failed, and today four sites answer the first
question separately and one of them answers it in prose assembled at the call
site. Unit F makes that one resolver behind one registered code, and units E and
H consume the same distinction.

Both substrates need a content digest. Per the first amendment, that digest is
not left to whichever unit needs it first: the existing manifest and stamp
helpers are the source, and no unit introduces a second hashing path.

## Design decisions

Each decision below is a place where the code contradicted the task, or where
two honest implementations existed and one had to be chosen.

**A1. The trust signal is originated, not reused.** The task says to reuse
`UNTRUSTED_SOURCE_TAG`. That constant is a prompt-delimiter tag name used to
wrap text on its way to a model; the module states it never rewrites a note, and
its four consumers are all model-payload assembly running nowhere near intake.
There is no untrusted signal at intake to join to. So intake originates one. The
source ingest path currently hardcodes a single trust level for every source,
which makes a scraped URL and a local file indistinguishable; that is itself the
defect, and it is fixed here rather than worked around.

**A2. The dangling read is closed by giving it a writer.** The retrieval gate
reads an `untrusted_source` frontmatter key. Nothing in the repository writes it;
the only other occurrences are two tests that hand-construct it. It is a gate
branch reachable only from a field no writer produces. The intake path now writes
it when provenance is untrusted. The task's instinct was correct and its stated
mechanism was not.

**A3. A quarantine that nothing filters on is a no-op, so the filter is
centralised.** Entities already carry a status. The cost is not the enum: the
`active` filter is re-implemented per caller across sixteen read sites, eight of
which apply no status filter at all and would treat a new value as visible. The
filter becomes one predicate those sites share, and a census fails the build if a
new entity read path bypasses it. This project reverted a unit in the previous
release for being unable to fire; the same failure mode is designed out here
rather than hoped against.

**B1. The binding's authority is the config file, never the caller's claim.**
There are no credentials. The nearest identity is self-asserted and additionally
overridable by a caller-supplied argument on twenty-two tool schemas, so a fence keyed
to it is bypassed by passing a different string. The binding is declared in the
vault config, which the operator controls and which no MCP call can rewrite. It
is described as a write boundary over caller-named paths, never as a security
boundary and never as per-credential.

**B2. The census is part of the deliverable, not a follow-up.** Sixty-two sites
write inside the vault through `node:fs` directly, bypassing every shared
helper - including one that writes a complete vault note with hand-rolled
frontmatter, and one in a command-line verb. That figure is the census's, not
this document's: `DIRECT_WRITE_EXCLUSIONS` in
`tests/core/architecture/write-site-census.test.ts` IS the count, and its own
docblock keeps the number out of prose precisely so a stated figure cannot drift
away from the list. Shipping a fence over a surface with that many known holes
and describing it as enforcement would be theatre. The census
enumerates every in-vault write site and requires each to either pass through a
shared writer or carry a written exclusion, in the same shape as the vault-guard
and terminal-state censuses this repository already runs. Two writers whose
divergence is a plain duplication defect are routed through the shared helper in
this unit; the rest become an asserted, readable list.

**C1. A skip must be distinguishable from a create.** The result type currently
declares creation as a literal, so a skip cannot be expressed at all. Returning
the same shape for both would be precisely the silent fallback this wave forbids.
The result carries a discriminated outcome, so a caller that skipped can never
read as a caller that created. Skip is decided on the existing exclusive-link
refusal, not by relaxing the overwrite flag, and returns before parent
directories are created so a no-op leaves nothing behind.

**C2. Validation is wiring, not machinery.** A document validator that takes an
artifact and returns coded violations already exists and is already bound to the
schema vocabulary. The sibling path validator is not reusable - its policy is the
exact complement of the note resolver's - and only the artifact half is used.

**C3. The template grammar is closed at two constructs.** Typed variable
substitution with canonical rendering, plus presence-driven sections and list
iteration. No expression language, no general-purpose mini-language. Unknown
placeholders are preserved intact, because the existing renderer documents that
rule deliberately so a typo surfaces in the output rather than vanishing.

**D1. The gap is the body, not the anchor.** Ranking already uses a
content-derived event time from frontmatter. The query-side module the task
names as the existing half in fact ranks nothing - it is pure query-text parsing.
What is missing is a date derived from the note's body, and materialisation at
index time so a candidate's body is not re-read on every query.

**D2. The existing extractor is reused, minus its clock.** A language-agnostic
body-text date extractor already exists, with negative tests in three
non-English scripts asserting that word forms are not recognised. No second
extractor is written. Its duration branch anchors to the current time and must
not be reached at ingest, because a stored value derived from a clock ages
silently while both index fastpaths, which gate on content identity, correctly
decline to recompute it.

**D3. Slash-formatted dates are not recognised, and future dates are kept.**
Resolving day-month against month-day requires a locale, and a locale is a
natural-language signal. The existing query-side parser refuses an entire class
rather than encoding such an assumption, and this follows it. A future date is a
real declaration and is stored; dropping it would be inference dressed as
validation.

**D4. A derived point becomes a day-width window.** Three time filters take an
interval rather than a point, and the task does not mention them. A bare date
snaps to day start and day end, matching what the existing validity parser
already does, so the anchor composes with those filters instead of being wired
only into the ranking boost.

**E1. The budget uses the estimator already resident in the embeddings layer.**
The task says to reuse the chunker's estimator to avoid a divergent tokenizer.
That estimator is not exported, and the premise is wrong in a more interesting
way: a second estimator already serves this layer and governs the cost gate. Two
notions of a token already exist and they differ by roughly a quarter on prose.
Using the layer's own means the cost gate and the batch budget describe the same
texts identically. The budget accounts for the instruction prefix the provider
prepends before batching.

**E2. Both batching providers get the budget.** A second provider carries the
identical count-only shape and would silently keep it.

**F1. The tier facts exist; the resolver does not.** Four sites compute whether
semantic search is available and why, separately. One of them assembles
operator-facing sentences at the call site, contrary to the rail this repository
adopted two releases ago. They share one resolver behind one registered code.

**F2. A capability predicate replaces a stringly-typed sentinel.** Four sites
test a provider by comparing its name to the literal `null`. Any new provider
name bypasses all four silently. The contract answers the question instead.

**G1. The scope is declared by the caller, because the alternative is a second
inference.** The premise that this system has explicit private and implicit
default is false: private is derived from a marker found in the record's own
content. A content marker for shared would be a second inference, which is the
thing the task objects to. An optional declared field is added, absent behaving
byte-identically to today.

**G2. The bypass becomes an asserted fact.** Four of twenty-four continuity
readers go through the filtering read model; the other twenty read the store
directly and already bypass the private drop, while the documentation states the
policy as universal. A census records which readers honour the read model, and
the documentation is corrected. Auditing the twenty is out of scope and said so.
The counts here are the measured ones; the reconnaissance pass reported five of
twenty-one because one direct reader carries a literal NUL byte and was
invisible to its grep.

**H1. Preview is the deliverable.** The mutation application function is already
pure and already runs full validation, so a dry run returning the resulting pack
and its diff touches no disk and reuses everything.

**I1. The kernel's own evidence, not an independent verifier.** The second
record carries the acting agent's claim, the digest the kernel wrote at pack time
and reads back off disk, and the match verdict. Read back rather than recomputed:
re-deriving it would mean hashing text the receipt does not retain, which is the
second hashing path the wave's first amendment forbids. The agent still cannot
author it, and the record says only what is on disk. There is no
verifier-identity field, and no surface describes the record as independently
witnessed.

**I2. The sibling asymmetry is fixed while the file is open.** One outcome record
carries an actor field and its sibling carries none.

**J1. The chain starts at the offer, because that is the missing link.** Skill
invocation is already observed and already aggregated; the task's claim that it
is not is false. What is missing is that an invocation record carries no
reference to the offer that produced it, so the two cannot be joined. The offer
gains an identity.

**J2. No third inverse-document-frequency implementation.** Two exist - one over
the skill descriptor corpus, one over the vault corpus with an explicit
no-stopword-list design. The floor combines the shape of the second with the
corpus of the first.

**J3. Provenance is retained where a skill is currently shadowed.** Duplicate
skills do not reach the ranker; they collapse on a name key first. The real
defect is the other half of that collapse - the shadowed path is discarded
silently and the entry has nowhere to record it. That is what is fixed, rather
than building a deduplicator for a case that does not occur.

## File changes

Expected, per unit. Implementers own their unit's files and report rather than
edit another unit's.

- **A** - `src/core/brain/intake/extract-intake.ts`, `src/core/brain/ingest/ingest.ts`, `src/core/brain/entities/{types,registry}.ts`, `src/mcp/brain/ner-tools.ts`, `src/core/brain/trust/retrieval-gate.ts`, a shared entity-status predicate module, and a new census test.
- **B** - a new write-binding module under `src/core/`, `src/core/vault.ts` and `src/core/brain/write-batch.ts` at the enforcement points, `src/core/brain/handoff.ts`, `src/cli/brain/verbs/links.ts`, config policy for the binding, and a new write-site census test.
- **C** - `src/core/brain/notes/create-note.ts`, a new template module, `src/mcp/brain/notes-tools.ts`.
- **D** - `src/core/search/{schema,indexer}.ts`, `src/core/search/store/documents.ts`, `src/core/search/pipeline/{candidate-signals,event-time}.ts`, reusing `src/core/brain/temporal-extract.ts` unchanged where possible.
- **E** - `src/core/search/embeddings/{openai-compat,zeroentropy}.ts`, `src/core/search/{index,types}.ts`.
- **F** - a new tier-resolver module under `src/core/search/`, `src/core/search/{semantic-phase,indexer}.ts`, `src/core/doctor-readiness.ts`, `src/core/search/embeddings/contract.ts`, `src/core/brain/diagnostics.ts`, a new backfill verb and its planner.
- **G** - `src/core/brain/continuity/{types,store,read-model}.ts`, `docs/observability.md`, a new census test.
- **H** - `src/core/brain/schema-mutate.ts`, `src/mcp/schema-tools.ts`.
- **I** - `src/core/brain/{context-pack-outcome,token-impact}.ts`, `src/core/brain/continuity/types.ts`, `src/mcp/brain/recall-tools.ts`.
- **J** - `src/core/surface/{skills,skill-attach}.ts`, `src/core/brain/skill-usage.ts`, `src/mcp/skill-tools.ts`, `src/mcp/registry-guard.ts`.

Shared, owned by the orchestrator: `CHANGELOG.md`, `README.md`, `package.json`
and the mirrored manifests.

## Risks and open questions

- **The entity read paths are the largest single risk in unit A.** Sixteen sites,
  eight with no status filter. If centralisation turns out to change what an
  existing surface returns, that is a behaviour change and must be reported, not
  absorbed.
- **Unit B's census may find that a direct writer is unreachable from any
  agent-triggered path.** The reconnaissance did not establish that distinction
  and it changes how much of the surface the fence must cover. The census records
  what it finds; it does not assume.
- **Unit D bumps the schema version, and a bump triggers NO reindex.**
  `applyMigrations` (`src/core/search/schema.ts`) runs the pending migrations in
  place on an existing index and raises only when the version on disk is NEWER
  than the binary supports; nothing anywhere re-indexes on a bump. So on an
  already-populated index the migration alone does not populate the body-derived
  date anchor for documents it leaves untouched: the schema v11 column exists and
  stays empty for them until those documents are re-indexed. The existing
  migration test asserts the version literal and needs a sibling. A migration
  that strands data on disk fails no test, so the migration is checked against a
  rewound index rather than only a fresh one.
- **Unit C's template grammar is the one place a mini-language could grow.** The
  two constructs are a hard boundary; anything needing a third is out of scope
  for this release.
- **Unit J depends on the offer and the invocation being observable in the same
  vault.** Invocation is recorded only when a session log is imported through an
  adapter, so the join is retrospective rather than live. That is a property of
  the existing mechanism, not a defect introduced here, and it is stated in the
  release notes rather than implied away.
