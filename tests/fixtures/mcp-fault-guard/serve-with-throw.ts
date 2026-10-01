/**
 * A process holding a real sync lock that then throws from a timer.
 *
 * Spawned by `tests/cli/mcp-fault-guard-spawn.test.ts`. The lock is taken
 * through the product's own lock module, whose `exit` hook unlinks every
 * held lock. The guard turns the uncaught exception into
 * `process.exit(70)`, which emits `exit`; the runtime default would not,
 * and the lock file would outlive the process.
 *
 * argv: <vault>; prints the lock path on stdout before throwing.
 */

import { join } from "node:path";

import { installMcpFaultGuard } from "../../../src/cli/mcp-fault-guard.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";

const vault = process.argv[2];
if (vault === undefined) throw new Error("usage: serve-with-throw.ts <vault>");

installMcpFaultGuard();
const lock = acquireLockSync(join(vault, "fault-guard-probe"));
process.stdout.write(`${lock.path}\n`);
setTimeout(() => {
  throw new Error("fixture exception from a timer");
}, 10);
// Keep the event loop alive the way a served transport would.
setInterval(() => {}, 1_000);
