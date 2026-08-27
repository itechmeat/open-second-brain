# Private is not a suggestion - implementation plan

Nine atomic units, each a separate conventional commit on
`feat/private-is-not-a-suggestion`. Every unit is test-first: the acceptance
line names a test that must fail with the stated error before the
implementation exists. Formatter and linter run green before every commit.

Tasks 1 and 2 are the kernel and everything else depends on them. Tasks 3, 4
and 5 are the three roots and are independent of each other. Task 6 is the
index column. Tasks 7, 8 and 9 are the proof, and each needs the roots it
measures to be in place.

## Tasks

### Task 1: The predicate and the reserved token

- **Files**: `src/core/graph/visibility.ts`,
  `tests/core/graph/remote-readability.test.ts`
- **What**: add `REMOTE_DENY_VISIBILITY_TOKEN` as a single exported constant
  and `isRemotelyReadable(pageTags, disclosure)` beside the existing
  `pageVisibility` / `normalizeVisibilityScope` / `isVisible`. Deny by
  default: a page carrying the reserved token is readable only at full
  disclosure. Untagged pages and pages carrying only non-reserved tokens are
  unaffected by this predicate and keep answering to `isVisible` alone.
- **Acceptance**: `tests/core/graph/remote-readability.test.ts` pins the truth
  table across the cross-product of {untagged, reserved token, non-reserved
  token, reserved plus non-reserved} and {full, reduced} disclosure, including
  that token matching is the same NFC + lower-case normalisation
  `normToken` already performs, so a second spelling of the reserved token
  does not exist. Fails before implementation with the symbol missing.
- **Depends on**: none

### Task 2: Disclosure is minted by the transport and refused from the caller

- **Files**: `src/core/graph/disclosure.ts` (new), `src/mcp/tool-contract.ts`,
  `src/mcp/server.ts`, `src/mcp/stdio.ts`, `src/mcp/http.ts`,
  `src/cli/main.ts`, `tests/mcp/disclosure-refusal.test.ts` (new)
- **What**: a frozen closed vocabulary with exactly two members and a
  narrowing predicate, in the shape `ENTITY_STATUS_SCOPE` and
  `VISIBILITY_SURFACE_CATEGORY` already use. `ServerContext` gains a required
  `disclosure`. `serveStdio` and the CLI's direct handler invocation mint full
  disclosure; `startHttp` mints full on a loopback bind and reduced otherwise,
  reusing `isLoopbackHost`. A disclosure-shaped member in a tool's arguments
  is refused by name, following `src/mcp/owner-scope-refusal.ts`'s stated
  rule.
- **Acceptance**: the new test asserts each transport's minted value, and
  asserts that a request carrying the argument is refused with the reason
  named in the message rather than silently ignored or silently honoured.
  Fails before implementation because `ServerContext` has no such field.
- **Depends on**: Task 1

### Task 3: Root A - the search pipeline, and one spelling of the rule

- **Files**: `src/core/search/result-filters.ts`,
  `src/core/search/pipeline/pool-filters.ts`, `src/core/search/search.ts`,
  `src/core/search/types.ts`, `tests/core/search/visibility-filter.test.ts`,
  `tests/mcp/visibility-scope.test.ts`
- **What**: `applyVisibilityScope` is reimplemented on `isRemotelyReadable`
  rather than left beside it. The pipeline carries the request's disclosure;
  the caller's `visibility` argument keeps narrowing and can no longer lift
  the reserved token.
- **Acceptance**: the existing `tests/mcp/visibility-scope.test.ts` fixture
  already seeds a `visibility: [private]` page; a new case asserts that a
  caller passing that scope at reduced disclosure gets nothing back, and that
  the same call at full disclosure is unchanged from today. The existing
  passing assertions stay green.
- **Depends on**: Tasks 1, 2

### Task 4: Root B - `listVaultPages`, and the OpenClaw walker

- **Files**: `src/core/vault.ts`, `src/openclaw/index.ts`, the remaining
  `listVaultPages` call sites under `src/core/brain/**`,
  `tests/core/vault/list-vault-pages-visibility.test.ts` (new),
  `tests/openclaw/page-search-visibility.test.ts` (new)
- **What**: `listVaultPages` takes a disclosure and drops pages the predicate
  denies, over the frontmatter it has already parsed - the shape
  `vaultPageInStatusScope` established. Internal maintenance lanes (heal,
  doctor, portability, link-graph repair, freshness, schema report) pass the
  named full-disclosure value explicitly, because a repair lane that stopped
  seeing private pages would corrupt the graph it repairs. `src/openclaw/`'s
  page search - the surface the census names at
  `visibility-surface-census.test.ts:84-88` - adopts the reduced value.
- **Acceptance**: the new vault test asserts a tagged page is absent from a
  reduced-disclosure listing and present at full; the OpenClaw test drives its
  registered page-search handler against a seeded tagged vault and asserts the
  page is missing from `pages` AND that `total_pages` does not count it, so
  the aggregate is not an existence oracle. Both fail before implementation
  because the parameter does not exist.
- **Depends on**: Tasks 1, 2

### Task 5: Root C - by-path and by-chunk-id reads answer as absent

