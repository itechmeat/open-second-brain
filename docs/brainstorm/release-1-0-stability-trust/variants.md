# Release 1.0.0 - Stability & Trust - variant audit trail

Consultant: Claude Code (`claude -p`), single pass, 2026-06-05. Full
verbatim output in `cli-output/claude.md`; prompt in
`cli-output/prompt.md`.

## Variant 1: Independent vertical slices (consultant verbatim)

- **Approach**: Each of the five units lands as a self-contained module with its own atomic commit, sharing only small existing primitives (`atomicWriteFileSync`, the `o2b.metrics.v1` writer, `time.ts`). The safeguard is a thin wrapper invoked at each long-running call site; the staged dream pipeline adds an output mode to existing `dream()` rather than a new engine; Unit 5's snapshot-diff and Unit 4's timezone formatter are local utilities threaded through their own render/persist sites. No new cross-unit abstraction is extracted.
- **Trade-offs**:
  - Pro: Cleanest fit for TDD with per-unit atomic commits; each unit independently reviewable and revertible.
  - Pro: Smallest blast radius - byte-compatibility of untouched surfaces is trivially preserved.
  - Pro: No risk of forking promotion logic, since dream stays the single engine with an added serialization mode.
  - Con: Units 3 and 5 both implement persisted-artifact + diff mechanics; mild duplication of "manifest, generated_at frontmatter, diff-against-prior" logic.
  - Con: Timezone presentation (Unit 4) and snapshot rendering (Unit 5) touch overlapping render sites twice instead of once.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Shared artifact-and-presentation substrate (consultant verbatim)

- **Approach**: Extract two reusable layers up front - a "persisted bundle + structured snapshot + deterministic diff" core that both the staged dream pipeline (Unit 3) and dual-output reports (Unit 5) build on, and a presentation module where the timezone formatter (Unit 4) and report rendering (Unit 5) share one timestamp/projection path. The safeguard (Unit 2) becomes shared middleware wrapping registered long-running operations. Unit 1's freeze documents these new shared contracts.
- **Trade-offs**:
  - Pro: Eliminates duplication across the genuinely overlapping units (3/5 artifacts, 4/5 rendering).
  - Pro: One diff engine and one presentation contract are easier to test exhaustively and to freeze coherently for 1.0.
  - Con: Higher coupling; per-unit atomic commits become interdependent (substrate must land before its consumers), straining the TDD-per-unit convention.
  - Con: Larger blast radius across render sites raises the chance of an accidental byte-compat regression in a frozen surface.
  - Con: Pressure to over-generalize the bundle abstraction risks the "don't fork the promotion engine" constraint if dream staging drifts toward the shared layer.
- **Complexity**: large
- **Risk**: medium

## Variant 3: Contract-registry spine (consultant verbatim)

- **Approach**: Make Unit 1 the architectural spine - build a machine-readable freeze manifest (tool surface, schema versions, config keys/env vars, on-disk formats) that the `doctor` probe reads to flag removed/relied-on surfaces. Units 2-5 then declare their new surfaces (safeguard timeout keys, bundle schema, snapshot schema, timezone config key) into that same registry, so "what is frozen" has one source of truth and the doctor check is data-driven rather than hand-maintained.
- **Trade-offs**:
  - Pro: Strongest trust story - the compatibility policy is enforced by a manifest, not prose, and the doctor probe stays accurate as surfaces evolve.
  - Pro: New 1.0 surfaces are born registered and frozen, preventing drift.
  - Con: A full contract registry is heavyweight for a single PR; most surfaces are already stable, so much of the registry is descriptive scaffolding with low immediate payoff.
  - Con: Couples four feature units to a new meta-layer, complicating atomic commits and adding a frozen surface that itself must be maintained forever.
  - Con: Doctor-as-registry-reader risks scope creep beyond the "callable-name probe or docs guidance" the task scopes.
- **Complexity**: large
- **Risk**: medium

## Consultant recommendation (verbatim)

### Recommended: Variant 1
**Rationale**: The constraints most strongly favor independence - per-unit atomic commits, byte-compatibility on every surface but the 9 aliases, and a single promotion engine all argue against the up-front coupling of Variants 2 and 3. The real overlaps (artifact persistence in Units 3/5, rendering in Units 4/5) are small enough to capture with a shared helper extracted opportunistically inside the slice work, without committing to a substrate or registry whose cost outweighs its one-PR payoff.

## Orchestrator decision

Variant 1 accepted as recommended; no override. Two refinements
folded into the design (both within the consultant's own framing):

1. **Tombstones** for the removed aliases (a static REMOVED_TOOLS map
   answering tools/call with the precise replacement) - this is the
   one element of Variant 3's "data-driven doctor" idea worth its
   cost, because it lives at a single dispatch point and pays off on
   every stale client, while the full registry does not clear the bar.
2. The consultant's own caveat about opportunistic shared helpers is
   adopted as an explicit rule: if dream-stage and report-snapshot
   converge on identical bundle mechanics, extract a small helper
   inside the slice work, never a substrate up front.
