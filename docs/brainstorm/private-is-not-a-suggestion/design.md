# Private is not a suggestion - `visibility:` becomes an enforcement boundary

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain ships a `visibility:` frontmatter field, a predicate that
reads it, and a filter that applies it - and the filter is wired into exactly
one call site. Of the 71 callable surfaces the project's own visibility
registry enumerates, 68 can hand back a page's path, title or body without
ever consulting the field. The three that do consult it (`brain_search`,
`brain_file_context`, the CLI verb `search query`) do so through a caller
argument, so a remote caller that asks for the private scope is given it. A
page's tag is therefore decorative everywhere and liftable where it is not.

The previous wave (v1.52.0) measured this rather than fixing it: it shipped
the surface census, the registry that backs it, and a `search check` honesty
finding that states in the operator's own diagnostics that this boundary does
not exist. This wave is the enforcement that census was built as the coverage
map for.

## Premise verification

Both source cards had premises refuted against live source before any design
work. The verdicts are deliverables in their own right and are recorded here
rather than silently built around.

### t_92c26f69 - REFUTED on both claims, rescoped

| Card claim | Verdict | Evidence |
|---|---|---|
| "No `visibility`/`private` frontmatter handling in the read surfaces" | **Refuted** | `src/core/graph/visibility.ts` ships `pageVisibility` (:31), `normalizeVisibilityScope` (:38), `isVisible` (:53); `src/core/search/result-filters.ts:249` applies them |
| "Extend `gatedOwnerScopeView` to also honour a per-page `visibility: private` flag" | **Refuted as an approach** | `src/core/brain/owner-scope-view.ts`'s own docblock states `scope === null` short-circuits every predicate to `true`, and that `warn` is inert on every surface using the view. It is reached only under `integrity.owner_scope_delivery: fail`, and it gates Brain artifacts by path rather than vault pages by frontmatter. Riding it would ship privacy that is off by default |

Rescoped ask, which is what this wave builds: one deny-by-default predicate
honouring a reserved token, independent of owner-scope configuration, with a
bypass keyed on a server-side transport fact rather than on anything the
caller says.

### t_8f670d8e - REFUTED on its central claim, rescoped to three named gaps

| Card claim | Verdict | Evidence |
|---|---|---|
| "No registry-driven harness that sweeps every remote operation against a private corpus" | **Refuted** | `tests/mcp/agent-scope-matrix.test.ts` partitions the live `buildToolTable("full")` in both directions and drives every entry against a seeded fixture |
| "No fail-closed 'unclassified new operation breaks the suite' gate" | **Refuted** | Both the matrix and `tests/core/architecture/visibility-surface-census.test.ts` fail on an unclassified newcomer; the census pins its population as an equality (43 MCP tools, 8 resources, 20 CLI verbs) |

What survives: the existing harness's axis is OWNER, not VISIBILITY. Its
fixture is a two-owner vault with no `visibility:`-tagged corpus; it asserts
nothing about the MCP `_meta` response member; it drives no federated caller
shape. Plus one follow-up the card did not carry:
`tests/core/architecture/visibility-surface-census.test.ts:84-88` names
`src/openclaw/index.ts` as an un-swept page-search surface, and
`src/openclaw/index.ts:128` does call `listVaultPages(vault)` filtered only by
entity status scope.

### Correction to the wave's own stated risk

The scope brief for this wave asserted that the work "moves `indexRevision`",
forcing a reindex for every vault, and must therefore be scheduled apart from
index-health releases. That is wrong about the mechanism.
`src/core/search/store/state.ts:112-118` defines `indexRevision` as a
monotonic counter bumped after any mutating index run, consumed only by
`computeCorpusGeneration` (`src/core/search/corpus-generation.ts:32`) to
invalidate the query cache. It is not a schema or index-format revision and
bumping it forces nothing. The real index-side obligations are different and
are stated under "Design decisions" below.

## Scope

- One deny-by-default predicate, `isRemotelyReadable`, in
  `src/core/graph/visibility.ts`, honouring a reserved visibility token that
  means "not readable at reduced disclosure".
- A closed disclosure vocabulary minted server-side by each transport and
  carried on `ServerContext`; a caller-supplied disclosure is refused by name.
- Enforcement at the three roots every callable surface reaches page content
  through: the search pipeline, `listVaultPages`, and the by-path/by-chunk-id
  read primitives.
- `applyVisibilityScope` subsumed by the new predicate, so the rule has one
  spelling.
- `src/openclaw/index.ts`'s page walker brought under the boundary and into
  the census population.
- A `documents.visibility` column written by the indexer, with a schema
  migration that backfills every pre-existing row from the frontmatter the
  index already stores.
- Registry reclassification: rows move `excluded` to `covered` naming which
  root covers them, and the `search check` honesty finding recounts itself off
  the registry as it already does.
- Census extended to prove root closure - that no fourth root exists.
- The agent-scope matrix gains a visibility axis, an `_meta` envelope
  assertion, and a federated caller shape.

