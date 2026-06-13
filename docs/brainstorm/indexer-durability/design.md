# Indexer Durability & Resilience - making interrupted index runs safe and resumable

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's search index is a SQLite database derived from the vault.
Long index runs can be interrupted (SIGTERM, crash, deadline). Three real gaps
exist today: (1) the `o2b search watch` shutdown handler resolves immediately
and kills an in-flight `indexVault` pass mid-write; (2) the only way to stop a
running index that is still within its time budget is to kill the process -
there is no cooperative, on-demand abort; (3) a full `reindexVault` rebuild that
is interrupted discards all progress and restarts from scratch. This suite
closes those gaps without duplicating mechanisms that already work.

## Grounding: what is already durable (do NOT rebuild)

- The incremental `indexVault` path is already resumable. `indexInto` skips
  unchanged files via an mtime+size fastpath, so a re-run after an interruption
  re-walks and skips everything already committed. `populateEmbeddings` only
  processes `findChunksWithoutEmbeddings()` and commits each batch, so an
  interrupted embed phase resumes by computing only the still-missing vectors.
  A new resumable-checkpoint table for this path would be redundant and is
  explicitly out of scope.
- The reindex rename window is already crash-safe: `Store.open` restores the
  `.bak` if the main DB is missing.
- A cooperative time deadline already exists: `Safeguard.checkpoint()` trips
  past a budget at file / batch boundaries. We compose with it, not replace it.

## Scope

- A cooperative `AbortSignal`, composed into the existing `Safeguard`, threaded
  through `indexVault` / `indexInto` / `populateEmbeddings` / `reindexVault`,
  checked at the same boundaries the deadline already uses (between files,
  between embed batches - never mid-write).
- A graceful `o2b search watch` shutdown: on SIGINT/SIGTERM, stop accepting new
  flushes, abort the in-flight pass, await it to settle at the next boundary
  within a bounded grace window, then close the store (WAL consolidate + lock
  release) and exit. A second signal forces immediate exit.
- A best-effort synchronous WAL checkpoint on process exit for any open writer
  store, so a bypassed `close()` does not leave an orphan `-wal` that trips
  `SQLITE_IOERR_SHORT_READ` on the next open.
- A lock heartbeat: the writer's `proper-lockfile` is refreshed during long runs
  so a legitimate long index is never mistaken for a stale lock; lock-busy is
  surfaced as a clean skip in the watch loop rather than crashing the watcher.
- An opt-in resumable `reindexVault`: a compatible in-progress `brain.sqlite.new`
  staging build is detected by a signature marker and resumed (via the existing
  incremental fastpath over the temp DB) instead of being discarded.
- Two config keys (`search_shutdown_grace_seconds`, `search_resume_reindex`)
  with env mirrors, defaulting to today's behaviour.

## Out of scope

