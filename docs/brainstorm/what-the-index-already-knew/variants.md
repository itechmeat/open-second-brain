# Variant audit trail

Consultant: Claude Code, single pass, exit 0. Fallback consultant not invoked -
the primary returned three parseable variants and a recommendation.

The prompt is at `cli-output/prompt.md` and the verbatim response at
`cli-output/claude.md`. The three variants are reproduced below in full,
followed by the orchestrator's decision.

### Variant 1: Invariant floor, then one explain envelope

- **Approach**: Land the correctness invariants first as unflagged fixes (inject `nowMs` from assembly, add unique tiebreakers to the three SQL orderings, fold the quote in `normalizeEntityName` with a named collision-resolution diagnostic, project `content_hash` into the hydrated row, thread `now` and the expired flag through the as-of surface, mount the existing match-window + char-span helpers on all three snippet surfaces, restore the intent profile inside the RRF relevance term). Then expose everything currently computed-and-discarded through a single opt-in `explain` envelope assembled once at the assembly stage — trace (evaluated/surfaced/excluded), true pre-truncation `total`, duplicate-merge records, shadow recall signals, snippet spans — serialized by one shared boundary projector that both the CLI and the MCP tool call. Store integrity (`PRAGMA integrity_check`) and schema table presence become one explicit `store check` path on the read-open seam that reports `not_run` rather than success when it cannot run; the oversize-chunk census ships as a file-level artifact from the existing token counts with the unprobeable true window declared as unknown.
- **Trade-offs**:
  - One flag, one absence contract, one place where "field is absent when off" is proved — the flag-on vs flag-off byte-identity comparison is written once, not eleven times.
  - The envelope is the natural home for the preview-budget escape hatch: a large trace becomes an artifact reference instead of a new tool or a description-length fight in the MCP registry.
  - Ordering is load-bearing and correct: a trace serialized over a wall-clock-reading ranker would faithfully document noise, so determinism must precede observability rather than ship beside it.
  - The envelope accretes unrelated concerns under one name; "explain" ends up meaning trace, dedup, shadow signals and spans at once, and later readers must be told which sub-object answers which question.
  - Sub-flags will eventually be wanted (shadow signals cost more to compute than the trace does), and retrofitting granularity into a shipped single flag is more work than starting granular.
  - The unflagged invariant fixes move real orderings, so the recall benchmark floors and the exact pass-count assertions must be re-pinned in the same wave, with the deltas attributed unit by unit rather than absorbed silently.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Eleven independent seam slices

- **Approach**: Treat each surviving unit as a self-contained vertical slice landed at the pipeline seam it belongs to — hydration gets `content_hash`, ranking gets injected time and tiebreakers, post-rank gets duplicate merge and shadow signals, fusion gets the intent profile, the registry gets the quote fold, the store gets presence and integrity checks, each snippet surface gets its own anchoring — with its own opt-in flag where a field is added, its own diagnostic code, and its own byte-identity proof. Shared discipline comes from a written convention checklist and the existing build ratchet, not from shared machinery. Each slice is independently revertable and independently reviewable.
- **Trade-offs**:
  - Maximum revert granularity: if the fusion weighting regresses the recall benchmark, that single slice backs out without disturbing the duplicate merge or the integrity gate.
  - Each slice's flag-off byte identity is trivially provable in isolation, which is exactly the shape the project's existing test convention wants.
  - No premature abstraction over units that are genuinely unrelated — the quote fold and the SQLite integrity check share nothing but a release wave.
  - Flag proliferation is real and permanent: five-plus new opt-in flags on one result type, a combinatorial on/off matrix nobody will fully test, and an MCP tool description that must name them all inside the registry's length limit.
  - Boundary plumbing gets rewritten per slice — each new optional field needs its own CLI serialization, its own MCP projection, its own preview-budget accounting — and the copies drift.
  - The trace and the `total` fix are the same defect seen twice (values the boundary refuses to carry); splitting them hides that the boundary projector, not the producers, is the thing that needs fixing.
  - Ordering discipline is only advisory, so nothing structurally prevents shipping the trace before determinism and pinning noise into the evaluation harnesses.
