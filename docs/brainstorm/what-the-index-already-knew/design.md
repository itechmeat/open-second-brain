# What the index already knew - eleven units on the retrieval path

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Eleven kanban tasks were selected as one wave because they sit on one seam: the
path a query takes from text to answer, and the store that path reads. A
reconnaissance pass over the code preceded any design and falsified the
load-bearing premise of nine of them. What survived has a shape none of the task
descriptions predicted. These are almost never missing capabilities. They are
values the system already computes and then discards before anything can see
them, and checks that were never run at all.

A structure recording which candidates were evaluated, surfaced and excluded is
built on every single search and serialized by no surface. A content hash has
been on every chunk since the first schema version and is never read back. A
match-centred snippet function is written, tested, and mounted on the wrong
surface. An expiry filter takes an as-of date as a parameter and no caller ever
passes one. A ranker accepts an injected clock and the stage above it does not
inject. That is the wave.

## Scope

Nine invariant fixes and two observability units. Every one is a read
projection, a computation over columns that already exist, or a parameter that
is already declared - because the schema version cannot move in this wave.

**Invariant floor**

- Ranking determinism: the ranker stops reading the wall clock, and three
  candidate queries gain a unique tiebreaker.
- Fusion under `rrf` honours the per-query intent profile it currently discards.
- Exact-duplicate passages merge instead of occupying separate result slots.
- Every snippet surface anchors its window on the match instead of the head of
  the chunk.
- The entity identity kernel folds typographic quote variants, and the collision
  that fold creates names its own resolution.
- The as-of date and the show-expired flag reach the one surface where expiry is
  enforced.
- The store verifies that the tables it is about to query exist.
- The store verifies that it is not corrupt before it answers with it.
- An oversize-chunk census reports what the configured chunk size does against
  the configured model's declared window, and says so plainly when that window is
  unknown.

**Observability, after the floor and not before it**

- The retrieval decision trace and the true pre-truncation pool size are
  serialized under the existing explain flag.
- The recall-quality signals that are computable are recorded on the existing
  per-query telemetry record. The two that are not computable are refused.

## Out of scope

Named explicitly, because each was asked for and each is being declined on
evidence rather than deferred:

- **A runtime embedder-window probe.** No provider in this system exposes model
  metadata, no local model file exists, and the provider contract has no window
  field. The only implementations are a network round trip or a hardcoded table
  over an open set of endpoints.
- **A rechunk backfill verb.** `o2b search reindex` is already a full rechunk.
  An incremental one would need a record of the parameters the live index was
  built under, and that record is deleted before the swap.
- **A second index-health counter surface.** `indexStatus` already reports
  per-fault counts and named drift reasons through both the CLI and MCP, and it
  is the eighth such surface. The stall reasons the task asks for describe a
  background drain loop this project does not run.
- **Column type-drift detection.** SQLite accepts a text value into an integer
  column and still reports the column as integer. No table here is strict, there
  is no statement that can retype a column, and the drift that can really happen
  is invisible to the schema introspection the check would use.
- **`latest_only`.** Newest-wins is already the default on recall through three
  independent mechanisms, and the topic query already returns one current rule
  per topic. The documented flag is the one that turns it off.
- **`reference_date` on search.** It would either duplicate the shipped `until`
  filter or require a transaction-time column, and this wave bumps no schema.
- **A daily snapshot of the derived store and a restore verb.** `o2b brain
  snapshot` and `o2b brain rollback` already ship the checksum sidecar, the
  verification, the pre-restore diff that names what would change, the
  confirmation, the listing and the retention. What they do not cover is a
  derived artifact whose loss costs spend rather than information.
- **Possessive-suffix folding.** A suffix rule is a natural-language word list.
  The structural alternative already exists and is deliberately proposal-only.
- **Acquisition risk and expected regret as recall signals.** There is no cost
  model and no fetch ledger behind the first. The second needs a counterfactual
  outcome, and every outcome this system holds arrives after the turn from an
  explicit caller call. Both would be invented numbers.
- **A `best_span` byte range on the result row.** The row already carries a path
  and a line span, thirty-three test files read that shape, and the preview
  budget parks the payload regardless, so a wider row buys no inline tokens.

## Chosen approach

The consultant produced three variants and recommended the first: land the
correctness invariants unflagged, then expose the discarded values through one
opt-in envelope assembled at a single boundary, with the store checks on the
read-open seam and the census as a file-level artifact.

That recommendation is adopted, with one deviation.

**Deviation: the shadow recall signals do not join the explain envelope.** The
consultant flagged the risk itself - that an envelope named `explain` accretes
unrelated concerns - and here the two lanes have different consumers and
different lifetimes. The trace is returned to the caller of one query and dies
with the response. The signals are recorded to a persistent append-only log for
later analysis, behind a telemetry gate that already exists and already defaults
off. Merging them would compute per-result signals on every explain call that
does not want them, and would write to the continuity log on behalf of callers
who asked only to see a trace. The two gates stay separate: `explain` returns,
`telemetry` records.

**Ordering is a structural dependency, not a preference.** Determinism lands
first. Serializing a trace or recording signals over a ranker that re-reads the
clock would faithfully document noise and pin it into the evaluation harnesses.

