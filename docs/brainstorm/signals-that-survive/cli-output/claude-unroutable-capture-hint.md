### Variant 1: Extend the existing write-advisory seam with a scope-routing hint
- **Approach**: Add a sibling of `adviseIncomingFeedback` in `src/core/brain/write-advisory.ts` that runs on the same operator-facing feedback path (CLI `o2b brain feedback` and MCP `brain_feedback`), after the write has landed. When the effective scope resolves to `undefined` (no `--scope`, no `feedback.default_scope`), it returns a structured `routing_hint` naming the missing signal (`scope`) plus the eligible scope slugs observed in the vault — the distinct `scope` values on confirmed preferences and recent signals, ranked by document frequency. An empty candidate set yields `null` (the absent case, exactly like the conflict advisory), so a fresh personal vault stays silent; the human path prints its forward pointer through `emitNextStep` against one newly registered `DIAGNOSTIC_SIGNALS` code.
- **Trade-offs**:
  - Reuses a proven, tested precedent for "non-blocking, computed around the write, surfaced as a structured field and logged" — the shape the triage note asked for, with no new mechanism.
  - No new configuration key, so the "byte-identical when absent" rule is satisfied by construction: an unscoped write on a vault with no scope corpus behaves exactly as today.
  - Eligible scopes come from vault frontmatter and frequency, not from any word list, so the language-agnostic rule holds.
  - Touches only two call sites that already thread `effectiveScope`; `routeExtractedFacts` is untouched, preserving the existing "advisory never double-fires on the extracted-fact path" invariant.
  - Covers only the feedback surface. Anchor-less extracted facts and note captures remain unhinted, so the "unrouted note" problem is addressed for one write family, not all of them.
  - Inferring eligibility from corpus frequency means the candidate list drifts with vault contents and can surface a scope the operator considers retired.
  - Needs one registered diagnostic code whose `nextCommand` must be a structural string; the honest exit is re-recording with `--scope` or setting `feedback.default_scope`, so the registry entry has to name a real command rather than a paraphrase.
- **Complexity**: small
- **Risk**: low

### Variant 2: Declared scope registry in Brain config
- **Approach**: Widen the existing `feedback:` config block from a single `default_scope` into a declared registry of eligible scopes (each with the slug it routes to), mirroring upstream's "covers-declaring scopes are registered" model. A scope-less write consults the registry and returns a hint naming the missing routing signal and the registered scopes it could have carried; with no registry declared, the hint never fires and the path stays byte-identical. Validation lives in `policy.ts` beside the existing `feedback.default_scope` rules, sharing the same slug constraints.
- **Trade-offs**:
  - Highest fidelity to the upstream feature: eligibility is declared by the operator rather than guessed, so the hint never names a stale or accidental scope.
  - Silent by default on personal installs, which matches upstream behaviour and satisfies the additive-configuration rule cleanly.
  - Gives the vault an explicit routing vocabulary that later surfaces (hygiene, dream, active-pack scoping) could reuse, so the investment is not single-purpose.
  - Requires the operator to configure something before the feature does anything, which is the opposite of the "reduce unrouted notes" goal for the users most likely to have them — the ones who never configured scopes.
  - Adds config schema, validation, template, and documentation surface for a hint, which is a large ratio of mechanism to payoff.
  - Two sources of truth for what a valid scope is (declared registry versus scopes already on disk) invites drift and a new doctor check to reconcile them.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Cross-surface capture-routability seam
- **Approach**: Introduce one routability module that every capture write funnels through, modelling "missing routing signal" as a small closed set of families: a scope-less feedback signal, an extracted fact that resolved no canonical entity anchor, and a captured note with no anchor or scope. Each family declares its missing-signal token and its candidate resolver, each maps to its own registered diagnostic code, and the aggregate is emitted through `emitGatedTelemetry` so unrouted-capture rates become observable alongside the existing route metrics.
- **Trade-offs**:
  - Addresses the actual retrieval-noise problem end to end: anchor-less extracted facts are the larger unrouted population, and they are exactly what Variant 1 leaves out.
  - One model for "unroutable capture" instead of a per-surface advisory, which is the DRY answer if more capture surfaces arrive later.
  - Telemetry makes the effect measurable rather than asserted, matching how this codebase already treats recall and route quality.
  - `routeExtractedFacts` runs per fact inside the capture hot path; adding a candidate-resolution step there risks turning a bounded loop into a per-fact vault read unless results are hoisted, and that path is already carefully budgeted.
  - Breaks the documented invariant that the advisory fires only on the operator-facing feedback path, so the double-fire question has to be re-answered rather than inherited.
  - Largest blast radius across capture, MCP, CLI, and telemetry for a feature whose user-visible output is one hint line; several hundred existing capture tests sit downstream of these seams.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: The transferable half of the upstream feature is the shape — a non-blocking hint that names the missing routing signal — and `write-advisory.ts` already implements that shape on the same path, with the same fail-soft, never-blocks-the-write contract and the same structured-field-plus-log surfacing, so the work is an extension rather than a new mechanism. It needs no new configuration key and no change to the extracted-fact hot path, which keeps the "byte-identical when absent" and capture-performance constraints trivially satisfied, and it resolves its forward pointer through the registered advisory rail as the v1.40.0 convention requires. Variant 2 asks the operator to configure their way into the benefit they lack, and Variant 3 spends a large refactor across the hottest capture seam before the smaller version has demonstrated that the hint changes behaviour.
