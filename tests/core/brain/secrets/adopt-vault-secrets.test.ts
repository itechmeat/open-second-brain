/**
 * Secrets a vault gained after its state moved out of it (review finding
 * R2A-43): on a vault with no `Brain/` tree the machine state lives in the
 * device-local state, seeded once from the vault. Secrets an older release
 * writes into the vault later are adopted on the next read, whole or not at
 * all: an adoption that fails leaves no half-filled folder that would pass
 * as done, and the next read adopts them.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DERIVED_STORE_DIR } from "../../../../src/core/brain/path-constants.ts";
import { secretsDir } from "../../../../src/core/brain/secrets/store.ts";
import { machineStatePath } from "../../../../src/core/state/machine-state.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test.skipIf(CHMOD_CANNOT_DENY)("a failed adoption leaves nothing, and the next read adopts", () => {
  env = makeStoreEnv("osb-secrets-adopt-", { legacyTree: false });
  // The state moves out of the vault and is seeded before any secret exists.
  mkdirSync(join(env.vault, DERIVED_STORE_DIR), { recursive: true });
  writeFileSync(join(env.vault, DERIVED_STORE_DIR, "bootstrap.json"), "{}");
  const relocated = machineStatePath(env.vault, DERIVED_STORE_DIR, "secrets");
  const legacy = join(env.vault, DERIVED_STORE_DIR, "secrets");
  expect(relocated).not.toBe(legacy);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "keyfile"), "key-bytes");
  writeFileSync(join(legacy, "secrets.json"), "{}");
  chmodSync(join(legacy, "secrets.json"), 0o000);
  try {
    expect(() => secretsDir(env!.vault)).toThrow();
    // No half-adopted folder: a later key mint would otherwise replace the key.
    expect(existsSync(relocated)).toBe(false);
  } finally {
    chmodSync(join(legacy, "secrets.json"), 0o600);
  }
  const dir = secretsDir(env.vault);
  expect(readFileSync(join(dir, "keyfile"), "utf8")).toBe("key-bytes");
  expect(readFileSync(join(dir, "secrets.json"), "utf8")).toBe("{}");
});
