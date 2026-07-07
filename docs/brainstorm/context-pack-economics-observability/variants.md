# Variants — Context-pack memory-economics & observability

Verbatim consultant output (`claude-opus-4-8`) + final rationale.

## Variant 1 — Five parallel verticals
Approach: Ship each card as a self-contained vertical that mirrors the existing `recall-telemetry.ts` triplet (`emit*` / `list*` / `summarize*`), each with its own new `ContinuityRecordKind`, its own gate (config flag or opt-in option), and its own reader verb. The only cross-module edge is Card 5 importing Card 3's ledger API; everything else is isolated. Card 1 slots a density comparator into the existing within-tier sort exactly as `sessionFocus` already does (byte-identical when the score map is empty).
Trade-offs:
- Maximum independence: each card's default-off branch is trivially and locally provable byte-identical, and each is genuinely PR-shippable alone.
- Reader surface fragments into five new summaries with duplicated list/filter/reverse/limit boilerplate, and no single "prompt-economics" view ties Cards 2/3/4/5 together.
- Two shared files still collide (`context-pack.ts` for Cards 1+3; `continuity/types.ts` for Cards 2+3+5), so drive order still has to serialize them regardless of the isolation.
Complexity: medium
Risk: low

## Variant 2 — Economics ledger spine first
Approach: Build Card 3's durable token-impact + quality ledger first as a unifying substrate — one economics kind-family, one reader framework, one `/outcome`-style calibration endpoint — then hang Cards 2 (route latency), 4 (budget-pressure watermark), and 5 (outcome loop) onto that spine as thin emitters, leaving Card 1 as the sole standalone ordering change. One consolidated economics reader surfaces all four signals.
Trade-offs:
- Cohesive single prompt-economics surface with minimal reader duplication; Card 5 sits on Card 3 with almost no glue, and the "three token signals kept strictly separate" invariant is enforced once in the shared schema.
- Front-loads the largest, highest-schema-risk card and couples the quick p4 wins to it, weakening the "five independently shippable signals" requirement and delaying byte-identical-off verification behind a broad substrate.
- If the shared schema needs to change after Cards 2/4 land on it, every dependent card's persisted records and readers churn together.
Complexity: large
Risk: medium

## Variant 3 — Thin shared kernel, parallel modules, priority-ordered drive
Approach: Add only the reuse that is real — extend `ContinuityRecordKind` with the new kinds in one small commit and introduce one tiny shared list/summarize helper that each card's reader composes — while keeping every card's pure logic in its own module behind its own gate. Drive in priority-and-collision order: Card 2 (isolated in `tools.ts`) → Card 1 (`context-pack.ts` sort comparator) → Card 3 (`context-pack.ts` `finalizeContextPackReport` emit region + ledger) → Card 4 (`active-budget.ts` `SECTION_PRIORITIES` reuse → `doctor.ts`) → Card 5 (on Card 3's ledger).
Trade-offs:
- Balances cohesion and independence: one small helper removes 5× reader boilerplate without coupling card schemas, and each card keeps a locally-provable byte-identical off-branch.
- Drive order resolves both shared-file collisions — Card 1 (sort) and Card 3 (finalize) touch disjoint regions of `context-pack.ts` in sequence, and the three `types.ts` kind additions serialize cleanly.
- The shared reader helper is a modest new abstraction to maintain, and the ordering discipline must be honored on the branch or the two `context-pack.ts` cards rebase-conflict.
Complexity: medium
Risk: low

## Recommended: Variant 3
It honors the release's stated shape — five deterministic, independently-shippable signals that reuse existing machinery — without either fragmenting the reader surface (Variant 1) or over-coupling the cards to a premature spine (Variant 2). The thin kernel captures exactly the reuse the codebase already rewards: `emitGatedTelemetry`'s fail-open no-work-when-off contract, the continuity store's append/list model, and the `sessionFocus` within-tier-boost precedent that makes Card 1's density score byte-identical when disabled. Its priority-ordered drive (p4 quick wins → p3 measurement → p2 capstone) matches the only hard dependency (Card 3 → Card 5) while serializing the `context-pack.ts` and `continuity/types.ts` collisions, so each card lands and ships on its own. The one new abstraction is small and earns its place by eliminating five copies of list/filter/summarize boilerplate.

---

## Final decision: Variant 3

**Agreed with the consultant's recommendation.** Variant 3 is the right fit
because it preserves o2b's two load-bearing invariants that the other variants
strain:

1. **Byte-identity-when-off.** Each card keeps a locally-provable off-branch
   (empty score map for C1, no-op emit for C2/C3/C5, quiet-when-healthy for C4).
   Variant 2's shared spine would force byte-identity verification across a broad
   substrate and couple the quick p4 wins to the largest card's schema risk.
2. **Independently shippable signals.** The release's whole premise is five
   signals that compose existing machinery rather than refactor it. Variant 1
   satisfies independence but fragments the reader surface into five
   near-duplicate triplets — a DRY violation the codebase explicitly avoids
   (`applyCharBudget`, `emitGatedTelemetry` already exist to prevent exactly
   this).

The thin shared kernel (3 new continuity kinds + one list/summarize helper) is
the minimum reuse that is real, and the priority-ordered drive
(C2 → C1 → C3 → C4 → C5) serializes the only two genuine shared-file collisions
(`context-pack.ts` sort-vs-finalize regions; `continuity/types.ts` kind additions)
while honoring the one hard dependency (C3 → C5).

Drive order: **C2 → C1 → C3 → C4 → C5**.
