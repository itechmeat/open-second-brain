### Variant 1: Eight local truths

- **Approach**: Each unit lands with its own local mechanism and no new shared abstractions: A's `countChunksWithoutEmbeddings` and G's record-vs-data audit are the only coupled pair (sequenced A→G on the shared `buildRecommendations`/`IndexCheckReport` surface). Unit H takes form B (enumeration census + doctor/search-check finding stating the boundary does not exist). Unit E's dead-letter knob resolves to in-response accounting only, with the durable dead-letter named and deferred in the design doc; F's read-back census and E's write accounting each define their own small report shape.
- **Trade-offs**:
  - Pro: smallest diff and review burden for an already-large 8-unit single PR; each unit is independently revertable inside the squash.
  - Pro: no new STATE_SURFACES row, no indexRevision move — zero migration cost for existing vaults.
  - Con: three near-identical "claimed/found/missing" shapes (E accounting, F census, G audit third-state) grow independently and will drift in vocabulary — the verdict-vocabulary census will eventually have to reconcile them anyway.
  - Con: a failed lane write that exists only in a response the caller drops is itself a silent loss — in-response-only accounting undercuts the wave's own theme.
  - Con: H form B plus deferred enforcement means the privacy gap survives the wave with only a warning attached.
- **Complexity**: small
- **Risk**: low

### Variant 2: Shared reconciliation vocabulary

- **Approach**: Introduce one small pure module — a reconciliation report type (`attempted/found/missing`, missing keys always named) — consumed by F's post-import read-back census, E's multi-artifact write accounting, and G's "record contradicts data" third state, so all three surfaces speak one vocabulary pinned by the existing verdict-vocabulary census. H takes form B, but its note-returning-surface enumeration is built as an extension of the same architecture-census machinery C uses for the write-site boundary assertion, so C and H share one census substrate. E's dead-letter knob resolves to a durable dead-letter under `.open-second-brain/` with its STATE_SURFACES row (a dropped response must not be the only record of a failed write). Sequencing: census/vocabulary substrate first, then A→G sequentially, then B/C/D/E/F against the settled substrate.
- **Trade-offs**:
  - Pro: one report shape means the wave's honesty guarantees are uniform and census-enforceable rather than three ad-hoc dialects.
  - Pro: durable dead-letter is the only resolution of the knob consistent with "nothing writes silently"; the STATE_SURFACES convention already prices it.
  - Pro: H form B ships something true and small now while its census artifact is exactly the coverage map form A needs later — no throwaway work.
  - Con: the shared module is a new coordination point; B/E/F/G all block on its shape settling before parallel work can start (mitigates the known parallel-agent pin-collision problem, but costs wall-clock).
  - Con: still defers real `visibility: private` enforcement; the doctor finding documents a hole rather than closing it.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Boundary-enforcing wave

- **Approach**: Unit H takes form A: `isRemotelyReadable` in graph/visibility.ts, transport-keyed (stdio vs HTTP) trusted-local bypass, wired at listVaultPages, pool-filters, and the indexer — and the entry-point derivation that C needs for `origin_channel` is generalized into one server-derived context object (channel + transport) threaded from the MCP server / CLI dispatcher, serving both C's stamp and H's bypass so no caller string ever carries privilege. Durable dead-letter for E rides the same STATE_SURFACES addition wave. Sequencing is strict: A→G on `buildRecommendations`, then H's indexer change last since it moves indexRevision and touches the same index surfaces A and G just instrumented.
- **Trade-offs**:
  - Pro: actually closes the private-content-in-chunks hole this wave's theme points at; one shared entry-point context is the architecturally clean home for both server-derived facts.
  - Pro: no second wave needed for H; the census lands as enforcement coverage proof, not an apology.
  - Con: indexRevision move forces a full reindex in the same release that ships new index-health recommendations (A, G) — every user's first post-upgrade `o2b search check` fires on a freshly invalidated index, muddying the very signals A and G introduce.
  - Con: largest blast radius in a single PR/CHANGELOG version; the indexer chokepoint touches the query hot path the constraints say A must stay off.
  - Con: three-chokepoint enforcement plus a covered/excluded census across every note-returning surface (brain_file_context, context_pack, query, backlinks, knowledge lane…) is a wave-sized unit by itself; bundled with seven others it dominates review and delays everything.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The wave's theme is honesty about writes and degradation, and Variant 2 is the only one that applies that theme to its own machinery: a single census-pinned reconciliation vocabulary keeps E, F, and G from drifting into three dialects of "missing", and a durable dead-letter is the only dead-letter answer where a failed write survives a dropped response. Variant 3's form-A enforcement is the right destination but its indexRevision move poisons A's and G's brand-new health signals inside the same mandatory single PR, while Variant 1 saves little over Variant 2 and leaves debts (report-shape drift, response-only failure records) that contradict the release's stated promise; H form B ships true statements now and produces exactly the coverage map a later form-A wave needs.