- **Complexity**: large
- **Risk**: high

### Variant 3: Hot path untouched, diagnostics as sidecar surfaces

- **Approach**: Keep the search result type essentially as it is — only the fixes that change the *answer* land inline (fusion weights, snippet anchoring, duplicate merge, quote fold, as-of threading, determinism) — and route every purely observational unit to a separate surface: a diagnostic verb that re-runs the query and emits the trace, true total and shadow signals; a store-check verb carrying schema presence and `PRAGMA integrity_check`; and a file-level census artifact for oversize chunks. Determinism is the enabling precondition rather than a peer unit: the sidecar's re-run is only trustworthy because the ranker no longer reads the wall clock.
- **Trade-offs**:
  - The hot result type gains no optional fields at all, so the preview budget, the description-length limit and the absence-assertion tests on the primary search surface are untouched.
  - Diagnostics can be as verbose as they need to be, since they are not competing with results for the same budget — the census in particular is a natural file artifact, not a response field.
  - The dependency between determinism and observability is structural rather than a matter of merge order, which is the strongest form of the guarantee.
  - Double execution: explaining a query means running it again, and any residual non-determinism (an unfixed source, a concurrent index write) makes the explanation describe a different run than the one the user saw — the failure mode is silent and confusing.
  - New surfaces cost registry budget in the MCP tool list and dispatcher entries in the CLI, and the constraint against a new default readiness probe means the store check must be explicitly invoked, weakening the "corrupt index serves wrong results indefinitely" fix to "corrupt index serves wrong results until someone asks".
  - Shadow signals computed in a second pass are shadow signals over a *replayed* context, which is weaker evidence than signals recorded in the run that actually served the user.
  - Some values genuinely belong inline — the true `total` is a property of the answer, not a diagnostic — so the split is not clean and the boundary ends up carrying one exception.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The wave's real shape is a boundary that refuses to carry values the core already computed, so the fix belongs at that boundary once rather than eleven times (Variant 2) or in a parallel surface that must re-derive them (Variant 3). A single envelope also matches the constraints most directly: one absence contract to prove flag-off byte identity, one place to hand a large trace to the existing artifact-reference escape hatch instead of spending MCP description or preview budget, and no new default probe. The invariant-floor-first ordering is the part that must not be traded away — serializing a trace or pinning shadow signals over a ranker that re-reads `Date.now()` would harden the non-determinism into the evaluation harnesses instead of removing it.

---

## Orchestrator decision

**Variant 1 is adopted, with one deviation.**

The recommendation is accepted on its central argument: the wave's real shape is
a boundary that refuses to carry values the core already computed, so the fix
belongs at that boundary once rather than eleven times. Variant 2 would have
produced five or more new opt-in flags on one result type with a combinatorial
matrix nobody would test, and would have hidden that the trace and the mis-set
total are the same defect seen twice. Variant 3 would have explained a query by
running it again, which makes the explanation describe a different execution than
the one the user saw - and its store check, being explicitly invoked, would have
weakened "a corrupt index serves wrong results indefinitely" to "until someone
asks".

**Deviation: the shadow recall signals stay out of the explain envelope.**

Variant 1 places the trace, the true total, the duplicate-merge records, the
snippet spans and the shadow signals in one envelope behind one flag. The
consultant named the risk in its own trade-off list, and for the signals it is
not a stylistic risk but a wrong coupling. The trace is returned to the caller of
one query and dies with the response. The signals are recorded to a persistent
append-only log for later analysis, behind a telemetry gate that already exists
and already defaults off. Merging them would compute per-result signals for every
caller who asked only to see a trace, and would write to a log file that has no
retention policy on behalf of callers who never asked to be logged. The gates
stay separate: `explain` returns, `telemetry` records.

**What is kept from the recommendation without change:** the invariant floor
lands before the observability units, and that ordering is a structural
dependency rather than a preference. Serializing a trace or recording signals
over a ranker that re-reads the wall clock would faithfully document noise and
pin it into the evaluation harnesses instead of removing it.
