/**
 * The migration bench gives the process environment back whatever order
 * its benches end in.
 *
 * Two benches made in one file end in the order their `afterAll` hooks
 * were registered, oldest first. A bench that put back what it saw when
 * it was made then restored the older bench's paths after the older bench
 * had removed them, and every later file of the process booted a brain
 * from a config that no longer existed.
 */
import { describe, expect, test } from "bun:test";

import { makeMigrationBench } from "./fixtures/migration-env.ts";

const KEYS = ["OPEN_SECOND_BRAIN_CONFIG", "HOME", "XDG_STATE_HOME", "O2B_DEVICE_ID"] as const;

function snapshot(): Record<string, string | undefined> {
  return Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
}

describe("makeMigrationBench", () => {
  for (const order of ["oldest first", "newest first"] as const) {
    test(`two benches that end ${order} leave the environment as it was`, () => {
      const before = snapshot();
      const older = makeMigrationBench("osb-bench-older-");
      let newer: ReturnType<typeof makeMigrationBench> | null = null;
      try {
        newer = makeMigrationBench("osb-bench-newer-");
        expect(process.env["OPEN_SECOND_BRAIN_CONFIG"]).toBe(newer.env["OPEN_SECOND_BRAIN_CONFIG"]);
        const [first, second] = order === "oldest first" ? [older, newer] : [newer, older];
        first.cleanup();
        // The bench still alive keeps its own environment.
        expect(process.env["OPEN_SECOND_BRAIN_CONFIG"]).toBe(
          second.env["OPEN_SECOND_BRAIN_CONFIG"],
        );
        second.cleanup();
        expect(snapshot()).toEqual(before);
      } finally {
        newer?.cleanup();
        older.cleanup();
      }
    });
  }
});
