# Index Freshness on Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read that finds the search index older than a threshold starts one low-priority background incremental index run, so the index stays current while agents work, with no daemon and no scheduler.

**Architecture:** A new `src/core/search/freshen.ts` owns the decision (pure), the per-device state file and claim, and the detached spawn. `search()` and `ensureVaultCurrent` call it. The child is `o2b search index --freshen <runId>`. The indexer skips its whole-index post-passes on a no-change run, and the catch-up write volume is measured per phase and its dominant cause fixed.

**Tech Stack:** Bun 1.4 + TypeScript, `bun:sqlite`, `bun:test`.

**Spec:** `docs/brainstorm/index-freshness/design.md`

## Global Constraints

- No resident process, timer, watcher or scheduler entry; indexing starts only from an agent-driven read or session start.
- A read never waits for indexing; `maybeFreshenIndex` never throws.
- A read-only open (`opts.selfHeal === false`) never freshens.
- Config keys: `search_freshen_interval_s` (default `60`, `0` = off, env `OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S`), `search_freshen_embeddings` (default `false`, env `OPEN_SECOND_BRAIN_SEARCH_FRESHEN_EMBEDDINGS`).
- Claim file `<dirname(dbPath)>/freshen.claim`, abandoned after 10 minutes; state file `<dirname(dbPath)>/freshen-state.json` (per device, never in `Brain/`).
- Backoff after a failed run: 60 s doubling, capped at 3600 s.
- Trail code `index-stale` with `detail.ageSeconds` when the index is older than 600 s.
- Background child: CPU priority lowered with `os.setPriority`; `ionice -c3` (Linux) or `taskpolicy -b` (macOS) prefix when on PATH.
- Catch-up write target: a ~200-file catch-up writes at most ~100 MB; if that needs a larger rework, stop and report numbers.
- Tests never spawn a real child except the one end-to-end test; `tests/setup.ts` pins the interval to `0`.
- Version: next minor after `main`, bump inside the PR; English only; no AI co-author trailers.

## Review Focus

1. Many sessions searching at once on a stale index: exactly one child runs; the others skip without error.
2. A child killed mid-run (reboot, OOM): the claim is taken over after 10 minutes and no failure streak is invented.
3. A vault whose index cannot be written (read-only disk, corrupt file): the child fails, backoff grows, searches keep working on the old index, `doctor` names the streak.
4. Cross-vault (`global`) and recall-source searches: never spawn into a foreign vault.
5. A schema-pack edit with no document change: the no-change fast path must still recompute relation-constraint flags.

Each item has a test in the owning task (Tasks 2, 2, 3, 4, 5 respectively).

---

### Task 1: Freshen configuration

**Files:**
- Modify: `src/core/search/types.ts` (add `ResolvedFreshenConfig`, optional `freshen` on `ResolvedSearchConfig`)
- Modify: `src/core/search/index.ts` (`resolveSearchConfig`)
- Modify: `tests/setup.ts` (pin `OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S=0` unless set)
- Test: `tests/core/search/freshen-config.test.ts`

**Interfaces:**
- Produces: `interface ResolvedFreshenConfig { readonly intervalSeconds: number; readonly embeddings: boolean; readonly configPath: string | null }`; `ResolvedSearchConfig.freshen?: ResolvedFreshenConfig` (absent = off, so hand-built configs in tests stay off).

- [ ] **Step 1: Failing tests** — default resolves `{ intervalSeconds: 60, embeddings: false, configPath }`; env `OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S=0` gives `0`; config key `search_freshen_interval_s: "300"` gives `300`; `"-1"` and `"abc"` throw naming the key; `search_freshen_embeddings: "true"` gives `true`. Tests save and restore the env var because the preload pins it.
- [ ] **Step 2: Run** `bun test tests/core/search/freshen-config.test.ts` — FAIL (`freshen` undefined).
- [ ] **Step 3: Implement** with the existing `parseInteger(envOrConfig(...), 60, "search_freshen_interval_s", { min: 0 })` and `parseBool` helpers; `configPath: opts.configPath ?? null`.
- [ ] **Step 4: Preload** — in `tests/setup.ts`, next to `O2B_DEVICE_ID`: `if (process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] === undefined) process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "0";` with a comment that the suite must never spawn background indexers.
- [ ] **Step 5: Run** the new test and `bun run typecheck` — PASS.
- [ ] **Step 6: Commit** `feat(search): freshen interval and embeddings config`.

### Task 2: Decision, claim, state and spawn (`freshen.ts`)

