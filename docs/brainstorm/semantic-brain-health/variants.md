# Semantic Brain Health & Self-Maintenance - variant audit trail

Consultant: Claude Code CLI (primary). Codex fallback not invoked - the
primary returned three parseable variants with a recommendation.
Raw output preserved at `cli-output/claude.md`; prompt at
`cli-output/prompt.md`.

## Variants (verbatim from the consultant)

### Variant 1: In-place extension of doctor.ts
Add each semantic detector as a new private `check*` helper appended to
`doctor.ts`, reusing the existing record readers / `similarity.ts` and
pushing `DoctorIssue`s onto the same array; reconciliation is a grouping
pass over those issues; edit-history and `remediate()` added beside it.
- Complexity: medium - Risk: medium
- Pro: maximal DRY; matches recent in-place style; fastest path.
- Con: `doctor.ts` (~1088 lines) would approach ~2000, mixing structural
  and semantic concerns; mutation next to a "never mutates" module blurs
  the contract; per-detector gating/testing awkward in one body.

### Variant 2: Semantic-health module layer with a separate remediation engine
`src/core/brain/health/` with one pure detector per concern, a
`reconcile.ts` domain-partitioned aggregator, an append-only
`edit-history.ts` sidecar, and a standalone `remediation.ts`
planner+executor. `doctor.ts` calls the detectors and merges findings,
staying non-mutating; remediation routes auto-safe fixes through the
`preference-txn` chokepoint.
- Complexity: medium - Risk: low
- Pro: clean structural/semantic separation; each detector independently
  skippable, config-gated, unit-testable; mirrors `assess-rule-quality.ts`
  and the pure-core+thin-shell convention; remediation isolation preserves
  the doctor non-mutating contract by construction; reconciliation falls
  out naturally; no sub-agents.
- Con: more files and a shared finding type; slightly more wiring than V1.

### Variant 3: Unified findings-as-data detector/repair registry
Model every detector (existing structural + the six new) as a uniform
`Finding` producer in an ordered registry; `doctor.ts` becomes a thin
runner; remediation and reconciliation are projections over one stream.
- Complexity: large - Risk: high
- Pro: maximally extensible/uniform; dry-run, step-cap, and
  auto-safe/needs-review classification become clean filters.
- Con: requires retrofitting shipped structural `check*` helpers into the
  contract - real regression risk to v0.12 integrity checks for no
  functional gain; registry abstraction heavier than anything in the
  codebase; iteration order must be pinned or determinism breaks.

## Consultant recommendation

**Variant 2.** Matches the pure-core + thin-shell convention and the
`assess-rule-quality.ts` gate pattern, keeps `brain_doctor` non-mutating
by isolating remediation and funneling writes through `preference-txn`,
gives free per-detector gating and a natural single-pass reconciliation,
and avoids the regression risk of V3 and the contract-blur/file-size
problems of V1.

## Orchestrator decision

**Adopt Variant 2 as recommended.** It is the only option that keeps the
doctor's shipped non-mutating invariant intact while adding mutation, and
it reuses the existing chokepoint (`writePreferenceTxn`) so revision bump,
content-hash, and the new edit-history append all stay in one place. No
override needed.

One refinement layered on top of the consultant's sketch: the new
detectors are still **surfaced through `doctor.ts`** (so `o2b brain
doctor` shows semantic findings alongside structural ones, best-effort
per-detector `try` boundaries) rather than living only behind a separate
command - this matches operator expectations and the existing hygiene-lint
wiring. A shared `sign.ts` helper is extracted from `dream.ts` so the
contradiction detector and the dream pass agree on one polarity
definition (DRY), instead of the detector re-deriving sign independently.
