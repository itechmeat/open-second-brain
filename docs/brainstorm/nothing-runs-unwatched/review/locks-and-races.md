# Locks, races and durability — independent review of `feat/nothing-runs-unwatched`

Scope: everything this branch changed about concurrency, locking and durability —
the new ingest locking, `acquireLockSyncWithRetry`, the architect's write lock and
plan-then-write ordering, the process-wide embedding ceiling and the `Semaphore`
itself, the bounded benchmark fan-out, the self-heal reindex herd, the maintenance
lease/journal as touched by the new gate and streak, and their tests.

Method: read the interleavings, then break the production code in a throwaway
`git worktree` and re-run the tests to see whether they catch the defect. Every
CONFIRMED item below was reproduced. **No modification was left in the tree**; the
scratch worktree was removed.

Findings are ordered most severe first.

---

## CONFIRMED

### C1. The retrying lock blocks the whole event loop — Ctrl-C, timers and progress all stop for up to 5 seconds

`src/core/brain/sync-lockfile.ts:170`

```ts
Bun.sleepSync(1 + Math.floor(Math.random() * RETRY_SLEEP_CEILING_MS));
```

`Bun.sleepSync` is a synchronous block. The retry loop therefore does not "wait" —
it freezes the single JavaScript thread for the entire budget. Nothing else in the
process runs: no timer, no progress emission, no signal handler, no other MCP tool
call.

Reproduced (2-second budget against a held lock):

```
threw after 2012 ms: lock busy: /tmp/probe-XXXXXX/.open-second-brain/content-manifest.json.lock
timer ticks during the 2s wait: 0 | SIGINT handled during wait: 0
SIGINT handled after wait: 1
```

A SIGINT delivered 200 ms into the wait was queued and only ran when the wait
finished. Failure scenario, concretely:

- **CLI.** `src/cli/interrupt.ts` is this branch's headline: "Ctrl-C reaches the
  operation". An operator who presses Ctrl-C while `generateArchDocs` is parked in
  `acquireLockSyncWithRetry` (`src/core/brain/architect/generate.ts:340`) gets no
  response for up to 5 s. Pressing it a second time — the documented escape for a
  hung synchronous pass — is worse: `process.once` means the second SIGINT falls
  through to the default handler, which kills the process without running the
  `process.on("exit")` hook that unlinks the lock (see P4).
- **MCP server.** `updateManifest` / `recordCompleted` / `appendGitRecords` run
  in-process. A 5 s stall there stalls *every* concurrent tool call and every
  progress notification the branch just added — including the ones the branch added
  so that "nothing runs unwatched".
- **Ingest.** Three locked call sites per source; worst case ~15 s of dead process
  per source before the ingest fails.

The docblock at `sync-lockfile.ts:133-137` argues the deadline exists "to make that
surface as a loud `ELOCKED` instead of a hang". The `ELOCKED` is indeed loud, but
the wait preceding it *is* a hang from every observer's point of view.

**Confidence: high (reproduced).**

### C2. A non-finite budget spins forever, uninterruptibly

`src/core/brain/sync-lockfile.ts:163-172`

```ts
const deadline = Date.now() + budgetMs;
for (;;) {
  try { return acquireLockSync(target); }
  catch (err) {
    if (code !== "ELOCKED") throw err;
    if (Date.now() >= deadline) throw err;   // NaN >= NaN  →  false, always
    Bun.sleepSync(...);
  }
}
```

With `budgetMs = NaN`, `deadline` is `NaN` and `Date.now() >= NaN` is `false` on
every iteration. Combined with C1 the process is wedged with no timer, no signal
handling and no way out but `SIGKILL`.

Reproduced: `acquireLockSyncWithRetry(target, Number.NaN)` against a held lock was
still spinning when a 6-second `timeout` killed it (exit 124).

Only tests pass an explicit budget today, so this is latent — but it is exactly the
class of defect this same branch hardened one file over. `requireCap`
(`src/core/search/embeddings/http-util.ts:118-124`) exists because "a cap this
module cannot honour is named rather than quietly reinterpreted". `budgetMs`
receives no such treatment, and its failure mode is strictly worse than the one that
did.

