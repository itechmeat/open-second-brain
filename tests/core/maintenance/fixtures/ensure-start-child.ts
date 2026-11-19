/**
 * Child process for the concurrent-start test: one session start on
 * `vault`, as the SessionStart hook or the MCP server runs it. It waits
 * for the barrier file so that every child starts at the same moment,
 * then prints the migration step's decision on stdout.
 *
 * Once its modules are loaded it writes `<barrier>.ready-<pid>`, so the
 * parent opens the barrier only when every child is ready: a child that
 * loads slowly cannot arrive after the first one's worker has finished.
 *
 * argv: <vault> <configPath> <barrier>
 * The environment (store root, state, device id) is the parent's.
 */
import { existsSync, writeFileSync } from "node:fs";

import { ensureVaultCurrent } from "../../../../src/core/maintenance/ensure-current.ts";

const [vault, configPath, barrier] = process.argv.slice(2) as [string, string, string];
writeFileSync(`${barrier}.ready-${process.pid}`, "");
// A parent that never opens the barrier (it failed first) must not leave
// this child waiting forever: it gives up after the test runner's timeout.
const deadline = Date.now() + 30_000;
while (!existsSync(barrier)) {
  if (Date.now() > deadline) {
    process.stderr.write("the barrier never opened\n");
    process.exit(2);
  }
  // eslint-disable-next-line no-await-in-loop
  await Bun.sleep(5);
}
const result = await ensureVaultCurrent(vault, { background: true, configPath });
process.stdout.write(`${result.migrationSpawn}\n`);
