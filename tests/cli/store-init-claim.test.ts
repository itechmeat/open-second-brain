/**
 * `o2b store init` and the view writer claim: a store created without the
 * shared partition takes no role and reports why, a re-run that adds the
 * shared partition takes it, and the JSON answer says whether this
 * device's switch was recorded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-init-claim-"));
  writeFileSync(join(parent, "config.yaml"), "");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
    [STORE_ROOT_ENV]: join(parent, "store"),
    O2B_DEVICE_ID: "dev-a",
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
  };
}

describe("o2b store init and the view writer", () => {
  test("a store with only the private partition is created and takes no role", async () => {
    const res = await runCli(["store", "init", "--partitions", "private", "--json"], {
      env: env(),
    });
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out["status"]).toBe("created");
    expect(out["viewWriter"]).toMatchObject({ claimed: false });
    expect(String((out["viewWriter"] as { message: string }).message)).toContain("shared");
  });

  test("a re-run that adds the shared partition takes the role", async () => {
    await runCli(["store", "init", "--partitions", "private"], { env: env() });
    const res = await runCli(["store", "init", "--json"], { env: env() });
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(out["status"]).toBe("completed");
    expect(out["viewWriter"]).toMatchObject({ claimed: true, device: "dev-a" });
  });

  test("the answer names the outcome of this device's switch record", async () => {
    // A half-made store first: the completing run is the one that answers twice.
    await runCli(["store", "init", "--partitions", "private"], { env: env() });
    const res = await runCli(["store", "init", "--json"], { env: env() });
    expect(JSON.parse(res.stdout)).toMatchObject({ fresh_switch: "recorded" });
  });

  test("a store made without the shared partition says the switch was not recorded", async () => {
    const res = await runCli(["store", "init", "--partitions", "private"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(res.stderr).toContain("holds no shared partition");
  });
});
