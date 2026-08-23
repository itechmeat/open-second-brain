# Nothing writes silently - variants audit trail

Consultant: Claude Code (`claude -p`), prompt at `cli-output/prompt.md`, raw output at `cli-output/claude.md`. Three variants returned; the consultant recommended Variant 2.

## Variant 1: Eight local truths (consultant)

Each unit lands its own local mechanism, no shared abstractions; unit H form B; dead-letter resolves to in-response accounting only. Complexity small, risk low. Consultant's own cons: three near-identical claimed/found/missing shapes drift into dialects; a failed lane write that exists only in a dropped response is itself a silent loss - undercutting the wave's theme.

## Variant 2: Shared reconciliation vocabulary (consultant, recommended)

One pure reconciliation report module consumed by E's write accounting, F's read-back census, and G's third state, pinned by the verdict-vocabulary census; H form B with its enumeration built on the same census machinery C's boundary assertion uses; durable dead-letter with its STATE_SURFACES row; sequencing substrate-first, then A->G sequential, the rest parallel. Complexity medium, risk medium. Cons: the shared module is a coordination point that costs wall-clock before parallel work starts; H form B defers real enforcement.

## Variant 3: Boundary-enforcing wave (consultant)

H takes form A (isRemotelyReadable at walker/search/indexer chokepoints, transport-keyed bypass), generalized entry-point context serving both C's stamp and H's bypass; strict sequencing with the indexer change last. Complexity large, risk high. Cons the consultant named: the indexRevision move forces a full reindex in the same release that ships the new index-health signals, muddying them; the three-chokepoint change plus full surface census is wave-sized by itself and dominates review.

## Decision

**Variant 2 accepted**, with two orchestrator amendments:

1. **Unit H card disposition.** Form B ships the truth (census + finding), not the card's ask (enforcement). The tracker card therefore does not close as done at release: it gets the redesign verdict recorded (form A spec; the census as its coverage map) and stays parked for a dedicated enforcement wave. Closing it on a doctor warning would be the misleading no-op this wave exists to remove.
2. **Dead-letter boundary.** Durable dead-letter only for lanes committing multiple artifacts from one validated payload (rollup fold, extract-signals batch); single-artifact lanes keep in-response accounting, because their single failure IS the response. This bounds the new STATE_SURFACES row to where a dropped response could actually hide a partial write, keeping Variant 2's honesty without Variant 3's blast radius.

Rationale for agreeing with the consultant: the wave's theme applied to its own machinery - one census-pinned vocabulary instead of three drifting dialects, and a durable record for exactly the failures a response cannot be trusted to carry. Variant 3's destination (real per-page enforcement) is right but belongs to its own wave; its cost lands on the same index surfaces units A and G are instrumenting, and the census Variant 2 ships is the coverage map that future wave starts from.
