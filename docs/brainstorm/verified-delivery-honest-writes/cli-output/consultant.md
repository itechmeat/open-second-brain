Consultant ran as the host orchestrator's in-session subagent (host execution mode); no external CLI was invoked.

### Variant A1: In-walker trim with comparator score reuse; presence as a sibling continuity record
- **Approach**: The trim runs after the unified walker in `packContext`, reusing the ranked-mode jaccard kernel (`relevanceById`) the comparator already computes: top-3 keep, restatement keep-rule at a fixed fraction, whole-item drops with a new `"tail-trim"` skip reason, and freed budget offered back to `over-budget` candidates in priority order behind a config flag that defaults off. Reply presence is folded by the existing answer-quote-check Stop loop into a sibling `reply_presence` continuity record joined to the context receipt by `session_id`, extending `ANSWER_QUOTE_VERDICT` with `absent` and fixing the `session_inject` receipt's missing session key at the source.
- **Trade-offs**:
  - Pros: zero duplicate scoring work and a byte-identical off-path; the context receipt stays automatically correct because finalize maps `report.items`; rescue is expressible because skipped candidates are still in hand; one verdict vocabulary and an append-only record respect the store's contract; the join key is fixed at the source, not inferred from time windows.
  - Cons: covers the unified path only until extended to the `packingPolicy` branch (out of v1); a new continuity kind obligates the fold-decision row and a documented join contract; presence rows grow the ledger per checked turn.
- **Complexity**: medium
- **Risk**: low

### Variant A2: Post-finalize delivery stage; presence via the existing log channel
- **Approach**: Apply the trim inside `finalizeContextPackReport` over `report.items`, uniformly across the unified and packing-policy return paths. Carry reply presence only through the channels the Stop hook already writes - the `additionalContext` annotation and the enforce-mode Brain-log `note` event - with no new continuity kind.
- **Trade-offs**:
  - Pros: one trim site covering both return paths; no new record kind, fold decision or join contract; the ledger stays quieter.
  - Cons: rescue is impossible at that point - skipped candidates are resolved and their budget accounting closed, so the card's term-aware rescue cannot exist; substring and semantic modes need score recomputation at finalize; Brain-log events are local, unsynced and unread by the receipt surface, so `brain_context_receipts` cannot serve presence; the enforce log exists only under `enforce`, so shadow-mode operators get nothing.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant A1
**Rationale**: The rescue rule and the receipt join are the two behaviors the cards name as their value, and only A1 can express either: rescue needs the walker's live skip list, and presence needs a store the receipt read surface can join against. A1 also reuses both verified seams with no duplicated computation, and its costs are census-silent or single-row decisions.

### Variant B1: Collector-level denial with named omissions everywhere
- **Approach**: Compute the denial once in `collectPreferenceRows` from the frontmatter map the collector already parsed, as a report beside complete `rows`; teach the json envelope (additive `omitted`, absent when empty), a detailed llms-txt variant, the bank bundle and the knowledge pack to drop denied rows and name each omission with reason `"visibility"`, with no override flag.
- **Trade-offs**:
  - Pros: one deny judgment reused by every consumer; `rows` stays complete so import-side topic maps keep seeing every preference; shared surfaces name their omissions per the v1.92.0 convention; byte-identity holds because `omitted` is absent-when-empty; SDK signatures stay stable behind delegating detail functions.
  - Cons: touches five source files across the shared surfaces; the bundle consistency extension is wider than the validator's narrowest reading; the absent-when-empty discipline needs its own pins.
- **Complexity**: medium
- **Risk**: low

### Variant B2: Verb-layer filtering
- **Approach**: Leave the collectors untouched; filter denied preferences inside `brain export` and `brain bank-export` by re-reading frontmatter at the verb layer, with the knowledge pack left as-is.
- **Trade-offs**:
  - Pros: the core export module and its envelope schema stay untouched; zero byte-identity pressure; the smallest diff for the CLI lane alone.
  - Cons: the SDK façade and `exportBankBundle` call the collectors directly, so those shared surfaces keep shipping marked preferences - the exact failure mode the card names; frontmatter is parsed twice per file; the knowledge pack keeps carrying rows every other lane denies, so surfaces disagree; the deny logic lives where it is hardest to test.
- **Complexity**: small
- **Risk**: high