**Confidence: high (reproduced).**

### C3. The stale-lock escape route the docblock names does not cover two of the three new lock sites

`src/core/brain/sync-lockfile.ts:134-137` (claim) vs `:180-184` (code)

The retry docblock justifies the 5-second deadline like this:

> Reaching it does not mean "busy", it means something is wrong — most likely a
> `.lock` left by a crashed process, which `brain doctor` reports via
> {@link scanStaleLocks} …

`scanStaleLocks` is called from exactly one place,
`src/core/brain/doctor/uncertainty-probes.ts:138`, with `dirs.brain` — i.e. it walks
`<vault>/Brain/` only. But two of the three new locks are not under `Brain/`:

| lock target | resolved path |
|---|---|
| content manifest (`content-manifest.ts:73`) | `<vault>/.open-second-brain/content-manifest.json.lock` |
| ingest checkpoint (`checkpoint.ts:97`) | `<vault>/.open-second-brain/ingest-checkpoints/<planId>.json.lock` |
| git record store (`git/store.ts:193`) | `<vault>/Brain/projects/git/<key>/commits.jsonl.lock` ✓ |
| architect (`architect/generate.ts:340`) | `<vault>/Brain/projects/arch/<key>.lock` ✓ |

Reproduced: with a lock present at
`<vault>/.open-second-brain/content-manifest.json.lock`,
`scanStaleLocks(join(vault, "Brain"))` returns `[]`.

Failure scenario: a crashed ingest leaves a manifest lock behind. Every subsequent
ingest freezes 5 s (C1) and then fails `ELOCKED`. The operator runs `brain doctor`,
which the docblock told them is the surface for this, and it reports **nothing**.
The `ELOCKED` message does name the file, so recovery is possible — but not by the
route the code says to take.

**Confidence: high (reproduced).**

### C4. `Semaphore` cannot detect an over-release, and `peakInFlight` hides it precisely when the bound breaks

`src/core/search/embeddings/http-util.ts:165-172`, `:147-149`

The hand-off fix is correct for the interleaving it targets (see the "sound"
section). What it does not do is defend the permit count:

```ts
release(): void {
  this.held--;                 // may go negative
  const next = this.waiters.shift();
  if (next) { next(); return; }
  this.permits++;              // may exceed `limit`
}
```

There is no `if (this.permits >= this.limit) throw`. Two spurious `release()` calls
permanently widen the ceiling. Reproduced:

```
limit: 2 | real concurrent holders: 4 | semaphore reports peakInFlight: 2
```

Both halves matter:

1. The bound is broken — four holders against a ceiling of two.
2. `peakInFlight` still reads **2**, because `held` was driven negative by the same
   spurious releases. The docblock at `:146` says "never above `limit`" and the class
   docblock says the counter exists "because a bound nothing can observe is a bound
   nothing can verify". The instrument reads clean in exactly the failure it was
   built to catch.

No current call site over-releases — all three (`openai-compat.ts:312`,
`zeroentropy.ts:131`, `benchmark.ts:246`) are `acquire()` … `try/finally release()`.
But `provider-semaphore.ts` has just promoted this object from per-call to
**process-wide and shared between callers**, so a future extra release in any one
caller silently raises the outbound-request ceiling for every other caller in the
process, including the indexer. That is a new blast radius introduced by this branch
with no guard added alongside it.

**Confidence: high (reproduced).**

### C5. The architect's lock test cannot tell "locked around the read-modify-write" from "locked around the writes only"

`tests/core/brain/architect.test.ts` — "the notes are written inside one lock, which
is released afterwards"; production at `src/core/brain/architect/generate.ts:340`.

The test asserts only that `<dir>.lock` exists at each `advanced` progress event,
and is gone afterwards. Every `advanced` event is emitted from the write loop
(`generate.ts:241`), which runs *after* all planning reads. So the assertion is blind
to where the lock was taken relative to the reads.

