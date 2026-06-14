# Indexer Durability & Resilience - implementation plan

Each task is one atomic unit = one TDD cycle = one conventional commit on
`feat/indexer-durability`. Order respects dependencies: the shared abort
primitive first, then the consumers.

## Task 1: Abort-composed Safeguard (shared primitive)
- **Files**: `src/core/brain/safeguard.ts`; `tests/core/brain/safeguard-abort.test.ts`.
- **Change**: add `SafeguardAbortError`; `CreateSafeguardOptions.signal?: AbortSignal`;
  `checkpoint()` throws `SafeguardAbortError` when `signal?.aborted`, in priority
  over the timeout check. `noopSafeguard` unchanged. Export a tiny
  `throwIfAborted(signal?: AbortSignal, operation?: string)` helper. No `as`
  casts; `signal` read with optional chaining.
- **Acceptance**: aborted signal trips `checkpoint()` with `SafeguardAbortError`
  even before the deadline; unset signal + live deadline behaves exactly as today;
  a no-deadline guard with an aborted signal still trips.
- **Depends on**: none.

## Task 2: AbortSignal threaded through the indexer
- **Files**: `src/core/search/indexer.ts`; `tests/core/search/indexer-abort.test.ts`.
- **Change**: `IndexVaultOptions.signal?: AbortSignal`. In `indexInto` and
  `populateEmbeddings`, after the existing `safeguard?.checkpoint()`, call
  `throwIfAborted(opts?.signal)` at the same boundaries (between files, between
  embed batches). The deletion sweep still runs only on full completion, so an
  abort leaves a consistent partial index. `reindexVault` forwards `signal`.
- **Acceptance**: a signal aborted before the loop throws `SafeguardAbortError`
  with nothing partial deleted; aborting between embed batches stops further
  embedding but keeps already-committed vectors; a run with no signal is
  byte-identical to today.
- **Depends on**: Task 1.

## Task 3: Writer lock heartbeat + lock-busy skip
- **Files**: `src/core/search/store.ts`; `tests/core/search/lock-heartbeat.test.ts`,
  `tests/core/search/multi-instance.test.ts`.
- **Change**: pass `update` (refresh interval = floor(stale/2)) to the
  `proper-lockfile.lock` call in write mode so a long run keeps the lock fresh.
  Confirm release cancels the refresh. `multi-instance.test.ts` asserts: two
  writers on different `dbPath`s both succeed; a second writer on the same
  `dbPath` gets `INDEX_LOCKED` (documents the honest multi-instance story).
- **Acceptance**: lock options include a positive `update` below `stale`; same-vault
  second writer is rejected with the typed error; different-vault writers coexist.
- **Depends on**: none.

## Task 4: Sync WAL-checkpoint-on-exit registry
- **Files**: `src/core/search/store-exit.ts` (new); `src/core/search/store.ts`;
  `tests/core/search/store-exit.test.ts`.
- **Change**: registry of open writer `Database` handles. `Store.open(write)`
  registers; `close()` unregisters. A `process.on("exit", ...)` hook (installed
  once, mirroring `sync-lockfile.ts`) runs `PRAGMA wal_checkpoint(TRUNCATE)`
  best-effort on each registered handle, swallowing errors. Idempotent; never
  throws.
- **Acceptance**: a registered handle is checkpointed by the hook function;
  unregister removes it; running the hook with a closed handle is a no-op, not a
  throw.
- **Depends on**: none.

## Task 5: Config keys (grace window + resume flag)
- **Files**: `src/core/search/types.ts`, `src/core/search/index.ts`;
  extend the existing search-config resolution test.
- **Change**: `ResolvedSearchConfig.shutdownGraceMs: number` and
  `resumeReindex: boolean`. DEFAULTS: `shutdownGraceMs` from 5s, `resumeReindex`
  false. Resolve `search_shutdown_grace_seconds`
  (env `OPEN_SECOND_BRAIN_SEARCH_SHUTDOWN_GRACE`, integer seconds >= 0, *1000)
  and `search_resume_reindex` (env `OPEN_SECOND_BRAIN_SEARCH_RESUME_REINDEX`,
  bool). Both threaded into the frozen `base` config.
- **Acceptance**: defaults present when keys absent; values parse from config and
  env; invalid values fail soft to default (matches existing parse helpers).
- **Depends on**: none.

## Task 6: Graceful watch shutdown (testable runner)
- **Files**: `src/core/search/watch-runner.ts` (new); `src/cli/search.ts`;
  `tests/core/search/watch-runner.test.ts`.
- **Change**: `IndexWatchRunner` owns flush single-flight + shutdown. Injected
  `now()`, `index()` function, and `AbortController` factory. `shutdown(graceMs)`
  sets stopped, aborts the in-flight controller, awaits the running flush up to
  `graceMs` (then returns even if still running - process exit follows), refuses
  new flushes after stop. `cmdSearchWatch` refactors to wire `fs.watch` +
  `SIGINT`/`SIGTERM` -> `runner.shutdown(cfg.shutdownGraceMs)` -> `store`/watcher
  close. A second signal forces immediate `resolve`.
- **Acceptance**: shutdown awaits an in-flight flush before resolving; if the
  flush exceeds the grace window shutdown still returns; a flush requested after
  stop is refused; a normal flush path is unchanged.
- **Depends on**: Tasks 1, 2, 5.

## Task 7: Opt-in resumable staged reindex
- **Files**: `src/core/search/indexer.ts`; `tests/core/search/reindex-resume.test.ts`.
- **Change**: in `reindexVault`, when `config.resumeReindex` is true, compute a
  staging signature (`embeddingSignature` + `LATEST_SCHEMA_VERSION` + chunkSize +
  chunkOverlap). If `brain.sqlite.new` exists and its `index_state`
  `reindex_signature` matches, resume by building with `force: false` (incremental
  fastpath completes the partial build); otherwise unlink the stale `.new` and
  start fresh with `force: true`. Write the signature marker at build start;
  delete it on success before the rename swap. When `resumeReindex` is false,
  keep today's unconditional `tryUnlink(newPath)` + `force: true`.
- **Acceptance**: with the flag on, a partial `.new` (some docs committed, marker
  matching) is completed without reprocessing the committed docs and the final
  index is identical to a fresh reindex; a marker signature mismatch discards the
  `.new` and rebuilds; with the flag off, behaviour is byte-identical to today
  (always fresh). The swapped main DB carries no `reindex_signature` row.
- **Depends on**: Tasks 1, 2, 5.

## Cross-cutting (done within the tasks above, no separate commit)
- No new dependencies; reuse `proper-lockfile`, `bun:sqlite`, Node `AbortSignal`.
- No `as` cast crutches; no natural-language word lists; provider-agnostic.
- Version bump + CHANGELOG + README land in the docs commit (Phase 5), per CLAUDE.md.
