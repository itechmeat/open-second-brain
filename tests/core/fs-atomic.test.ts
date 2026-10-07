import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
  FileAlreadyExistsError,
  FileDriftError,
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  atomicWriteText,
  fileMatchesExpected,
  isFileAlreadyExists,
  isFileDrift,
} from "../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../src/core/vault.ts";

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

describe("FileAlreadyExistsError", () => {
  test("the exclusive creator throws the typed error and the predicate recognises it", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "preexisting");

    let caught: unknown;
    try {
      atomicCreateFileSyncExclusive(target, "new");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FileAlreadyExistsError);
    const err = caught as FileAlreadyExistsError;
    expect(err.code).toBe("EEXIST");
    expect(err.path).toBe(target);
    expect(err.kind).toBeUndefined();
    expect(err.name).toBe("FileAlreadyExistsError");
    // The native errno survives so a caller that wants the raw link(2)
    // detail still has it.
    expect((err.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EEXIST");
    expect(isFileAlreadyExists(err)).toBe(true);
  });

  test("the predicate recognises a native EEXIST reachable through .cause", () => {
    const native: NodeJS.ErrnoException = new Error("EEXIST: file already exists, link");
    native.code = "EEXIST";
    expect(isFileAlreadyExists(native)).toBe(true);
    expect(isFileAlreadyExists(new Error("wrapper", { cause: native }))).toBe(true);
  });

  test("the predicate rejects an unrelated error", () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT: no such file");
    enoent.code = "ENOENT";
    expect(isFileAlreadyExists(enoent)).toBe(false);
    expect(isFileAlreadyExists(new Error("plain"))).toBe(false);
    expect(isFileAlreadyExists(new Error("wrapper", { cause: enoent }))).toBe(false);
    expect(isFileAlreadyExists("EEXIST")).toBe(false);
    expect(isFileAlreadyExists(null)).toBe(false);
    expect(isFileAlreadyExists(undefined)).toBe(false);
  });
});