Reproduced: in a scratch worktree I moved `acquireLockSyncWithRetry(dir)` out of
`generateRun` and into `renderNotes`, wrapping **only** the write loop — the exact
lost-update defect ("a lock that starts after the read does not prevent a lost
update"). Result:

```
19 pass, 0 fail   (tests/core/brain/architect.test.ts + architect-progress.test.ts)
```

The docblock at `generate.ts:333-339` makes the strongest claim on this branch —
"two architect runs on the same repo would still read the same 'before' state and
erase each other's merge" — and **no test anywhere exercises two concurrent architect
runs**. Compare the ingest path, which does it properly with four real processes
behind a barrier (see the "sound" section). The architect got the same lock and none
of the same evidence.

The production code is, as written, correct: `planNote`'s `readFileSync` and
`atomicWriteFileSync` are both inside the critical section. The finding is that
nothing holds it there.

**Confidence: high (reproduced).**

### C6. A streak-refused task is a permanently red lane whose only exit disables every gate the operator configured

`src/core/brain/maintenance/lane.ts:255-263`, `:325-345`;
`src/cli/brain/verbs/maintenance.ts:275`

Once `consecutiveTaskFailures(vault, task) >= limit`, the task is never run
unforced, so the streak can never be cleared by a success. The refusal result
carries `ok: false`, and the CLI returns `result.tasks.some((t) => !t.ok) ? 1 : 0` —
so the nightly cron lane exits 1 forever, and the human line renders the refusal as
`reindex: FAILED (refused: 3 consecutive journaled failures …)`.

The only escape the code offers is `--force`, and `--force` is **lane-wide**: it
bypasses the window, the busy gate and the operator's brand-new
`host_pressure_percent` gate for *every* task, not just the refused one. There is no
`--force-task <name>`. So the remedy for one broken task is to run the whole heavy
lane with the operator's own load protection switched off.

Two related honesty problems in the same area:

- `src/core/brain/policy/blocks/maintenance.ts:50-53` argues against a limit of 1
  because it "converts a self-healing outage into a manual one". The default of 3 has
  the identical property once reached — it only requires three occurrences. A
  provider outage spanning three nightly runs produces a permanent manual-only
  refusal, and the docblock reads as if the default avoided that.
- The lane's own vocabulary work insists "a refusal is not an attempt"
  (`lane.ts:341-343`), yet the human-readable line prints it as `FAILED`.

**Confidence: high (read + exit-code path traced).**

### C7. The embedding ceiling's stated INVARIANT is per-endpoint; the key is per-(identity, endpoint)

`src/core/search/embeddings/provider-semaphore.ts:5-7`

> INVARIANT: across every concurrent `embed()` call in this process, at most
> `embedding_concurrency` embedding requests are in flight against **one resolved
> provider endpoint**.

The key is `JSON.stringify([embeddingSignature({provider, model, dimension}), endpoint])`
(`:70-81`). Two models — or two configured dimensions — against the same host are two
keys and therefore two independent budgets. `2 × embedding_concurrency` requests can be
in flight against one endpoint, which is the quantity a provider's rate limit actually
counts.

This is deliberate: `tests/core/search/embeddings.concurrency-ceiling.test.ts:195`
("two identities on one endpoint do not share a ceiling") asserts it, and the "What
the key is, and why" section argues for it. The defect is the INVARIANT line, which
states a property the code does not provide and which a reader will take at face
value when sizing `embedding_concurrency` against a provider quota.

Note the two negative tests here (`:195` and `:209`) cannot fail against
over-sharing — I confirmed both still pass with the registry bypassed. They pin the
partition, not the ceiling.

**Confidence: high (read + test behaviour confirmed).**

### C8. The self-heal rows pair on a pid, in a file the module says carries nothing machine-local

`src/core/maintenance/self-heal-reindex.ts:29-41`

> They pair on the child's pid … Nothing machine-local is written into a row — no db
> path, no host — because a synced vault carries it to peers where it is false.

A pid *is* machine-local, and it is the pairing key. The rows land in
`Brain/metrics/self_heal_reindex.jsonl` (`src/core/brain/metrics.ts:67`), which the
same docblock says is "synced across devices". Consequences:

- Device A writes `{decision: spawned, pid: 4242}`; device B writes
  `{outcome: completed, pid: 4242}` from an unrelated run. After sync they pair, and
  the test's own pairing rule (`self-heal-reindex.test.ts:141`,
  `completed?.pid === spawned?.pid`) reports a vanished child as completed.
