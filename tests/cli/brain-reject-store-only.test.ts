/**
 * `o2b brain reject` on a store-only machine: a preference the store does
 * not hold is not found there, and the refusal names no vault page.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function cli(args: ReadonlyArray<string>) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: env!.configPath } });
}

describe("o2b brain reject on a store-only machine", () => {
  test("an unknown preference is not found in the store, with no page path", async () => {
    env = makeStoreEnv("osb-reject-store-");
    switchDevice(env.storeRoot);
    const res = await cli(["brain", "reject", "--id", "pref-none", "--reason", "x"]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("preference not found: pref-none; expected in the brain store");
    expect(res.stderr).not.toContain(env.vault);
  });
});
