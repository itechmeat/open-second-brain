### Variant 1: In-place extension of doctor.ts
- **Approach**: Add each semantic detector as a new private `check*` helper appended to `doctor.ts`, reusing the existing `readAllPreferenceRecords`/`readAllLogRecords`/`similarity.ts` plumbing and pushing `DoctorIssue`s onto the same array. Reconciliation becomes a grouping pass over the issues the new checks emit; the edit-history sidecar and a `remediate()` entry point are added as further exports in (or directly beside) `doctor.ts`.
- **Trade-offs**:
  - Pro: maximal DRY — reuses already-present record readers, similarity, and verdict assembly with zero new wiring.
  - Pro: matches the "in-place-extension-of-pure-modules" style the project just used for v0.12/v0.13.
  - Pro: fastest path; least new surface area to test and document.
  - Con: `doctor.ts` is already 1088 lines and would approach ~2000, mixing structural and semantic concerns in one file.
  - Con: putting mutation (`remediate`) next to a module whose invariant is "never mutates today" blurs the non-mutating contract and invites accidental coupling.
  - Con: per-detector config-gating and independent testing get awkward when everything shares one function body and one issues array.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Semantic-health module layer with a separate remediation engine
- **Approach**: Introduce `src/core/brain/health/` with one pure detector module per concern (`contradiction.ts`, `concept-gap.ts`, `stale-claim.ts`), a `reconcile.ts` aggregator that runs them as partitioned domains (preferences / evidence / retirement) in a single deterministic pass, an append-only `edit-history.ts` sidecar reader/writer, and a standalone `remediation.ts` planner+executor. `doctor.ts` calls the detectors and merges their findings into its `issues`+`trustVerdict`, staying non-mutating; remediation is a distinct opt-in path that routes auto-safe fixes through the `preference-txn` chokepoint.
- **Trade-offs**:
  - Pro: clean separation of structural vs semantic; each detector is independently skippable, config-gated, and unit-testable.
  - Pro: mirrors the existing `assess-rule-quality.ts` pure-gate pattern and the "pure core + thin shell" convention.
  - Pro: remediation isolation preserves the doctor non-mutating contract by construction; mutations funnel through `writePreferenceTxn` (revision bump, content-hash, edit-history hook in one place).
  - Pro: reconciliation as domain-partitioned single pass falls out naturally from per-domain detector modules — no sub-agents.
  - Con: more files and a shared "finding" type that both doctor and the remediation planner consume.
  - Con: slightly more upfront wiring than Variant 1.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Unified findings-as-data detector/repair registry
- **Approach**: Model every detector — existing structural `check*` plus the six new ones — as a uniform `Finding` producer registered in an ordered registry; `doctor.ts` becomes a thin runner that executes registered detectors and collects a single `Finding` stream. Remediation is a separate consumer mapping `Finding.kind` → deterministic repair handlers via a second registry, and reconciliation/verdict become group-by projections over the same stream.
- **Trade-offs**:
  - Pro: maximally extensible and uniform — future detectors, remediation, and reconciliation are all projections over one data contract.
  - Pro: dry-run, step-cap, and auto-safe/needs-review classification become clean filters over the planned `Finding`→repair mapping.
  - Con: requires retrofitting the already-shipped structural `check*` helpers into the `Finding` contract — real regression risk to v0.12 integrity checks for no functional gain.
  - Con: introduces a registry/abstraction layer heavier than anything currently in the codebase (over-engineering for six features).
  - Con: registry iteration order must be explicitly pinned or determinism across peers breaks.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It matches the project's established "pure core modules + thin MCP/CLI shell" convention and directly mirrors the `assess-rule-quality.ts` gate pattern, while keeping `brain_doctor` non-mutating by isolating the remediation engine and funneling every write through the existing `preference-txn` chokepoint. The per-domain detector modules give free independent gating and make the single-pass partitioned reconciliation natural, without the regression risk of retrofitting shipped structural checks (Variant 3) or the file-size and contract-blur problems of cramming mutation into `doctor.ts` (Variant 1).
