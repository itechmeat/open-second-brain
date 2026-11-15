/**
 * Test helper: one topic-planning pass in a process of its own, against
 * the simulated machine whose store root and device-local base the
 * arguments name. It waits for the start file, so several such processes
 * plan at the same moment. Prints the report (or the error) and the time
 * it finished as JSON.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openStore } from "../../../../src/core/store/store-open.ts";
import { runTopicPlanning } from "../../../../src/core/topics/planning.ts";

const [root, device, parent, start] = process.argv.slice(2) as [string, string, string, string];
const store = openStore({
  root,
  device,
  dirs: {
    platform: process.platform,
    home: join(parent, "home", device),
    env: {
      XDG_STATE_HOME: join(parent, "state", device),
      LOCALAPPDATA: join(parent, "state", device),
    },
  },
});
const deadline = Date.now() + 20_000;
while (!existsSync(start) && Date.now() < deadline) Bun.sleepSync(5);
// Tell the parent this process is about to plan (and so to wait on the lock).
writeFileSync(`${start}.${process.pid}`, "");
let out: Record<string, unknown>;
try {
  out = { report: runTopicPlanning(store, { agent: "dream" }) };
} catch (err) {
  out = { error: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`${JSON.stringify({ ...out, end: Date.now() })}\n`);
