# Memory subsystem alignment — variants

## Consultant variants

## Variant 1: Shared budget-aware write engine
Approach: Introduce one deterministic core module (e.g. `src/core/brain/memory-write/`) that owns budget accounting and atomic application, exposing a budget probe that returns an explicit outcome (`ok` | `budget_exceeded` with original/stored byte counts) and a batch applicator that validates every op against the *final* projected budget before any write. `pinned.ts` and the continuity store both consume it, and the `on_memory_write` handler is a thin adapter that maps the verified host payload into a batch and calls the same engine. The three cards become three consumers of one source of truth for truncation, atomicity, and idempotent/terminal success markers.
Trade-offs:
- Single place to enforce "no silent truncation" and "all-or-nothing" — strongest DRY and the least chance of divergent semantics between pinned_context, continuity, and the bridge.
- Highest upfront abstraction; must prove byte-identical output when the operations array / truncation fields are absent, across two existing call sites plus the new one.
- The bridge inherits atomicity for free, matching the card note that batch is "the natural substrate" for it.
Complexity: medium
Risk: medium

## Variant 2: Per-surface incremental extension
Approach: Treat each card as an independent, local change. Add an explicit truncation/rejection signal inside `pinned.ts`; add an `operations` array branch in `context-tools.ts` and a separate batch-append under one lock in the continuity store; implement `on_memory_write` as its own handler that calls the existing single-op writers in sequence. No shared primitive is introduced.
Trade-offs:
- Smallest, most reviewable diffs per card; each can land and be tested in isolation with minimal blast radius.
- Budget and atomicity logic is duplicated across pinned_context and continuity, and the bridge re-implements batch semantics — a DRY violation and a real hazard for the "no misleading partial-write fallback" constraint if one copy drifts.
- Sequencing benefit from the cards (batch as substrate for the bridge) is lost; the bridge becomes the weakest link semantically.
Complexity: small
Risk: medium

## Variant 3: Contract-driven, bridge-first
Approach: Anchor the whole design to the verified Hermes `on_memory_write` contract (PRs #48507/#48262): derive the canonical batch operations schema from the host's payload shape first, build the atomic batch applicator to match it exactly, and make both the MCP `pinned_context` tool and the bridge consumers of that one host-aligned schema. Budget honesty is realized as the rejection arm of the batch applicator (an over-budget or malformed op aborts the batch).
Trade-offs:
- Tightest alignment with the live host contract and the strategic card; the no-op-when-host-silent path and batch forwarding fall out naturally.
- Depends on an external contract that may shift, and risks over-fitting the internal pinned_context tool to a host-shaped schema it does not otherwise need.
- Front-loads the contract-verification work (required for card 3 regardless), which can stall the two lower-risk cards behind it.
Complexity: medium
Risk: high

## Recommended: Variant 1
Rationale: The release theme is *alignment*, and a single budget-aware write engine is the only option that makes "no silent truncation" and "all-or-nothing batch" one enforced invariant rather than three hand-copied ones, satisfying DRY and the no-misleading-fallback brief simultaneously. It naturally honors the cards' stated sequence — budget signal, then atomic batch, then bridge as a thin adapter over that substrate — and keeps the deterministic, provider-agnostic kernel intact. Fold in Variant 3's discipline by verifying the exact Hermes contract before wiring the bridge layer, so the strategic card rests on a confirmed payload shape rather than a guessed one.

## Final decision rationale

Final choice: Variant 1 — Shared budget-aware write engine.

The consultant returned three parseable variants and recommended Variant 1. I agree with that recommendation because this release is explicitly about aligning memory behavior across pinned context, batch writes, and the Hermes provider bridge. A shared deterministic write substrate best satisfies DRY, prevents divergent budget/atomicity semantics, and lets the bridge remain an adapter over verified host payloads rather than a parallel implementation.
