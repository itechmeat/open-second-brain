### Variant 1: Bottom-up primitives, feature-by-feature wiring
- **Approach**: Implement the three shared primitives as small standalone modules (`integrity.ts` for hash + revision compute, `workrun.ts` for JSONL phase log, and a thin re-export of the existing `dream({dryRun:true})` path). Each of the five features then ships as its own commit that imports the primitives and modifies the existing call sites directly — collision checks added inline at `writePreference`, gates added inline at the dream promote/retire steps, workrun calls scattered through `scanBrain` phases, doctor gets a new check appended, `brain_review_candidates` added next to `toolBrainDream`.
- **Trade-offs**:
  - Pro: minimal new abstraction; matches the existing pure-function, `scan → compute → apply` style of the codebase.
  - Pro: each feature has a tight, isolated blast radius — easy to write a failing test per file in `tests/core/brain/<feature>.test.ts`.
  - Pro: lowest review burden per commit; reviewers see exactly which call site changed.
  - Con: integrity logic gets sprinkled across `writePreference` and dream's promote/retire — the same "compare expected vs actual" idea expressed in two places.
  - Con: if a sixth gate is added later, both call sites need parallel edits; drift between the two paths is possible.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Single transactional write-path chokepoint
- **Approach**: Refactor `writePreference` into a thin façade over a new `writePreferenceTxn(vault, input, expectations, options)` that wraps `proper-lockfile` (mirroring `transitionRequest` from `approval.ts:361`): acquire lock → re-read current frontmatter → run all gates as ordered checks (revision/staleness, content-hash drift observer, shrink, duplicate-window, source-lock) → mutate → `writeFrontmatterAtomic` → release. Dream's promote and retire steps call into the same txn with feature-specific expectations (shrink-gate and retire-from-confirmed gate become two more `expectations` predicates). Workrun stays a separate concern — a small context object threaded through dream phases — and `brain_review_candidates` is a thin MCP wrapper over the existing `dryRun` path.
- **Trade-offs**:
  - Pro: every collision/gate mode lives in one auditable function; one place to add a future gate, one place to read for invariants.
  - Pro: direct writes via `writePreference` and indirect writes via dream share enforcement guarantees identically — no skew possible.
  - Pro: the lockfile recipe is already proven in-tree; reusing it keeps "no new external deps" trivially true.
  - Con: requires up-front refactor of `writePreference` and all its callers before tests can be made green; first commit is heavier.
  - Con: the txn signature grows (an `expectations` object) — slightly more API surface to learn than the current `(vault, input, options)`.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Validator-chain pipeline
- **Approach**: Model every mutation as a `PreferenceIntent` flowing through `validate → check → apply` stages. Each gate (StaleUpdate, UnsafeShrink, SourceLock, DuplicateWrite, ShrinkGate, RetireFromConfirmedGate, drift observer) becomes a pure validator returning `ok | block | warn`. Workrun becomes a pipeline observer that records phase transitions; `brain_review_candidates` is the same pipeline with the `apply` stage swapped for `report`. The dream pass is rewritten to feed intents through the pipeline rather than calling `writePreference` directly.
- **Trade-offs**:
  - Pro: maximally extensible; each validator is independently testable as a pure function.
  - Pro: a single mental model — projection, enforcement, and observation all derived from the same chain.
  - Con: introduces a framework the codebase does not have today; conflicts with the "no premature abstraction" stance and the recent v0.11.0 cleanup that retired pre-1.0 shims.
  - Con: reviewers must understand the framework before they can review any feature; the diff balloons and the first commit no longer maps cleanly to one user-visible feature.
  - Con: dream's scan/compute/apply structure has to be inverted into a push-style pipeline — bigger blast radius than the task warrants.
- **Complexity**: large
- **Risk**: medium-high

### Recommended: Variant 2
**Rationale**: Variant 2 centralises every collision and gate on the one place the project already needs to harden — the preference write path — and reuses the proper-lockfile recipe already proven in `transitionRequest`, so it adds no new abstraction the codebase has to learn. Workrun and `brain_review_candidates` stay as small, independent pieces alongside the txn rather than being folded into a unified framework, which keeps the diff legible while still giving the five features a single chokepoint they can share. Variant 1 risks drift between the two write paths and Variant 3 invents a pipeline framework the v0.11.0 line explicitly avoided.