### Recommended: Variant B1
**Rationale**: The card's value is a privacy class honored by shared surfaces, and B2 leaves the SDK and bundle lanes leaking by construction. B1 computes the deny once at the seam where the data is already in hand and makes every consumer name what it leaves out; its extra breadth is three small, independently testable surfaces.

### Variant C1: New flat verbs with a core classifier module
- **Approach**: `o2b brain dead-letters` (list/show/recover) over a new core `dead-letter-recovery.ts` classifier, with dead-letter schema v2 freezing the payload at failure time and v1 letters classifying as re-extract; `o2b brain validate` as a read-only selection-driven gate (`--paths`/`--dirty`) reusing the write-receipt page-lint pass verbatim behind a tiny git-dirty helper. One lane owns the four CLI wiring files.
- **Trade-offs**:
  - Pros: each surface carries one contract - the recovery verb can implement the consent ladder without negotiating with a pinned behavior; the classifier is core-testable over fixture vaults; validate's exit code is unambiguous; manifest rows make both verbs discoverable through the derived help surfaces for free.
  - Cons: two new verbs and four wiring rows to land; both cards' mechanical edits concentrate in one lane's wiring files.
- **Complexity**: medium
- **Risk**: low

### Variant C2: Overload the existing verbs
- **Approach**: Recovery as a subcommand of `brain repair-lane`; validation as `--paths`/`--dirty` flags on `brain lint`, changing its exit code to block.
- **Trade-offs**:
  - Pros: no new manifest rows or wiring edits; repair-lane is an established destructive-consent surface; lint already runs non-interactively.
  - Cons: repair-lane is memory-graph repair - dead extraction writes are a different domain with a different retention rule; lint's always-exit-0 report contract is pinned by tests and relied on by callers, so repurposing it is a breaking change smuggled into a flag; validate would inherit `--consolidate`'s required-flag grammar it does not use; the recovery verb still needs its own dry-run/apply grammar, so the overload saves nothing.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant C1
**Rationale**: Both cards are new operator surfaces with new contracts; the flat-verb convention plus manifest-derived help make new verbs cheaper than overloads that break lint's pinned exit contract. The wiring-file concentration is real but is exactly what the lane ownership rule absorbs.

### Variant D1: Extensions on the existing surfaces
- **Approach**: Two folder actions on the note-lifecycle verb and MCP tool, backed by a new core module that reuses the relocation primitive and the pair-list rewrite engine; the status `store` group inside the operator snapshot with an injected lock-probe seam; a `client_versions` probe appended to the readiness registry beside `registered_commands`, fail-soft over the install manifest with an async spawn.
- **Trade-offs**:
  - Pros: the file surface's rename/move mistake-guard extends to folders from day one; occupancy pre-flight, partial-failure reporting and the count guard keep their established meanings; the snapshot already resolves the dbPath and additive fields flow to MCP with zero plumbing; the probe inherits the timeout machinery, grading vocabulary and manifest detection; none of it needs the CLI wiring files another lane owns.
  - Cons: the lifecycle module gains the action vocabulary in an already large file (mitigated by putting the core logic in a new module); the snapshot field must be documented as search-lock-scoped; the version command table needs per-adapter verification beyond the two confirmed binary names.
- **Complexity**: medium
- **Risk**: low

### Variant D2: Dedicated new surfaces
- **Approach**: A new `brain folder` verb with its own MCP tool for folder operations; a separate `brain lock-status` verb for store ownership; a standalone `--client-versions` doctor flag outside the probe registry.
- **Trade-offs**:
  - Pros: zero contact with existing modules' shapes; each surface ships independently.
  - Cons: a new folder verb duplicates the envelope, relocation and rewrite machinery note-lifecycle already composes, and a new verb requires exactly the wiring files assigned to the capture-writes lane - structurally non-viable under the ownership rule; a lock-status verb re-composes the snapshot it already builds to answer one question a group can carry; a doctor flag outside the registry drifts from the shared timeout, grading and reporting machinery.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant D1
**Rationale**: All three cards ask for visibility on surfaces operators already use, and D1 is the only variant that respects both the surface economy and the lane contract: extensions carry the established guards, reporting shapes and census discipline with additive fields, while D2 would need another lane's wiring files and would fragment three surfaces that are already composed.