## Out of scope

- Encryption at rest. A private page's body remains in `chunks` and
  `chunk_fts`; anyone with file access to `brain.sqlite` reads it. This is the
  same trust boundary as the vault's own Markdown files, and the registry's
  `index_store` row already states it. This wave keeps that row and updates its
  wording; it does not close it.
- Owner-scope delivery. `integrity.owner_scope_delivery` and this boundary are
  independent rules over different subjects, and neither is folded into the
  other.
- Any new operator configuration key. Deny-by-default means the boundary is
  not something an operator has to switch on.
- Per-token access-control policy (who may see `team`, `agent:foo`, and so
  on). Non-reserved tokens keep exactly today's caller-liftable scoping
  semantics.

## Chosen approach

Three roots, one predicate, an index column that is measured rather than
assumed.

Every surface in the registry reaches a page's path, title or body through one
of three roots: `search()`'s pipeline, `listVaultPages`, or a read primitive
that takes a path or a chunk id. Enforcement goes at those three roots and
nowhere else, and the census is extended to prove there is no fourth. This is
the shape the project already uses for status scoping
(`src/core/brain/entities/page-scope.ts`: one predicate over frontmatter a
walker has already parsed, adopted by its callers rather than reimplemented).

The predicate takes a *disclosure* rather than a caller-supplied scope. A
disclosure is a value from a closed vocabulary that only a transport
constructor can mint: `serveStdio`, `startHttp` (which already distinguishes
loopback from network via `isLoopbackHost` and already refuses an
unauthenticated non-loopback bind), and the CLI's direct handler invocation.
A caller that puts a disclosure-shaped value in its arguments is refused by
name, following the rule `src/mcp/owner-scope-refusal.ts` states once: an
identity echoed back from the request is not an identity.

At reduced disclosure a page carrying the reserved token is not returned, not
counted, and not named in an error - a withheld page is reported exactly as an
absent one, the convention `src/mcp/resources.ts` already holds for
owner-scope. The caller's existing `visibility` argument keeps working and can
only ever NARROW: it can no longer lift the reserved token.

## Design decisions

- **Deny by default, no config key.** A boundary an operator must enable is
  the defect the previous wave's honesty finding named. There is no opt-out
  key in this design; the escape hatch is the transport a caller arrives on,
  which the operator already controls when they choose how to expose the
  server.

- **The reserved token is a named constant, not a phrase.** Visibility tokens
  stay opaque and language-neutral, exactly as `graph/visibility.ts` already
  documents. One token is reserved as a vocabulary identifier - the same kind
  of thing as `kind: entity` or an entity `status` value, both of which this
  repository already treats as identifiers rather than prose. It is hoisted
  into a single exported constant, and every other token keeps today's
  semantics untouched.

- **Disclosure is minted, never parsed.** It is keyed on the transport, not on
  a string in the request, because a caller-supplied trust claim is not a
  trust claim. What the bypass actually proves is stated plainly rather than
  overclaimed: stdio and the CLI prove the caller already holds
  filesystem-equivalent access to this vault, and loopback HTTP proves the
  request originated on this host. Neither proves operator intent, and the
  design says so where it is implemented.

- **The index column is backfilled from data the index already holds.** The
  consultant's recommended variant proposed treating a missing column value as
  private, calling the legacy population "self-healing". Verified against
  source, that is a total search blackout: `applyMigrations`
  (`src/core/search/schema.ts:773`) adds a column with NULL for every existing
  row, so on upgrade every document in every vault - including the
  overwhelming majority that have never used `visibility:` at all - would be
  withheld until a full reindex. That breaks the wave's own zero-behaviour-
  change constraint. The correction: the migration backfills. `packBlocks`
  (`src/core/search/chunker.ts:312-330`) emits a page's frontmatter as its own
  chunk, whole and without overlap, at `chunk_index = 0` - a structural fact
  `src/core/search/store/visibility-tag.ts` already depends on and
  `tests/core/search/visibility-tag-presence.test.ts` already pins. The
  migration therefore parses the stored frontmatter for every existing
  document and writes the column with no vault walk and no operator action.

- **Unmeasured is a third state and is denied.** A page whose frontmatter the
  index cannot produce - an unterminated frontmatter block, which
  `chunker.ts:137-141` omits, or a document with no chunks - is not measurable
  from the index. It is left NULL, and NULL is withheld at reduced disclosure.
  Fail closed: a visibility claim that cannot be read is not the absence of
  one, the convention `owner-scope-view.ts` states for ownership. The count of
  such rows is reported by `search check` rather than absorbed.

- **Private pages stay indexed.** Excluding them from the index would take an
  operator's own private notes out of their own local search, which is a
  product regression dressed as a hardening. They are indexed and marked, so
  the search root filters in SQL on the column instead of re-reading
  frontmatter per candidate, and a caller holding a raw chunk id is gated by
  the same column.

