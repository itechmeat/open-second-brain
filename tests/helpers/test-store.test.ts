/**
 * The explicit test store (task 2.10): the preload configures no store, and
 * a test whose writes go to the store gets one for its life.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendPinnedContext } from "../../src/core/brain/pinned.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { inspectStore } from "../../src/core/store/store-open.ts";
import { readPinned } from "../../src/core/store/read/pinned.ts";
import { StoreWriteError } from "../../src/core/store/store-write.ts";
import { makeTestStore } from "./test-store.ts";

describe("makeTestStore", () => {
  test("the preload's store root holds no store", () => {
    expect(inspectStore(process.env[STORE_ROOT_ENV]!)).toBeNull();
  });

  test("a bare vault's write lands in the test's store, and cleanup takes it back", () => {
    const before = process.env[STORE_ROOT_ENV];
    const vault = mkdtempSync(join(tmpdir(), "osb-test-store-vault-"));
    const store = makeTestStore();
    try {
      try {
        expect(process.env[STORE_ROOT_ENV]).toBe(store.root);
        appendPinnedContext(vault, "the test store holds this");
        expect(readPinned({ vault }).content).toContain("the test store holds this");
        expect(existsSync(join(vault, "Brain"))).toBe(false);
      } finally {
        store.cleanup();
      }
      expect(process.env[STORE_ROOT_ENV]).toBe(before);
      expect(existsSync(store.root)).toBe(false);
      // Without a store, the same store-only write fails with its reason.
      expect(() => appendPinnedContext(vault, "no store now")).toThrow(StoreWriteError);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
