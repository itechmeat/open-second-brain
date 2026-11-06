/**
 * The Brain log's append primitives (`log-append-io.ts`) on their own:
 * a write that fails part way leaves the shard as it was, and the
 * backward line scan reads a line longer than many chunks correctly.
 *
 * A full disk is simulated with the forwarding `node:fs` mock idiom of
 * `tests/core/brain/ingest/incremental-extract.test.ts`: every call is
 * passed through untouched, except that while a target file is armed, a
 * write to it lands only half its bytes and the next one raises ENOSPC,
 * the shape a real short write followed by a full disk has. Later writes
 * go through again, so the rollback itself can be observed.
 */

import * as fsNamespace from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realWriteSync = fsNamespace.writeSync;
const realFstatSync = fsNamespace.fstatSync;
const realStatSync = fsNamespace.statSync;
let armed: { readonly dev: number; readonly ino: number } | undefined;
let shortWriteDone = false;

mock.module("node:fs", () => ({
  ...fsNamespace,
  writeSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    if (armed !== undefined) {
      const st = realFstatSync(fd);
      if (st.dev === armed.dev && st.ino === armed.ino) {
        if (shortWriteDone) {
          // One failure, then the disk has room again: what the rollback
          // writes back must land.
          armed = undefined;
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        }
        shortWriteDone = true;
        const half = Math.max(1, Math.floor(length / 2));
        return realWriteSync(fd, buffer, offset, half, position);
      }
    }
    return realWriteSync(fd, buffer, offset, length, position);
  },
}));

const { appendSeparated, scanLinesFromEnd } =
  await import("../../../src/core/brain/log-append-io.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osb-log-append-io-"));
  armed = undefined;
  shortWriteDone = false;
});

afterEach(() => {
  armed = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function arm(path: string): void {
  const st = realStatSync(path);
  armed = { dev: st.dev, ino: st.ino };
  shortWriteDone = false;
}

const BLOCK = `{"row":"${"x".repeat(200)}"}\n`;

describe("a failed append leaves the shard as it was", () => {
  test("the normal append path", () => {
    const path = join(dir, "shard.jsonl");
    const before = `{"row":1}\n{"row":2}\n`;
    writeFileSync(path, before);
    arm(path);

    expect(() => appendSeparated(path, BLOCK, "\n", BLOCK)).toThrow(/ENOSPC/);

    expect(readFileSync(path, "utf8")).toBe(before);
    appendSeparated(path, BLOCK, "\n", BLOCK);
    expect(readFileSync(path, "utf8")).toBe(`${before}${BLOCK}`);
  });

  test("the path that trims an unusual whitespace tail first", () => {
    const path = join(dir, "day.md");
    const before = "## 10:00 - note\n\ntext\n\n\n\n";
    writeFileSync(path, before);
    arm(path);

    expect(() => appendSeparated(path, "## 11:00 - note\n", "\n\n", "x")).toThrow(/ENOSPC/);

    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("the first write into an empty file", () => {
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    arm(path);

    expect(() => appendSeparated(path, BLOCK, "\n", BLOCK)).toThrow(/ENOSPC/);

    expect(readFileSync(path, "utf8")).toBe("");
  });
});

describe("scanLinesFromEnd", () => {
  test("reads a line many chunks long, and the lines around it", () => {
    const path = join(dir, "long.jsonl");
    const long = "y".repeat(64 * 1024 * 5 + 17);
    writeFileSync(path, `first\r\n${long}\r\nlast`);
    const seen: string[] = [];
    expect(
      scanLinesFromEnd(path, (line) => {
        seen.push(line);
        return null;
      }),
    ).toBeNull();
    expect(seen).toEqual(["last", long, "first"]);
  });

  test("a file that is one line with no newline is that line", () => {
    const path = join(dir, "one.jsonl");
    const long = "z".repeat(64 * 1024 * 3 + 5);
    writeFileSync(path, long);
    expect(scanLinesFromEnd(path, (line) => line)).toBe(long);
  });
});
