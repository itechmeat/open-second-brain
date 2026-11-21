/**
 * `o2b brain attest sign` on a switched vault with no `Brain/` tree. The
 * manifest an attestation signs measures the legacy log's chain heads and
 * the ledger folders under `Brain/`; once the brain lives in the store
 * none of them exists, so a signature would vouch for a manifest that
 * holds nothing of the brain. The sign refuses by name instead of
 * writing such a record.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { listAttestationRecordFiles } from "../../src/core/brain/attestation/record.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("attest sign refuses on a switched vault whose legacy log is gone", async () => {
  env = makeStoreEnv("osb-attest-store-only-", { legacyTree: false });
  const cliEnv = {
    OPEN_SECOND_BRAIN_CONFIG: env.configPath,
    [STORE_ROOT_ENV]: env.storeRoot,
    O2B_DEVICE_ID: "dev-a",
    HOME: join(env.parent, "home"),
    XDG_STATE_HOME: join(env.parent, "state"),
    LOCALAPPDATA: join(env.parent, "state"),
  };
  // An empty stdin: no passphrase, and the CLI never waits on the pipe.
  const keygen = await runCli(["brain", "attest", "keygen", "--vault", env.vault], {
    env: cliEnv,
    stdin: "",
  });
  expect(keygen.returncode).toBe(0);

  const sign = await runCli(["brain", "attest", "sign", "--vault", env.vault], {
    env: cliEnv,
    stdin: "",
  });
  expect(sign.returncode).not.toBe(0);
  expect(sign.stderr).toContain("nothing of the brain");
  expect(listAttestationRecordFiles(env.vault)).toEqual([]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});
