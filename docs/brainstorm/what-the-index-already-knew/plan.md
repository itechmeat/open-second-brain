# What the index already knew - implementation plan

Eleven units. The invariant floor lands first; the two observability units land
last and depend on it. Every unit is a read projection, a computation over
existing columns, or a parameter that already exists - the SQLite schema version
does not move in this wave.

## Tasks

### Task C: the ranker stops reading the wall clock
- **Files**: `src/core/search/pipeline/assemble.ts`, `src/core/search/store/keyword.ts`, `src/core/search/store/vectors.ts`, `src/core/search/store/trigram.ts`, `tests/core/search/`
- **Acceptance**: a test that runs `search()` twice with the query cache off,
  over a fixture built so that two rows tie on score, and asserts identical row
  identity and order. It must fail before the fix - paste the failure. The three
  candidate queries end their ordering in a unique column.
- **Depends on**: none. Everything else in the wave depends on this.

### Task B: `rrf` fusion honours the per-query intent profile
- **Files**: `src/core/search/ranker.ts`, `src/core/search/fusion.ts`, `tests/core/search/`
- **Acceptance**: a quoted-phrase query prefers the verbatim hit in `rrf` mode as
  it already does in `linear` mode. The default `linear` path is byte-identical -
  proved by comparing a flag-off projection, not by inspection.
- **Depends on**: C.

### Task D: exact-duplicate passages merge
- **Files**: `src/core/search/store/chunks.ts`, `src/core/search/pipeline/assemble.ts`, `tests/core/search/`
- **Acceptance**: two byte-identical passages in two files return one row naming
  both locations; two distinct passages from one file still return two rows; a
  near-duplicate is untouched and still demoted by the diversity reranker. The
  merge runs before diversity reranking. The returned window is not silently
  shorter than the requested limit.
- **Depends on**: C.

### Task E: snippets anchor on the match
- **Files**: new shared module under `src/core/search/`, `src/mcp/search-tools.ts`, `src/core/search/cards.ts`, `src/cli/search/outcome-render.ts`, `src/core/brain/session-recall.ts`, `tests/`
- **Acceptance**: a match late in a long chunk appears in the preview on all
  three surfaces. A chunk with no query-term occurrence returns the same bytes as
  today - asserted, not assumed. The existing session-grep behaviour is unchanged
  after the helper is lifted; one function has three callers, not three copies.
- **Depends on**: none.

### Task A: the entity identity kernel folds quote variants
- **Files**: `src/core/brain/entities/canonical.ts`, `src/core/brain/entities/registry.ts`, `src/core/brain/diagnostics.ts`, `tests/core/brain/`
- **Acceptance**: two entity records differing only in apostrophe form resolve to
  one identity key. The collision this creates raises a registered diagnostic
  naming the command that resolves it, never an opaque failure. A corpus of
  currently-valid labels keys identically before and after. A separate test locks
  the property that both apostrophe forms already retrieve the same rows through
  the real search lanes - it must be able to fail, so prove it against a
  deliberately broken tokenizer configuration or an injected fixture.
- **Depends on**: none.

### Task J: the as-of date reaches the surface that enforces expiry
- **Files**: `src/cli/brain/verbs/query.ts`, `src/mcp/brain/query-tools.ts`, `src/mcp/search-tools.ts`, `tests/`
- **Acceptance**: `o2b brain query` accepts an as-of instant and a show-expired
  flag, and a record that expired after that instant is returned. Omitting both
  produces byte-identical output to today. The `since`/`until` MCP descriptions
  stop claiming they filter on modification time.
- **Depends on**: none.

### Task I: the store verifies the tables it is about to query
- **Files**: `src/core/search/store/lifecycle.ts`, `src/core/search/schema.ts`, `tests/core/search/`
- **Acceptance**: a database stamped with the current version but missing a table
  or a column is refused at read-open through the existing mismatch diagnostic
  that names the reindex command, instead of failing later inside a query. The
  manifest is derived from the schema, not typed by hand twice.
- **Depends on**: none. Must not bump the schema version.

### Task K: a corrupt store is not answered from
- **Files**: `src/core/search/store/lifecycle.ts`, `src/core/search/pipeline/store-open.ts`, `tests/core/search/`
- **Acceptance**: a deliberately corrupted-but-parseable index is classified as
  unreadable and takes the existing self-heal path rather than serving results.
  The check's cost on a healthy store is measured and reported in the unit's
  report, not estimated.
- **Depends on**: I (both land on the same read-open seam).

### Task H: the oversize-chunk census
- **Files**: `src/core/search/embeddings/presets.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/cli/search/verbs/status.ts`, `tests/`
- **Acceptance**: an index whose configured chunk size exceeds the configured
  model's declared window reports a counted, named warning with a registered
  exit. A model with no declared window reports that the check did not run for
  it - not a pass. The count comes from the token count already stored, with no
  schema change. A new statistics field is absent when the condition does not
  arise.
- **Depends on**: none.

### Task F: the trace that was built and thrown away
- **Files**: `src/core/search/pipeline/outcome.ts`, `src/cli/search/outcome-render.ts`, `src/mcp/search-tools.ts`, `tests/`
- **Acceptance**: the retrieval decision trace and the trust assessment are
  serialized on both surfaces under the existing explain flag, and absent - not
  null - when it is off. The reported total becomes the pre-truncation pool size
  and is reported inline; a query matching many documents no longer reports a
  total equal to the number of rows returned.
- **Depends on**: C. A trace over a wall-clock ranker documents noise.

### Task G: the recall signals that can be computed
- **Files**: `src/core/brain/recall-telemetry.ts`, `src/mcp/search-tools.ts`, `tests/`
- **Acceptance**: the computable signals are recorded on the existing per-query
  telemetry record behind its existing gate, one record per query and not one per
  result. Production ordering is proved unchanged with the gate on. The two
  uncomputable signals appear nowhere in the code. The unit also reports whether
  the graph-holdout module has any production caller and proposes wiring or
  removal - it does not remove anything without reporting first.
- **Depends on**: C, F.
