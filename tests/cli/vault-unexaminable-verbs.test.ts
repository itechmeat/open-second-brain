/**
 * The read and write verbs on a vault whose `Brain/` cannot be examined (a
 * folder at mode 000: `stat` answers, every look inside it does not). They
 * used to answer from it as if it were empty (`brain query`, `brain
 * claims`, `brain pending list`, `brain export`), say every legacy entry
 * had a destination (`migrate-store --dry-run`), pass the doctor's vault
 * check, or crash with a stack. Each now names the vault in one line and
 * exits non-zero; the doctors report it as a failing check. The macOS
 * shape of the same condition (the realpath refused) is reproduced by spy
 * in tests/mcp/vault-unexaminable-realpath.test.ts.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | undefined;
afterEach(() => {
  if (env !== undefined) chmodSync(join(env.vault, "Brain"), 0o755);
  env?.cleanup();
  env = undefined;
});

/** An unswitched vault with a store, its Brain/ at mode 000. */
function lockedBrain(): StoreEnv {
  env = makeStoreEnv("osb-cli-brain-000-");
  chmodSync(join(env.vault, "Brain"), 0o000);
  return env;
}

function run(e: StoreEnv, args: ReadonlyArray<string>) {
  return runCli([...args], {
    env: {
      OPEN_SECOND_BRAIN_CONFIG: e.configPath,
      [STORE_ROOT_ENV]: e.storeRoot,
      O2B_DEVICE_ID: "dev-a",
    },
  });
}

describe.skipIf(CHMOD_CANNOT_DENY)("verbs on a Brain/ that cannot be examined", () => {
  test.each([
    { args: ["brain", "query", "--topic", "x"] },
    { args: ["brain", "claims"] },
    { args: ["brain", "pending", "list"] },
    { args: ["brain", "export", "--format", "llms-txt"] },
    { args: ["brain", "feedback", "--topic", "x", "--principle", "y", "--signal", "positive"] },
  ])("$args.0 $args.1 names the vault in one line and exits 1", async ({ args }) => {
    const e = lockedBrain();
    const r = await run(e, args);
    expect(r.returncode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cannot be examined (EACCES)");
  });

  test("migrate-store --dry-run lists the unreadable folders and does not pass", async () => {
    const e = lockedBrain();
    const r = await run(e, ["brain", "migrate-store", "--dry-run"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("Unreadable folders:");
    expect(r.stdout).not.toContain("Every legacy entry has a destination.");
  });

  test("both doctors report it as a failing check", async () => {
    const e = lockedBrain();
    const brainDoctor = await run(e, ["brain", "doctor"]);
    expect(brainDoctor.returncode).toBe(1);
    expect(brainDoctor.stdout).toContain("[ERROR]");
    expect(brainDoctor.stdout).toContain("Brain layer could not be read");
    const doctor = await run(e, ["doctor"]);
    expect(doctor.returncode).not.toBe(0);
    expect(doctor.stdout).toContain("[FAIL] vault_writeable");
    expect(doctor.stdout).toContain("cannot be examined (EACCES)");
  });
});
