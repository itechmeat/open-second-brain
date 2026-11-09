/**
 * Child process for the crash tests: runs the migration or the rollback of
 * `vault` and kills ITSELF with SIGKILL at a fixed point, the way a power
 * loss or a closed terminal ends a run: no `finally`, no gate release, no
 * state save. The parent then inspects what a real kill leaves behind.
 *
 * The kill point comes through the fault-injection hooks: a kill sent from
 * the parent cannot land on a chosen item, because the fixture migrates in
 * milliseconds.
 *
 * argv: <migrate|rollback> <vault> <killAt>
 * The environment (store root, state, device id, config) is the parent's.
 */
import { runMigration } from "../../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../../src/core/store-migration/outcome.ts";

const [mode, vault, killAtText] = process.argv.slice(2) as [string, string, string];
const killAt = Number(killAtText);
const kill = (n: number): void => {
  if (n === killAt) process.kill(process.pid, "SIGKILL");
};

if (mode === "migrate") {
  runMigration(vault, { settleMs: 0, hooks: { afterItemAppended: kill } });
} else if (mode === "rollback") {
  rollback(vault, { hooks: { afterReplayed: kill } });
} else {
  throw new Error(`unknown mode ${mode}`);
}
// Reaching this line means the kill point was never met.
process.exit(3);
