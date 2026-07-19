### Variant 1: Two shared kernels, cluster-local units

- **Approach**: Extract exactly two new shared abstractions, each riding in with the first unit that needs it: a gitignore-style path-scope engine (`src/core/fs/ignore.ts`: nested ignore-file composition, nearer-`!`-wins, `.git/info/exclude` layering) introduced by Unit 1 and consumed by Unit 2's `--src-subpath`/`--exclude`; and a diagnostics-signal model (issue class + detector + optional fixer + next-command hint) introduced by Unit 9 and consumed by Unit 10's snapshot. Everything else lands as local changes to its existing module, organized into four clusters: scope/gate (1→2→3), ingest integrity (5, 4), provenance/query (6, 7, 8), operator surface (11, 9→10). The dependency spine is short - only 1→2 and 9→10 are hard edges; ship order 11, 1, 2, 3, 5, 4, 6, 7, 8, 9, 10 keeps every prefix coherent.
- **Trade-offs**:
  - Pro: shared logic gets exactly one home (ignore matching, issue/hint model) without any infrastructure-only commit - each abstraction ships inside a feature commit with its tests.
  - Pro: maximal prefix-shippability; a stalled wave still leaves `main` releasable after any unit.
  - Pro: byte-identical opt-out is easy - the ignore engine replaces the static skip-dir list only where Unit 1 wires it; nothing else changes uninvoked.
  - Con: the ingest path (Units 2, 3, 5, 4) stays four separate touch points in `ingest.ts`/`batch-plan.ts` rather than one explicit pipeline; a future wave may still want that consolidation.
  - Con: the diagnostics model's shape is decided by Unit 9's needs and may need a small extension when Unit 10 arrives.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Source-pipeline spine

- **Approach**: Treat Units 1-5 as stages of one explicit discovery pipeline abstraction in `src/core/brain/ingest/`: scope (ignore engine + subpath/exclude) → gate (`extractable` check) → pre-extract (deterministic code-structure pass) → dispatch → reconcile, each stage a typed hook on a shared `SourcePipeline` context. Operator tooling (9, 10) similarly reads a shared health-signal registry, and hygiene scan (Unit 1) becomes another consumer of the same scope stage. Units 6, 7, 8, 11 remain peripheral standalone changes.
- **Trade-offs**:
  - Pro: strongest conceptual match to the wave theme - one choke point for "what enters the vault and how," which future ingest features slot into.
  - Pro: reconciliation (Unit 4) and gating (Unit 3) become trivially testable as pipeline stages rather than call-site patches.
  - Con: the pipeline scaffold is effectively an infrastructure commit, which the repo's conventions discourage, and it forces refactoring `ingest.ts`/`batch-plan.ts` before any user-visible unit ships - a stalled wave leaves a half-migrated pipeline.
  - Con: highest risk to the byte-identical opt-out constraint, since existing ingest flow is rerouted through new machinery even when no new flag is set.
  - Con: hygiene scan (Unit 1) importing from `brain/ingest` inverts sensible layering; the ignore engine would need to live below both anyway, eroding the "one spine" elegance.
- **Complexity**: large
- **Risk**: high

### Variant 3: Eleven islands, convention-only sharing

- **Approach**: Every unit lands independently in its own existing module with no new shared homes: Unit 1 implements ignore parsing inside `hygiene/`, Unit 2 imports that parser directly (a hygiene→ingest reach-across), Unit 10 calls the existing verb functions (`brain_health`, `brain_doctor`, etc.) and formats their outputs itself, and Unit 9 pairs fixers with doctor checks ad hoc inside `doctor.ts`. Ordering is nearly free - only Unit 2's import of Unit 1's parser is a hard edge.
- **Trade-offs**:
  - Pro: cheapest to execute and the easiest to parallelize across agents; every commit is small, atomic, and independently revertable.
  - Pro: near-perfect prefix-shippability with zero scaffolding to leave half-finished.
  - Con: the ignore engine living under `hygiene/` while `ingest/` imports it violates the one-directional-layering direction, or else gets duplicated - either way conflicting with "shared logic gets exactly one home."
  - Con: Unit 10 re-deriving and re-formatting signals from six verbs duplicates presentation logic and drifts as those verbs evolve; hints get hardcoded per call site instead of traveling with the issue.
  - Con: defers exactly the consolidation debt the post-v1.30.1 refactor just paid down.
- **Complexity**: small
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: Variant 1 delivers the two abstractions this wave genuinely reuses (ignore composition, diagnostics signals with hints) in their correct one-home locations, while avoiding Variant 2's infrastructure-first commit and its threat to the byte-identical opt-out and atomic-feature-commit conventions. Unlike Variant 3, it keeps layering one-directional - the ignore engine sits below both hygiene and ingest, and hints travel with issue definitions instead of being duplicated in the snapshot. Its short dependency spine (1→2, 9→10) preserves the constraint that a partially completed wave still ships as a coherent prefix of v1.34.0.
