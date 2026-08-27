You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Make `visibility:` frontmatter a real enforcement boundary in Open Second Brain, instead of a caller-liftable filter wired into one search lane.

Two kanban cards back this scope. BOTH have had premises refuted against live source; the refutations are stated here as findings, not as work to redo.

## Card t_92c26f69 - "Per-page visibility:private flag riding on the existing owner-scope predicate"

Original claim: "No `visibility`/`private` frontmatter handling in the read surfaces; extend `gatedOwnerScopeView` to also honour a per-page `visibility: private` flag."

REFUTED, verified this run:
  - `src/core/graph/visibility.ts` already ships `pageVisibility()` (line 31), `normalizeVisibilityScope()` (38) and `isVisible()` (53) over opaque, language-neutral tokens.
  - `src/core/search/result-filters.ts:249` `applyVisibilityScope` applies them.
  - It is wired at exactly ONE call site: `src/core/search/pipeline/pool-filters.ts:130`, inside `search()`.
  - `gatedOwnerScopeView` (`src/core/brain/owner-scope-view.ts`) is the WRONG carrier: its own docblock states `scope === null` short-circuits every predicate to `true` unless the operator has set `integrity.owner_scope_delivery: fail`, and that `warn` is inert on every surface that uses this view. It gates Brain ARTIFACTS by path, not vault pages by frontmatter. Riding it would ship privacy that is off by default.

REMAINING ASK: one deny-by-default predicate honouring a reserved private token, independent of owner-scope config, with a trusted-local bypass keyed on TRANSPORT and never on a caller-supplied string.

## Card t_8f670d8e - "Registry-driven remote privacy sweep across every MCP operation"

Original claim: "no registry-driven harness that sweeps every remote operation against a private corpus, and no fail-closed unclassified-newcomer gate."

REFUTED, verified this run:
  - `tests/mcp/agent-scope-matrix.test.ts` partitions the entire live `buildToolTable("full")` table into buckets in BOTH directions, drives every entry against a two-owner fixture, and asserts neither the response nor the thrown message carries a marker unique to the other owner. A new or removed tool fails the suite until classified.
  - `tests/core/architecture/visibility-surface-census.test.ts` mechanically sweeps `src/mcp/` for files importing note-content-returning primitives, resolves tool names through constants, cross-checks against the live tool table, and pins the population as an equality (43 MCP tools, 8 resources, 20 CLI verbs).

REMAINING ASK, three named gaps:
  1. The matrix's axis is OWNER, not VISIBILITY. Its fixture is a two-owner vault; no seeded `visibility:`-tagged corpus.
  2. No assertion on the MCP `_meta` channel (`src/mcp/progress.ts` shows `_meta` is a live response member).
  3. No federated / multi-source caller shape in the matrix.
  4. `tests/core/architecture/visibility-surface-census.test.ts:84-86` names `src/openclaw/index.ts` as an un-swept page-search surface, out of that census's charter. Verified: `src/openclaw/index.ts:128` calls `listVaultPages(vault)` and filters only by entity status scope (`vaultPageInStatusScope`), never by visibility.

# Measured starting state (read off the live registry this run, not estimated)

  - `src/core/search/visibility-surface-registry.ts` holds 72 rows: 71 callable + 1 `index_store` structural row.
  - 68 of 71 callable surfaces are category `excluded` - they can return a page's path, title or body without ever consulting `visibility:`.
  - Exactly 3 are `covered`: `brain_search`, `brain_file_context`, and the CLI verb `search query`. All three are covered only because they route through `search()`.
  - `src/core/search/indexer.ts` chunks every page regardless of its tag; the registry's `index_store` row states this in its own words ("stored in chunks and mirrored into chunk_fts regardless of any read-side filter").
  - `o2b search check` emits a visibility honesty finding (`src/core/search/indexer.ts:1672`) whose counts are read off `excludedCallableVisibilitySurfaces()` at call time, so the finding recounts itself as surfaces move category.

# Index-side facts that a variant must respect (verified, and they correct a widely-repeated assumption)

  - `indexRevision` (`src/core/search/store/state.ts:112-118`) is a MONOTONIC QUERY-CACHE GENERATION COUNTER bumped after any mutating index run, consumed by `computeCorpusGeneration` (`src/core/search/corpus-generation.ts:32`). It is NOT a schema or index-format revision. Bumping it invalidates cached query results; it does NOT force a reindex. Any variant that claims "this forces a full reindex for every vault" is wrong about this mechanism.
  - The indexer's deletion sweep (`src/core/search/indexer.ts:537-540`) removes any stored document the walk did not yield. So a page that STOPS being yielded has its chunks purged on the next ordinary incremental run.
  - BUT `seen.add(file.relPath)` happens at `indexer.ts:390`, BEFORE the content read and frontmatter parse. A "skip private pages" that merely `continue`s after parsing frontmatter leaves the path marked seen and its stale chunks in place. Exclusion has to route into an explicit delete, or the skip has to happen before the mark.
  - `walkVault` (`src/core/search/walker.ts`) does not parse frontmatter at all - it yields `.md` files by scope rules and `statSync`. A visibility decision needs frontmatter, which only the indexer body reads.
  - The mtime+size fastpath (`indexer.ts:400`) skips the content read entirely when both match. A page that was ALREADY tagged private before this feature ships has an unchanged mtime, so an ordinary incremental run never re-examines it and its chunks survive. Handling that pre-existing population is a real, nameable design obligation.

