### Variant 1: Trust-Boundary Kernel
- **Approach**: Build one new shared module (e.g. `src/core/boundary/`) that owns every trust/identity primitive: a canonical identity function (NFC path + content-hash, Units 1+2), a provenance-delimiter/neutralizer (Unit 1), a scope-predicate factory (Unit 5), and a generic "side-index" abstraction the graph (Unit 4) and watcher-driven indexer (Unit 3) both register against. Each unit becomes a thin caller of the kernel; the kernel is the single place the suite's theme is enforced.
- **Trade-offs**:
  - Pro: the "every byte crossing a boundary" theme is literally one module — discoverable, one test surface for the cross-cutting invariants.
  - Pro: identity (NFC+hash) is defined once, so Unit 1's `sha256="..."` and Unit 2's change-detection key cannot drift apart.
  - Con: forces a premature abstraction over genuinely different mechanics (a string neutralizer vs a daemon vs a SQL filter share almost no real shape); the generic side-index/scope abstractions risk being shallow wrappers.
  - Con: largest blast radius against the byte-identical-when-off guarantee — every existing call site is rerouted through the kernel even when flags are off.
- **Complexity**: large
- **Risk**: high

### Variant 2: Five Independent Units, Shared Nothing New
- **Approach**: Each unit stays in its named home (`redactor.ts`, `note-path.ts`/`content-hash.ts`, `indexer.ts`, `communities.ts`/`store.ts`, `search.ts`) and reuses only what already exists (the current content-hash). No new shared module; the only common discipline is convention (pure derivation, opt-in flag, byte-identical-when-off). Persisted-vs-derived is decided locally per unit with a strong default of read-time derivation, persisting only where Unit 4 measurably needs it.
- **Trade-offs**:
  - Pro: smallest diff per unit, cleanest TDD-one-by-one story, each unit independently revertable — matches "independent in code" literally.
  - Pro: lowest risk to the byte-identical guarantee — touches stay local to each file.
  - Con: the unifying theme exists only in the changelog, not the code; the identity primitive (NFC+hash) is shared by Units 1 and 2 but lives in two files, inviting future drift.
  - Con: Units 3 and 4 both want a "kept-fresh derived view" but solve it twice with no shared invalidation discipline.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Thin Identity Core, Independent Edges
- **Approach**: Extract only the one primitive two units genuinely share — a canonical identity (NFC-normalized path + content-hash) consumed by both the Unit 1 delimiter's `sha256`/`path` provenance and Unit 2's change-detection key — into the existing `content-hash.ts`/`note-path.ts` boundary. Leave the three operational units (3 watcher at the CLI/MCP edge, 4 graph side-indexes, 5 recall scope) fully independent in their own homes. Resolve the derive-vs-persist tension by rule: read-time-derive everywhere (Units 1, 2, 5), with Unit 4 alone allowed an in-memory side-index memoized and invalidated on store version (not SQLite-persisted), and Unit 3's watcher reusing the existing incremental `indexVault` rather than introducing a new persisted state.
- **Trade-offs**:
  - Pro: shares exactly what is provably shared (identity) and nothing speculative — kills the Unit 1/Unit 2 drift risk without inventing a kernel.
  - Pro: gives the suite one explicit, documented rule for the derive-vs-persist tension, so Units 3/4/5 are individually simple but collectively coherent.
  - Pro: preserves byte-identical-when-off cleanly — only the identity boundary is shared, and NFC is idempotent on already-NFC (Linux) inputs.
  - Con: requires judgment on where "shared enough" stops; Unit 4's memoize-and-invalidate is the one place that needs careful concurrency/determinism review.
  - Con: slightly more upfront coordination than Variant 2 (the identity extraction lands first and the others build on it).
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3
**Rationale**: The only real cross-unit coupling is identity (Unit 1's provenance hash and Unit 2's change-detection key must be the same canonical NFC+hash), so extracting that one primitive — and nothing else — captures the theme's coherence without paying for Variant 1's speculative kernel or accepting Variant 2's latent drift. It honors the repo's established read-time-derive precedent (`recall-hint.ts`, `enrich.ts`) as the default while granting Unit 4 the single principled exception its O(1) performance goal demands, and the narrow shared surface keeps the byte-identical-when-off guarantee and one-by-one TDD flow intact across a single branch and release.
