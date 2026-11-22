/**
 * Child process for the two-process take test: opens the store as one
 * device, waits for the go file, then takes until the queue is empty and
 * prints every item id it leased, one per line.
 *
 * argv: <root> <device> <stateHome> <ready file> <go file>
 */
import { existsSync, writeFileSync } from "node:fs";

import { dreamQueueOn, takeWork } from "../../../../../src/core/brain/dream-queue/queue.ts";
import { openStore } from "../../../../../src/core/store/store-open.ts";
import { registerFixtureOperations } from "../../../../helpers/dream-queue-fixtures.ts";

const [root, device, stateHome, readyFile, goFile] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const store = openStore({
  root,
  device,
  dirs: {
    platform: process.platform,
    home: stateHome,
    env: { XDG_STATE_HOME: stateHome, LOCALAPPDATA: stateHome },
  },
});
const ops = registerFixtureOperations();
try {
  const queue = dreamQueueOn(store, { vault: null, writer: `worker-${process.pid}` });
  writeFileSync(readyFile, "ready\n");
  const deadline = Date.now() + 30_000;
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) {
      process.stderr.write("the go file never came\n");
      process.exit(2);
    }
    Bun.sleepSync(1);
  }
  const taken: string[] = [];
  for (let busy = 0; busy < 50;) {
    const result = takeWork(queue, { run: `run-${process.pid}` });
    if (result.item !== null) taken.push(result.item.id);
    else if (result.reason === "busy") busy += 1;
    else break;
  }
  process.stdout.write(`${taken.join("\n")}\n`);
} finally {
  ops.unregister();
}
