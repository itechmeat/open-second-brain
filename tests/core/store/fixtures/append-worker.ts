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
 * comes ends the worker after 30 s instead of leaving it behind. A store
 * lock refusal (ELOCKED) is retried within a bound; see the append loop.
 *
 * With `small` as the last argument no record spills: every append is one
 * short line, so the workers hand the shard lock to each other as often as
 * they can (the Windows lock-release race).
 *
 * argv: <root> <device> <stateHome> <worker> <count> <ready dir> <go file> [small]
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../../src/core/store/appender.ts";
import { STORE_LINE_CAP_BYTES } from "../../../../src/core/store/constants.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";

const [root, device, stateHome, worker, countText, readyDir, goFile, bodies] = process.argv.slice(
  2,
) as [string, string, string, string, string, string, string, string?];
const spill = bodies !== "small";
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
// Six workers each firing their appends back to back is far more contention
// than the store lock's wait budget is sized for (one append per agent
// action, not a tight loop), and on a slow Windows runner a worker could
// lose every round past it with `store lock busy` (ELOCKED). That refusal
// is documented as retryable ("retry once the other writer finishes"), and
// it arrives before the record's line is written: the clock tick it may
// have spent is never reused and a spilled blob is content-addressed, so a
// retried append writes the same blob name and one new line. The worker
// therefore retries the refused append with a short randomized backoff,
// within a bound; what the test proves is the shard under concurrency
// (every record present once, unique ids and clocks, one blob, interleaving).
const RETRY_UNTIL_MS = 30_000;
for (let i = 0; i < Number(countText); i++) {
  const giveUpAt = Date.now() + RETRY_UNTIL_MS;
  for (;;) {
    try {
      appendRecord(store, {
        partition: "shared",
        stream: "events",
        kind: "feedback",
        agent: `worker-${worker}`,
        body: spill && i % 3 === 0 ? { large } : { worker, i },
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() > giveUpAt) throw err;
      Bun.sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
}
