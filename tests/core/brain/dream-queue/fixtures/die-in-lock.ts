/**
 * Child process for the dead-holder test: opens the store as one device
 * and is killed (SIGKILL, as a session ended at its budget is) while it
 * holds a lock: `queue` inside a take's queue lock, `run` inside the
 * run's lock.
 *
 * argv: <root> <device> <stateHome> <queue|run> <run id>
 */
import { dreamQueueOn, takeWork } from "../../../../../src/core/brain/dream-queue/queue.ts";
import { withDreamRunLock } from "../../../../../src/core/brain/dream-queue/run-record.ts";
import { openStore } from "../../../../../src/core/store/store-open.ts";
import { registerFixtureOperations } from "../../../../helpers/dream-queue-fixtures.ts";

const [root, device, stateHome, where, run] = process.argv.slice(2) as [
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
registerFixtureOperations();
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("still alive after SIGKILL");
};
if (where === "queue") {
  takeWork(dreamQueueOn(store, { vault: null, writer: "dying" }), {
    run,
    filter: () => die(),
  });
} else {
  withDreamRunLock(store.deviceStateDir, run, () => die());
}
process.stderr.write("the lock was never reached\n");
process.exit(3);
