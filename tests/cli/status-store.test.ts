/**
 * `o2b status` carries the same brain store block as `second_brain_status`
 * (design D12, task 2.11): `--json` gains a `store` object, and the human
 * output gains one line naming the store root and whether it exists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let vault: string;
let root: string;
let cfgPath: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "o2b-status-store-"));
  vault = join(parent, "vault");
  root = join(parent, "store");
  cfgPath = join(parent, "config.yaml");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  // Something to move, so a migration is offered.
  writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
  writeFileSync(cfgPath, `vault: ${vault}\n`);
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    XDG_STATE_HOME: join(parent, "state"),
    OPEN_SECOND_BRAIN_CONFIG: "",
    VAULT_DIR: "",
    O2B_DEVICE_ID: "dev-a",
  };
}

describe("o2b status store block", () => {
  test("--json carries the store block, with a migration available while Brain/ is there", async () => {
    const r = await runCli(["status", "--config", cfgPath, "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const store = JSON.parse(r.stdout).store as Record<string, unknown>;
    expect(store["root"]).toEqual({ path: root, origin: "env", exists: false });
    expect(store["initialized"]).toBe(false);
    expect(store["device_id"]).toBe("dev-a");
    expect(store["view_target"]).toEqual({
      path: null,
      origin: "none",
      exists: false,
      error: null,
    });
    expect(store["dual_write_enabled"]).toBe(false);
    expect(store["migration"]).toEqual({
      available: true,
      legacy_tree_present: true,
      store_exists: false,
      switched: false,
      next_commands: ["o2b store init", "o2b brain migrate-store --dry-run"],
    });
  });

  test("the human output names the store root and whether the store exists", async () => {
    const before = await runCli(["status", "--config", cfgPath], { env: env() });
    expect(before.returncode).toBe(0);
    expect(before.stdout).toContain(`store_root: ${root} (not created)`);

    const { storeId } = initStore({ root });
    const after = await runCli(["status", "--config", cfgPath], { env: env() });
    expect(after.stdout).toContain(`store_root: ${root} (store ${storeId})`);
  });
});