describe("writeFrontmatterAtomic collision", () => {
  test("keeps the kinded message byte-identical and stays typed", () => {
    const vault = join(tmp, "vault");
    const target = join(vault, "Brain", "inbox", "sig-topic.md");
    writeFrontmatterAtomic(target, { id: "sig-topic" }, "body\n");

    let caught: unknown;
    try {
      writeFrontmatterAtomic(target, { id: "sig-topic" }, "body\n", {
        existsErrorKind: "signal",
        vaultForRelativePath: vault,
      });
    } catch (err) {
      caught = err;
    }

    // Byte-identical to the wording that shipped before the class existed.
    expect((caught as Error).message).toBe("signal already exists: Brain/inbox/sig-topic.md");
    expect(caught).toBeInstanceOf(FileAlreadyExistsError);
    expect((caught as FileAlreadyExistsError).code).toBe("EEXIST");
    expect((caught as FileAlreadyExistsError).kind).toBe("signal");
    expect((caught as FileAlreadyExistsError).path).toBe(target);
    expect(isFileAlreadyExists(caught)).toBe(true);
  });

  test("without a kind the collision is still recognised by the predicate", () => {
    const target = join(tmp, "plain.md");
    writeFrontmatterAtomic(target, { id: "plain" }, "body\n");
    expect(() => writeFrontmatterAtomic(target, { id: "plain" }, "body\n")).toThrow(
      FileAlreadyExistsError,
    );
    try {
      writeFrontmatterAtomic(target, { id: "plain" }, "body\n");
    } catch (err) {
      expect(isFileAlreadyExists(err)).toBe(true);
      expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  test("overwrite: true never collides", () => {
    const target = join(tmp, "over.md");
    writeFrontmatterAtomic(target, { id: "a" }, "one\n");
    writeFrontmatterAtomic(target, { id: "b" }, "two\n", { overwrite: true });
    expect(readFileSync(target, "utf8")).toContain("two");
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

  // Windows has no POSIX permission bits: stat reports 0o666/0o444 from the
  // read-only attribute alone, so a mode cannot be observed there.
  test.skipIf(process.platform === "win32")(
    "defaults to private 0o600 mode and honors a mode override",
    () => {
      const strict = join(tmp, "strict.txt");
      atomicWriteText(strict, "secret");
      expect(statSync(strict).mode & 0o777).toBe(0o600);

      const open = join(tmp, "open.txt");
      atomicWriteText(open, "public", { mode: 0o644 });
      expect(statSync(open).mode & 0o777).toBe(0o644);
    },
  );

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

describe("expectBefore compare-before-write", () => {
  function tempFiles(): string[] {
    return readdirSync(tmp).filter((n) => n.startsWith(".") && n.endsWith(".tmp"));
  }

  function driftOf(fn: () => unknown): FileDriftError {
    try {
      fn();
    } catch (err) {
      expect(isFileDrift(err)).toBe(true);
      return err as FileDriftError;
    }
    throw new Error("expected a FileDriftError");
  }

  test("matching bytes write", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "old\n");
    expect(atomicWriteFileSync(target, "new\n", { expectBefore: "old\n" })).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  test("different bytes throw FileDriftError naming the path and leave the target untouched", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "hand edit\n");
    const err = driftOf(() => atomicWriteFileSync(target, "new\n", { expectBefore: "old\n" }));
    expect(err).toBeInstanceOf(FileDriftError);
    expect(err.path).toBe(target);
    expect(err.message).toContain(target);
    expect(readFileSync(target, "utf8")).toBe("hand edit\n");
    expect(tempFiles()).toEqual([]);
  });

  test("null with an absent target writes", () => {
    const target = join(tmp, "fresh.md");
    expect(atomicWriteFileSync(target, "body\n", { expectBefore: null })).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("body\n");
  });

  test("null with a present target throws, even when it is empty", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "");
    driftOf(() => atomicWriteFileSync(target, "body\n", { expectBefore: null }));
    expect(readFileSync(target, "utf8")).toBe("");
    expect(tempFiles()).toEqual([]);
  });

  test("a string expectation with an absent target throws, even an empty one", () => {
    const target = join(tmp, "gone.md");
    driftOf(() => atomicWriteFileSync(target, "body\n", { expectBefore: "" }));
    expect(existsSync(target)).toBe(false);
    expect(tempFiles()).toEqual([]);
  });

  test("undefined keeps the unconditional overwrite", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "anything\n");
    expect(atomicWriteFileSync(target, "new\n", { expectBefore: undefined })).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  test("composes with skipIfUnchanged", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "same\n");
    // The expectation holds and the bytes already match: nothing to write.
    expect(
      atomicWriteFileSync(target, "same\n", { expectBefore: "same\n", skipIfUnchanged: true }),
    ).toBe(false);
    // The expectation fails: drift wins over the short-circuit.
    driftOf(() =>
      atomicWriteFileSync(target, "same\n", { expectBefore: "other\n", skipIfUnchanged: true }),
    );
    // The expectation holds and the bytes differ: it writes.
    expect(
      atomicWriteFileSync(target, "next\n", { expectBefore: "same\n", skipIfUnchanged: true }),
    ).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("next\n");
    expect(tempFiles()).toEqual([]);
  });

  test("an edit landing after the temp write is refused before the rename", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "old\n");
    // The first fsync is the temp file's: by then the up-front check has
    // passed and the temp file exists, so only the re-check before the
    // rename can see this edit.
    const realFsync = fs.fsyncSync;
    const spy = spyOn(fs, "fsyncSync").mockImplementationOnce((fd) => {
      realFsync(fd);
      writeFileSync(target, "edit during the write\n");
    });
    try {
      const err = driftOf(() => atomicWriteFileSync(target, "new\n", { expectBefore: "old\n" }));
      expect(spy).toHaveBeenCalled();
      expect(err.path).toBe(target);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("edit during the write\n");
    expect(tempFiles()).toEqual([]);
  });

  test("an unchanged file holding invalid UTF-8 matches the lossy read of it", () => {
    const target = join(tmp, "bin.md");
    const bytes = Buffer.from([...Buffer.from("stale "), 0xff, 0x0a]);
    writeFileSync(target, bytes);
    const read = readFileSync(target, "utf8");
    expect(fileMatchesExpected(target, read)).toBe(true);
    atomicWriteFileSync(target, "new\n", { expectBefore: read });
    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  test("valid UTF-8 is compared byte for byte", () => {
    const target = join(tmp, "x.md");
    writeFileSync(target, "café\n");
    const read = readFileSync(target, "utf8");
    // NFD: same text on screen, different bytes on disk.
    writeFileSync(target, "café\n");
    expect(fileMatchesExpected(target, read)).toBe(false);
    driftOf(() => atomicWriteFileSync(target, "new\n", { expectBefore: read }));
    expect(readFileSync(target, "utf8")).toBe("café\n");
  });

  test("an invalid-UTF-8 file is drift when its decoding changed", () => {
    const target = join(tmp, "bin.md");
    writeFileSync(target, Buffer.from([...Buffer.from("stale "), 0xff, 0x0a]));
    const read = readFileSync(target, "utf8");
    const edited = Buffer.from([...Buffer.from("edited "), 0xff, 0x0a]);
    writeFileSync(target, edited);
    expect(fileMatchesExpected(target, read)).toBe(false);
    driftOf(() => atomicWriteFileSync(target, "new\n", { expectBefore: read }));
    expect(readFileSync(target)).toEqual(edited);
  });

  test("known limit: two invalid sequences with the same decoding look equal", () => {
    // 0xff and 0xfe both decode to U+FFFD; the lossy read cannot tell them apart.
    const target = join(tmp, "bin.md");
    writeFileSync(target, Buffer.from([0xfe]));
    expect(fileMatchesExpected(target, Buffer.from([0xff]).toString("utf8"))).toBe(true);
  });

  test("fileMatchesExpected tells absent, empty and different apart", () => {
    const target = join(tmp, "x.md");
    expect(fileMatchesExpected(target, null)).toBe(true);
    expect(fileMatchesExpected(target, "")).toBe(false);
    writeFileSync(target, "");
    expect(fileMatchesExpected(target, "")).toBe(true);
    expect(fileMatchesExpected(target, null)).toBe(false);
    writeFileSync(target, "body\n");
    expect(fileMatchesExpected(target, "body\n")).toBe(true);
    expect(fileMatchesExpected(target, "other\n")).toBe(false);
  });

  test("isFileDrift rejects other errors and follows a wrapped cause", () => {
    expect(isFileDrift(new Error("x"))).toBe(false);
    expect(isFileDrift(null)).toBe(false);
    const inner = new FileDriftError(join(tmp, "x.md"));
    expect(isFileDrift(new Error("wrapped", { cause: inner }))).toBe(true);
  });
});