- No `--port` / `--instance` daemon model. OSB's MCP server is stdio-only;
  multiple instances against different vaults already run conflict-free because
  the writer path takes a per-`dbPath` lock, and a second writer on the same
  vault already gets a typed `INDEX_LOCKED`. We verify and document this; we do
  not fabricate a daemon. (The honest reading of t_ea80ddb5's "multi-instance".)
- No resumable-checkpoint table for the incremental path (already resumable).
- No "attempt accounting / dead-letter" job-queue accounting from the upstream:
  the index is not a retrying job queue, so importing that vocabulary would be
  misleading. The honest slice of t_79e773be is the cooperative AbortSignal.
- No preemptive cancellation: Bun runs SQLite synchronously, so abort is
  cooperative only. We never claim otherwise.

## Chosen approach

Variant 2 (see variants.md): the Variant 1 "fix the real gaps in place" core -
abort-composed Safeguard, graceful watch shutdown, exit-path WAL flush, lock
heartbeat - PLUS the genuinely non-resumable path made resumable: opt-in staged
reindex resume. The CLI consultant recommended Variant 1 (skip resumable
reindex) on risk grounds. We override, because:

1. Without resumable reindex, the chosen task t_672c751e delivers almost nothing
   new - everything else it asks for (resume, final flush) is either already
   present (incremental resume) or is the same shutdown/flush work as t_ea80ddb5.
2. The operator's brief for this cycle is an explicitly larger, substantive
   change; the resumable reindex is the only honest, non-redundant home for real
   volume here.
3. The consultant's one serious objection - resuming onto a stale staging build
   could yield a wrong index - is removed by design: resume is gated on a
   signature marker (embedding signature + schema version + chunk params); on
   any drift the staging DB is discarded and rebuilt; and resume itself is the
   ordinary incremental walk over the temp DB (fastpath re-reads any changed
   file, and the final deletion sweep removes vanished files), so it is
   self-healing rather than a blind trust of partial state. The whole behaviour
   is behind a flag that defaults to today's discard-on-interrupt.

## Design decisions

- **Compose, don't replace.** The abort lives inside `Safeguard`: an optional
  `signal` makes `checkpoint()` throw a typed `SafeguardAbortError` when the
  signal is aborted, in priority over the timeout. Callers that already hold a
  Safeguard get abort for free; there is one trip point, not two.
- **Throw, don't silently truncate.** An aborted run throws `SafeguardAbortError`
  exactly as a timed-out run throws `SafeguardTimeoutError`. The deletion sweep
  runs only after the walk completes, so a thrown abort leaves a consistent,
  partially-refreshed index (identical to today's timeout behaviour). The watch
  shutdown coordinator catches the abort and treats it as a clean stop.
- **Reuse the KV table, no migration.** The reindex staging marker is a row in
  the existing `index_state` KV table of the temp DB. No new table, no schema
  version bump, so existing indices are untouched and reads never break with a
  spurious `SCHEMA_MISMATCH`. Byte-identical when `search_resume_reindex` is off.
- **Testable coordinator, thin CLI.** The watch shutdown logic (in-flight await,
  grace window, refuse-after-stop) moves into a `IndexWatchRunner` with an
  injected clock and index function, so it is unit-tested without real signals
  or timers. The CLI wires `fs.watch` + signal handlers + store lifecycle to it.
- **Exit-hook mirrors the existing pattern.** The sync WAL-checkpoint-on-exit
  registry follows `sync-lockfile.ts`'s `process.on("exit", ...)` shape:
  best-effort, synchronous (bun:sqlite is sync), never throws.
- **Fail loud on lock contention.** Lock-busy stays a typed `INDEX_LOCKED`; the
  watch loop treats it as a skip (report + keep watching) rather than crashing,
  but a one-shot `o2b search index` still surfaces it. No silent no-op.

## File changes

New:
- `src/core/search/watch-runner.ts` - testable watch flush/shutdown coordinator.
- `src/core/search/store-exit.ts` - sync WAL-checkpoint-on-exit registry.
- tests: `tests/core/brain/safeguard-abort.test.ts`,
  `tests/core/search/indexer-abort.test.ts`,
  `tests/core/search/watch-runner.test.ts`,
  `tests/core/search/store-exit.test.ts`,
  `tests/core/search/reindex-resume.test.ts`,
  `tests/core/search/lock-heartbeat.test.ts`,
  `tests/core/search/multi-instance.test.ts`,
  plus a config-resolution test extension.

Modified:
- `src/core/brain/safeguard.ts` - optional `signal`, `SafeguardAbortError`,
  `throwIfAborted` helper.
- `src/core/search/indexer.ts` - thread `signal` through options; resumable
  `reindexVault`; staging signature marker.
- `src/core/search/store.ts` - proper-lockfile `update` heartbeat; register with
  the exit-flush registry on write open / unregister on close.
- `src/core/search/types.ts` - `shutdownGraceMs`, `resumeReindex` on
  `ResolvedSearchConfig`.
- `src/core/search/index.ts` - resolve the two new keys + env mirrors + DEFAULTS.
- `src/cli/search.ts` - `cmdSearchWatch` uses `IndexWatchRunner`; graceful close.
- `README.md`, `CHANGELOG.md`, `package.json` (+ manifest sync), config docs.

## Risks and open questions

- **Stale staging resume (highest consequence).** Mitigated by the signature
  marker + self-healing incremental walk + opt-in flag (see Chosen approach).
  Tests assert that signature drift discards the staging DB.
- **Lock heartbeat interval.** Must be well under `stale` (e.g. stale/2) and must
  not leak a timer when the store closes. The `update` option of proper-lockfile
  handles the refresh; `close()`/release cancels it.
- **Exit-hook reentrancy.** The sync checkpoint must be idempotent and tolerate
  an already-closed DB; it never throws out of the exit handler.
- **Grace window default.** 5 seconds (matches the upstream agentmemory grace and
  is ample for a single-file boundary). Configurable; 0 means "abort and exit
  immediately without awaiting", which we treat as a valid explicit choice.
