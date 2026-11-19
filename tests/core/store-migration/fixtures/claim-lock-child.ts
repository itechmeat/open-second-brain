/**
 * Child process for the lock takeover race: waits for the barrier file,
 * claims the automatic migration's worker lock once, writes `claimed` or
 * `refused` to `<answers>/<pid>`, and stays alive until the `done` file
 * appears, so a claim it holds is a live holder's for the whole race. The
 * environment (state directories) is the parent's, so every child claims
 * the same lock.
 *
 * argv: <vault> <barrier> <answers dir> <done>
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimAutoMigrationLock } from "../../../../src/core/store-migration/auto-state.ts";

const [vault, barrier, answers, done] = process.argv.slice(2) as [string, string, string, string];
const deadline = Date.now() + 25_000;
while (!existsSync(barrier) && Date.now() < deadline) Bun.sleepSync(5);
const token = claimAutoMigrationLock(vault, new Date());
writeFileSync(join(answers, String(process.pid)), token === null ? "refused" : "claimed");
while (!existsSync(done) && Date.now() < deadline) Bun.sleepSync(10);
