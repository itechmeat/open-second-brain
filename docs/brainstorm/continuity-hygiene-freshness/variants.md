# Continuity, Hygiene & Freshness Suite - variants audit trail

Primary consultant: Claude Code (`claude -p`), 2026-06-10. Raw output: `cli-output/claude.md`. Fallback consultant not invoked (primary returned 3 parseable variants).

## Variant 1: Extend-in-place (substrate growth, no new kernels)

- **Approach**: Every feature lands as an extension of the module that already owns the nearest behavior. A1's lineage fields go onto `HookPayloadBase` with the crutch as one file under `hooks/lib/`; A2 extends `session-recall.ts` and capture with optional lineage fields on existing continuity records (additive, no schema bump); A3 grows `applyCharBudget` into a ladder inside `recall-budget.ts`; A4 is one small cache module on existing hook events. Cluster B becomes a single `src/core/brain/hygiene/` domain module that directly calls `reconcile-outcomes.ts`, recall-telemetry readers, the search embeddings registry (B2), and `sourceRefs.hash` comparisons (B4), with B5 as an apply action inside it.
- **Trade-offs**:
  - Pro: smallest diff surface; no new abstractions to design or test; follows the existing pattern of pure helpers plus domain modules established in the v1.2.0 decomposition.
  - Pro: A3 stays a drop-in upgrade for both `context-pack.ts` and `pre-compress-pack.ts` since both already call the same budget primitive.
  - Con: the hygiene module accretes four unrelated detection concerns (contradiction, usefulness, dedup, freshness) behind one wall; B5's recompile logic entangles hygiene with the import and indexer pipelines.
  - Con: lineage resolution logic gets duplicated across capture, recall, and the A4 cache unless extracted later anyway; the CRUTCH boundary risks leaking into `session-recall.ts`.
  - Con: B2's embeddings fallback and B3's resolver bridge each reinvent plumbing (`bench/judge.ts` gets copied rather than shared).
- **Complexity**: medium
- **Risk**: medium

## Variant 2: Two shared kernels (lineage resolver plus findings pipeline)

- **Approach**: Introduce exactly two new substrates. First, a `lineage` module (`src/core/brain/lineage/`) exposing `resolveLineage(payload) -> {rootId, parentId, depth}` with the native path reading the extended `HookPayloadBase` and the interim Hermes crutch isolated in one file marked `CRUTCH(t_1459706f)`; capture (A2), recall and session-read tools (A2), and the anticipatory cache key (A4) all consume it, while A3 stays an independent upgrade of `recall-budget.ts`. Second, a `hygiene` module built around a small detector contract: each detector (`dedup` B2, `freshness` B4, `conflicts` B3 wrapping `reconcile-outcomes.ts`, `usefulness` from recall-telemetry) is a pure function returning typed `Finding[]`; `scan` fans out over detectors, `apply` executes a typed remediation plan, B5 is the freshness-findings executor that calls into existing import/indexer entry points, and B3's resolver reuses a shared external-command bridge extracted from `bench/judge.ts`.
- **Trade-offs**:
  - Pro: the crutch isolation constraint is satisfied by construction, and lineage semantics live in one place for all three consumers instead of three copies.
  - Pro: the detector contract matches B1's actual job description (integrate heterogeneous signals into one digest) and makes scan-versus-apply, dry-run, and the audit trail uniform across B2 through B5.
  - Pro: extracting the judge bridge gives B3 the fail-open external-LLM pattern without duplicating spawn/timeout/JSON plumbing, keeping the deterministic-core rule auditable in one file.
  - Con: two new abstractions designed up front; the detector interface could be over-fitted if a future detector needs streaming or cross-detector state.
  - Con: more files and more parity-list churn (new MCP tools and CLI verbs for hygiene, lineage-aware session tools, cache commands) in one release.
- **Complexity**: medium-large (closest single label: large)
- **Risk**: low

## Variant 3: Feature-siloed modules composed at the surface

- **Approach**: Each of the nine features ships as its own self-contained module with its own CLI verbs and MCP tools: `lineage/`, `session-stitch/`, `budget-ladder/`, `context-cache/`, `hygiene-scan/`, `dedup/`, `conflict-resolve/`, `freshness/`, `recompile/`. There is no shared detector contract; B1's scan composes by calling the public functions of the sibling modules and concatenating their reports, and B5 calls B4's public freshness API directly. Sharing happens only through already-existing primitives (continuity store, search index, `applyCharBudget`).
- **Trade-offs**:
  - Pro: maximally parallelizable development (nine kanban tasks map one-to-one to modules); each module is small, independently testable, and independently revertable if a feature slips the release.
  - Pro: no speculative abstractions; seams follow the kanban decomposition exactly.
  - Con: B1 degrades from an integration surface into a report concatenator; consolidate/forget/archive remediation and the audit trail get reimplemented per detector, or apply-mode ends up inconsistent across dedup, freshness, and conflicts.
  - Con: lineage resolution is still needed by three modules, so either `session-stitch/` and `context-cache/` both depend on `lineage/` (recreating Variant 2's kernel informally) or they duplicate it.
  - Con: nine new tool surfaces inflate the frozen 54-tool parity list and the 76-verb CLI more than the features warrant, contradicting the recent consolidation direction of the v1.2.0 refactor.
- **Complexity**: large
- **Risk**: medium

## Consultant recommendation

Variant 2. "The task's own structure already names the two real seams: A1/A2/A4 share lineage resolution (and the crutch must be isolated in one module regardless, so the kernel costs almost nothing extra), and B1 is explicitly the umbrella through which B2/B3/B4 findings surface, which is precisely a detector-and-plan pipeline. Variant 1 saves little while smearing the crutch and the remediation audit trail across existing modules, and Variant 3 rediscovers both kernels informally while bloating the frozen tool surface. Variant 2 also aligns with the project's current trajectory (v1.2.0 SOLID/DRY domain modules, pure deterministic detectors, the `bench_judge_cmd` fail-open bridge as the sanctioned LLM boundary) and keeps every constraint - no daemon, deterministic core, additive surfaces - enforceable at module boundaries rather than by convention."

## Orchestrator decision

Variant 2, accepted without override. Project context confirms the consultant's reasoning on every point that matters here: the crutch-isolation requirement comes from kanban t_1459706f and is satisfied structurally; the +2 MCP tool delta (`brain_hygiene`, `brain_anticipatory_context`) is the smallest surface among the variants that still ships all nine features; and the detector contract directly reuses the deterministic substrates that already exist (reconcile-outcomes, recall-telemetry, embeddings registry, sourceRefs hashes) instead of wrapping them per-feature.
