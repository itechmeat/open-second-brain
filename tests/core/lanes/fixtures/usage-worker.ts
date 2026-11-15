/**
 * Child process for the two-process procedural usage test, on the machine
 * the parent's environment names. `tick`: marks the procedure used once
 * per round. `reconcile`: reconciles the procedures folder once per round.
 *
 * Each worker writes `<ready dir>/<role>` once it is up and then waits for
 * the go file, so the two run at the same time. A go file that never comes
 * ends the worker after 30 s.
 *
 * argv: <vault> <role> <rounds> <entry id> <ready dir> <go file>
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  markProceduralMemoryUsed,
  reconcileProceduralMemory,
} from "../../../../src/core/brain/procedural-memory.ts";

const [vault, role, roundsText, id, readyDir, goFile] = process.argv.slice(2) as [
  string,
  "tick" | "reconcile",
  string,
  string,
  string,
  string,
];
writeFileSync(join(readyDir, role), "ready\n");
const deadline = Date.now() + 30_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    process.stderr.write("the go file never came\n");
    process.exit(2);
  }
  Bun.sleepSync(1);
}
for (let i = 0; i < Number(roundsText); i++) {
  if (role === "tick") markProceduralMemoryUsed(vault, id);
  else reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
}
