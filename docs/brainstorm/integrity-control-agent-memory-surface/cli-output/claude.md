### Variant 1: Narrowest seams, per-card local logic
- **Approach**: Each card lands as an isolated edit at its existing call site with no shared abstraction. Card 1 adds a title-plus-alias term pool and an inline "exactly one page carries this term" filter inside `collectRepairCandidates`; Card 2 adds a post-pass in `runPreExtract` that probes relative specifiers against the manifest path set and fills an optional `resolvedTo` on the seed; Card 3 adds one JSX opening-tag regex and a `uses` kind; Card 4 calls `rememberKey` from `applyWriteBatch` with a `write_batch` record whose `ref` carries the receipt; Card 5 is one sentence; Card 6 threads a `matchMode` boolean-ish flag through `SearchOptions` to `buildFtsMatch`.
- **Trade-offs**:
  - Pro: smallest diff, every default byte-identical, each card reviewable on its own.
  - Pro: no new modules, no new public types beyond the widened union and optional fields.
  - Con: the unique-match discipline is written twice (pages in Card 1, files in Card 2) with two chances to diverge.
  - Con: ambiguous terms and unbound specifiers tend to vanish silently unless each site remembers to count and report them, which strains the "nothing degrades silently" convention.
  - Con: Card 4 records the ledger entry after the commit, leaving a crash window between apply and remember that a retry can double-apply through.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Shared unique-resolution primitive with named refusals
- **Approach**: Introduce one small pure module (a term index plus a resolver that returns `unique | ambiguous | none` with the candidate list) and consume it from both the repair-lane term resolver (Card 1, terms pooled from titles and `buildAliasIndex`) and the pre-extract specifier binder (Card 2, terms are extension-probed paths over the ingested-file set passed in as an explicit input). Both surfaces carry the refusal counts outward: the repair report gains an ambiguous-terms section and the pre-extract result gains an `unbound` list with reasons. Card 4 reuses `rememberKey` unchanged with the batch receipt in `ref`, consulted before any commit and recorded inside the batch's atomic unit so the receipt and the writes land together; Card 6 defines one `FtsMatchMode` type shared by `buildFtsMatch` and `buildExpandedFtsMatch`; Cards 3 and 5 stay local.
- **Trade-offs**:
  - Pro: one tested discipline for "bind only when exactly one target matches", so Cards 1 and 2 cannot drift.
  - Pro: honesty by construction, since the resolver returns a typed status and callers must map every status to something visible.
  - Pro: no new dependencies, no new machinery beyond a pure function module, determinism is trivial to prove because the resolver takes the index as an argument.
  - Con: a new cross-cutting module means a broader test surface and one more thing for the link-graph and ingest owners to agree on.
  - Con: putting the ledger record inside the batch commit touches the write-batch kernel's atomic path, which is the most sensitive code in the wave.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Index-first candidate tables and a separate receipt store
- **Approach**: Build explicit reusable indexes as first-class inputs: `loadPages` returns a corpus term index that the repair lane, `findUnlinkedMentions` and future consumers share, and `ingestSource` builds an ingested-file index from the manifest and hands it to pre-extract. Cards 1 and 2 produce a full candidate table (every term with all matching targets and a resolution status) as an intermediate artifact surfaced in dry-run reports, and binding becomes a filter over that table. Card 4 gets a dedicated receipt store keyed by request ID rather than a ledger record, and Card 6 replaces the boolean with a parsed query object carrying tokens and mode.
- **Trade-offs**:
  - Pro: richest operator visibility, and the shared indexes would let the target-centric mention scanner converge with the corpus-wide path later.
  - Pro: the candidate table makes ambiguity a reported fact instead of a dropped edge.
  - Con: changes the shape of `loadPages` output and the pre-extract input contract, the widest blast radius in the wave.
  - Con: a separate receipt store duplicates what the idempotency ledger already does and drifts from the card's stated scope of extending `rememberKey` semantics; it also edges toward the struck durable-queue territory.
  - Con: the parsed query object for Card 6 is more than the card asks for and risks touching the two derived-term callers.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: Variant 2 keeps every default byte-identical and adds no machinery, yet it gives the two resolution cards one shared, typed unique-match discipline so ambiguity is always named rather than silently dropped, which is the project's core honesty rule. It reuses the existing idempotency ledger exactly as the validator scoped Card 4, while closing the apply-then-remember crash window that Variant 1 leaves open. Variant 3 buys visibility the cards did not ask for at the cost of public-shape changes and a parallel receipt store the constraints explicitly steer away from.
