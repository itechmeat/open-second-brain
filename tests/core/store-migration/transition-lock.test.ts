/**
 * A session killed during the transition import leaves the import lock
 * and its scratch file behind. The lock is judged by its holder's process,
 * as the dream queue's is: a holder that is gone is taken over at once,
 * not after half an hour, and its scratch file is removed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { SCRATCH_DIR } from "../../../src/core/store-migration/spill-map.ts";
import { importLateLegacyWrites } from "../../../src/core/store-migration/transition.ts";
import { homeEnv } from "../../helpers/platform.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench("osb-transition-lock-");
});
afterEach(() => bench.cleanup());

test("an import killed while it held the lock is taken over at once, and its scratch removed", () => {
  expect(runMigration(bench.vault, { settleMs: 0 }).ok).toBe(true);
  const store = bench.store();
  const dir = migrationDir(store);
  // A session takes the import lock and is killed: it never releases it.
  const transition = join(import.meta.dir, "../../../src/core/store-migration/transition.ts");
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const t = await import(${JSON.stringify(transition)}); ` +
        `t.acquireTransitionImportLock(${JSON.stringify(dir)}); process.kill(process.pid, "SIGKILL");`,
    ],
    env: { ...process.env, ...homeEnv(bench.storeRoot) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The child is dead: it did not exit by itself with code 0. The signal
  // it died of is SIGKILL on POSIX; Windows reports no signal for a killed
  // child, so the signal is asserted where it exists.
  expect(child.success).toBe(false);
  if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
  const scratch = join(dir, SCRATCH_DIR, `scratch-${child.pid}-abcd1234.sqlite`);
  mkdirSync(join(dir, SCRATCH_DIR), { recursive: true });
  writeFileSync(scratch, "left by the killed import");

  const result = importLateLegacyWrites(bench.vault, store, "test-agent", null, { waitMs: 0 });
  expect(result.converged).toBe(true);
  expect(existsSync(scratch)).toBe(false);
});
