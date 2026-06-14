# Indexer Durability & Resilience - variant audit trail

Primary consultant: Claude Code (`claude -p`), output captured verbatim in
`cli-output/claude.md`. Fallback (Codex) not invoked - the primary returned
three parseable variants and a recommendation. Below: the consultant's variants
verbatim, then the orchestrator's final decision and rationale.

---

## Consultant variants (verbatim)

### Variant 1: Fix the real gaps in place (distributed wiring)
- **Approach**: Extend `Safeguard` with an optional `AbortSignal` so `checkpoint()` throws either the existing `SafeguardTimeoutError` or a new typed `SafeguardAbortError` - one cooperative primitive, two trip conditions. Fix the `o2b search watch` signal handler to await the in-flight `indexVault` pass within a configurable grace window, then fire the abort to unwind cleanly; guarantee a WAL-consolidating, lock-releasing close on every exit path by routing through the existing `sync-lockfile` process-exit hook. Add a lock-heartbeat that refreshes the proper-lockfile mtime during long runs (so a genuine long index never looks stale at 60s) and treat lock-busy as a skip, plus honest attempt accounting in the embed retry path (no retry for the non-idempotent batch commit). `reindexVault` stays non-resumable but becomes abort-honoring, leaving the original DB intact via the temp file as today.
- **Trade-offs**: Pro: smallest surface that closes every OSB-applicable gap across all three tasks; reuses `Safeguard`, `lock.ts`, `sync-lockfile.ts` (DRY, no new abstraction). Pro: no new schema/table, so it cannot become a "redundant resumable mechanism" for the already-resumable incremental path; byte-identical when grace window/heartbeat flags are off. Pro: fixes the genuine watch-handler-kills-mid-flush bug and the orphan `-wal`/held-lock-on-SIGTERM bug directly. Con: leaves `reindexVault` restarting full rebuilds from scratch - the one genuinely non-resumable path is unaddressed. Con: abort/grace/heartbeat concerns are wired at several call sites rather than one object.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Resumable staged reindex (carry-forward temp DB)
- **Approach**: Build on Variant 1's shutdown/abort/heartbeat core, then make the genuinely non-resumable `reindexVault` resumable by treating `brain.sqlite.new` as a durable staging DB instead of discarding it on interruption. On the next reindex, detect a compatible in-progress staging build (matching `LATEST_SCHEMA_VERSION` plus a vault fingerprint) and resume it - reusing the existing `indexInto` mtime/size fastpath and `findChunksWithoutEmbeddings()` logic on the temp file - before the unchanged atomic same-file rename swap. A small staging marker records fingerprint and schema version so a stale or schema-drifted temp build is invalidated and rebuilt rather than silently resumed.
- **Trade-offs**: Pro: addresses the only genuinely non-resumable path honestly, without duplicating the incremental path's resume logic (it reuses it on the temp DB). Pro: atomic swap and `.bak` crash-recovery window are untouched; gated behind a flag that defaults to today's discard-on-interrupt behaviour. Con: the staging marker is a quasi-checkpoint that must be rigorously invalidated; a subtle fingerprint bug could resume onto a stale build and produce a wrong index. Con: significantly larger validation surface for a path that runs rarely. Con: closest of the three to brushing against the "no misleading/duplicate mechanism" rule.
- **Complexity**: large
- **Risk**: medium-high

### Variant 3: Centralized RunController supervisor
- **Approach**: Introduce one queue-scoped supervisor object that owns the entire long-run lifecycle: an `AbortController` composed into `Safeguard`, the signal handlers with grace window and in-flight await, the SIGTERM-safe WAL-consolidate-and-release close, the lock heartbeat with lock-busy-as-skip, and honest attempt accounting with per-handler wall-clock budgets. Every long-running operation receives this one controller. `reindexVault` stays non-resumable but abort-honoring.
- **Trade-offs**: Pro: single composition point makes abort/shutdown/heartbeat/accounting impossible to forget on new code paths. Pro: centralizes honest accounting and budgets. Con: a new singleton lifecycle abstraction is heavy for a codebase whose only long-running process is `watch`; real risk of over-engineering. Con: a singleton invites accidentally re-importing multi-instance/daemon framing that OSB's stdio + per-vault locking forbids. Con: larger refactor touching every long-op call site.
- **Complexity**: large
- **Risk**: medium

### Consultant's recommendation: Variant 1
Rationale (verbatim summary): closes every gap that actually exists while honoring the hard constraints; Variant 2 carries the suite's only wrong-index failure mode for a rarely-run path; Variant 3 over-engineers a lifecycle abstraction for a tool with a single long-running process.

---

## Orchestrator decision: Variant 2 (override, documented)

**Chosen: Variant 2** = Variant 1's full core (abort-composed Safeguard, graceful
watch shutdown, exit-path WAL flush, lock heartbeat, lock-busy skip) PLUS the
opt-in resumable staged reindex.

**Why override the consultant's Variant 1:**

1. **Task coverage.** t_672c751e ("resumable durable checkpoints") is one of the
   three chosen tasks. Under Variant 1 it delivers nothing new: the incremental
   path is already resumable, and the "final flush" it asks for is the same work
   as t_ea80ddb5's shutdown. Variant 2 is the only honest, non-redundant way to
   actually satisfy t_672c751e - by making the one genuinely non-resumable path
   (`reindexVault`) resumable.

2. **Cycle intent.** The operator's brief for this cycle is a deliberately larger,
   substantive change. Resumable reindex is the only place real volume can come
   from without padding or duplicating existing mechanisms.

3. **The risk is designed out.** The consultant's sole serious objection -
   resuming onto a stale staging build yields a wrong index - is removed:
   - resume is gated on a signature marker (embedding signature + schema version
     + chunk params); any drift discards `.new` and rebuilds from scratch;
   - resume is the ordinary incremental walk over the temp DB, so the fastpath
     re-reads any file whose mtime/size changed and the final deletion sweep
     removes vanished files - it is self-healing, not blind trust;
   - the whole behaviour sits behind `search_resume_reindex`, default false, so
     when off the path is byte-identical to today (always discard + fresh build);
   - the marker lives in the existing `index_state` KV table, so there is no
     schema migration and no risk of breaking existing indices.

**Why not Variant 3:** the supervisor singleton over-engineers a lifecycle object
for a codebase whose only long-running process is `watch`, and a singleton risks
smuggling back the daemon/multi-instance framing that OSB's stdio + per-vault
locking explicitly forbids. Variant 2 keeps the abort inside the existing
`Safeguard` (one trip point) and the shutdown inside a small testable runner -
the DRY benefit Variant 3 promised, without the abstraction weight.
