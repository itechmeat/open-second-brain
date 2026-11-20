/**
 * Child process of the rebuild test: rebuild the fixture's index the way a
 * background self-heal does, while the parent keeps searching it.
 *
 * With a signal and a gate path, the rebuild stops at its first indexed
 * file (it holds the writer lock by then, before the swap), creates the
 * signal file, and waits until the gate file exists. The parent reads the
 * index in that window, so a read during the rebuild is proved rather than
 * left to timing. The pause rides the indexer's own per-file callback; no
 * production code knows about it.
 *
 * The optional fourth argument pauses at that indexed file instead of the
 * first, so the files before it are committed to the staging index.
 *
 * Usage: bun store-rebuild-worker.ts <fixture parent> [<signal path> <gate path> [<file>]]
 */
import { existsSync, writeFileSync } from "node:fs";

import { healIndex } from "../../../../src/core/search/self-heal.ts";
import { fixtureConfig } from "./brain-store-index.ts";

const [parent, signal, gate, pauseAt] = process.argv.slice(2);
if (parent === undefined) throw new Error("usage: store-rebuild-worker.ts <fixture parent>");
let paused = false;
let files = 0;
const onFile = (): void => {
  files += 1;
  if (paused || signal === undefined || gate === undefined) return;
  if (files < Number(pauseAt ?? "1")) return;
  paused = true;
  writeFileSync(signal, "locked\n");
  // A parent that dies or times out never opens the gate: end rather than
  // stay behind holding the writer lock.
  const deadline = Date.now() + 30_000;
  while (!existsSync(gate)) {
    if (Date.now() > deadline) {
      process.stderr.write("the gate never opened\n");
      process.exit(2);
    }
    Bun.sleepSync(5);
  }
};
// `STORE_REBUILD_WORKER_RESUME=1` turns on resumable staging, as a
// machine config does, so a staging file an earlier run left is judged by
// its signature instead of discarded unread.
const config =
  process.env["STORE_REBUILD_WORKER_RESUME"] === "1"
    ? { ...fixtureConfig(parent), resumeReindex: true }
    : fixtureConfig(parent);
const outcome = await healIndex(config, { onFile });
process.stdout.write(`${JSON.stringify(outcome)}\n`);
