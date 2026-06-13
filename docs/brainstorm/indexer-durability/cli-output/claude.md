### Variant 1: Fix the real gaps in place (distributed wiring)
- **Approach**: Extend `Safeguard` with an optional `AbortSignal` so `checkpoint()` throws either the existing `SafeguardTimeoutError` or a new typed `SafeguardAbortError` - one cooperative primitive, two trip conditions. Fix the `o2b search watch` signal handler to await the in-flight `indexVault` pass within a configurable grace window, then fire the abort to unwind cleanly; guarantee a WAL-consolidating, lock-releasing close on every exit path by routing through the existing `sync-lockfile` process-exit hook. Add a lock-heartbeat that refreshes the proper-lockfile mtime during long runs (so a genuine long index never looks stale at 60s) and treat lock-busy as a skip, plus honest attempt accounting in the embed retry path (no retry for the non-idempotent batch commit). `reindexVault` stays non-resumable but becomes abort-honoring, leaving the original DB intact via the temp file as today.
- **Trade-offs**:
  - Pro: smallest surface that closes every OSB-applicable gap across all three tasks; reuses `Safeguard`, `lock.ts`, `sync-lockfile.ts` (DRY, no new abstraction).
  - Pro: no new schema/table, so it cannot become a "redundant resumable mechanism" for the already-resumable incremental path; byte-identical when grace window/heartbeat flags are off.
  - Pro: fixes the genuine watch-handler-kills-mid-flush bug and the orphan `-wal`/held-lock-on-SIGTERM bug directly.
  - Con: leaves `reindexVault` restarting full rebuilds from scratch - the one genuinely non-resumable path is unaddressed.
  - Con: abort/grace/heartbeat concerns are wired at several call sites rather than one object, so the lifecycle is spread out and easy to forget to thread on a future code path.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Resumable staged reindex (carry-forward temp DB)
- **Approach**: Build on Variant 1's shutdown/abort/heartbeat core, then make the genuinely non-resumable `reindexVault` resumable by treating `brain.sqlite.new` as a durable staging DB instead of discarding it on interruption. On the next reindex, detect a compatible in-progress staging build (matching `LATEST_SCHEMA_VERSION` plus a vault fingerprint) and resume it - reusing the existing `indexInto` mtime/size fastpath and `findChunksWithoutEmbeddings()` logic on the temp file - before the unchanged atomic same-file rename swap. A small staging marker records fingerprint and schema version so a stale or schema-drifted temp build is invalidated and rebuilt rather than silently resumed.
- **Trade-offs**:
  - Pro: addresses the only genuinely non-resumable path honestly, without duplicating the incremental path's resume logic (it reuses it on the temp DB).
  - Pro: atomic swap and `.bak` crash-recovery window are untouched; gated behind a flag that defaults to today's discard-on-interrupt behaviour.
  - Con: the staging marker is a quasi-checkpoint that must be rigorously invalidated; a subtle fingerprint bug could resume onto a stale build and produce a wrong index - the highest-consequence failure mode in the suite.
  - Con: significantly larger validation surface (schema drift, vault mutation mid-build, partial-batch embed state) for a path that runs rarely.
  - Con: closest of the three to brushing against the "no misleading/duplicate mechanism" rule, so it needs the most justification.
- **Complexity**: large
- **Risk**: medium-high

### Variant 3: Centralized RunController supervisor
- **Approach**: Introduce one queue-scoped supervisor object (the OSB-faithful reading of upstream's "DB supervisor singleton") that owns the entire long-run lifecycle: an `AbortController` composed into `Safeguard`, the signal handlers with grace window and in-flight await, the SIGTERM-safe WAL-consolidate-and-release close, the lock heartbeat with lock-busy-as-skip, and honest attempt accounting with per-handler wall-clock budgets. Every long-running operation (`indexVault`, `populateEmbeddings`, `reindexVault`, the `watch` loop) receives this one controller instead of threading deadline, signal, and lock concerns separately. `reindexVault` stays non-resumable but abort-honoring.
- **Trade-offs**:
  - Pro: single composition point makes abort/shutdown/heartbeat/accounting impossible to forget on new code paths; most faithful adaptation of all three upstream intents to OSB's actual architecture.
  - Pro: centralizes honest accounting and budgets, which are otherwise scattered.
  - Con: a new singleton lifecycle abstraction is heavy for a codebase whose only long-running process is `watch`; real risk of over-engineering relative to the actual surface.
  - Con: a singleton invites accidentally re-importing multi-instance/daemon framing that OSB's stdio + per-vault locking explicitly forbids.
  - Con: larger refactor touching every long-op call site, raising regression risk against the "byte-identical when off" guarantee.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: It closes every gap that actually exists in the OSB codebase - the watch-handler mid-flush bug, the orphan-WAL/held-lock-on-SIGTERM bug, the missing on-demand abort, the stale-lock-during-long-run, and dishonest retry - across all three kanban tasks, while honoring the hard constraints: it composes with `Safeguard` rather than replacing it, adds no table that would duplicate the already-resumable incremental path, and stays byte-identical when its flags are off. Variant 2's staged-reindex resume carries the suite's only wrong-index failure mode for a rarely-run path and can be added later if reindex restart cost becomes real; Variant 3's supervisor is the cleanest design in the abstract but over-engineers a lifecycle abstraction for a tool with a single long-running process and risks smuggling back the daemon framing the grounding facts forbid.
