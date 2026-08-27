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