**Files:**
- Create: `src/core/search/freshen.ts`
- Test: `tests/core/search/freshen.test.ts`

**Interfaces:**
- Consumes: `ResolvedFreshenConfig` (Task 1), `isWriterLockHeld(dbPath)` from `store/writer-lock.ts`.
- Produces:
  - `FRESHEN_SKIP = { off, fresh, backoff, writerLock, claimed, readOnly, noIndex }` (string values `off`, `fresh`, `backoff`, `writer_lock`, `claimed`, `read_only`, `no_index`).
  - `decideFreshen(input: { nowMs: number; lastIndexedAt: string | null; intervalSeconds: number; backoffUntilMs: number | null }): { action: "spawn" } | { action: "skip"; reason: FreshenSkip }` (pure; lock and claim are checked after it).
  - `claimFreshen(dir: string, nowMs: number): string | null` — exclusive create of `freshen.claim` holding `{ token, at }`; takes over a claim older than 600 s; returns the token or `null`.
  - `releaseFreshen(dir: string, token: string): void` — removes the claim only if it still holds `token`.
  - `readFreshenState(dir) / writeFreshenState(dir, state)` with `FreshenState { failures: number; backoffUntil: string | null; lastOutcome: "completed" | "failed" | null; lastRunAt: string | null; lastDurationMs: number | null; lastError: string | null; lastChanged: number | null }`; a missing or torn file reads as the empty state.
  - `nextBackoffMs(failures: number): number` — `min(60_000 * 2 ** (failures - 1), 3_600_000)`.
  - `freshenCommand(base: string[], has: (tool: string) => boolean, platform: NodeJS.Platform): string[]` — prefixes `ionice -c3` on linux / `taskpolicy -b` on darwin when `has(tool)`.
  - `maybeFreshenIndex(config: ResolvedSearchConfig, opts: { lastIndexedAt: string | null; readOnly?: boolean; nowMs?: number; spawn?: (argv: string[]) => void }): FreshenDecision` — never throws; returns `"spawned"` or the skip reason.

- [ ] **Step 1: Failing tests** for `decideFreshen`: `intervalSeconds 0` → `off`; `lastIndexedAt null` → `no_index` (self-heal owns a missing index); age 30 s / interval 60 → `fresh`; age 61 s → `spawn`; `backoffUntilMs > now` → `backoff`.
- [ ] **Step 2: Failing tests** for the claim: first claim returns a token; a second returns `null` (`claimed`); a claim file with `at` 601 s ago is taken over; `releaseFreshen` with a foreign token leaves the file (Review Focus 1, 2).
- [ ] **Step 3: Failing tests** for state and backoff: round-trip; torn JSON reads as empty; `nextBackoffMs(1) === 60_000`, `(2) === 120_000`, `(10) === 3_600_000`.
- [ ] **Step 4: Failing tests** for `freshenCommand`: linux with `ionice` → `["ionice", "-c3", ...base]`; linux without → `base`; darwin with `taskpolicy` → `["taskpolicy", "-b", ...base]`; win32 → `base`.
- [ ] **Step 5: Failing tests** for `maybeFreshenIndex` with an injected `spawn` and a temp dir: stale index → spawn called once with `search index --vault <v> --freshen <id>` (plus `--config <p>` when set); fresh → not called; `readOnly: true` → `read_only`, not called (Review Focus 4); held writer lock (create the lock dir the way `writer-lock.ts` does) → `writer_lock`; a `spawn` that throws → returns a skip, does not throw.
- [ ] **Step 6: Run** `bun test tests/core/search/freshen.test.ts` — FAIL.
- [ ] **Step 7: Implement** `freshen.ts`. The real spawner reuses the self-heal pattern from `src/core/maintenance/ensure-current.ts` (`Bun.spawn`, streams `ignore`, `windowsHide`, `detached` on win32, `env: { ...process.env }`, `unref`) and the `o2bCommand()` resolution (move it to a small shared helper `src/core/maintenance/o2b-command.ts` and import it from both). The claim token is passed as `--freshen <token>`.
- [ ] **Step 8: Run** tests and typecheck — PASS.
- [ ] **Step 9: Commit** `feat(search): freshen decision, claim, state and spawn`.

### Task 3: The background child (`o2b search index --freshen`)

**Files:**
- Modify: `src/cli/search/verbs/indexing.ts` (`cmdSearchIndex`)
- Modify: `src/core/brain/metrics.ts` only if surfaces are registered there (add `index_freshen`)
- Test: `tests/cli/search-index-freshen.test.ts`

