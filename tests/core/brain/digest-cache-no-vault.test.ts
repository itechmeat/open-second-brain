/**
 * The no-vault digest cache is one copy: the hooks name a machine with no
 * vault by the stand-in root (`noVaultRoot`), the readers by `null`, and
 * both resolve to the same cached `active.md` and `lessons.md`.
 */
import { afterEach, expect, test } from "bun:test";

import { digestCachePath } from "../../../src/core/brain/compiled-digest-path.ts";
import { noVaultRoot } from "../../../src/core/platform-dirs.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("the stand-in root and no vault name the same cached digest", () => {
  env = makeStoreEnv("osb-digest-novault-", { legacyTree: false, configureVault: false });
  for (const digest of ["active", "lessons"] as const) {
    expect(digestCachePath(noVaultRoot(), digest)).toBe(digestCachePath(null, digest));
  }
});
