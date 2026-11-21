/**
 * A build's vault root that cannot be examined (a parent folder without
 * search permission) was reported as "vault not found", which sends the
 * operator looking for a moved vault instead of at the permission fault.
 * An unswitched machine already stops earlier, at the store-only "cannot
 * tell" check; a switched machine answers that check from its marker and
 * reached the root check, so the root check names the fault itself.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../store-migration/fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
let locked: string | null = null;
afterEach(() => {
  if (locked !== null) {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
    locked = null;
  }
  bench?.cleanup();
  bench = null;
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a switched machine's build names a vault it cannot examine, not a missing one",
  async () => {
    bench = makeMigrationBench("osb-index-unexaminable-");
    expect(runMigration(bench.vault, { settleMs: 0 }).ok).toBe(true);
    locked = mkdtempSync(join(tmpdir(), "osb-index-locked-"));
    const vault = join(locked, "vault");
    mkdirSync(vault);
    const config = resolveSearchConfig({
      vault,
      configPath: bench.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    chmodSync(locked, 0o000);
    await expect(indexVault(config)).rejects.toThrow(/vault cannot be examined \(EACCES\)/);
    chmodSync(locked, 0o755);
    expect(existsSync(join(vault, ".open-second-brain"))).toBe(false);
  },
);
