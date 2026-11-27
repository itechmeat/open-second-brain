/**
 * A worker standing in for the automatic migration worker: its error
 * output is the device-local log (opened by `spawnSelfDetachedChild`), it
 * bounds that log as the worker does, then writes far more than the cap.
 *
 * argv: <log path> <lines>
 */
import { boundStderrToLog } from "../../../../src/core/store-migration/worker-log.ts";

const [path, lines] = process.argv.slice(2) as [string, string];
boundStderrToLog(process.stderr, path);
for (let i = 0; i < Number(lines); i++) {
  process.stderr.write(`line ${String(i).padStart(6, "0")} ${"x".repeat(180)}\n`);
}
process.stderr.write("the last line\n");