- Pids are reused within one host too, so the same collision happens on a single
  device over a long-lived vault.

There is no run id / nonce to pair on instead, and the surface has no retention cap
(`metrics.ts` has no sweep), so the collision space only grows.

**Confidence: high (read; the sync claim is the module's own).**

### C9. "A spawn row with no terminal row is a child that vanished" is false for at least three other states

`src/core/maintenance/self-heal-reindex.ts:32-34`

The pair is genuinely diagnostic for SIGKILL. It is not diagnostic *of* SIGKILL,
because the same evidence is produced by:

1. **A child that is still running.** A full reindex of a real vault takes minutes;
   for that whole window the pair looks identical to a kill. The test at
   `self-heal-reindex.test.ts:122-126` asserts precisely this state ("the child's
   terminal row is not there yet") as the *correct* observation, then polls — but a
   later reader has no poll and no way to tell.
2. **A child that threw before it could arm the recording.**
   `src/cli/search/verbs/indexing.ts:252` runs `resolveConfig(flags)` *outside* the
   try, before `startedAt` at `:254`. An unreadable or missing `--config`, a bad
   `--vault`, or a `parseFlags` refusal all exit with no outcome row at all.
3. **A child whose recording itself failed.** `append()`
   (`self-heal-reindex.ts:158-169`) swallows every error — a read-only vault, a full
   disk, a `MetricSurfaceError` — by design. A child that completed successfully but
   could not write its row is indistinguishable from a child that was killed.

"A child that never started" *is* distinguishable, correctly: `Bun.spawn` throwing
means `recordSelfHealSpawn(spawned)` at `ensure-current.ts:163` is never reached and
the outer catch pushes `search-reindex: …` into `errors`, leaving no row of either
kind. Credit where due — that half of the question is answered well.

**Confidence: high (read; call ordering verified).**

### C10. One of the five ingest race tests cannot fail

`tests/core/brain/ingest/concurrent-shared-writes.test.ts:249-269` — "the manifest
stays parseable JSON after concurrent writers".

With the lock removed from `acquireLockSyncWithRetry`, four of the five tests in the
file went red; this one stayed green. It has to: `atomicWriteFileSync` renames a
complete file into place, so the manifest is parseable regardless of locking. The
test's own sibling docblock says so (`:11-14`, "Atomicity is not exclusivity"). It
certifies a property the lock does not provide and the absence of the lock does not
threaten.

Harmless on its own — but it is the one test in this file that would let a
lock regression through, and it sits under a `describe` block titled "the shared
files are not corrupted by the race".

**Confidence: high (reproduced).**

---

## PLAUSIBLE

### P1. The herd thinning is near-zero in the scenario it was written for

`src/core/maintenance/ensure-current.ts:126-140`

The docblock is honest about the *mechanism* — "Two callers can both find the lock
free and both spawn — the window between the probe and the child's own
`acquireWriterLock` is not closed by anything here" — and honest about the remedy's
limits ("this only thins the herd"). What it does not state is the window's
**magnitude**, and the magnitude is what decides whether the fix works.

The window spans: `Bun.spawn` → cold Bun start → module graph load → flag parse →
`resolveConfig` → `reindexVault`'s `acquireWriterLock`. That is hundreds of
milliseconds, not microseconds. The motivating scenario is "a schema bump makes every
session that starts afterwards find the index stale at once" — i.e. N parents probing
inside that same window. All of them see the lock free, and all of them spawn. The
fix helps sessions that start *after* some child has taken the lock, which is not the
herd described.

There is no test for it: `tests/core/maintenance/self-heal-reindex.test.ts` covers
one parent with the lock genuinely held (good — real contention, and it does catch
the fix) and one parent with it free. Nothing exercises two parents racing.

A remedy that would close it — have the child take the lock and the parent wait for
the *lock* rather than the spawn, or have the parent write a short-lived spawn
intent marker before `Bun.spawn` and have peers check that too — is not attempted or
discussed.

**Confidence: medium-high (reasoned; window magnitude not measured end-to-end).**

### P2. The 5-second budget is not generous "against a hold measured in milliseconds", because the holds are O(store size) and there is no fairness

`src/core/brain/sync-lockfile.ts:133-134`, `src/core/brain/git/store.ts:200-208`,
`src/core/brain/ingest/content-manifest.ts:236-248`

Two of the critical sections are linear in the data they guard:

- `appendGitRecordsLocked` calls `readRecords`, which reads and `JSON.parse`s **every
  line** of `commits.jsonl` before appending. On a repo with tens of thousands of
  commits that is not milliseconds.
- `updateManifest` spreads the entire manifest object and rewrites the whole file.

The retry has no queue and no fairness: each contender independently draws
`[1, 25] ms` and races. A waiter can lose many draws in a row. The premise the
budget rests on — "a hold measured in milliseconds", so "reaching it … means
something is wrong" — fails when `ingest/batch-plan.ts` does what it exists to do and
dispatches many parallel subagents against a large store. The observable outcome is a
hard `ELOCKED` failure of a perfectly healthy ingest, reported to the operator as a
crashed-process lock.

The jitter itself is sound: `1 + floor(random() * 25)` is redrawn every attempt, so
contenders genuinely decorrelate and do not converge on a common tick. That part of
the docblock holds.

**Confidence: medium (reasoned; not reproduced at scale).**

### P3. "No half-refreshed prefix" holds for `RegionError` and for the deadline — not for a write failure or a crash

`src/core/brain/architect/generate.ts:239-244`, and the module docblock at `:19-23`

Planning-before-writing genuinely removes the two failure modes it names, and the
test at `architect.test.ts` ("a corrupted note aborts the run before any note is
written") is a real test of the `RegionError` case. But the write loop is still a
loop over N `atomicWriteFileSync` calls:

```ts
for (const plan of plans) {
  if (plan.text !== null) atomicWriteFileSync(plan.path, plan.text);
  progress.advance(ARCHITECT_STAGE.render);
}
```

An `ENOSPC` / `EACCES` / `EIO` on the k-th write, or a SIGKILL, leaves k−1 notes
refreshed beside N−k+1 stale ones — the exact "half-refreshed tree" the module
docblock says the design prevents. The renderer's own comment concedes the shape of
this ("the write loop is the cheap part … that must not be left half-done") but
"must not" is an aspiration, not a mechanism. The header's flat claim at `:19-21`
overstates what the code delivers; scoping it to "a corrupted-sentinel abort" (which
the very next sentence does) would make it true.

**Confidence: medium-high (reasoned; the loop is unambiguous).**

### P4. A second Ctrl-C leaves an ingest lock nothing reclaims

`src/cli/interrupt.ts:91` (`process.once`) + `src/core/brain/sync-lockfile.ts:43`
(`process.on("exit")`)

`process.on("exit")` runs on a normal exit and on `process.exit()`. It does **not**
run when the default SIGINT/SIGTERM disposition terminates the process. `onInterrupt`
uses `process.once` deliberately, so the second interrupt falls through to that
default — which is the right call for a hung synchronous pass, and is exactly when a
process is most likely to be inside `Bun.sleepSync` holding or waiting on a lock.

The result is a `.lock` on disk that:

- nothing breaks on a timer — unlike `src/core/search/store/writer-lock.ts:18`,
  which gives the *search* writer lock a 60-second stale window so "a SIGKILL never
  wedges the index for longer than this window";
- `brain doctor` cannot see, for the manifest and checkpoint (C3);
- now costs 5 seconds of frozen process per attempt before failing (C1).

The asymmetry is worth naming: this branch added a stale-aware advisory probe to the
lock that already self-heals, and added retrying waits to the lock that does not.

**Confidence: medium-high (mechanism verified; the exact Bun signal disposition not
re-tested here).**

### P5. The ceiling registry never evicts, and a conflict surfaces mid-run

`src/core/search/embeddings/provider-semaphore.ts:59`, `:92-106`

`const ceilings = new Map<string, Semaphore>()` has no eviction. In a long-lived MCP
server that switches vaults (`brain_switch_vault`) or whose config changes model,
base URL or dimension, entries accumulate for the process lifetime, each retaining
its `waiters` array. Bounded in practice by the number of distinct configurations
seen, which is small — but "small" is a property of usage, not of the code, and the
module is explicitly about process-lifetime state.

Separately: `providerSemaphore` is called from inside `embed()`
(`openai-compat.ts:288`, `zeroentropy.ts:115`), so a ceiling conflict is raised after
batching has already been computed, on whichever `embed()` happens to be second. The
refusal is explicit and names `embedding_concurrency` (good), but it fires at an
arbitrary point in a run rather than at config resolution, where "two live
configurations disagree" is actually decidable.

**Confidence: medium (reasoned).**

### P6. The benchmark ceiling test asserts the gate's own counter, and that counter is never reset

`src/core/search/benchmark.ts:47`, `:55-57`;
`tests/core/search/benchmark-concurrency.test.ts:61`

`expect(_benchmarkQueryPeakForTests()).toBe(BENCHMARK_QUERY_CONCURRENCY)` reads
`queryGate.peakInFlight` — the semaphore's own bookkeeping, not the number of
`search()` calls actually overlapping. A production change that took a permit and
released it *before* calling `search()` would still saturate the counter to 8 while
bounding nothing. The honest instrument is the one the embedding test uses: a probe
inside the thing being bounded (`embeddings.concurrency-ceiling.test.ts:119-135`
counts in-flight HTTP requests at the server).

Also, `peak` is a process-lifetime high-water mark on a module-scoped semaphore with
no reset hook — deliberate for `tuneRecall`, but it means the assertion is
order-dependent if any other test in the same process ever exercises the benchmark
first.

**Confidence: medium (reasoned).**

### P7. `sweepJournal`'s "the one point where no other writer can race the journal" is not true, and this branch added another unleased writer

`src/core/brain/maintenance/lane.ts:300-302`, `journal.ts:92-102`, `lane.ts:215-234`

`sweepJournal` is a read → write-temp → rename. `appendJournal` is `O_APPEND`, which
is safe against *other appends* but not against a concurrent rewrite: a line appended
between the sweep's `readLines` and its `renameSync` is lost.

Gate-refusal rows are appended **before** `acquireLease` — that is the design
(`journal.ts:83-87` says so). So a second lane process that is gate-refused while a
first holds the lease and sweeps can lose its row. This branch adds one more unleased
append to that window: the `pressure:unmeasurable` notice at `lane.ts:219-226`, which
is written on *every* invocation on a host where the metric is degenerate (any
container with a CPU quota — `host-pressure.ts:210-212`).

Impact is observability only: task-outcome rows, which are the streak's input, are
written under the lease by the same process that sweeps, so the decision input is not
corrupted. Still, the comment asserts a property the code does not have, on a file
that this branch has just made load-bearing for a refusal decision.

**Confidence: medium (reasoned).**

### P8. A killed lease holder wedges the lane for 30 minutes, and `--force` is documented not to help

`src/core/brain/maintenance/lease.ts:59-83`, `lane.ts:213` (`MAINTENANCE_LEASE_TTL_MS`)

The lease self-frees by expiry, which is the right design, and the holder string
includes `@${process.pid}` (`cli/brain/verbs/maintenance.ts:129-131`) so two
processes cannot accidentally share a holder and both "re-entrantly renew" into
mutual-exclusion loss. Good.

But the TTL is 30 minutes and `--force` deliberately does not bypass the lease. There
is no `maintenance release` verb — `src/cli/brain/verbs/maintenance.ts` exposes `run`
and `status` only. After a SIGKILLed lane, the operator's options are to wait up to
30 minutes or to delete `<vault>/.open-second-brain/maintenance.sqlite` by hand. That
is the "manual file surgery" the review brief asks about; it is pre-existing, but the
branch's new streak refusal makes forced runs a routine operator action and therefore
makes this reachable more often.

**Confidence: medium (reasoned; pre-existing).**

### P9. `acquireLockSync` says the doctor reads the lock body; it does not

`src/core/brain/sync-lockfile.ts:85-87` vs
`src/core/brain/doctor/uncertainty-probes.ts:132-147`

> The contents are purely diagnostic — the doctor surface reads them when reporting
> stale locks.

`staleLockProbe` emits `{ code, path, message }` and never opens the file. The pid
and timestamp stamped into every lock — the two facts an operator needs to decide
whether a lock is abandoned, which is the judgment the probe explicitly delegates to
them — are written and then thrown away. Pre-existing, but it is the second load the
new retry docblock puts on a doctor surface that is weaker than advertised (see C3).

**Confidence: high on the mismatch, low on impact.**

---

## Checked and found sound

- **`acquireLockSyncWithRetry`'s core contract.** Only `ELOCKED` is retried; every
  other error propagates on the first attempt; the sole `return` is a successful
  `acquireLockSync`, so **there is no path that proceeds unlocked**. The expired
  budget rethrows the original error, which carries `code === "ELOCKED"`, `.path`,
  and a message naming the lock file — verified directly. `budgetMs <= 0` degrades
  cleanly to a single attempt (the deadline check runs after the first try). The
  jitter is redrawn per attempt and genuinely decorrelates contenders.
  (Bounds: C1, C2, P2.)

- **All three ingest sites lock the *whole* read-modify-write, not just the write.**
  Verified line by line: `content-manifest.ts:236-248` (spread of `readManifest`
  inside), `checkpoint.ts:187-206` (`readCheckpoint` + union + write inside),
  `git/store.ts:191-197` (`readRecords` + dedup + append inside, via the extracted
  `appendGitRecordsLocked`). No lost-update window remains at any of the three.

- **`tests/core/brain/ingest/concurrent-shared-writes.test.ts` creates real
  contention and would have caught the pre-fix code.** Four real `bun` children, a
  shared wall-clock start instant with a 1.5 s lead and a `Bun.sleepSync(1)` spin
  barrier — the docblock at `:61-66` names process-startup stagger as the thing the
  barrier defeats, which is the right worry, correctly addressed. Reproduced: with
  the lock neutralised, 4 of the 5 tests fail —

  ```
  (fail) updateManifest   … missing 75 of the expected entries
  (fail) recordCompleted  … 75 completed items lost
  (fail) appendGitRecords … the shared sha landed twice, not once
  (fail) acquireLockSyncWithRetry — an expired budget is loud
  ```

  This is the strongest test work on the branch. (Caveat: C10.)

- **The `Semaphore` hand-off fix is correct for the interleaving it targets.** The
  releaser transfers its permit directly and the resumed acquirer does not decrement
  again, so the permit is never observable as free between the wake and the
  continuation. A fresh `acquire()` arriving in the same synchronous turn as the
  release queues instead of stealing. Reproduced: reverting to the pool form
  (`permits++` on release, `permits--` after the await) makes
  `embeddings.concurrency-ceiling.test.ts:26` go red with `peak = 2` against a
  ceiling of 1. The test is a real test. No permit is leaked on a throw at any call
  site — all three use `try/finally` — and no waiter can be stranded: every queued
  waiter is resolved by some `release()`, and the abort paths in `openai-compat.ts`
  and `zeroentropy.ts` check `cancel.signal.aborted` *after* acquiring and still fall
  through the `finally`. (Bounds: C4.)

- **The process-wide ceiling actually spans the process, and its test proves it.**
  Reproduced: forcing `providerSemaphore` back to `new Semaphore(limit)` per call
  makes 4 of the 9 ceiling tests fail, including both of the "two overlapping
  `embed()` calls share one budget" cases and the ZeroEntropy mirror. The key is
  correctly built from the **configured** dimension rather than `provider.dimension`,
  which does prevent the ceiling from moving when the dimension is learned from the
  first response; excluding the API key is right, both for the rotation reason given
  and for not parking a secret in a process-lived map key. A conflicting limit is
  refused rather than reconciled, and the refusal names `embedding_concurrency`.
  (Bounds: C7, P5.)

- **`isWriterLockHeld` is honest.** Same `stale` window and same `realpath: false` as
  both acquire paths, so its answer agrees with what an acquire would do; it does not
  collapse a stat failure to `false`; and `ensure-current.ts:130-140` correspondingly
  records the probe failure into `errors` and spawns anyway rather than silently
  declining. The docblock's "ADVISORY, and only that" is accurate about what the
  function guarantees. (Bounds: P1, on how much the advisory buys.)

- **`self-heal-reindex.ts` picks the right surface for the right reason.** The
  argument for the metrics JSONL over the maintenance journal (run-level rows,
  `O_APPEND` single lines, no lock on the hook path, and a journal whose verdict
  vocabulary genuinely does not fit) holds up against both files. The fail-soft
  `append()` on a server-start path is the right trade. The child records `failed`
  before rethrowing, so the row survives whatever the caller's stderr points at, and
  a stopped rebuild is correctly recorded as a rebuild that did not happen — the
  staging database is abandoned and never swapped in. `--self-heal` changes nothing
  about the rebuild itself. (Bounds: C8, C9.)

- **`host-pressure.ts` refuses instead of inventing.** Two-state reading; every
  refusal reason named; the refusals are checked before the arithmetic; the gate is
  left **open** on `unmeasurable` and the reason is journaled on its own line, so a
  degenerate metric never reads as a quiet host. `evaluateGates` probes the host only
  after window and busy have passed, so a closed earlier gate honestly leaves no
  reading. The tests inject `readPressure` and assert the measurement count, so
  "never measures when unconfigured" and "never probes behind a closed gate" are both
  real assertions.

- **The streak's counting rules are right, even where its policy is not.** A success
  ends the walk; gate refusals, lease skips and `refused:streak` rows are all skipped
  because they are not `verdict === run`, so a refusal provably cannot deepen the
  streak it reports (`journal.ts:141-150`, asserted at
  `maintenance.test.ts` "A refusal is not an attempt"); a `run` row with no `ok`
  stops the walk, erring toward running. The streak is read inside the lease, so it
  cannot race another lane. `MAINTENANCE_FAILURE_STREAK_LIMIT_MIN = 1` makes the
  `limit = 0` brick-the-lane case unreachable through config. (Bounds: C6.)

- **The maintenance lease itself.** Single conditional upsert with a read-back
  confirmation, so two processes cannot both win; a positive-TTL guard with an
  explicit rationale for why a zero TTL would silently destroy mutual exclusion;
  holder strings carry the pid so re-entrant renewal cannot be triggered by two
  different processes; `releaseLease` is in a `finally` and is holder-scoped.
  (Bounds: P8.)

- **The benchmark gate is module-scoped for the correct reason** — `tuneRecall`'s
  24-way grid would otherwise bound each call at 8 while the process ran 192 — and
  `queryGate.acquire()` sits outside the `try` with `release()` inside the `finally`,
  which is the right shape (a failed acquire must not release). (Bounds: P6.)

- **`requireCap` is a genuine improvement.** The old `Math.max(1, cap | 0)` really did
  wrap a ceiling above 2^31−1 negative and then clamp it to 1 — the largest ceiling an
  operator can configure becoming the smallest possible. The test at
  `embeddings.concurrency-ceiling.test.ts:68-76` pins it with a reachable value, and
  the refusals at `:78-83` cover 0, negative, fractional and NaN. Folding the
  concurrency cap into the same `CAP_FIELD` vocabulary is DRY done right.

---

## What I did not cover

Progress plumbing, the MCP progress-token work, the sunset/doctor checks, the bench
failure-mode fixtures, install/ownership and the census tests — all outside the
concurrency, locking and durability scope.

Note for whoever reads this next: at review time the working tree also carried
unrelated uncommitted edits to `tests/core/doctor.test.ts`,
`tests/mcp/config-read-failure-tools.test.ts` and `tests/mcp/mcp.test.ts` from
concurrent work by another author. They are not mine and I did not touch them.
