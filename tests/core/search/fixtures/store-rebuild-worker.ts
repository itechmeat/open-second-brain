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
 * Usage: bun store-rebuild-worker.ts <fixture parent> [<signal path> <gate path>]
 */
import { existsSync, writeFileSync } from "node:fs";

import { healIndex } from "../../../../src/core/search/self-heal.ts";
import { fixtureConfig } from "./brain-store-index.ts";

const [parent, signal, gate] = process.argv.slice(2);
if (parent === undefined) throw new Error("usage: store-rebuild-worker.ts <fixture parent>");
let paused = false;
const onFile = (): void => {
  if (paused || signal === undefined || gate === undefined) return;
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
const outcome = await healIndex(fixtureConfig(parent), { onFile });
process.stdout.write(`${JSON.stringify(outcome)}\n`);
