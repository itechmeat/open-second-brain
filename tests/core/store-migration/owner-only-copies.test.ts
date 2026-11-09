/**
 * The migration copies secrets, signing keys and the rest of the
 * backup-class and device-local surfaces into the device-local state
 * (design D11 step 3, D14 item 6). Those copies are owner-only whatever
 * mode the source had: every folder the migration creates there is `0700`
 * and every copied file `0600` (POSIX; Windows gets the owner-only ACL of
 * the secrets module instead, which a mode test cannot observe).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function modesBelow(dir: string, out: Array<{ path: string; mode: number; dir: boolean }> = []) {
  const stat = lstatSync(dir);
  out.push({ path: dir, mode: stat.mode & 0o777, dir: stat.isDirectory() });
  if (stat.isDirectory()) for (const name of readdirSync(dir)) modesBelow(join(dir, name), out);
  return out;
}

describe("owner-only migration copies", () => {
  test.skipIf(IS_WINDOWS)("copied secrets and state are 0600 in 0700 folders", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    // A loose source: an older install, a restored backup.
    const secrets = join(a.vault, ".open-second-brain", "secrets");
    chmodSync(secrets, 0o755);
    chmodSync(join(secrets, "keyfile"), 0o644);
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);

    const dir = migrationDir(a.store());
    const copies = [...modesBelow(join(dir, "backup", "files")), ...modesBelow(join(dir, "local"))];
    expect(copies.some((c) => c.path.endsWith("keyfile"))).toBe(true);
    const loose = copies
      .filter((c) => (c.dir ? c.mode !== 0o700 : c.mode !== 0o600))
      .map((c) => `${c.path.slice(dir.length)} ${c.mode.toString(8)}`);
    expect(loose).toEqual([]);
  });
});