- **The indexer marks; it does not skip.** A "skip private pages" written as a
  `continue` after the frontmatter parse would be a live defect:
  `indexer.ts:390` adds the path to `seen` BEFORE the content is read, so the
  deletion sweep at `indexer.ts:537-540` would not purge the stale rows and
  the page would keep whatever chunks it already had. Writing the column on
  every upsert avoids the trap entirely, which is the second reason to mark
  rather than exclude.

- **One spelling of the rule.** `applyVisibilityScope` is not left beside the
  new predicate; it is reimplemented on top of it. Two functions answering
  "may this caller see this page" is the defect
  `src/mcp/owner-scope-refusal.ts` was written to remove on the ownership
  side.

- **The proof is the existing instruments, moved.** The registry rows change
  category with a written reason each; `excludedCallableVisibilitySurfaces()`
  is already what the honesty finding counts (`indexer.ts:1672`), so the
  operator-facing number falls on its own. No new count is hand-written.

## File changes

New:

- `src/core/graph/disclosure.ts` - the closed disclosure vocabulary and its
  narrowing predicate.
- `tests/core/graph/remote-readability.test.ts` - the predicate's truth table.
- `tests/core/search/visibility-column-backfill.test.ts` - the migration over
  a pre-boundary index.
- `tests/mcp/disclosure-refusal.test.ts` - a caller-supplied disclosure is
  refused by name.
- `tests/mcp/visibility-matrix.test.ts` - the visibility axis, `_meta`
  assertion and federated caller shape, if it does not fit inside the existing
  matrix file.
- `tests/core/architecture/read-root-closure.test.ts` - the no-fourth-root
  sweep, if it does not fit inside the existing census file.

Modified (principal):

- `src/core/graph/visibility.ts` - `isRemotelyReadable`, the reserved-token
  constant, and `isVisible` retained as the narrowing half.
- `src/core/search/result-filters.ts` - `applyVisibilityScope` reimplemented
  on the predicate.
- `src/core/search/pipeline/pool-filters.ts` - disclosure carried into the
  filter; the caller argument narrows only.
- `src/core/vault.ts` - `listVaultPages` takes a disclosure and enforces it.
- `src/openclaw/index.ts` - the page walker adopts it.
- `src/core/search/schema.ts` - migration 12, column plus backfill.
- `src/core/search/store/documents.ts` - the column on read and write.
- `src/core/search/indexer.ts` - writes the column on upsert; `search check`
  reports the unmeasured count.
- `src/core/search/visibility-surface-registry.ts` - reclassification.
- `src/mcp/tool-contract.ts`, `src/mcp/server.ts`, `src/mcp/stdio.ts`,
  `src/mcp/http.ts`, `src/cli/main.ts` - minting and threading the disclosure.
- `tests/core/architecture/visibility-surface-census.test.ts` - population
  pins move; `src/openclaw/` enters the sweep.
- `tests/mcp/agent-scope-matrix.test.ts` - visibility axis.
- The remaining `listVaultPages` call sites in `src/core/brain/**` - each
  passes the named full-disclosure value, because an internal maintenance lane
  that stopped seeing private pages would corrupt the link graph it repairs.
- `README.md`, `CHANGELOG.md`, `package.json` and the mirrored version
  manifests via `scripts/sync-version.ts`.

## Risks and open questions

- **Behaviour change for vaults that do tag pages.** Pages that read over MCP
  today stop reading. This is the point of the wave, but it has to be legible:
  `search check` must report the count of pages the boundary now withholds,
  and the release notes must lead with it. Vaults that never set `visibility:`
  see no change at all, and the migration is what guarantees that rather than
  an assumption.
- **The bypass proves less than it sounds like it proves.** A remote host can
  spawn a stdio subprocess. Stated at the implementation site and in the
  release notes rather than papered over; the alternative - no bypass at all -
  would take an operator's private notes away from their own CLI.
- **Root closure is the whole guarantee.** A surface that reads a vault file
  directly rather than through one of the three roots escapes until the census
  learns that shape. The sweep for direct filesystem reads of vault paths
  under `src/mcp/`, `src/cli/` and `src/openclaw/` is what makes the claim
  checkable, and its blind spots are written down the way the existing
  census's are.
- **Open question, resolved during implementation:** whether the backfill runs
  inside migration 12's transaction or as a post-migration pass. The parse is
  over every document's chunk-zero row, which on a large vault is the cost of
  one table scan; if that proves unacceptable inside the migration
  transaction, it moves to a post-open pass with the same fail-closed NULL
  semantics in the meantime. The decision is measured, not guessed, and the
  measurement is part of Task 6.
- **Open question, resolved during implementation:** whether the visibility
  matrix axis fits inside `tests/mcp/agent-scope-matrix.test.ts` or needs a
  sibling file. The existing file is already large; the deciding factor is
  whether the two axes can share one fixture without either one's assertions
  becoming conditional.
