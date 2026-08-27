# Variants - private is not a suggestion

The consultant run is reproduced verbatim below, followed by the
orchestrator's decision. The primary consultant (Claude Code) returned three
parseable variants and a recommendation on its first invocation, exit 0, so
the fallback consultant was not run and `cli-output/codex.md` does not exist.

The prompt the consultant received is `cli-output/prompt.md`. It carried the
premise verifications already done against live source, so the consultant was
reasoning about the real codebase rather than about the cards' refuted claims.

---

## Consultant output, verbatim

### Variant 1: Capability-scoped read primitives (choke point in core)

- **Approach**: Move enforcement into the note-content-returning primitives themselves (`listVaultPages`, the read-page-by-path primitive, and the index query layer), which become deny-by-default: they consult a single `vaultPageVisible(metadata, disclosure)` predicate (built on the existing `visibility.ts` tokens, sibling in shape to `vaultPageInStatusScope`) before yielding a page. A server-side `disclosure` value is minted only by transport constructors — `serveStdio`, `startHttp` (loopback vs. non-loopback via `isLoopbackHost`), and `src/cli/main.ts` — and threaded into `ServerContext` and down through the primitives; no caller-supplied string can produce it. `applyVisibilityScope` is subsumed: the pool-filter call site delegates to the same predicate, so one rule has one spelling.
- **Trade-offs**:
  - Pro: new surfaces are safe by construction — a tool that imports the primitives cannot forget the filter, so the census's "excluded" category structurally empties.
  - Pro: no existence oracle for free — a withheld page is literally never yielded, so counts, aggregates, and `_meta` cannot mention it.
  - Con: signature churn — `disclosure` must thread from three transports through `ServerContext` into core primitives, touching most of the 17 `listVaultPages` call sites plus every tool that constructs core calls; the wave lands at the top of the 50–70 file budget.
  - Con: internal engine lanes (indexer, dedup pool, link-graph repair) legitimately need unfiltered reads; they need a named in-process full-disclosure value, and drawing that line wrong either breaks wikilink integrity or quietly re-opens the hole.
  - Con: honest bypass statement is weak-but-defensible: stdio/CLI/loopback prove only "the caller already has filesystem-equivalent access to this vault," not operator intent.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Per-surface predicate sweep, census-enforced

- **Approach**: Define the same single predicate once, but leave primitives unfiltered and sweep all 68 `excluded` surfaces (including `src/openclaw/index.ts:128`) to adopt it at their own enumeration/read points, exactly as `vaultPageInStatusScope` was adopted. Each adoption flips its registry row from `excluded` to `covered` with a written reason; the agent-scope matrix gains a seeded `visibility:` corpus axis (including `_meta` and a federated caller shape), so an unclassified or wrongly-wired surface fails the suite.
- **Trade-offs**:
  - Pro: maximally reviewable — 68 small, independent, idiom-matching diffs; the registry and honesty finding move row by row, making progress and closure legible.
  - Pro: no plumbing churn; transports still mint the `disclosure` server-side, but it only has to reach tool handlers, not core signatures.
  - Con: enforcement stays distributed forever — every future surface is one forgotten predicate away from a leak, and only the census/matrix (not the type system or call graph) stands between it and shipping.
  - Con: no-existence-oracle must be re-proven per surface (backlink counts, graph aggregates, thrown messages), which is exactly the class of error a 68-site sweep invites.
  - Con: heaviest test burden: the matrix must drive every surface against the visibility corpus in both directions to make the claim real.
- **Complexity**: large
- **Risk**: medium-high

### Variant 3: Two-root enforcement with a fail-closed index column

- **Approach**: Observe that every callable surface reaches page content through one of three roots — `listVaultPages`, the read-by-path primitive, or the search index — and enforce only there, with the census extended to prove no fourth root exists (mechanical sweep for direct `fs` reads of vault paths under `src/mcp/`, `src/cli/`, `src/openclaw/`). The index gains a per-document visibility column written at index time; query-side filtering treats a missing/unreadable value as private (fail closed), which makes the pre-existing-tagged-page population self-healing — stale fastpath-skipped rows have no column, so they are withheld immediately and correctly reclassified on the next content read, with a one-time persisted store marker (not `indexRevision`, which is only a cache generation) forcing full frontmatter re-examination once. Private pages stay indexed but flagged, so the transport-keyed `disclosure` can lift the filter for local callers without a segregated store; the indexer skip-vs-delete trap (`seen.add` at `indexer.ts:390`) never arises because nothing is skipped.
- **Trade-offs**:
  - Pro: smallest enforcement surface — three choke points plus a census that proves their sufficiency; the 68 registry rows flip to `covered` by root, each citing which root covers it.
  - Pro: index handling is the cleanest of the three: fail-closed column solves the mtime-fastpath legacy population without a purge/migration dance, and trusted-local search over private pages keeps working.
  - Con: private page bodies remain in `chunks`/`chunk_fts` at rest — anyone with file access to the store reads them; this must be stated plainly (it is the same trust boundary as the vault files themselves, but it is a fact, not nothing).
  - Con: the whole guarantee hangs on the root-closure census being right; a surface that shells out or re-implements a walk escapes until the census learns that shape.
  - Con: read-by-path root must refuse with the same `not found` an absent page produces, and that message-identity must be asserted in the matrix.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: Variant 3 delivers Variant 1's safe-by-construction property at a fraction of the signature churn, fits comfortably inside the 50–70 file wave, and is the only variant whose index-side story respects all four verified indexer facts without a fragile purge path — the fail-closed column turns the pre-existing-private-page obligation from a migration into a default. It subsumes `applyVisibilityScope` naturally (the search root is one of the three choke points), and its residual risk — trusting the root-closure census — is exactly the mechanism this project has already chosen and shipped for population claims, so extending the census to prove "no fourth root" is idiomatic rather than novel.

