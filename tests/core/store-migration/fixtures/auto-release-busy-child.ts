/**
 * Child process for the failure table's column "the gate release meets a
 * busy gate lock": runs one automatic attempt on `vault`. At the named step
 * boundary it writes the `take` file, which tells the lock holder the test
 * process started (`gate-lock-holder-child.ts`) to take the gate lock, and
 * waits until it holds it; then it throws there (`throw`), or lets the run
 * go on to its end (`end`). Either way the attempt's own release of the gate
 * meets the busy lock, leaves the gate, and the attempt ends; this process
 * then exits, so the gate's holder is gone, as a worker's is after it ends.
 *
 * The holder is not spawned here: on Windows a child that is not detached
 * is ended together with this process, so it would die with the lock still
 * taken and never let it go itself.
 *
 * The step comes through the worker's fault-injection hooks, an in-process
 * option the CLI entry never passes.
 *
 * argv: <vault> <configPath> <step> <throw|end> <marker> <take> <ready>
 * Exit codes: 0 the attempt ended; 4 the holder never held the lock.
 * The environment (store root, state directories, device id) is the parent's.
 */
import { existsSync, writeFileSync } from "node:fs";

import { runAutoStoreMigration } from "../../../../src/core/store-migration/auto-worker.ts";

const [vault, configPath, step, mode, marker, take, ready] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const lockElsewhere = (): void => {
  writeFileSync(take, step);
  // The holder takes the lock within its 5 s budget or not at all.
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(ready)) {
    process.stderr.write(`the lock holder did not hold the gate lock within 10 s of ${step}\n`);
    process.exit(4);
  }
  writeFileSync(marker, step);
  if (mode === "throw") throw new Error(`fault injection: ${step}`);
};

const run = runAutoStoreMigration(vault, {
  configPath,
  settleMs: 0,
  hooks: {
    atStep: (at) => {
      if (at === step) lockElsewhere();
    },
    afterItemAppended: () => {
      if (step === "convert" && !existsSync(marker)) lockElsewhere();
    },
    beforeVerify: () => {
      if (step === "verify") lockElsewhere();
    },
  },
});
writeFileSync(marker, `${step} ${run.outcome}`);
