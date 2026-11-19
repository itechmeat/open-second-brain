/**
 * Child process for the gate ownership test: takes this machine's
 * migration gate on `vault` for the run `runId` (as a live migration run
 * does), writes the `ready` file, and stays alive holding it until the
 * `done` file appears or its deadline passes. The environment (state
 * directories) is the parent's, so it is the same gate.
 *
 * argv: <vault> <runId> <ready> <done>
 */
import { existsSync, writeFileSync } from "node:fs";

import { holdGateFor } from "../../../../src/core/store-migration/quiesce.ts";

const [vault, runId, ready, done] = process.argv.slice(2) as [string, string, string, string];
holdGateFor(vault, runId);
writeFileSync(ready, String(process.pid));
const deadline = Date.now() + 25_000;
while (!existsSync(done) && Date.now() < deadline) Bun.sleepSync(10);
