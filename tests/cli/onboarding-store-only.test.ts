/**
 * The onboarding checklist of a store-only machine: a fresh vault's
 * scaffold is the brain store (never `o2b brain init`, which would make
 * the machine a legacy one again), and a store that exists but cannot be
 * read points to the doctor, not to an init that would refuse it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildOnboardingChecklist } from "../../src/cli/onboarding.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const step = (vault: string | null, id: string, configPath: string) =>
  buildOnboardingChecklist(vault, { configPath }).steps.find((s) => s.id === id);

describe("onboarding on a store-only machine", () => {
  test("a fresh vault with a store is scaffolded; without one it is pointed at o2b init --vault", () => {
    env = makeStoreEnv("osb-onboard-fresh-", { legacyTree: false });
    expect(step(env.vault, "scaffold_brain", env.configPath)).toMatchObject({ done: true });
    env.cleanup();
    env = makeStoreEnv("osb-onboard-fresh-nostore-", { legacyTree: false, partitions: [] });
    const scaffold = step(env.vault, "scaffold_brain", env.configPath);
    expect(scaffold?.done).toBe(false);
    expect(scaffold?.command).toBe(`o2b init --vault "${env.vault}"`);
  });

  test("an unreadable store points to the doctor", () => {
    env = makeStoreEnv("osb-onboard-broken-", { legacyTree: false, configureVault: false });
    writeFileSync(join(env.storeRoot, "shared", "store.json"), "{");
    const created = step(null, "store_initialized", env.configPath);
    expect(created?.done).toBe(false);
    expect(created?.command).toBe("o2b doctor");
  });

  test("a fresh vault whose store cannot be read points to the doctor too", () => {
    env = makeStoreEnv("osb-onboard-fresh-broken-", { legacyTree: false });
    writeFileSync(join(env.storeRoot, "shared", "store.json"), "{");
    const scaffold = step(env.vault, "scaffold_brain", env.configPath);
    expect(scaffold?.done).toBe(false);
    expect(scaffold?.command).toBe("o2b doctor");
    expect(scaffold?.hint).toContain("cannot be read");
  });

  test.skipIf(process.platform === "win32")(
    "a vault path a shell would expand is quoted so the command runs as shown",
    () => {
      env = makeStoreEnv("osb-onboard-quote-", { legacyTree: false, partitions: [] });
      const odd = join(env.parent, "it's $HOME");
      const scaffold = step(odd, "scaffold_brain", env.configPath);
      expect(scaffold?.command).toBe(`o2b init --vault '${odd.replaceAll("'", "'\\''")}'`);
    },
  );
});
