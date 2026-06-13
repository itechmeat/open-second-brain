### Variant 1: Unified staged-intake kernel
- **Approach**: Generalize the existing `write-session` kernel into ONE provider-agnostic "intake transaction" that every generation-bearing feature (ingest, research-report, derived-facts, on-write NER) funnels through: the agent proposes a typed payload across an MCP/CLI boundary, OSB validates → provenance-stamps → cross-links → atomically commits. The boundary sits at this single kernel; primitive (a) is the discriminated `ExtractionIntake` payload (entities/concepts) shared by ingest and NER, (b) is a `Provenance` value object the kernel stamps at commit on any payload (source links, premise links, `stated|deduced|inferred` token), and (c) reuses `agent-scope.ts` for owner fields. Features 2/3/6 become payload variants or phases that call the same commit path.
- **Trade-offs**:
  - Pro: Maximum DRY — one validation/commit/provenance path, one place to guarantee byte-identical-when-off and atomicity.
  - Pro: Minimal new MCP tool surface; directly extends the cited kernel precedent.
  - Pro: Provenance and idempotency (sha256 dedup) live in exactly one tested seam.
  - Con: A large upfront abstraction conflicts with "one feature at a time via TDD" — the kernel must be near-complete before any feature lands, so the first commits carry the most risk.
  - Con: Over-generalization risk: ingest (many pages) and a single derived fact stress the same payload type very differently, inviting leaky union types or `as` crutches the conventions forbid.
  - Con: Hardest to keep each feature's commit atomic and independently revertable.
- **Complexity**: large
- **Risk**: high

### Variant 2: Per-feature pipelines over three shared libraries
- **Approach**: Each feature is its own module/pipeline with its own MCP tool or CLI command and its own TDD unit (`ingest.ts`, `research.ts`, a `derive` phase in `dream.ts`, `ner.ts`, owner-scoped facts on `preference-txn.ts`, an extension to `attention-flows.ts`), but all import three shared library functions rather than duplicating logic: `extractIntake()` (primitive a, shared by ingest + NER), `stampProvenance()`/citation builder (primitive b, shared by ingest + research + derive), and the existing owner-visibility helpers (primitive c). The generation boundary sits at each feature's own tool — the agent supplies extracted entities / summaries / report findings / derived reasoning, and each pipeline sequences-validates-commits using the shared libs (mirroring `importSession`'s dedup-hash blueprint).
- **Trade-offs**:
  - Pro: Matches the repo's established decomposition (v1.2 domain modules) and the one-atomic-commit-per-feature TDD constraint exactly — each feature fails-first, passes, ships independently.
  - Pro: Risk is isolated per feature; a flawed ingest pipeline cannot regress derived-facts.
  - Pro: DRY is enforced structurally (three named exports) without a monolithic type; easiest to keep flags independently opt-in and byte-identical-off.
  - Con: Larger MCP/CLI surface (several new tools on top of 72); sequencing/commit boilerplate is repeated per pipeline even when the libs aren't.
  - Con: Discipline-dependent — nothing forces callers through the shared libs, so drift is possible without review vigilance.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Read-time provenance/visibility resolver with thin write adapters
- **Approach**: Push provenance, trust-ordering, and owner-scoping entirely into a read-time derivation at `packContext`/recall time, governed by frontmatter tokens and wikilinks; writes stay "dumb." The generation features become thin agent-side adapters that only emit notes carrying the right frontmatter (`provenance:`, `owner:`, premise links, `Sources` section), while one `resolveProvenance()`/`resolveVisibility()` layer at the read chokepoint does all ordering and filtering. Primitive (a) is a minimal extraction-intake that just writes tagged pages (shared by ingest + NER), (b) is the frontmatter token convention plus the read-time resolver (shared by ingest/research/derive), (c) is `agent-scope.ts` invoked at read for both facts and search — unifying owner-scoped facts with v1.6 agent-scope in one place.
- **Trade-offs**:
  - Pro: Strongest byte-identical-when-off guarantee — storage is unchanged; behavior only appears when the resolver is flagged on at read.
  - Pro: Trust ordering (stated > deduced > inferred) and owner filtering live in one read seam, naturally extending the read-time-derive pattern and the standing-query attention layer (feature 6 is already a read-time injector).
  - Con: Ingest and research are inherently write-heavy multi-page cross-referencing operations that don't fit a pure read-time model — those features still need real write pipelines, so the resolver only covers 3/6 features and a hybrid is unavoidable.
  - Con: Recomputing provenance/visibility on every context assembly adds read-path cost and complicates caching against the O(1) graph side-index.
  - Con: Frontmatter-only provenance is brittle if a page is hand-edited in Obsidian, with no commit-time validation to catch it.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 2
**Rationale**: It is the only variant that fits the hard process constraints — one feature at a time via TDD, one atomic revertable commit per unit, all inside a single 50-70 file PR — because each pipeline lands independently while the three named shared exports satisfy the DRY mandate without a monolithic kernel. It mirrors the repo's own precedents (`importSession`, `write-session`, v1.2 domain decomposition) and keeps each opt-in flag and its byte-identical-off guarantee isolated, whereas Variant 1's upfront kernel front-loads risk against the TDD cadence and Variant 3 only cleanly covers the read-side half of the suite. Where Variant 2 needs the agent-supplies-generation boundary it simply borrows the staged-intake shape inside the `extractIntake` primitive, getting Variant 1's key benefit without its monolith.
