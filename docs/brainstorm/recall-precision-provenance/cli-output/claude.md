## Variant 1
Approach: Drive the six cards one at a time as additive, independently-switched modules, ordering only the two pairs that share a file so the second builds on a seam the first already laid: land D2's read-time `Lstart-Lend` pointer primitive before D3's disclosure-depth layering (both touch citation/evidence rendering), and land D4's chain-stop before D5's coverage-retry (both touch `search.ts`/cross-vault). D1 (read-only correlation-join reader) and D7 (expose `minTokens`) are orthogonal and can land in any slot. Each card integrates at a single guarded call site whose default-off branch is bit-identical to today.
Trade-offs:
- Minimal blast radius and easy per-card review/revert; matches the "one PR, many cards, each behind a switch" cadence the git log already follows.
- Ordering is a discipline, not a guarantee — a mis-sequenced D5-before-D4 would force a rebase, and the shared-file pairs still serialize (no parallel authoring of D2/D3 or D4/D5).
Complexity: medium
Risk: low

## Variant 2
Approach: Spend the first commit defining the shared seams before any card logic: a `PointerSpec` citation type consumed by both D2 and D5, a single ordered recall-decision policy hook in `search.ts`/`cross-vault.ts` into which D4 (chain-stop) and D5 (coverage follow-up) register as distinct deterministic policies, and a disclosure-layer contract that D3 implements over the existing store read. Each card then plugs into its seam as an isolated, separately-flagged implementation.
Trade-offs:
- Lowest late-stage merge risk: D4/D5 stop colliding because they share an explicit registration point rather than both editing the same hot path, and D2/D3 share one citation type.
- The seam commit is speculative design ahead of two unwritten cards; if D5's targeted-requery shape diverges from the guessed policy interface, the abstraction churns — and an over-built hook risks accidentally altering the off-path, threatening the bit-identical guarantee.
Complexity: large
Risk: medium

## Variant 3
Approach: Refactor `search.ts`, `cross-vault.ts`, and `evidence-pack.ts` into one unified recall pipeline that natively expresses layered disclosure (D3), normalized-confidence chain-stop (D4), coverage-driven follow-up (D5), and line-anchored pointers (D2/D5), with per-vault config knobs (D7) and the provenance reader (D1) reading the pipeline's emitted traces.
Trade-offs:
- Most cohesive end state — one place to reason about precision, coverage, and disclosure together, with no duplicated guard logic across cards.
- Largest blast radius on the most-tested hot paths; breaks the one-at-a-time shared-branch discipline (every card now depends on the refactor landing first), and a single pipeline makes "default-off ⇒ ranking bit-identical" far harder to prove per-card, directly stressing the core convention.
Complexity: large
Risk: high

## Recommended: Variant 1
Variant 1 is the only option that natively honors o2b's load-bearing conventions. Each card stays a self-contained module behind its own explicit switch whose off-branch is provably bit-identical — the precondition the repo demands for any ranking/cost change (D4, D5) and the easiest property to verify when integration is one guarded call site rather than a shared pipeline (Variant 3) or a pre-committed policy interface (Variant 2). It preserves the demonstrated release pattern (themed multi-card suite, driven sequentially, landing as one PR) and keeps the kernel LLM-free: D4's stop and D5's trigger remain deterministic guards at their own sites. Non-conflict on the shared branch is achieved by the cheapest sufficient mechanism — ordering the only two real collision pairs (D2→D3 on citation rendering; D4→D5 on `search.ts`) so the later card extends an already-merged seam, while D1 and D7 stay fully orthogonal. D2 stays read-time-only (pure pointer slicing, deterministic across Syncthing peers), D3 reuses the existing store read instead of a new index, D5 reuses `coverage.uncoveredRareTerms` + existing expansion capped at one pass, and D7 narrows to exposing `minTokens` without perturbing chunk hashes. Telemetry on every card routes through `emitGatedTelemetry` and stays fail-open. Borrow exactly one idea from Variant 2 — a shared `Lstart-Lend` pointer type used by both D2 and D5 — but introduce it inside the D2 card rather than as a speculative up-front seam, so no abstraction is committed ahead of the card that proves its shape.
