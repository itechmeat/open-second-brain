import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
} from "../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-fs-atomic-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  test("writes new file and overwrites existing", () => {
    const target = join(tmp, "x.md");
    atomicWriteFileSync(target, "first");
    expect(readFileSync(target, "utf8")).toBe("first");
    atomicWriteFileSync(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("creates parent directories", () => {
    const target = join(tmp, "a", "b", "c.md");
    atomicWriteFileSync(target, "deep");
    expect(readFileSync(target, "utf8")).toBe("deep");
  });

  test("leaves no orphaned temp file on success", () => {
    const target = join(tmp, "x.md");
    atomicWriteFileSync(target, "hi");
    const stragglers = readdirSync(tmp).filter((n) => n.startsWith(".") && n.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });
});

describe("atomicCreateFileSyncExclusive", () => {
  test("creates a new file", () => {
    const target = join(tmp, "x.md");
    atomicCreateFileSyncExclusive(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("throws EEXIST on an existing file", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "preexisting");
    expect(() => atomicCreateFileSyncExclusive(target, "new")).toThrow();
    try {
      atomicCreateFileSyncExclusive(target, "new");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
    expect(readFileSync(target, "utf8")).toBe("preexisting");
  });

  test("removes its temp inode after EEXIST", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "preexisting");
    try {
      atomicCreateFileSyncExclusive(target, "new");
    } catch {
      // expected
    }
    const stragglers = readdirSync(tmp).filter((n) => n.startsWith(".") && n.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  test("removes its temp inode after success", () => {
    const target = join(tmp, "x.md");
    atomicCreateFileSyncExclusive(target, "ok");
    expect(existsSync(target)).toBe(true);
    const stragglers = readdirSync(tmp).filter((n) => n.startsWith(".") && n.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  test("creates parent directories", () => {
    const target = join(tmp, "a", "b", "c.md");
    atomicCreateFileSyncExclusive(target, "deep");
    expect(readFileSync(target, "utf8")).toBe("deep");
  });
});