**Interfaces:**
- Consumes: `releaseFreshen`, `readFreshenState`, `writeFreshenState`, `nextBackoffMs` (Task 2).
- Produces: flag `--freshen <token>`; on success the state gets `failures: 0, lastOutcome: "completed", lastChanged: added+updated+deleted`; on failure `failures+1`, `backoffUntil = now + nextBackoffMs(failures)`, `lastError`; a metric row on surface `index_freshen` only on failure or when `lastChanged > 0`; the claim is released in `finally`.

- [ ] **Step 1: Failing tests** (in-process `cmdSearchIndex` with a temp vault): `--freshen <token>` after `claimFreshen` → exit 0, claim gone, state `completed`; a vault whose db path is unwritable (a directory squatting `brain.sqlite`) → state `failed`, `failures 1`, `backoffUntil` set, claim gone (Review Focus 3); a second failure → `failures 2` and a doubled backoff.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: parse `freshen`; when present, `os.setPriority(process.pid, 10)` in a try; `embeddings: cfg.freshen?.embeddings === true` unless `--embeddings` was given; wrap the run in try/catch/finally writing state, the metric row and releasing the claim; the exit code stays as today.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(search): background freshen child records its outcome`.

### Task 4: Call sites and the `index-stale` trail code

**Files:**
- Modify: `src/core/search/search.ts` (after the store opens)
- Modify: `src/core/maintenance/ensure-current.ts` (after the rebuild check)
- Modify: `src/core/search/retrieval-trail.ts` (code, membership, description)
- Modify: `docs/cli-reference.md` (trail table row; required by `tests/docs/retrieval-trail-doc.test.ts`)
- Test: `tests/core/search/freshen-search.test.ts`, extend `tests/core/maintenance/ensure-current*.test.ts`

**Interfaces:**
- Consumes: `maybeFreshenIndex` (Task 2). A test seam: `SearchOptions.freshenSpawn?: (argv: string[]) => void` passed through to `maybeFreshenIndex({ spawn })`.
- Produces: `RETRIEVAL_DEGRADATION.indexStale = "index-stale"` with `detail: { ageSeconds }`; `EnsureCurrentResult.freshen: FreshenDecision | null`.

- [ ] **Step 1: Failing tests**: a search over an index whose `last_indexed_at` is 5 min old with `freshen.intervalSeconds 60` calls the injected spawn once and returns results; `selfHeal: false` never calls it; age 11 min adds `{ code: "index-stale", detail: { ageSeconds } }` to `degraded`; age 2 min does not; interval `0` with age 11 min still reports `index-stale` but never spawns. `ensureVaultCurrent` on a current-schema stale index returns `freshen: "spawned"` (spawn injected through `EnsureCurrentOptions.freshenSpawn`), and on a rebuild-needed index leaves `freshen: null`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: in `search()` read `store.getState(LAST_INDEXED_AT_STATE_KEY)` once; call `maybeFreshenIndex(effectiveConfig, { lastIndexedAt, readOnly: opts.selfHeal === false, spawn: opts.freshenSpawn })`; push `index-stale` when the age exceeds 600 s. In `ensureVaultCurrent`, when no rebuild is needed, open the index read-only, read the stamp, call `maybeFreshenIndex`.
- [ ] **Step 4: Add the trail code** to `RETRIEVAL_DEGRADATION`, `RETRIEVAL_DEGRADATION_CODES` (after the keyword codes) and `describeRetrievalDegradation`; add the `docs/cli-reference.md` row: "the index was last updated more than ten minutes ago, so notes changed since then may be missing; a background run has been started unless freshening is off or backing off".
- [ ] **Step 5: Run** the new tests, `tests/docs/retrieval-trail-doc.test.ts`, `tests/core/search/` — PASS. **Step 6: Commit** `feat(search): reads refresh a stale index in the background`.

### Task 5: No-change run skips the whole-index post-passes

**Files:**
- Modify: `src/core/search/indexer.ts` (around the post-passes after the delete loop)
- Modify: `src/core/search/store/state.ts` (new key `schema_pack_digest`)
- Test: `tests/core/search/indexer-noop.test.ts`

**Interfaces:**
- Produces: state key `SCHEMA_PACK_DIGEST_STATE_KEY = "schema_pack_digest"`; `IndexStats.postPassesSkipped: boolean`.

- [ ] **Step 1: Failing tests**: index a small vault, index again with no change → `postPassesSkipped: true` and `last_indexed_at` advanced; change a note → `false`; change only `Brain/_brain.yaml` `link_constraints` → `false` and the blocked flag recomputed (Review Focus 5); a forced run → `false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: compute a SHA-256 of the raw `_brain.yaml` bytes (empty string when absent); skip `resolveLinkTargets`, `resolveAliasTargets`, `recomputeRelationConstraintFlags` and the tier pass when `added + updated + deleted === 0`, not forced, and the digest equals the stored one; store the digest after the post-passes run. Keep the stamp, the census and the deferred-reason reads.
- [ ] **Step 4: Run** the new test and `tests/core/search/indexer*.test.ts` — PASS. **Step 5: Commit** `perf(search): a no-change index run skips the whole-index post-passes`.