- **Files**: `src/mcp/resources.ts`, the read primitives the registry's
  `excluded` rows name as path-keyed or chunk-id-keyed,
  `tests/mcp/visibility-not-found-parity.test.ts` (new)
- **What**: a withheld page is reported with the message an absent page
  produces, byte for byte - the convention `src/mcp/resources.ts` already
  holds for owner-scope, so a refusal does not announce what it hides.
- **Acceptance**: the new test asserts message identity between a read of a
  tagged page at reduced disclosure and a read of a path that does not exist,
  for every path-keyed and chunk-id-keyed surface in scope. Fails before
  implementation because the tagged read currently succeeds.
- **Depends on**: Tasks 1, 2

### Task 6: The `documents.visibility` column and its backfill

- **Files**: `src/core/search/schema.ts`,
  `src/core/search/store/documents.ts`, `src/core/search/store.ts`,
  `src/core/search/indexer.ts`,
  `tests/core/search/visibility-column-backfill.test.ts` (new)
- **What**: schema migration 12 adds the column and backfills every existing
  document by parsing the frontmatter the index already stores at
  `chunk_index = 0` - the structural fact `store/visibility-tag.ts` depends on
  and `visibility-tag-presence.test.ts` pins. The indexer writes the column on
  every upsert. A row the index cannot measure - unterminated frontmatter, or
  a document with no chunks - stays NULL and is withheld at reduced
  disclosure. The search root filters on the column instead of re-reading
  frontmatter per candidate.
- **Acceptance**: the new test builds an index at schema 11 with one untagged
  page, one tagged page and one page with unterminated frontmatter, migrates,
  and asserts the three column states; a second case asserts that a vault
  which never used `visibility:` returns byte-identical search results before
  and after the migration, which is the zero-behaviour-change constraint made
  executable. Fails before implementation with a missing-column SQL error.
  This task also carries the measurement that answers the design's open
  question about running the backfill inside the migration transaction.
- **Depends on**: Task 1

### Task 7: Root closure - the census proves there is no fourth root

- **Files**: `tests/core/architecture/visibility-surface-census.test.ts`,
  `src/core/search/visibility-surface-registry.ts`
- **What**: extend the sweep to bring `src/openclaw/` into the population, and
  add a mechanical check that no file under `src/mcp/`, `src/cli/` or
  `src/openclaw/` reads a vault Markdown path through the filesystem directly
  rather than through one of the three roots. Its blind spots are written down
  the way the existing census's are, not implied.
- **Acceptance**: the sweep's population pins move to their new measured
  values and a synthetic intruder file performing a direct vault read is
  reported. Fails before implementation because `src/openclaw/` is outside the
  swept tree today.
- **Depends on**: Tasks 3, 4, 5

### Task 8: Reclassification, and the honesty finding recounts itself

- **Files**: `src/core/search/visibility-surface-registry.ts`,
  `src/core/search/indexer.ts`,
  `tests/core/search/visibility-honesty-finding.test.ts`,
  `tests/cli/search-check-visibility-honesty.test.ts`
- **What**: every row that a root now covers moves from `excluded` to
  `covered` with a written reason naming which root covers it. The
  `index_store` row stays and is reworded: private bodies remain at rest in
  `chunks`, and the column is what gates the read rather than the storage. The
  `search check` finding gains the count of unmeasured documents, so the
  legacy population is reported rather than absorbed.
- **Acceptance**: the existing honesty tests keep deriving both counts from
  `excludedCallableVisibilitySurfaces()` / `callableVisibilitySurfaces()` and
  now assert the moved values; no count is hand-written anywhere. A new case
  asserts the unmeasured count is present and derived from the store, not a
  literal.
- **Depends on**: Tasks 3, 4, 5, 6, 7

### Task 9: The matrix gains a visibility axis, `_meta`, and a federated caller

- **Files**: `tests/mcp/agent-scope-matrix.test.ts` (or a sibling
  `tests/mcp/visibility-matrix.test.ts` if the two axes cannot share one
  fixture)
- **What**: the existing partition over the live tool table is driven a second
  time against a seeded `visibility:`-tagged corpus at reduced disclosure. The
  assertion covers the whole response envelope - structured fields, rendered
  text, the thrown message, and the MCP `_meta` member `src/mcp/progress.ts`
  shows is live - and is run in a federated multi-source caller shape as well
  as the single-source one.
- **Acceptance**: every entry in the tool table is driven against the tagged
  corpus and asserted to carry no marker unique to the tagged page in any of
  the four envelope channels, in both caller shapes. A newly added tool still
  fails the suite until classified, in both directions, which the existing
  partition assertions already enforce and which must stay green.
- **Depends on**: Tasks 3, 4, 5, 6

## Release-phase obligations, carried on this branch

Per `CLAUDE.md`, which overrides the playbook's generic default, the version
bump rides inside this pull request rather than following it:

1. `CHANGELOG.md` entry under a new `## [X.Y.Z] - <date>` heading plus its
   `[X.Y.Z]: .../compare/...` link reference at the foot of the file.
2. `package.json` version bumped, then `bun run scripts/sync-version.ts`.
3. `bun run scripts/sync-version.ts --check` green before the push.

This is a behaviour change for vaults that tag pages, so the release is a
minor bump, not a patch.
