# Answer trust: verified quotes, claim attribution, source archives, session identity - brainstorm audit trail

Consultant: variant analysis run against the branch point a00fa3f5 (v1.80.0) with the verified-premises brief; the variants below are the consultant output verbatim, mirrored in `cli-output/consultant.md`. Prompt at `cli-output/prompt.md`.

## Variants as returned

### Variant 1: Independent lanes at natural seams
- **Approach**: Each card lands exactly where its verified premises point, with no shared machinery beyond the existing vault layout: A as a new Stop-hook step plus src/core/brain/answer-quotes/check.ts with a per-phase quote_check resolver (off|shadow|enforce, shadow default); B as the optional sample_id field frozen on ClaimEvent plus the read-only claim-provenance.ts join; C as provenance/source-archive.ts wired into the distill intake path; D as explicit no-session semantics in the five reader sites plus the count-only blank-session-identity doctor check. Config stays per-feature in src/core/config.ts, doctor checks register individually in DOCTOR_CHECKS, and each card carries its own census test. The repair lane (property-pushdown freshness gate, CHANGELOG whitespace) rides along independently of all four.
- **Trade-offs**:
  - Matches the house parallel-lane process: disjoint file ownership, each card testable and revertible in isolation.
  - The hot path is touched by exactly one component (the A hook step), bounded and fail-open as the constraints require.
  - No sequencing constraints between lanes, so the PR assembles at merge time with minimal coordination.
  - Wave coherence is editorial, not structural: nothing in the code expresses claim → receipt → note → archived source as one chain.
  - Small risk of duplicated utility logic (hashing, redaction interplay, span normalization) across lanes that a shared home would consolidate.
  - A later cross-card feature, such as quote verification against archived bytes, would need a second pass.
- **Complexity**: small
- **Risk**: low

### Variant 2: Provenance spine (B and C fuse into one chain)
- **Approach**: Make src/core/brain/provenance/ the structural center of the wave: C's source-archive.ts and B's claim-provenance.ts live there under one integrity contract (content-addressed, redacted-before-persist, doctor-verified presence), so the read-time join resolves claim → receipt → note → source_archive_hash as a single chain terminating in durable bytes. A and D keep their prescribed shapes unchanged, with A's hook step still bounded and fail-open, but the doctor family and census tests guard the whole chain invariant instead of per-card fragments. The repair lane still rides along independently.
- **Trade-offs**:
  - The wave spine becomes literal: a claim's provenance can end at content-addressed bytes that survive link rot, the strongest trust story available this wave.
  - One integrity contract and one doctor family avoid scattered, inconsistent verify logic and duplicated hashing/redaction utilities.
  - Seeds future work cleanly: A verifying against archived bytes later is additive, not a redesign.
  - Lanes B and C share the provenance home, breaking strict disjoint file ownership and forcing C's format to land before B's join consumers.
  - Coupling crosses card boundaries: a regression in C's capture marks B's chain incomplete, widening the blast radius of each lane.
  - More up-front design for a chain whose only consumer this wave is doctor/CLI reporting, since OSB never sees answer text.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Unified answer-trust phase ladder
- **Approach**: Compose the wave around one config namespace, answer_trust, with a single per-phase ladder (off|shadow|enforce) governing all cards at once: A's quote checking, C's capture scope (shadow = best-effort capture, enforce = refuse-not-truncate ingest without an archive entry), and B's join surfacing (shadow = doctor/CLI report, enforce = provenance annotations on claim reads). D sits outside the ladder because its decision is semantic and fixed, and the repair lane is unaffected. This trades per-feature resolvers for one operational dial across the whole trust surface.
- **Trade-offs**:
  - One mental model for operators: a single phase readout answers "how much trust machinery is on" without consulting four resolvers.
  - Shadow-by-default propagates consistently, and per-phase switchability is preserved across the wave.
  - Conflates independent failure domains: one mis-set phase silently degrades capture, verification, and join surfacing together, which the per-feature resolver house rule exists to prevent.
  - D does not fit the ladder, so the unified story needs an exception on day one, weakening the abstraction immediately.
  - Gating C's intake behavior on a wave-wide phase entangles the write path with A/B posture changes, and future cards must negotiate the ladder's semantics.
  - Largest config and test surface: the ladder itself needs its own resolver, census coverage, and phase-matrix tests before any card value ships.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: Every card's verified premise already fixes its shape and seam, so Variant 1 is the faithful composition and the only one that preserves strict disjoint lane ownership, per-feature config resolvers, and a hot path touched by exactly one bounded, fail-open component. Variant 2 buys a literal trust chain at the cost of lane coupling and sequencing that the parallel-lane process cannot absorb in this wave, and Variant 3's wave-wide ladder conflates failure domains against the house resolver rule and guarded architecture. Variant 1 also keeps the spine cheap to grow later, since both B's optional sample_id field and C's source_archive_hash stamp are additive, schema-compatible fields that a future provenance home can adopt without rework.

## Orchestrator decision

Variant 1 is accepted. The verified premises already fix each card's shape and seam, so the faithful composition is also the cheapest one, and its strict disjoint lane ownership is exactly what the five-way parallel implementation process requires. The rejected variants fail on process grounds the wave cannot absorb: Variant 2 couples B and C into shared ownership with landing-order constraints, and Variant 3 conflates independent failure domains against the per-feature resolver house rule while needing a day-one exception for D. The coherence Variant 1 defers is cheap to recover later, because B's optional `sample_id` and C's `source_archive_hash` stamp are additive, schema-compatible fields a future provenance home can adopt without rework.
