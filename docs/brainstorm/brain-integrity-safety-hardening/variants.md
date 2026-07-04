# Brain Integrity & Safety Hardening — brainstorm variants (audit trail)

Consultant: Claude Code (`claude -p`), model `claude-opus-4-8`, primary. Exit 0, three parseable variants returned, so the fallback was not invoked (anti-pattern: sequential, fallback only on primary failure). Prompt: `cli-output/prompt.md`. Raw output: `cli-output/claude.md`.

## Variant 1: Primitive-first (extract the shared substrate, then wire consumers)

- **Approach**: Land three cross-cutting primitives before any feature task, then build the nine tasks as thin consumers of them: (1) a **write-boundary chokepoint** built on the existing `proper-lockfile` writer-lock/lease pattern (`store.ts:228`, `maintenance/lease.ts`) that both serializes all Brain writes (A) and exposes a single instrumentation seam for write-volume accounting (I); (2) a **linear-bounded corpus-scan detector harness** hosted in the maintenance lane's quiet window that `context-guard`'s `TEXT_PATTERNS` (C), the redactor's new infra-topology detectors (D), and the path-hygiene check (G) all register into; (3) a **unified findings/health-gate reporter** feeding `doctor`/`vault_health` that the graph-health gate (E) and hygiene checks surface through. B, F, and H then land as independent leaves.
- **Trade-offs**:
  - Pro: maximal DRY — the ReDoS-linearity contract, the lease acquisition, and the findings shape are each written and tested once.
  - Pro: coherent operator surfaces (one findings vocabulary across injection/graph/path).
  - Con: front-loads abstraction risk — primitives must be designed for consumers not yet built; wrong guess forces rework.
  - Con: primitive PRs are byte-identical-when-off *and* feature-invisible, which fights the "one atomic commit ships one unit" grain and complicates CHANGELOG framing.
  - Con: sequences the concurrency-invariant change (A) earliest, before any safety net exists.
- **Complexity**: large
- **Risk**: medium-high

## Variant 2: Thematic vertical slices (the release's own three sub-themes)

- **Approach**: Ship three cohesive, individually-demoable verticals matching the stated theme. **Write-time integrity discipline:** A (single-writer lane), E (graph-health gate), H (safe fallback names). **Cross-machine portability:** B (scan-root-relative keys), G (hardcoded-path hygiene), I (write cost meter). **Corpus-level safety:** C (injection sweep), D (redactor fail-closed + topology detectors), F (signed grounding score). Extract a shared primitive only *within* a slice where two members genuinely share one — e.g. C and D share the linear-regex detector contract inside the safety slice.
- **Trade-offs**:
  - Pro: each slice maps to a release-narrative section and a self-contained CHANGELOG story.
  - Pro: moderate, low-risk reuse that stays inside a slice boundary.
  - Con: misses the strongest cross-slice couplings — A's write chokepoint (integrity slice) and I's write meter (portability slice) instrument the *same* boundary but never meet; C's corpus scan (safety) and G's hygiene detector (portability) want the same registry harness across slices.
  - Con: some duplicated scan/reporting scaffolding across slices.
- **Complexity**: medium
- **Risk**: medium

## Variant 3: Risk-ordered incremental, minimal abstraction (refactor-on-second-use) (CHOSEN)

- **Approach**: Ignore grouping; sequence all nine strictly by blast radius, landing byte-identical-when-off, report-only leaves first and the concurrency-invariant change last. Order: **G, H, I, E** (additive/report-only) → **B, F** (read-time derivations / append-only projections, no history mutation) → **C, D** (deterministic scanners behind flags) → **A** (single-writer lane, which touches the write path every other task depends on). Each task ships self-contained via TDD as one atomic commit; shared primitives are extracted opportunistically only when a second real consumer appears — the ordering *engineers* those second-use points (I meters at A's chokepoint because A lands after it is anticipated; D shares C's linear-regex detector because D follows C).
- **Trade-offs**:
  - Pro: lowest per-step risk; the tree is always shippable and every step is independently revertible.
  - Pro: cleanly honors "one unit, one branch, one atomic commit" and the repo's read-time-derive precedent (F, E, I compute at read time, nothing new persisted).
  - Pro: the invariant-touching write-lane (A) lands *after* the health gate, cost meter, and safety scanners exist — the safety net precedes the risky change.
  - Con: least upfront DRY; reuse emerges via ordering rather than design, risking minor rework if a late task reveals a primitive an early task could have shared.
  - Con: no single unifying architecture diagram; A's cross-cutting benefit arrives latest.
- **Complexity**: medium
- **Risk**: low

## Consultant recommendation: Variant 3

> The repo's stated grain — "each suite unit ships one-by-one via TDD on a single feature branch, one atomic conventional commit per task" — plus byte-identical-when-off makes Variant 1's speculative primitives a poor fit: a primitive PR changes no observable behavior and can't be validated by its own acceptance test, and the codebase's *only* principled persisted-derivation exception (memoized side-indexes) signals a strong refactor-on-second-use culture rather than design-for-reuse-upfront. Risk ordering also respects the standing invariants directly: the concurrency-touching single-writer lane (A) is the one task that can destabilize every other write path, so landing it last — after E's non-aborting health gate, I's write meter, and the C/D safety scanners are already in place — means the "safety hardening" net exists before the riskiest change, and A's `proper-lockfile` chokepoint becomes the natural, already-anticipated second-use seam where I's write accounting attaches. F, E, and I stay pure read-time projections over the append-only ledger and telemetry (no history mutation, nothing new on disk), and B/G/H remain independent leaves, so the sequence keeps every step revertible and honestly opt-in without forcing a big-bang abstraction the conventions would struggle to justify.

## Orchestrator decision: accept Variant 3

No override. Variant 3 matches three standing project facts the consultant independently weighed:

1. **The repo's grain is "one unit, one atomic commit, byte-identical-when-off."** Variant 1's speculative primitives cannot be validated by their own acceptance test (they change no observable behaviour) and front-load abstraction over consumers not yet built — directly against the codebase's refactor-on-second-use culture (the *only* persisted-derivation exception in the whole project is the memoized side-indexes from the prior Vault Integrity suite).
2. **The single concurrency-invariant change (A) is the highest-risk task** because it touches the write path every other task depends on. Risk-ordering lands it **last**, after E's non-aborting graph-health gate, I's write meter, and the C/D scanners already exist — the safety net precedes the riskiest change, which is precisely what a "safety hardening" release should do.
3. **The cross-cutting couplings are real but narrow.** I's meter and A's lane share one boundary; C and D share one linear-detector contract; E's and C's findings share the existing `DoctorIssue`/hygiene shape. Variant 3 extracts each of these on the second real consumer (engineered by the ordering), rather than paying Variant 1's upfront cost or missing the coupling entirely as Variant 2 does (it puts A and I in different slices that never meet).

This is the direct sibling of the prior suite's "Thin Identity Core, Independent Edges" choice: share only what is provably shared, nothing speculative. The one difference here is there is no single provably-shared *primitive* (no analog to the NFC identity function); there are only shared *contract shapes*, which is exactly why refactor-on-second-use (not upfront extraction) is the right call.

De-scope noted in `design.md`: the umbrella card `t_9935bd26` and the Hermes-core-conformance children `t_2c8448bb`/`t_3190e771` are out of this release (meta / different axis). Raising the 256 KB redactor window value is out of scope (fail-closed marker is in; window size stays a tunable). No on-disk artifact migration (portability converges on the next pass). No silent deletion of any finding.