# Transport facts (for the trusted-local bypass)

  - `ServerContext` (`src/mcp/tool-contract.ts:101-128`) carries `vault`, `configPath`, `repoRoot`, `capabilityReport`, `artifactStore`, `agentName`. There is NO transport field today.
  - Two transports construct the server: `serveStdio` (`src/mcp/stdio.ts:65`) and `startHttp` / `serveHttp` (`src/mcp/http.ts:61`, `:198`). `isLoopbackHost` (`src/mcp/http.ts:338`) already exists, and `startHttp` already refuses a non-loopback bind without an API key.
  - `MCPServer.context` (`src/mcp/server.ts:152`) is a GETTER that rebuilds the context per access.
  - The CLI (`src/cli/main.ts`) also invokes tool handlers directly (`o2b tool-call`), which is a third caller shape.
  - Note the honest difficulty: stdio is not automatically "trusted". A remote host can spawn a stdio subprocess. State clearly what your variant's bypass actually proves.

# Existing idiom to imitate rather than reinvent

  - `src/core/brain/entities/page-scope.ts` - `vaultPageInStatusScope(metadata, scope)`: a page-level predicate over the frontmatter a walker already parsed, defined once, adopted by `src/openclaw/index.ts` and `src/core/brain/link-graph/repair-lane.ts`. This is the closest existing shape to what a visibility predicate should look like.
  - `src/mcp/owner-scope-refusal.ts` - the project's stated rule that an identity echoed back from the request is not an identity; a disagreement is refused BY NAME rather than silently substituted.
  - `src/mcp/resources.ts` `gatedOwnerScopeView` usage - a withheld artifact is reported with the same `not found` message an absent one produces, so a refusal does not announce the page it hides (no existence oracle).

# Project context

Open Second Brain. TypeScript on Bun. Monolithic repo; `src/core/` is the engine, `src/mcp/` the MCP server, `src/cli/` the CLI, `src/openclaw/` a native plugin adapter, `plugins/hermes/` a Python sidecar. Tests under `tests/` run with `bun test`.

Recent commits:
23e6b81e fix(brain): merged pages leave the dedup pool, and the write seam refuses cycles (v1.53.1) (#182)
c2e13f9d fix(hermes): make prefetch recall query-aware (#181)
5102f142 fix(hermes): record context-pack receipts and explicit outcomes (#179)
323e2f09 feat: nothing writes silently, nothing degrades silently (v1.52.0) (#178)
6d3e8b23 feat: what earns its keep (v1.51.0) (#177)
b49af81e feat: a label is not a boundary (v1.49.0) (#166)

Related files:
src/core/graph/visibility.ts
src/core/search/result-filters.ts
src/core/search/pipeline/pool-filters.ts
src/core/search/visibility-surface-registry.ts
src/core/search/indexer.ts
src/core/search/walker.ts
src/core/vault.ts (listVaultPages, 17 call sites)
src/openclaw/index.ts
src/mcp/tool-contract.ts
src/mcp/server.ts
src/mcp/stdio.ts
src/mcp/http.ts
src/mcp/owner-scope-refusal.ts
src/core/brain/owner-scope-view.ts
src/core/brain/entities/page-scope.ts
tests/mcp/agent-scope-matrix.test.ts
tests/core/architecture/visibility-surface-census.test.ts

Conventions, taken from the repository's own shipped code and its agent guidance:
- SOLID, KISS, DRY. Repeated literals hoist into named constants. One rule, one spelling: a second spelling of the same rule is treated as a defect.
- No silent fallback. A degradation is named and surfaced, never quietly absorbed. "Nothing writes silently, nothing degrades silently" is a shipped release title in this repo.
- No stubs, no placeholder values, no hardcoded natural-language phrases in any language. Visibility tokens are opaque and language-neutral by existing design; nothing may enumerate the languages of the world or hardcode a closed natural-language enum.
- Fail closed on unreadable state: an ownership or visibility claim that cannot be read is not an absence of one.
- No existence oracle: a withheld page must be indistinguishable from an absent one, including in counts, aggregates and error messages.
- Census and matrix tests are the project's chosen mechanism: a population is pinned as an equality, a newcomer fails the suite until classified, and a reason is written per entry.
- Every artifact is English.

Constraints:
- Deny by default. A variant whose protection is off unless an operator sets a config key does not meet the ask.
- The trusted-local bypass must key on transport or another server-side fact, never on a caller-supplied string.
- Zero behaviour change for vaults that never set `visibility:`. Default-visibility pages must stay reachable everywhere, and the cost for such a vault must be near zero.
- This is a BEHAVIOUR CHANGE for vaults that do set it: pages that read today over MCP stop reading. Say how your variant makes that legible to the operator.
- Do not introduce a second enforcement path alongside `applyVisibilityScope`; either subsume it or state plainly why two exist.
- No new external dependencies.
- The wave is sized at roughly 50-70 changed files. A variant that cannot be reviewed at that size should say so.
- `src/openclaw/index.ts` is in scope: it is the un-swept page walker the census names.
- The existing registry and matrix must be able to PROVE the closure, not merely describe it - the covered/excluded counts must move and the honesty finding must recount itself.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
