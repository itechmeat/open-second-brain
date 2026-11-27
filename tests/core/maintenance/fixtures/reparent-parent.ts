/**
 * A hook standing in for a session start hook that runs past its time
 * limit: it starts the worker stand-in through the spawn helper, prints
 * the pid the helper returned, and stays alive until it is signalled (or
 * for a minute).
 *
 * argv: <reparented|child> <stand-in script> <report file>
 */
import {
  spawnSelfDetached,
  spawnSelfDetachedChild,
} from "../../../../src/core/maintenance/o2b-command.ts";

const [mode, standin, report] = process.argv.slice(2) as [string, string, string];
const argv = [process.execPath, "run", standin, report];
const pid = mode === "child" ? spawnSelfDetachedChild(argv).pid : spawnSelfDetached(argv).pid;
process.stdout.write(`spawned:${pid}\n`);
setTimeout(() => {}, 60_000);