## Design decisions

- **The clock is injected, not read.** The ranker already accepts `nowMs`. The
  fix is that assembly passes the request's already-resolved value instead of
  letting the ranker default to the wall clock. This is one line, and it is the
  only defect in this wave a user can observe as the same query returning two
  different orderings.
- **The determinism test must observe the failure it prevents.** A test that runs
  the same query twice with the cache off and compares row identity is the
  assertion the suite lacks; the existing near-neighbours either read from cache,
  or use fixtures with no score ties, or strip scores first precisely to work
  around this bug. The new test constructs a tie deliberately.
- **Weighted fusion, not weighted-by-exception.** Under `rrf` the intent profile
  is applied to the per-lane contributions rather than to a post-fusion score.
  That is a standard formulation, it preserves what reciprocal-rank fusion is
  for, and it makes a quoted phrase mean the same thing in both fusion modes.
- **The duplicate merge runs before diversity reranking**, where it is a linear
  pass that shrinks a quadratic loop, rather than after it, where it would waste
  the comparisons it makes redundant. Merged-away locations are reported on the
  surviving row, never silently dropped.
- **One snippet function, three callers.** The match-centred window and the
  char-span-to-line-span helper already exist. They are lifted into a shared
  module and the three head-truncating surfaces call it. When no query term
  occurs in the content the window is the head of the chunk, which is the same
  bytes as today. That is a defined behaviour with a test, not a silent
  fallback.
- **A fold that creates a collision must name the exit.** Folding quote variants
  in the identity kernel makes two previously-distinct entity records resolve to
  one key, and the registry refuses that. The refusal resolves a registered
  diagnostic naming the command that merges them. An upgrade that starts failing
  with an opaque error would be a worse outcome than the duplicate it fixes.
- **A check that cannot run says so.** The oversize census compares the
  configured chunk size against the configured model's declared window. For a
  model outside the curated preset table there is no window to compare against,
  and the census reports that the check did not run for that model. Treating an
  unknown window as a pass would be exactly the misleading do-nothing this
  project forbids.
- **Integrity is checked where the store is opened**, so that a
  corrupt-but-parseable index is classified as unreadable and takes the existing
  self-heal path, instead of answering questions with corrupt data indefinitely.
- **`total` stops being the row count.** It is currently assigned the length of
  the returned array, which makes it carry no information at all. The
  pre-truncation pool size is a property of the answer and is reported inline,
  not behind the explain flag.
- **Two signals are refused in writing.** Acquisition risk and expected regret
  are named in this document, in the changelog and on the board as not
  implementable on this architecture, rather than shipped as plausible numbers.

## File changes

Expected to be touched, by unit:

- Determinism: `src/core/search/pipeline/assemble.ts`, `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/store/trigram.ts`
- Fusion: `src/core/search/ranker.ts`, `src/core/search/fusion.ts`
- Duplicate merge: `src/core/search/store/chunks.ts`, `src/core/search/pipeline/assemble.ts`
- Snippets: new shared module under `src/core/search/`, `src/mcp/search-tools.ts`, `src/core/search/cards.ts`, `src/cli/search/outcome-render.ts`, `src/core/brain/session-recall.ts`
- Entity fold: `src/core/brain/entities/canonical.ts`, `src/core/brain/entities/registry.ts`, `src/core/brain/diagnostics.ts`
- As-of expiry: `src/cli/brain/verbs/query.ts`, `src/mcp/brain/query-tools.ts`, `src/mcp/search-tools.ts` (stale filter description)
- Schema presence: `src/core/search/store/lifecycle.ts`, `src/core/search/schema.ts`
- Integrity gate: `src/core/search/store/lifecycle.ts`, `src/core/search/pipeline/store-open.ts`
- Oversize census: `src/core/search/embeddings/presets.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/cli/search/verbs/status.ts`
- Explain envelope: `src/core/search/pipeline/outcome.ts`, `src/cli/search/outcome-render.ts`, `src/mcp/search-tools.ts`
- Shadow signals: `src/core/brain/recall-telemetry.ts`, `src/mcp/search-tools.ts`

## Risks and open questions

- **The recall benchmark has roughly a tenth of margin** above its floors, and
  several evaluation harnesses assert exact pass counts rather than thresholds.
  Duplicate merge, fusion weighting and snippet anchoring can all move those
  numbers. Any movement is attributed to a named unit and explained, never
  absorbed silently.
- **The entity fold changes an identity kernel** that is documented in-code as
  byte-stable. The proof obligation is a corpus of currently-valid labels keying
  identically before and after, not a spot check.
- **The schema version is frozen for this wave.** A unit that concludes it needs
  a column stops and reports rather than bumping, because a bump forces every
  existing index through a self-heal reindex that drops embeddings unless the
  operator re-runs the embedding phase with spend.
- **An evaluation module has no production caller.** The graph-holdout harness is
  reachable only from tests. Whether it is wired to a surface or removed is a
  decision this wave takes explicitly rather than leaving it as it found it.
- **The continuity log has no retention policy.** Recording per-result signals
  keeps the existing per-query record shape rather than adding a record per
  result, because nothing prunes that file.
