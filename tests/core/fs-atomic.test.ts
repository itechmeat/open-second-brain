import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  atomicWriteText,
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

describe("atomicWriteText", () => {
  test("preserves old content when validation rejects the candidate", () => {
    const target = join(tmp, "state.yaml");
    writeFileSync(target, "schema_version: 1\n", "utf8");

    expect(() =>
      atomicWriteText(target, "broken: true\n", {
        validate: () => {
          throw new Error("candidate failed lint");
        },
      }),
    ).toThrow("candidate failed lint");

    expect(readFileSync(target, "utf8")).toBe("schema_version: 1\n");
    const leakedTemps = readdirSync(tmp).filter(
      (name) => name.startsWith(".state.yaml.") && name.endsWith(".tmp"),
    );
    expect(leakedTemps).toHaveLength(0);
  });

  test("writes the candidate atomically after validation passes", () => {
    const target = join(tmp, "Brain", "_brain.yaml");

    atomicWriteText(target, "schema_version: 1\nschema:\n", {
      validate: (candidate) => expect(candidate).toContain("schema_version"),
    });

    expect(readFileSync(target, "utf8")).toBe("schema_version: 1\nschema:\n");
  });

  test("defaults to private 0o600 mode and honors a mode override", () => {
    const strict = join(tmp, "strict.txt");
    atomicWriteText(strict, "secret");
    expect(statSync(strict).mode & 0o777).toBe(0o600);

    const open = join(tmp, "open.txt");
    atomicWriteText(open, "public", { mode: 0o644 });
    expect(statSync(open).mode & 0o777).toBe(0o644);
  });

  test("overwrites an existing target", () => {
    const target = join(tmp, "x.yaml");
    atomicWriteText(target, "first\n");
    atomicWriteText(target, "second\n");
    expect(readFileSync(target, "utf8")).toBe("second\n");
  });
});

describe("skipIfUnchanged short-circuit", () => {
  test("atomicWriteFileSync returns true on a real write and false on a no-op", () => {
    const target = join(tmp, "noop.txt");
    // First write to a fresh path always writes.
    expect(atomicWriteFileSync(target, "body\n", { skipIfUnchanged: true })).toBe(true);
    const firstMtime = statSync(target).mtimeMs;

    // Identical content short-circuits: no write, mtime unchanged.
    expect(atomicWriteFileSync(target, "body\n", { skipIfUnchanged: true })).toBe(false);
    expect(statSync(target).mtimeMs).toBe(firstMtime);

    // Different content writes and reports the change.
    expect(atomicWriteFileSync(target, "changed\n", { skipIfUnchanged: true })).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("changed\n");
  });

  test("without the flag an identical write still rewrites (default unchanged)", () => {
    const target = join(tmp, "always.txt");
    atomicWriteFileSync(target, "body\n");
    // Default behaviour returns true and rewrites.
    expect(atomicWriteFileSync(target, "body\n")).toBe(true);
  });

  test("atomicWriteText short-circuits identical content too", () => {
    const target = join(tmp, "text.txt");
    expect(atomicWriteText(target, "hello", { skipIfUnchanged: true })).toBe(true);
    expect(atomicWriteText(target, "hello", { skipIfUnchanged: true })).toBe(false);
    expect(atomicWriteText(target, "world", { skipIfUnchanged: true })).toBe(true);
  });
});
