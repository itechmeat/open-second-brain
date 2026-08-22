### Variant A: Deterministic islands (kernel-lean)

- **Approach**: Build no new shared infrastructure; every unit takes its most deterministic, most descoped option and plugs into existing seams as-is. Unit 1 uses the deterministic scorer (salience mass + Wilson confidence + reuse rates) feeding the rollup fold set; unit 4 emits an honest-template SKILL.md staged inside Brain/skill-proposals/pending/; unit 8 is a standalone diarization-shaped verb with a dedicated cardinality checker beside response-shape.ts (research.ts precedent); unit 2 is the wave's only new envelope, cloned from the diarization shape; unit 5 is deferred with a recorded decision honoring the retrieval-ranking design's no-ML-runtime ruling; units 6 and 7 ship the sentinel-region verdict stamp and containment-only diagram. The only shared piece is a small evidence-scoring module reused by units 1 and 4.
- **Trade-offs**:
  - Pro: smallest blast radius; each of the eight units is independently landable and testable, ideal for one PR of atomic TDD units.
  - Pro: kernel stays strictly model-free on the two units where an LLM lane was optional (1, 4); no verdict ledger, no second round trip.
  - Con: the envelope count grows from three shapes to four-plus while the named DRY paydown is skipped — the debt compounds exactly when it was cheapest to pay.
  - Con: template-body skill drafts and score-only salience gating cap output quality; a later upgrade to model-authored variants re-opens every one of these files.
- **Complexity**: small
- **Risk**: low

### Variant B: Shared envelope spine, additive adoption

- **Approach**: First deliverable of the wave is a named `NeedsLlmStep` envelope core plus a sidecar semantic-checker registry hung beside response-shape.ts (keeping ShapeDescriptors deliberately shallow), and an idempotency-ledger-keyed verdict-ledger helper generalized from rollup discipline. Adoption is additive: the three legacy shapes are re-declared as aliases of the shared type without rewriting write-session, while all new model lanes plug in directly — unit 2's auto-capture envelope, unit 8's design-note envelope with an "exactly one Recommended" sidecar checker, unit 1's optional LLM retriage (deterministic scorer ships as default, LLM triage behind the verdict ledger), and unit 4's envelope-drafted SKILL.md body staged through the existing proposal accept path. Units 3, 6, 7 proceed deterministically as in Variant A; unit 5 ships only the EmbeddingIdentity seam and exhaustive-switch registration point, no runtime.
- **Trade-offs**:
  - Pro: pays the named DRY debt at the exact moment the wave would otherwise double the envelope population from three to six divergent shapes.
  - Pro: one home for model-payload validation semantics — unit 2's new ShapeDescriptor and unit 8's cardinality checker land in the same registry with the same fail-loud refusal vocabulary.
  - Pro: additive aliasing avoids touching durable write-session state, so the riskiest legacy surface is read, not rewritten.
  - Con: sequencing dependency — four units block on the spine landing first, weakening unit independence inside the single PR.
  - Con: the spine must be designed against three existing shapes plus three new consumers at once; a wrong generalization is expensive to unwind after this release.
- **Complexity**: medium
- **Risk**: medium

### Variant C: Speculative-artifact pipeline first

- **Approach**: The shared abstraction is the human-approval staging lifecycle, not the envelope: generalize the pending.ts / skill-proposals machinery into a "speculative artifact" surface (source-typed inbox entry, evidence floor, WAL-protected accept, destructive-ladder-guarded reject) that unit 2's auto-extracted signals, unit 4's staged SKILL.md drafts, and unit 1's `retriage` verdicts all flow through. Units 6 and 7 share a sentinel-region writer in architect generate.ts that preserves byte-identity outside stamped regions; unit 8 stays a standalone diarization-shaped verb; unit 3 rides the existing destructive ladder; unit 5 is deferred. Envelopes stay per-unit copies of the diarization shape.
- **Trade-offs**:
  - Pro: institutionalizes the house rule that precision beats recall — every model-authored durable write in the wave passes one uniform human gate, with one STATE_SURFACES story.
  - Pro: gives unit 4 its cleanest answer to "skills_dir may be outside the vault": staging lives in the generalized pipeline, materialization on accept is the only out-of-vault write.
  - Con: skill-proposals.ts is 51KB of working, WAL-protected code; extracting a generic lifecycle from it is the largest and most regression-prone refactor available in this wave.
  - Con: leaves the envelope DRY debt untouched while adding two more divergent shapes, so the next wave inherits both problems.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant B
**Rationale**: This wave adds model lanes whether or not anything is shared — units 2 and 8 are envelopes by specification — so Variant A's savings are illusory: it ships the new shapes anyway and merely declines the consolidation the conventions already name as a paydown target. Variant B captures that paydown with additive aliasing rather than a write-session rewrite, keeping risk bounded, and its sidecar-checker registry resolves unit 8's cardinality problem and unit 2's shape validation in one fail-loud mechanism instead of two ad-hoc ones. Variant C's refactor of the 51KB proposal machinery is the wrong risk for a single-PR, eight-unit release, and its benefits (uniform staging) are largely obtainable later on top of B's spine.
