# Retrieval quality and context delivery - consultant variants (audit trail)

Consultant: Claude Code (`claude -p`), run 2026-07-19. Raw output: cli-output/claude.md.

### Variant 1: Platform-first extraction
- **Approach**: Extract all five candidate seams as shared modules before any feature task lands: a `scope-key` module (owner/session/project composite keys), a read-only `retrieval-diagnostics` composition layer wrapping query-plan/density/reliability/latency signals, a generalized session-state store in `hooks/lib`, a unified index-admission policy in the walker, and the RRF source-identity key helper. The nine tasks then consume these as libraries, ordered infra-first (seams, then 8, 1, 7, then the rest).
- **Trade-offs**:
  - Pro: source identity and scope keying each have exactly one implementation from day one; tasks 1, 7, 8 cannot drift on key semantics.
  - Pro: the diagnostics layer guarantees 3 and 4 stay shadow-only by construction (the layer exposes no mutating handles).
  - Con: two of five seams (diagnostics composition, generalized hook state) have only two consumers each and no third in sight; this is speculative abstraction the "no stubs, no do-nothing surfaces" culture pushes against.
  - Con: infra commits precede any user-visible behavior, inflating an already nine-commit PR and making the byte-identical-default review harder (reviewers must check unused-yet code paths).
  - Con: getting the scope-key vocabulary right before task 8's dedup-migration questions are answered risks a mid-wave redesign of the very module everything depends on.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Two hard seams, rest conventions
- **Approach**: Extract only the seams where a second divergent implementation would be a correctness bug: (a) one composite-key module providing both the RRF/dedup source-identity key (task 1's federation hardening) and the scope-key vocabulary (task 8's per-namespace dedup and search filters, plus task 1's scope-aware seed resolution); (b) one index-admission predicate at the walker/indexer touch point, owned by task 7's lane exclusion and consulted by task 8's search scoping. Everything else stays a documented convention: 3 and 4 each read the existing signal modules directly (shadow-only enforced by API choice and tests, not a layer), and 5 and 6 store their stamps as namespaced keys in the existing `hooks/lib` session state. Ordering: key module rides in with task 8, task 1 consumes it next; admission predicate rides in with task 7; tasks 2, 3, 4, 5, 6, 9 are order-independent and can interleave.
- **Trade-offs**:
  - Pro: each extraction ships inside the atomic commit of its first consumer, matching the one-commit-per-task convention with no bare infra commits.
  - Pro: the two extracted seams are exactly the ones where drift is silent and dangerous (a key mismatch collapses or fails to collapse results; a walker mismatch drops or leaks index rows); the convention seams fail loudly in review instead.
  - Pro: smallest total surface for the byte-identical-default audit; diagnostics tasks 3 and 4 remain independent and can be reviewed or even dropped without unwinding shared code.
  - Con: 3 and 4 will duplicate some signal-plumbing (sampling queries, reading the reliability ledger); a future third diagnostic surface would trigger a refactor.
  - Con: hook-state conventions rely on discipline (key naming, TTL semantics) rather than types; a collision between the "recently oriented" stamp and nav-cadence state is possible if the convention is under-specified.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Extract-on-second-use, ordering-driven
- **Approach**: No upfront extraction at all; sequence the wave so the first consumer of each candidate seam lands early with inline code, and the second consumer performs the extraction as part of its own commit (rule of two). Concretely: 7 ships walker exclusion inline, then 8 hoists it into a shared predicate when adding scope filters; 1 ships its RRF key inline, then 8 hoists the key helper for dedup; 3 ships inline sampling, then 4 hoists a shared diagnostics reader; 6 ships its stamp inline, then 5 hoists cadence state.
- **Trade-offs**:
  - Pro: zero speculative abstraction; every shared module is proven by two real call sites at the moment it is born.
  - Pro: early tasks are maximally simple and can merge-review independently; nothing blocks on a shared-module design debate.
  - Con: second-consumer commits are no longer atomic to their own task; they mix "implement task 8" with "refactor tasks 1 and 7", violating the one-atomic-commit-per-task convention or forcing extra refactor commits inside the PR.
  - Con: within a single PR the churn is pure waste; code written in commit 3 is rewritten in commit 6 before any reviewer sees it stable, and the byte-identical regression tests for 7 must be re-verified after 8's hoist.
  - Con: the key-semantics seam (source identity plus scope) is precisely where two independently written inline versions are most likely to disagree subtly before unification.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 2
**Rationale**: The wave ships as one PR with one atomic commit per task, so both the bare-infra commits of Variant 1 and the intra-PR rewrite churn of Variant 3 fight the repo's own conventions, while Variant 2 lets each shared module ride in with its first real consumer. It extracts exactly the two seams where divergence is a silent correctness bug (composite ranking/dedup keys, walker index admission) and leaves the advisory and hook-state seams as test-enforced conventions, which best serves the byte-identical-default and shadow-only constraints with the smallest review surface. Ordering falls out naturally: 8 then 1 around the key module, 7 before 8's search scoping at the walker, and the remaining six tasks stay freely schedulable.

## Orchestrator decision

Variant 2 accepted as recommended, no override. The two extracted seams (composite scope/source key module, walker index-admission predicate) are exactly the places where silent divergence corrupts ranking or index membership; everything else stays a test-enforced convention, which matches the one-atomic-commit-per-task rule and keeps the byte-identical-default audit small. The under-specified hook-state convention risk is mitigated in plan.md by naming the session-state keys and TTL semantics up front.