---

## Orchestrator decision: Variant 3, with one mechanism corrected

Variant 3 is adopted. Its central insight is the one that survives contact
with the source: every callable surface in the registry reaches page content
through one of three roots, so enforcement belongs at those roots and the
census - the instrument this project has already chosen and shipped for
population claims - is extended to prove no fourth root exists. That is
Variant 1's safe-by-construction property without Variant 1's signature churn
through seventeen `listVaultPages` call sites and every tool that builds a
core call, and it is the opposite of Variant 2, which leaves enforcement
distributed across 68 sites forever and puts every future surface one
forgotten predicate away from a leak. Variant 2 also fails the project's
one-rule-one-spelling convention on its face.

One mechanism in Variant 3 is refuted and is replaced rather than adopted.

The variant proposes that a missing index column value be read as private,
calling the pre-existing tagged-page population "self-healing" and claiming
this dissolves the mtime-fastpath obligation into a default. Checked against
source, it does the opposite. `applyMigrations`
(`src/core/search/schema.ts:773`) adds a column with NULL for every row that
already exists, and `assertSchemaIsCurrent`
(`src/core/search/store/lifecycle.ts:123-131`) admits a migrated index
without any reindex. So on upgrade every document in every vault would read as
private - including the overwhelming majority of vaults that have never set
`visibility:` at all - and every search would return nothing until the
operator ran a full reindex they were never told they needed. That is a
silent, total capability blackout, and it breaks the wave's own stated
zero-behaviour-change constraint.

The replacement is smaller than the thing it replaces. Migration 12
backfills. `packBlocks` (`src/core/search/chunker.ts:312-330`) emits a page's
frontmatter as its own chunk, whole and without overlap, at `chunk_index = 0`
- a structural fact `src/core/search/store/visibility-tag.ts` already relies
on and `tests/core/search/visibility-tag-presence.test.ts` already pins. The
migration parses that stored frontmatter for every existing document and
writes the column with no vault walk and no operator action. The legacy
population is then gone rather than deferred, and NULL narrows to what it
should always have meant: a page whose frontmatter the index genuinely cannot
produce - unterminated frontmatter, which `chunker.ts:137-141` omits, or a
document with no chunks. That population is tiny, it is the correct thing to
fail closed on, and `search check` reports its count rather than absorbing it.

Two smaller amendments to the variant as written:

- Variant 3 says private page bodies "remain in `chunks`/`chunk_fts` at rest"
  as a con to be stated plainly. Adopted, and it is also a deliberate product
  decision rather than only a residue: excluding private pages from the index
  would take an operator's own private notes out of their own local search.
  The registry's existing `index_store` row already states the storage fact
  and is kept, reworded.
- Variant 3 does not mention the `seen.add` trap. It is load-bearing for the
  choice: `indexer.ts:390` marks a path seen before the content read, so a
  "skip private pages" written as a `continue` would leave stale chunks that
  the deletion sweep at `indexer.ts:537-540` never purges. Marking rather than
  skipping avoids it, which is a second, independent reason for the column.

### Why not Variant 1

Safe by construction and honestly assessed by the consultant, but it threads a
disclosure parameter from three transports through `ServerContext` into core
primitives and out across most of the seventeen `listVaultPages` call sites
plus every tool that constructs a core call. The consultant's own note is the
deciding one: the internal engine lanes - the indexer, the dedup pool, the
link-graph repair lane - legitimately need unfiltered reads, and drawing that
line wrong either breaks wikilink integrity or quietly re-opens the hole. The
chosen design still passes an explicit full-disclosure value at those lanes,
but at three roots rather than at every call site, so the line is drawn in
three places that can be read at once instead of across the engine.

### Why not Variant 2

It is the most reviewable diff and the least durable boundary. Sixty-eight
independent adoptions means sixty-eight places to re-prove the
no-existence-oracle property on counts, aggregates and thrown messages, which
is precisely the class of error a sweep that size invites; and the day after
it ships, the sixty-ninth surface is one forgotten call away. This repository
has already shipped the argument against it: `a-label-is-not-a-boundary`
(v1.49.0) exists because ownership had two callers and every other surface
bypassed them, and `owner-scope-refusal.ts` states in its own docblock that a
rule with two spellings is a rule with none.