### Task 6: Catch-up write volume, measured then fixed

**Files:**
- Create: `scripts/measure-index-writes.ts` (Linux; reads `/proc/self/io` `write_bytes` around phases; prints a table)
- Modify: `src/core/search/indexer.ts` (optional `onPhase` hook in `IndexOptions`, no behaviour change)
- Modify: the module of the dominant phase (decided by the measurement)

- [ ] **Step 1:** Add `onPhase?: (phase: "walk" | "post" | "embed" | "stamp" | "close") => void` to the index options, called at phase boundaries. Commit.
- [ ] **Step 2:** The script copies the reference vault to a temp dir, indexes it, rewinds the copy's `last_indexed_at` and touches 200 notes with new content, then runs a catch-up index and prints bytes per phase plus the close (WAL checkpoint). Run it; record the table in the PR description.
- [ ] **Step 3:** Fix the dominant phase. Expected candidates and fixes: per-file transactions → one transaction per batch of files; full-index link/alias resolution → restrict to links touching changed documents; WAL-to-DELETE checkpoint on every close → keep WAL between runs where the backing allows it. Write a regression test for the behaviour changed (not for byte counts).
- [ ] **Step 4:** Re-run the script; target ≤ ~100 MB. If not reachable without a broader rework, stop, keep what helped, and report the numbers. Commit `perf(search): <what was fixed>`.

### Task 7: Freshness in `search status` and `doctor`

**Files:**
- Modify: `src/cli/search/verbs/status.ts`
- Modify: the readiness check module under `src/core/brain/doctor/` that prints index lines
- Test: extend the status and readiness tests

- [ ] **Step 1: Failing tests**: `o2b search status` prints `freshen: every 60s` (or `off`), `index_age: <n>s`, `last_freshen: completed <ts> (<n> changed)` / `failed <ts>: <error>`, and `freshen_backoff_until: <ts>` when active; `--json` carries the same fields under `freshen`. Readiness warns when `failures >= 3`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** from `readFreshenState(dirname(dbPath))`. **Step 4: Run** — PASS. **Step 5: Commit** `feat(search): show index freshness in status and doctor`.

### Task 8: End-to-end with a real child

**Files:**
- Test: `tests/e2e/index-freshen.test.ts`

- [ ] **Step 1:** Temp vault + config, index it, write a new note, set `OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S=1` for a spawned `o2b search query` (via `runCli` helpers), wait up to 20 s polling the state file for `lastOutcome: "completed"`, then search finds the new note. Timeout generous for Windows.
- [ ] **Step 2: Run** on Linux — PASS. **Step 3: Commit** `test(search): background freshen end to end`.

### Task 9: Docs, version, gates, PR

**Files:** `docs/cli-reference.md` (keys, `--freshen`, status fields), `docs/how-it-works.md`, `docs/architecture.md` ("no daemon" clarification), `docs/hermes-cron.md`, the reindex `--cron-template` help text, `README.md` release line, `CHANGELOG.md` (+ compare link), `package.json` + `bun run scripts/sync-version.ts`, `bun run sync-plugin-mirrors` if a skill changed.

- [ ] **Step 1:** Write the docs and CHANGELOG (Added: freshen on read, trail code, status fields; Changed: no-change runs, catch-up writes with the measured numbers; note that a search may start a short background process and `search_freshen_interval_s: 0` turns it off).
- [ ] **Step 2:** Bump the minor version, sync, `--check`.
- [ ] **Step 3:** Gates: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run link-ratchet:check`, `bun run sync-plugin-mirrors:check`, the OpenClaw bundle diff with Bun 1.4.0, `bun test --parallel`.
- [ ] **Step 4:** Commit, push the branch, open the PR with the measurement tables; wait for CI and review bots; fix findings.
