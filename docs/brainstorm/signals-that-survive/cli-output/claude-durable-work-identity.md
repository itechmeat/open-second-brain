### Variant 1: Declared work identity as a precedence rung above the crutch

- **Approach**: Add an optional durable pair — `workId` and `laneId` — sourced at the capture boundary in strict precedence (host payload field, then an environment/config key, then a per-worktree marker recorded in `Brain/.state/`), and persist both as new optional `wid`/`lane` fields on `LedgerLine`. `resolveSessionLineageDetailed` gains a rung between `payload` and `crutch`: when this session and exactly one predecessor share a `wid`, the link is made on identity alone with no freshness bound and no `cwd`/branch/commit predicate, so a resumed work item re-attaches after a model, account, branch or worktree switch. Lanes are a hard separator rather than a tiebreaker — two entries sharing a `wid` but carrying different `laneId` values can never link, and two same-lane survivors abstain through the existing ambiguity path with new named reasons (`lane-conflict`, `work-ambiguous`).
- **Trade-offs**:
  - Exact/external identity always wins, and nothing is inferred; the kernel stays deterministic and no natural-language signal is consulted.
  - Absent `wid`/`lane` the resolver is the current one line-for-line, so the byte-identical-when-absent rule holds without a compatibility shim.
  - The ledger already hashes line bodies by removal of chain fields and compacts verbatim, so new optional fields ride the existing integrity chain untouched.
  - `CRUTCH_LINK_WINDOW_MS` survives as the fallback bound rather than being deleted; the crutch is demoted, not removed, which leaves two resolution rules to reason about.
  - Value depends on something actually declaring the id — an unwired host gets no benefit, so the feature is only as good as its capture-boundary adapters.
  - A stale or copied marker file in a cloned worktree would assert a false identity; the lane separator contains it but does not detect it.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Derived work fingerprint with an attestation-union registry

- **Approach**: Derive the work identity structurally instead of declaring it — a content-addressed fingerprint over canonical remote, upstream/merge-base ref, and worktree gitdir identity — and maintain a union registry in `Brain/.state/` that binds fingerprints observed together by one session into a single work identity, so a branch or worktree switch inside one session teaches the registry that both fingerprints name the same work. The lane is derived from the gitdir identity, keeping parallel worktrees separate by construction. Resolution keys on registry membership, and a union that would join two already-distinct works abstains rather than merging.
- **Trade-offs**:
  - Requires no host cooperation and no operator action; every existing session gains identity immediately.
  - Lane separation falls out of the same derivation as identity, so there is no second thing to wire or forget.
  - The property that must survive — branch and worktree change — is precisely what the fingerprint encodes, so identity only survives through a learned union, and the very first switch cannot be recognized until after the fact.
  - Unions are cumulative and effectively irreversible; one bad attestation permanently welds two work items, which inverts the fail-closed contract that v1.39.0 established.
  - Merge-base and upstream probes are unbounded git work at a fail-soft lifecycle boundary, and their absence in a detached or non-git tree silently collapses the fingerprint space.
  - The registry is mutable shared state inside a Syncthing-replicated tree, where two peers can produce conflicting unions with no arbiter.
- **Complexity**: large
- **Risk**: high

### Variant 3: Lane lease ledger replacing the freshness window outright

- **Approach**: Make the execution lane the primary durable object: each session opens a lease on a work id at `SessionStart` and releases or hands it off at the compression boundary, recorded as explicit open/handoff/close lines in the existing append-only ledger. Continuation becomes lease re-acquisition — a new session links only to a predecessor whose lease is in handed-off state and unclaimed — so `CRUTCH_LINK_WINDOW_MS` is deleted rather than demoted, and concurrency is refused because a live lease is already held rather than because two candidates tied.
- **Trade-offs**:
  - The timing crutch disappears entirely; freshness stops being a proxy for anything.
  - Concurrent lanes are structurally impossible to collapse, not merely detected and abstained on.
  - The lease lifecycle is observable and auditable in the same chained ledger, and a handoff is an explicit fact rather than an inference.
  - A crashed or SIGKILLed session leaks an open lease forever; reclaiming it needs a staleness age, which reintroduces a time window at exactly the point the variant claims to remove one.
  - Lease semantics assume a single authority over the state file, which a Syncthing-replicated vault does not provide; two peers can each believe they hold the same lease.
  - Deleting the window is an incompatible change to a resolution path that currently degrades to `flat` gracefully, and every hook must now emit a close event or continuity quietly stops working.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The upstream contract's substantive claim is that exact and external identifiers always win while inference stays advisory, and Variant 1 is the only one that implements that literally — identity is declared, never derived, so the kernel adds no new inference and the ambiguity layer shipped in v1.39.0 is reused rather than re-litigated. It fits the scoping note by extending the lineage/crutch layer with two optional ledger fields and one precedence rung instead of standing up a registry subsystem, and it keeps behaviour byte-identical when the fields are absent. Variants 2 and 3 both place mutable, authority-assuming state inside a peer-replicated vault and both reintroduce the failure they set out to remove — an irreversible silent union in one case, a time-based lease reclamation in the other.
