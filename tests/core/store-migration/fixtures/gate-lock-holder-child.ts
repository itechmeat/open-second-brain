/**
 * Child process for the gate lock tests: takes the lock beside this
 * machine's migration gate (the one every gate check, takeover and release
 * runs under), writes the `ready` file, and keeps the lock until the `done`
 * file appears or its deadline passes. The environment (state directories)
 * is the parent's, so it is the same lock.
 *
 * With a `take` path it first waits for that file, so another process can
 * say when the lock is to be taken while the test process stays this
 * holder's parent. On Windows a child is ended together with the process
 * that spawned it unless it is detached, so a holder spawned by a
 * short-lived process dies with it and never lets the lock go itself.
 *
 * argv: <ready> <done> [take]
 * Exit codes: 0 the lock was taken and let go; 5 `done` came before `take`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { migrationGatePath } from "../../../../src/core/migration-gate.ts";
import { acquireDirLock, STORE_LOCK_STALE_MS } from "../../../../src/core/store/local-lock.ts";

const [ready, done, take] = process.argv.slice(2) as [string, string, string | undefined];
// Bounded by the parent's own child timeouts; the parent writes `done`
// as soon as it no longer needs the lock.
const deadline = Date.now() + 90_000;
if (take !== undefined) {
  while (!existsSync(take) && !existsSync(done) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(take)) process.exit(5);
}
const target = migrationGatePath();
mkdirSync(dirname(target), { recursive: true });
const release = acquireDirLock(target, {
  staleMs: STORE_LOCK_STALE_MS,
  budgetMs: 5_000,
  label: "test gate lock",
  remedy: "the test holds it",
});
writeFileSync(ready, String(process.pid));
while (!existsSync(done) && Date.now() < deadline) Bun.sleepSync(10);
release();
