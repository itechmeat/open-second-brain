/**
 * Test helper: a brain store a test asks for explicitly (design D14 items
 * 1 and 16, task 2.10).
 *
 * The test preload (`tests/setup.ts`) gives every run a device id and a
 * store root that does not exist, so a test sees no store unless it makes
 * one. A test whose writes go to the store (a bare vault, a switched
 * machine, no vault at all) makes one here: `o2b store init` at a temp
 * root of its own, pointed at through `OPEN_SECOND_BRAIN_STORE_ROOT` for
 * the life of the test. `cleanup` restores the variable, forgets the
 * store-only switches this process saw, and removes the store.
 *
 * In-process `runCli` runs inherit the root (`./run-cli.ts` replaces only
 * the preload's shared default root), so a test's CLI runs and its direct
 * calls write the same store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetMachineStateCache } from "../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";

/**
 * Names the shared store root the preload points the suite at, so the CLI
 * harness (`./run-cli.ts`) can give each run that still uses it a root of
 * its own.
 */
export const DEFAULT_STORE_ROOT_ENV = "O2B_TEST_DEFAULT_STORE_ROOT";

export interface TestStore {
  /** The store root, `OPEN_SECOND_BRAIN_STORE_ROOT` until `cleanup`. */
  readonly root: string;
  cleanup(): void;
}

export interface TestStoreOptions {
  /** Partitions the store holds (default both). */
  readonly partitions?: ReadonlyArray<"shared" | "private">;
}

/** A store for this test, configured as the machine's store until `cleanup`. */
export function makeTestStore(
  prefix = "osb-test-store-",
  options: TestStoreOptions = {},
): TestStore {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const root = join(parent, "store");
  try {
    initStore({ root, partitions: options.partitions ?? ["shared", "private"] });
  } catch (err) {
    // No handle reaches the caller, so nothing else would remove the parent.
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }
  const saved = process.env[STORE_ROOT_ENV];
  process.env[STORE_ROOT_ENV] = root;
  forgetMachineStateCache();
  return {
    root,
    cleanup: () => {
      if (saved === undefined) delete process.env[STORE_ROOT_ENV];
      else process.env[STORE_ROOT_ENV] = saved;
      forgetMachineStateCache();
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
