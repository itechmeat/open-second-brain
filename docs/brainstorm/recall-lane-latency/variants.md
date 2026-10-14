# Recall Lane Latency and Caller Control - brainstorm audit trail

Consultant: internal role-play per operator brief for this wave (no external CLI process spawned; the orchestrator generated the variants itself and records them verbatim below, which is the audit trail this project requires). Prompt that would have been sent: `cli-output/prompt.md`.

## Variants (consultant verbatim)

### Variant 1: Unified Recall Budget Owner
- **Approach**: Treat the wave as one budgeting subsystem change. Build a single recall-budget owner that both the context pack and the recall-inject hook consume, migrate both surfaces onto it in the same release, expose `packing_policy` on the pack tool and the hook config at once, and rebuild the test fixture as a new multi-endpoint fake (embeddings plus rerank plus chat) alongside the concurrency change.
- **Trade-offs**:
  - Pro: one budget model from day one; the packing policy is meaningful on every surface immediately.
  - Pro: the fixture grows once, in its own task, with all routes at the same time.
  - Con: the hook cannot fetch page bodies inside its 2,500 ms retrieval budget, so a unified owner either grows the hook's latency ceiling or silently narrows the policy on the hook path - exactly the silent fallback the standing brief forbids.
  - Con: four features now share one critical path; a regression in the budget owner blocks the whole wave, and the byte-identical guarantee must be argued across two surfaces instead of one.
  - Con: a chat-completions route has no consumer in this tree (no chat flow exists), so the fixture work would ship dead surface.
- **Complexity**: large
- **Risk**: high

### Variant 2: Substrate-First Opt-In Seams
- **Approach**: Land the shared test substrate first (add a `/rerank` route to the existing fake-http default handler and migrate the cross-encoder tests onto it), then ship each recall improvement behind its own existing seam: start-early/join-late lane overlap in `search()` with a lazy keyword-hit supplier and a per-call timing sink for `overlapped_ms` (never on `SearchOutcome`, which the query cache persists whole); a pure lane-allocation primitive in `recall-budget.ts` plus a strictly opt-in `packing_policy` on `brain_context_pack` only, where both candidate populations already meet under one token budget; a read-time provenance join that annotates standing-instruction facets on the attention-flow `standing_query` evaluation, gated by a new `standing_instruction` bench category. Every default path stays byte-identical; anything that cannot be pinned simple is deferred.
- **Trade-offs**:
  - Pro: each card lands on the seam it already owns, so lanes are file-disjoint and independently revertable.
  - Pro: the byte-identical contract is testable per seam with existing pin patterns (`resultShape` for search, the absent-option pins for the pack, the bench baseline for the fixture).
  - Pro: honors the validator corrections - correlate before reordering, join provenance instead of stamping it, extend the fixture instead of rebuilding it.
  - Con: the packing knob does not reach the recall-inject hook in this wave, so its upstream benefit (facts brief vs pages in one call) is only partially realized.
  - Con: `overlapped_ms` does not surface on merged multi-vault MCP payloads, only on `search --explain` and the bench.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Concurrency-and-Facets Only
- **Approach**: Ship the fixture substrate, the lane overlap with its timing accounting, and the standing-instruction facets with the bench gate; drop the packing-policy card to a later wave entirely rather than risk a half-correlated budget.
- **Trade-offs**:
  - Pro: smallest blast radius; the wave is pure latency plus provenance with no budget semantics at all.
  - Pro: no risk of a knob that reads as available but is inert on the surfaces callers actually use.
  - Con: abandons a card whose corrected scope (correlate, then a strictly opt-in pack-only knob) is already small and fully expressible inside the pack's existing single budget.
  - Con: the recall lane gains an overlap metric but no caller control over what the budget buys, leaving the wave's "caller control" half undone.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 2
**Rationale**: It is the only variant that keeps all four cards' value while respecting the two hard project constraints: every omitted option must be byte-identical, and nothing may ship as an inert or silent fallback. Variant 1 fails the hook-latency reality the recon measured (a second retrieval pass cannot fit the hook's 2,500 ms budget) and couples four features into one critical path; Variant 3 leaves a small, well-scoped card undelivered for no technical reason. Variant 2 also matches the operator note exactly: concurrency, facets and the fixture land first, the packing knob stays strictly opt-in and scoped to the one surface where the two lanes already meet, with the hook side explicitly deferred rather than stubbed.

## Orchestrator decision

Variant 2 accepted. Project-context confirmation beyond the consultant's reasoning:

1. The operator note anticipated this exact decision point: "If the packing-knob budget correlation grows during design, land concurrency, facets and the fixture first and keep the knob strictly opt-in or defer that one card." The recon showed the correlation cannot span surfaces (the pack and the hook never run in one call), so the design scopes the knob to `brain_context_pack`, where preference-derived candidates and page candidates already share the single `maxTokens` budget, and defers the hook side instead of stubbing it.
2. The lane-assignment constraint reinforces Variant 2's seam choice: hosting the facet projection on the attention-flow evaluation (not a `ContextPackOptions` field) keeps lane B and lane C file-disjoint, which the four-lane plan requires.
3. Precedents pinned in the recon all point the same way: `queryMode` for opt-in vocabulary and MCP-first parity, `freshenSpawn` for a per-call sink on `SearchOptions`, `raceRerank`/`awaitWithinDeadline` for the join, `detectThreadFacets` for the pure-facet contract, and the bench knob pin for a measured gate.
