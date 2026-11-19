# Tasks: the automatic migration worker always starts, and says so when it cannot

Test first for every behaviour, each new test seen failing before the code.

## 1. The worker starts under the running runtime

- [x] 1.1 Reproduction: a start with no Bun on PATH under an absolute runtime
  path; the worker reaches its outcome.
- [x] 1.2 The self-spawn helper and its census over every self-spawn site.
- [x] 1.3 Every background child detached on every platform.

## 2. A worker that cannot run is seen

- [x] 2.1 The claim protocol: awaited and confirmed hand-overs; the lost
  worker in `decideClaim` and its table (invariants 9 and 10).
- [x] 2.2 The spawner and the next start record the failure; a spawn error
  is recorded; the worker's error output goes to a device-local log.
- [x] 2.3 Status, doctor and the session notice name a lost worker.

## 3. The cohort

- [x] 3.1 Device evidence over every shard naming scheme (table test).
- [x] 3.2 The transition report reads the cohort status; a census over the
  surfaces on one fixture with a device of each kind.
