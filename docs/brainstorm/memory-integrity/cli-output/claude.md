### Variant 1: Four independent vertical slices
- **Approach**: Land each feature as a self-contained module against its own existing seam, sharing only primitives that already exist (config chain, `brainDirs`, doctor, `writeSignal`). Sharding edits `log.ts`/`log-jsonl.ts` and the directory-scanning readers; capture boundaries wrap `session-lifecycle.ts` + `import.ts`; regex extraction is a new fail-soft hook emitting `brain_feedback` candidates; the entity registry is a standalone `Brain/entities/` subsystem with its own index and doctor checks. No new cross-feature abstraction is introduced.
- **Trade-offs**:
  - Pro: maximally parallelizable; four small PRs-worth of work bundled into one CHANGELOG, each independently testable under TDD.
  - Pro: smallest blast radius on the hot capture path; fail-soft is local to each slice.
  - Pro: lowest risk of speculative generality — matches the tasks' explicit "no over-engineering" warnings.
  - Con: regex extraction (task 3) and message suppression (task 4) independently re-walk the same `SessionTurn` stream and duplicate turn-iteration + pattern-compile + malformed-pattern handling.
  - Con: name normalization/alias resolution gets implemented twice — once in the entity registry, once (informally) wherever extracted identity/possession facts are routed — so extracted facts never cleanly resolve to canonical entities.
  - Con: four separate diagnostics surfaces; no single place to reason about "what entered/was kept out of memory."
- **Complexity**: medium
- **Risk**: low

### Variant 2: Capture-boundary pipeline + canonicalization kernel
- **Approach**: Pair the two regex-over-turns features into one ordered, deterministic capture pipeline at the shared ingestion seam (`session-lifecycle.ts` live hook and `import.ts` batch): source-classify/suppress (task 4) → extract facts (task 3) → route to signals, with suppression and stateless mode gating extraction so suppressed/read-only turns never produce evidence. Build the entity registry (task 1) as its own subsystem but factor out a small canonicalization primitive (normalized `(category, name)` + alias index) that the extraction router reuses, so identity/possession facts can resolve to canonical entities. Keep device sharding (task 2) fully independent as a write-layer/file-strategy change, since it shares nothing semantic with the other three.
- **Trade-offs**:
  - Pro: eliminates the real duplication (one turn walk, one pattern-compile/error-handling path) and makes the suppression→extraction ordering explicit rather than emergent.
  - Pro: extracted facts gain a precise anchor via the shared canonicalization kernel — the entity task's core value proposition, delivered without coupling the two subsystems.
  - Pro: single coherent capture-diagnostics surface (counters, active patterns, foreground/side-channel, unknown-source) for `brain sources`/doctor.
  - Pro: sharding stays decoupled and shippable on its own, respecting its "decided design."
  - Con: the pipeline couples tasks 3+4 on the hot path; staged fail-soft must be carefully preserved (one stage's crash must not block the others or the runtime).
  - Con: more upfront design than Variant 1; the 3+4 pairing must land together rather than as two trivially independent slices.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Full integrity substrate
- **Approach**: Extract a foundational layer first — a generalized shardable append-only Brain store (sharding the log becomes one instance, and signals/entities could shard too), a reusable rebuildable-index-as-cache primitive shared by the log-shard reader and the entity identity index, and a single turn-scan/filter primitive — then implement all four features as thin consumers on top. Everything routes through common substrate contracts for write/merge, index rebuild, and turn processing.
- **Trade-offs**:
  - Pro: maximal reuse and a uniform index-is-cache/append-only contract across the whole Brain; future features inherit the substrate.
  - Pro: one consistent merged-read and rebuild story everywhere.
  - Con: directly contradicts the tasks' explicit anti-over-engineering guidance (sharding warns against a daemon; entity task insists the index is a cache, not a new storage model).
  - Con: speculative generality — entity writes are rare and operator-governed, so they don't need device sharding; generalizing the store buys little and risks regressing the many directory-scanning log readers (`readAllLogRecords`, temporal index).
  - Con: largest blast radius, slowest to ship, hardest to keep deterministic and backward-compatible across all existing readers in one release.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It captures the only genuine synergies — the two regex-over-turns features share one turn seam and a suppress-then-extract ordering, and a small canonicalization kernel lets extracted facts resolve to canonical entities — while leaving the orthogonal sharding work decoupled and independently shippable, exactly as its "decided design" expects. This avoids both Variant 1's duplicated turn-walking and normalization logic and Variant 3's over-engineered substrate that the tasks explicitly warn against, and it keeps each piece testable, fail-soft, and backward-compatible within a single bundled release.
