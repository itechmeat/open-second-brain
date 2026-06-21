### Variant 1
- **Approach**: Introduce a transport-neutral seam: keep `MCPServer.handleRequest` as the sole JSON-RPC dispatch core, refactor the existing `serveStdio` readline loop to sit behind a small `Transport` contract, then add the Streamable HTTP transport as a peer implementation of that same contract. Packaging (new bin entries) and the offline guarantee each get a dedicated module — a `resolveBackend` deferral helper for credentials and an MCP launcher shared by stdio/http — so all four tasks plug into clean, named seams.
- **Trade-offs**:
  - + Long-term clean: one dispatch core, one launcher, no per-transport duplication; easiest place to add a third transport later.
  - + Auth, framing, and protocol-version checks live once and apply uniformly.
  - − Refactoring the existing stdio loop puts the byte-identical stdio guarantee directly at risk; requires a golden-output regression test before any move.
  - − Front-loads abstraction the four cards don't all need, fighting KISS and the one-card-at-a-time cadence (card 1 must land the seam before later cards benefit).
- **Complexity**: large.
- **Risk**: medium.

### Variant 2
- **Approach**: Treat every task as a strictly additive leaf. The HTTP transport is a new file that calls `MCPServer.handleRequest` directly over Bun/Node built-in `http`, with auth and framing local to it; the existing `serveStdio` is never touched. New bin shims delegate to the existing stdio entry. Offline support is an in-place reordering of backend resolution inside the indexer that emits an explicit deferred-reason in its structured output, and the reference-link pass is a self-contained reference-definition sub-pass appended inside `extractLinks`.
- **Trade-offs**:
  - + Byte-identical stdio and inline-link output are guaranteed by construction — the old code paths are physically unchanged.
  - + Minimal deps, KISS, forward-only; each card is an independent commit that cannot conflict with shared files beyond doc/changelog appends.
  - + Matches the predecessor release's read-only/additive posture.
  - − A thin amount of shared logic (protocol-version gate, frame parsing) is reused rather than abstracted; the HTTP file must deliberately call `handleRequest` to satisfy the single-source-of-truth constraint instead of re-deriving dispatch.
  - − No unified transport picker, so a future third transport repeats the bootstrap pattern.
- **Complexity**: medium.
- **Risk**: low.

### Variant 3
- **Approach**: Unify everything behind one MCP runtime orchestrator: `o2b mcp serve` gains `--transport stdio|http` and `--api-key`, the new bin scripts and the HTTP server all funnel through a single runtime builder that selects the transport, and a shared "runtime readiness" report (consulted by both the MCP server and the indexer) carries the offline/deferred-credential state as structured output. The reference-link pass is folded into the same release as a link-extraction config flag surfaced through that one runtime.
- **Trade-offs**:
  - + Single config surface and one readiness model; offline state is reported consistently wherever it matters.
  - + Strong discoverability — one command/flag set documents the whole MCP story.
  - − The orchestrator tends toward a god-object coupling packaging, transport, auth, and indexer-readiness concerns that are otherwise independent.
  - − Couples the credential-deferral work (kernel/indexer) to the MCP runtime, violating the constraint that the kernel must not depend on MCP and blurring the deliberate packaging-vs-transport task split.
  - − Hard to drive one card at a time: the central builder is a contended shared file across all four cards.
- **Complexity**: large.
- **Risk**: high.

### Recommended: Variant 2
Variant 2 is the only strategy that makes the two hard backward-compatibility guarantees — byte-identical stdio behavior and byte-identical inline-link output — true by construction rather than by careful refactoring, because it never edits the existing `serveStdio` loop or the inline-link branch of `extractLinks`. It honors the repo's minimal-dependency and KISS conventions (built-in `http`, no framework, no MCP SDK), keeps MCP optional and the kernel independent (the offline/deferred-backend work stays inside the indexer and is reported explicitly, never coupled to a running server), and respects the constraint that HTTP reuse `handleRequest` as the single dispatch source by calling it directly instead of inventing a transport abstraction. It also fits the four-card, shared-branch cadence best: each task is an additive leaf that builds cleanly on the prior commit with conflicts confined to append-only doc/changelog edits, and it continues the predecessor release's deliberately additive, forward-only posture. The one genuinely shared concern (protocol-version gate and frame parsing) is small enough to reuse as a helper without the upfront seam Variant 1 demands or the central coupling Variant 3 imposes.
