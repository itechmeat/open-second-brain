/**
 * Child process for the automatic migration's failure table: runs one
 * automatic attempt (`runAutoStoreMigration`, the worker's own logic) on
 * `vault` and kills ITSELF with SIGKILL at the named step boundary, the
 * way a power loss or an OOM kill ends a worker: no `finally`, no lock
 * release, no state save.
 *
 * The kill point comes through the worker's fault-injection hooks, an
 * in-process option the CLI entry never passes; no flag, environment
 * variable or config key reaches them.
 *
 * Right before the kill it writes the step to `<marker>`, so the parent
 * knows the kill point was met, not only that the process died.
 *
 * argv: <vault> <configPath> <step> <marker>
 * The environment (store root, state directories, device id) is the parent's.
 */
import { writeFileSync } from "node:fs";

import { runAutoStoreMigration } from "../../../../src/core/store-migration/auto-worker.ts";

const [vault, configPath, step, marker] = process.argv.slice(2) as [string, string, string, string];
const kill = (): void => {
  writeFileSync(marker, step);
  process.kill(process.pid, "SIGKILL");
};

runAutoStoreMigration(vault, {
  configPath,
  // Nothing writes while it runs: no settle wait (see the table's FAST).
  settleMs: 0,
  hooks: {
    atStep: (at) => {
      if (at === step) kill();
    },
    afterItemAppended: () => {
      if (step === "convert") kill();
    },
    beforeVerify: () => {
      if (step === "verify") kill();
    },
  },
});
// Reaching this line means the kill point was never met.
process.exit(3);
