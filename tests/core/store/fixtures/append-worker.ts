/**
 * Child process for the concurrent-append test: opens the store as one
 * device and appends `count` records, every third one large enough to
 * spill its body into a blob (all workers spill the SAME large body, so
 * they also race for one blob name).
 *
 * Every worker writes `<ready dir>/<worker>` once it is up and then waits
 * for the go file the parent writes when all are ready, so they append at
 * the same time rather than one after another as each process happens to
 * start, however slowly the runner starts them. A go file that never
 * comes ends the worker after 30 s instead of leaving it behind.
 *
 * argv: <root> <device> <stateHome> <worker> <count> <ready dir> <go file>
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../../src/core/store/appender.ts";
import { STORE_LINE_CAP_BYTES } from "../../../../src/core/store/constants.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";

const [root, device, stateHome, worker, countText, readyDir, goFile] = process.argv.slice(2) as [
  string,
  string,
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
// Above the line cap, so every third record spills into a blob.
const large = "x".repeat(STORE_LINE_CAP_BYTES * 2);
writeFileSync(join(readyDir, worker), "ready\n");
const deadline = Date.now() + 30_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    process.stderr.write("the go file never came\n");
    process.exit(2);
  }
  Bun.sleepSync(1);
}
for (let i = 0; i < Number(countText); i++) {
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "feedback",
    agent: `worker-${worker}`,
    body: i % 3 === 0 ? { large } : { worker, i },
  });
}
