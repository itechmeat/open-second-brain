# Cycle 20261026 (verified-delivery-honest-writes) - lane variants (consultant output) and final rationale

The consultant ran in host execution mode against the wave's recon reports. Two real variants per lane, with the recommendation and the orchestrator decision. Variant content is grounded in the recons' alternatives and open questions; the design decisions in `design.md` encode the winners.

## Lane A - delivery (`t_cb6a5558`, `t_f8510c55`)

### Variant A1: in-walker trim with comparator score reuse; presence as a sibling continuity record
- **Approach**: The trim runs after the unified walker in `packContext`, reusing the ranked-mode jaccard kernel (`relevanceById`) the comparator already computes; top-3 keep, restatement keep-rule, whole-item drops with a new `"tail-trim"` skip reason, and freed budget offered back to `over-budget` candidates in priority order. Reply presence is folded by the existing answer-quote-check Stop loop into a sibling `reply_presence` continuity record joined to the receipt by `session_id`, with `ANSWER_QUOTE_VERDICT` extended by `absent` and the `session_inject` receipt gaining its missing session key.
- **Trade-offs**:
  - Pros: zero duplicate scoring work; the off-path stays byte-identical by construction; the context receipt is automatically correct because finalize maps `report.items`; rescue (the card's load-bearing behavior) is expressible because skipped candidates are still in hand; one verdict vocabulary and an append-only record respect the store's contract; the join key is fixed at the source instead of inferred from time windows.
  - Cons: the trim covers the unified path only until someone extends it to the `packingPolicy` branch (explicitly out of v1); a new continuity kind obligates the fold-decision row and a documented join contract; presence rows grow the ledger per checked turn.
- **Complexity**: medium
- **Risk**: low

### Variant A2: post-finalize delivery stage; presence via the existing log channel
- **Approach**: Apply the trim as a stage inside `finalizeContextPackReport` operating on `report.items`, uniformly across the unified and packing-policy return paths. Carry reply presence only through the channels the Stop hook already writes - the `additionalContext` annotation and the enforce-mode Brain-log `note` event - with no new continuity kind.
- **Trade-offs**:
  - Pros: one trim site covering both return paths; no new record kind, no fold decision, no join contract; the ledger stays quieter.
  - Cons: rescue is impossible at that point - `skipped` candidates are already resolved and their budget accounting closed, so the card's term-aware rescue cannot exist; in substring or semantic modes scores must be recomputed at finalize, duplicating comparator work; Brain-log events are local, unsynced and unread by the receipt surface, so presence would be unwritable into `brain_context_receipts` - the read surface the card's consumers use; the enforce log only exists under `enforce`, so shadow-mode operators get nothing.
- **Complexity**: medium
- **Risk**: high (the receipt read surface - the actual deliverable - cannot be served)

### Recommended: Variant A1
**Rationale**: The rescue rule and the receipt join are the two behaviors the cards name as their value, and only A1 can express either: rescue needs the walker's live skip list, and presence needs a store the receipt read surface can join against. A1 also reuses both verified seams (jaccard kernel, Stop-hook check loop) with no duplicated computation, and its costs - one record kind plus one verdict member - are census-silent or single-row decisions.

## Lane B - export privacy (`t_b88c2190`)

### Variant B1: collector-level denial with named omissions everywhere
- **Approach**: Compute the denial once in `collectPreferenceRows` from the frontmatter map the collector already parsed, as a report beside complete `rows`; teach the json envelope (`omitted`, absent when empty), the llms-txt detailed variant, the bank bundle and the knowledge pack to drop denied rows and name each omission with reason `"visibility"`.
- **Trade-offs**:
  - Pros: one deny judgment reused by every consumer; `rows` stays complete so the import-side topic maps keep seeing every preference; every shared surface names its omissions, so no two exporters disagree about the same directory; byte-identity holds because `omitted` is absent-when-empty; the SDK signatures stay stable behind delegating detail functions.
  - Cons: touches five source files across the shared surfaces; the bundle consistency extension is wider than the validator's narrowest reading of the card; a new envelope field requires the absent-when-empty discipline to be tested, not assumed.
- **Complexity**: medium
- **Risk**: low

### Variant B2: verb-layer filtering
- **Approach**: Leave the collectors untouched; filter denied preferences inside `brain export` and `brain bank-export` by re-reading frontmatter at the verb layer, with the knowledge pack left as-is.
- **Trade-offs**:
  - Pros: the core export module and its envelope schema are untouched; zero byte-identity pressure; the smallest possible diff for the CLI lane alone.
  - Cons: the SDK façade and `exportBankBundle` call the collectors directly, so those shared surfaces keep leaking marked preferences - the exact failure mode the card names; frontmatter is parsed twice per file; the knowledge pack keeps shipping preferences that every other lane denies, so surfaces disagree; the deny logic lives where it is hardest to test exhaustively.
- **Complexity**: small
- **Risk**: high (shared surfaces remain inconsistent - the defect survives)

### Recommended: Variant B1
**Rationale**: The card's value is a privacy class honored by shared surfaces, and B2 leaves the SDK and bundle lanes leaking by construction. B1 computes the deny once at the seam where the data is already in hand and makes every consumer name what it leaves out, matching the v1.92.0 name-every-omission convention; its extra breadth is three small, independently testable surfaces.

## Lane C - capture writes (`t_50794f57`, `t_dc782fd5`)

### Variant C1: new flat verbs with a core classifier module
- **Approach**: `o2b brain dead-letters` (list/show/recover) over a new `dead-letter-recovery.ts` classifier, dead-letter schema v2 freezing the payload at failure time; `o2b brain validate` as a read-only selection-driven gate reusing `lintPagesWithContext` verbatim; a tiny `vault-dirty.ts` helper for the git-dirty selection. Lane C owns all four wiring files.
- **Trade-offs**:
  - Pros: each surface has one contract - the recovery verb can carry the consent ladder (dry-run default, headless `--yes`) without negotiating with an existing verb's pinned behavior; the classifier is core-testable over fixture vaults independent of CLI wiring; `validate`'s exit code is unambiguous; the manifest rows make both verbs discoverable through help and completions for free.
  - Cons: two new verbs and four manifest/help rows to land; the wiring files concentrate both cards' mechanical edits in one lane (the reason for the exclusive ownership rule).
- **Complexity**: medium
- **Risk**: low

### Variant C2: overload the existing verbs
- **Approach**: Recovery as a subcommand of `brain repair-lane` (which is already a repair surface); validation as `--paths`/`--dirty` flags on `brain lint`, changing its exit code to block.
- **Trade-offs**:
  - Pros: no new manifest rows or wiring edits; the repair verb is an established destructive-consent surface; `lint` already runs non-interactively.
  - Cons: `repair-lane` is memory-graph repair - dead extraction writes are a different domain with a different retention rule, and folding them in muddies both; `brain lint`'s always-exit-0 report contract is pinned by tests and relied on by callers, so repurposing it is a breaking surface change smuggled into a flag; the validate gate would inherit `--consolidate`'s required-flag grammar it does not use; the recovery verb would still need its own dry-run/apply grammar, so the overload saves nothing real.
- **Complexity**: medium
- **Risk**: high (breaks a pinned contract and conflates two domains)

### Recommended: Variant C1
**Rationale**: Both cards are new operator surfaces with new contracts, and the repo's flat-verb convention plus the free manifest-derived help make new verbs cheaper than overloads that break `lint`'s pinned exit contract. The wiring-file concentration is real but is exactly what the lane ownership rule absorbs; the classifier and helper stay core modules testable without the CLI.

## Lane D - operator surfaces (`t_9571a47f`, `t_cfe2ce5d`, `t_8e49ec96`)

### Variant D1: extensions on the existing surfaces
- **Approach**: Two folder actions on the note-lifecycle verb and MCP tool, backed by a new core `folder-lifecycle.ts` that reuses the relocation primitive and the `retargetWikilinks` pair engine; the status `store` group inside the operator snapshot with an injected lock-probe seam; a `client_versions` probe appended to the readiness registry beside `registered_commands`.
- **Trade-offs**:
  - Pros: the file surface's rename/move mistake-guard extends to folders from day one; occupancy pre-flight, partial-failure reporting and the count guard keep their established meanings; the snapshot already resolves the dbPath and `brain_status` flows additive fields to MCP with zero plumbing; the probe inherits the timeout machinery, grading vocabulary and manifest detection; none of it touches the wiring files Lane C owns.
  - Cons: `lifecycle.ts` gains the action vocabulary in a file that is already large (the reason the core logic goes to a new module); the snapshot field must be documented as search-lock-scoped so it is not read as covering the brain `.lock` family; the version command table needs per-adapter verification beyond the two confirmed binary names.
- **Complexity**: medium
- **Risk**: low

### Variant D2: dedicated new surfaces
- **Approach**: A new `brain folder` verb with its own MCP tool for folder operations; a separate `brain lock-status` verb for store ownership; a standalone `--client-versions` doctor flag instead of a registry probe.
- **Trade-offs**:
  - Pros: zero contact with existing modules' shapes; each surface ships independently.
  - Cons: a new folder verb duplicates the envelope, relocation and rewrite machinery that `note-lifecycle` already composes, and a new verb requires exactly the wiring files the cross-lane contract assigns to Lane C - the variant is structurally non-viable under the ownership rule; a lock-status verb re-composes the snapshot it already builds (doctor, semantic health, hygiene) to answer one question the snapshot can carry as a group; a doctor flag outside the probe registry drifts from the timeout, grading and reporting machinery the other probes share.
- **Complexity**: large
- **Risk**: high (ownership violation plus surface fragmentation)

### Recommended: Variant D1
**Rationale**: All three cards ask for visibility on surfaces operators already use, and D1 is the only variant that respects both the product's surface economy and the lane contract: extensions carry the established guards, reporting shapes and census discipline with additive fields, while D2 would need Lane C's wiring files and would fragment three surfaces that are already composed.

## Orchestrator acceptance note

The orchestrator accepts the consultant's recommendations for all four lanes: A1, B1, C1, D1. The decision rule across the wave was to reuse the seam each recon verified rather than build a parallel surface, and to make every new fact land in an existing reporting contract (skip reasons and gap telemetry, `omitted`/`blocked` omission naming, readiness rows, snapshot groups, continuity record kinds) instead of a second vocabulary. The losing variants were rejected for cause, not taste: A2 cannot serve the receipt read surface the card exists for, B2 leaves two shared surfaces leaking the exact content the card denies, C2 breaks a pinned exit contract, and D2 violates the lane ownership contract while duplicating composed machinery. No variant overrides the consultant's recommendation; the honest-scope notes in `design.md` (lock owner reported as null, signal-lane re-admission at current state with schema v2) are recon-mandated narrowing, not variant substitutions.
