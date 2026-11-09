/**
 * `o2b store path`: where the brain store, its partitions and the
 * device-local state directory are, which setting put each there, and
 * whether each exists. A store that does not exist yet is a report, not a
 * failure (exit 0, naming `o2b store init`, the way `o2b search status`
 * treats a missing index); a store root that cannot be used is exit 1.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NEXT_COMMAND_KEY } from "../../src/core/brain/next-step.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-path-"));
  root = join(parent, "store");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
  };
}

interface PathReport {
  ok: boolean;
  root: { path: string; origin: string; exists: boolean };
  initialized: boolean;
  store_id: string | null;
  partitions: Array<{ name: string; path: string; held: boolean; exists: boolean }>;
  device_state_dir: { scope: string; path: string; origin: string; exists: boolean };
  view_target: { path: string | null; origin: string; exists: boolean; error: string | null };
  error: string | null;
  [NEXT_COMMAND_KEY]?: string;
}

describe("o2b store path", () => {
  test("a store that does not exist yet prints its resolved paths, says so, and names the init", async () => {
    const r = await runCli(["store", "path"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(root);
    expect(r.stdout).toContain("(env, missing)");
    expect(r.stdout).toContain(join(root, "shared"));
    expect(r.stdout).toContain(join(parent, "state"));
    expect(r.stdout).toContain("does not exist yet");
    expect(r.stdout).toContain("o2b store init");
    expect(existsSync(root)).toBe(false);
  });

  test("--json carries every path with its origin and existence, and the next command", async () => {
    const r = await runCli(["store", "path", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const body = JSON.parse(r.stdout) as PathReport;
    expect(body.ok).toBe(true);
    expect(body.root).toEqual({ path: root, origin: "env", exists: false });
    expect(body.initialized).toBe(false);
    expect(body.store_id).toBeNull();
    expect(body.partitions.map((p) => [p.name, p.path, p.held])).toEqual([
      ["shared", join(root, "shared"), false],
      ["private", join(root, "private"), false],
    ]);
    expect(body.device_state_dir).toMatchObject({ scope: "all-stores", origin: "env" });
    expect(body[NEXT_COMMAND_KEY]).toBe("o2b store init");
  });

  test("an initialized store names its id, the partitions held, and its own state directory", async () => {
    const { storeId } = initStore({ root, partitions: ["shared"] });
    const text = await runCli(["store", "path"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain(storeId);
    expect(text.stdout).toContain(`${join(root, "shared")} (held)`);
    expect(text.stdout).not.toContain("o2b store init");

    const json = JSON.parse((await runCli(["store", "path", "--json"], { env: env() })).stdout);
    const body = json as PathReport;
    expect(body.initialized).toBe(true);
    expect(body.store_id).toBe(storeId);
    expect(body.partitions.map((p) => [p.name, p.held])).toEqual([
      ["shared", true],
      ["private", false],
    ]);
    expect(body.device_state_dir.scope).toBe("store");
    expect(body.device_state_dir.path.endsWith(storeId)).toBe(true);
    expect(body[NEXT_COMMAND_KEY]).toBeUndefined();
  });

  test("a store root inside the vault prints the paths and the refusal, exit 1", async () => {
    const vault = join(parent, "vault");
    mkdirSync(vault);
    root = join(vault, "store");
    writeFileSync(join(parent, "config.yaml"), `vault: ${vault}\n`);
    const r = await runCli(["store", "path", "--json"], { env: env() });
    expect(r.returncode).toBe(1);
    const body = JSON.parse(r.stdout) as PathReport;
    expect(body.ok).toBe(false);
    expect(body.root.path).toBe(root);
    expect(body.error).toContain("inside the vault");
  });

  test("an unexpected argument is a usage error", async () => {
    const r = await runCli(["store", "path", "extra"], { env: env() });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unexpected argument");
  });

  test("the view target is printed with its origin and existence, and is none when unset", async () => {
    const none = await runCli(["store", "path", "--json"], { env: env() });
    expect((JSON.parse(none.stdout) as PathReport).view_target).toEqual({
      path: null,
      origin: "none",
      exists: false,
      error: null,
    });
    const noneText = await runCli(["store", "path"], { env: env() });
    expect(noneText.stdout).toContain("view target:  none");

    const view = join(parent, "pages");
    mkdirSync(view);
    writeFileSync(join(parent, "config.yaml"), `view_target: ${view}\n`);
    const json = await runCli(["store", "path", "--json"], { env: env() });
    expect((JSON.parse(json.stdout) as PathReport).view_target).toEqual({
      path: view,
      origin: "config",
      exists: true,
      error: null,
    });
    const text = await runCli(["store", "path"], { env: env() });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain(`view target:  ${view} (config, exists)`);
  });
});
