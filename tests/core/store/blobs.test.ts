/**
 * Blob creation (design D1, D2): where the temp file goes, the exclusive
 * create, and the fallback for filesystems without hard links.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { NO_LINK_CODES, readBlob, writeBlob } from "../../../src/core/store/blobs.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { BLOB_TEMP_PREFIX, STORE_LINE_CAP_BYTES } from "../../../src/core/store/constants.ts";
import { blobPath, partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

/** Every file under `dir`, relative, `/`-separated. */
function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/** A link call that behaves like a FAT or exFAT volume. */
function noHardLinks(): never {
  throw Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
}

/** A link call that fails for a reason unrelated to hard-link support. */
function diskFull(): never {
  throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
}

describe("writeBlob", () => {
  let tmp: TempStore;
  let partition: string;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-blob-");
    partition = partitionDir(tmp.open("dev-a").root, "shared");
  });
  afterEach(() => tmp.cleanup());

  test("with a device-local temp dir on the same filesystem, nothing temporary touches blobs/", () => {
    const tempDir = join(tmp.parent, "state", "dev-a", "tmp");
    const text = JSON.stringify({ note: "hello" });
    const sources: string[] = [];
    const written = writeBlob(partition, text, {
      tempDir,
      link: (from, to) => {
        sources.push(from);
        linkSync(from, to);
      },
    });
    expect(written.created).toBe(true);
    expect(sources.length).toBe(1);
    expect(dirname(sources[0]!)).toBe(tempDir);
    expect(walk(join(partition, "blobs"))).toEqual([`${written.sha.slice(0, 2)}/${written.sha}`]);
    expect(walk(tempDir)).toEqual([]);
    expect(readBlob(partition, written.sha)).toEqual({ status: "ok", text });
  });

  test("with no usable device-local dir the temp file is dot-prefixed beside the blob", () => {
    const sources: string[] = [];
    const written = writeBlob(partition, JSON.stringify({ note: "beside" }), {
      link: (from, to) => {
        sources.push(from);
        linkSync(from, to);
      },
    });
    expect(dirname(sources[0]!)).toBe(dirname(written.path));
    expect(basename(sources[0]!).startsWith(BLOB_TEMP_PREFIX)).toBe(true);
    expect(existsSync(sources[0]!)).toBe(false);
  });

  test("an unusable device-local dir falls back to a dot-prefixed temp beside the blob", () => {
    const fileNotDir = join(tmp.parent, "not-a-dir");
    writeFileSync(fileNotDir, "");
    const sources: string[] = [];
    const written = writeBlob(partition, JSON.stringify({ note: "fallback" }), {
      tempDir: join(fileNotDir, "tmp"),
      link: (from, to) => {
        sources.push(from);
        linkSync(from, to);
      },
    });
    expect(dirname(sources[0]!)).toBe(dirname(written.path));
    expect(basename(sources[0]!).startsWith(BLOB_TEMP_PREFIX)).toBe(true);
    expect(walk(join(partition, "blobs"))).toEqual([`${written.sha.slice(0, 2)}/${written.sha}`]);
  });

  const noLinkCodes = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"];

  test("the codes below are every code that means the filesystem has no hard links", () => {
    expect([...NO_LINK_CODES].toSorted()).toEqual(noLinkCodes.toSorted());
  });

  test.each(noLinkCodes)(
    "a link refused with %s falls back to an exclusive create of the final name",
    (code) => {
      const text = JSON.stringify({ note: `no link ${code}` });
      const written = writeBlob(partition, text, {
        link: () => {
          throw Object.assign(new Error(`link refused: ${code}`), { code });
        },
      });
      expect(written.created).toBe(true);
      expect(readBlob(partition, written.sha)).toEqual({ status: "ok", text });
      expect(walk(join(partition, "blobs"))).toEqual([`${written.sha.slice(0, 2)}/${written.sha}`]);
    },
  );

  test("without hard links the final name is created exclusively and reads back verified", () => {
    const text = JSON.stringify({ note: "fat volume" });
    const written = writeBlob(partition, text, { link: noHardLinks });
    expect(written.created).toBe(true);
    expect(readBlob(partition, written.sha)).toEqual({ status: "ok", text });
    // No temp file is left behind anywhere in the blob tree.
    expect(walk(join(partition, "blobs"))).toEqual([`${written.sha.slice(0, 2)}/${written.sha}`]);
  });

  test("without hard links a second write of the same body is a verified no-op", () => {
    const text = JSON.stringify({ note: "twice" });
    writeBlob(partition, text, { link: noHardLinks });
    const again = writeBlob(partition, text, { link: noHardLinks });
    expect(again.created).toBe(false);
    expect(readBlob(partition, again.sha)).toEqual({ status: "ok", text });
  });

  test("a taken name holding a torn write is repaired to the content its name promises", () => {
    const text = JSON.stringify({ note: "repair me" });
    const sha = sha256Hex(text);
    const path = blobPath(partition, sha);
    // A crash halfway through a direct create left the first half on disk.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.slice(0, 5));
    expect(readBlob(partition, sha).status).toBe("mismatch");
    const written = writeBlob(partition, text, { link: noHardLinks });
    expect(written.created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
    // The repair goes through a temp file renamed over the blob; none is left behind.
    expect(walk(join(partition, "blobs"))).toEqual([`${sha.slice(0, 2)}/${sha}`]);
  });

  /** A torn first half of `text` at its blob name, as a crash during a direct create leaves it. */
  function tornBlob(text: string): string {
    const path = blobPath(partition, sha256Hex(text));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.slice(0, 5));
    return path;
  }

  test("a repair writes its temp file in the device-local dir, not in blobs/", () => {
    const text = JSON.stringify({ note: "repair locally" });
    tornBlob(text);
    const tempDir = join(tmp.parent, "state", "dev-a", "tmp");
    const sources: string[] = [];
    writeBlob(partition, text, {
      tempDir,
      link: noHardLinks,
      rename: (from, to) => {
        sources.push(from);
        renameSync(from, to);
      },
    });
    expect(sources.map((s) => dirname(s))).toEqual([tempDir]);
  });

  test("a repair refused because the writer still holds the blob open waits for that writer", () => {
    const text = JSON.stringify({ note: "slow writer" });
    const path = tornBlob(text);
    const written = writeBlob(partition, text, {
      link: noHardLinks,
      rename: () => {
        // The slow writer finishes while the rename is refused.
        writeFileSync(path, text);
        throw Object.assign(new Error("resource busy or locked, rename"), { code: "EBUSY" });
      },
    });
    expect(written.created).toBe(false);
    expect(readBlob(partition, written.sha)).toEqual({ status: "ok", text });
    expect(walk(join(partition, "blobs"))).toEqual([`${written.sha.slice(0, 2)}/${written.sha}`]);
  });

  test("a refused repair of a blob that never completes still fails", () => {
    const text = JSON.stringify({ note: "never completes" });
    tornBlob(text);
    expect(() =>
      writeBlob(partition, text, {
        link: noHardLinks,
        rename: () => {
          throw Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" });
        },
      }),
    ).toThrow("operation not permitted");
  });

  test("a link failure that is not about hard-link support propagates and leaves no temp file", () => {
    expect(() => writeBlob(partition, "{}", { link: diskFull })).toThrow("no space left");
    expect(walk(join(partition, "blobs"))).toEqual([]);
  });
});

describe("appendRecord spills through the device-local temp dir", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-blob-append-");
  });
  afterEach(() => tmp.cleanup());

  test("a spilled body leaves only the blob in blobs/", () => {
    const store = tmp.open("dev-a");
    const result = appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "note",
      agent: "tester",
      body: { text: "x".repeat(STORE_LINE_CAP_BYTES * 2) },
    });
    expect(result.spilled).toBe(true);
    const sha = result.record.sum;
    expect(walk(join(tmp.root, "shared", "blobs"))).toEqual([`${sha.slice(0, 2)}/${sha}`]);
  });
});
