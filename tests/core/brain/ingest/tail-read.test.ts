/**
 * The from-offset tail read (Lane 5, Task 5.3) - the substrate for
 * incremental extraction of appended source text.
 *
 * The contract pinned here:
 *   - a delta returns ONLY the text appended since `fromByte`, its start
 *     snapped forward past any partial UTF-8 sequence (a mid-codepoint
 *     offset decodes cleanly, never as U+FFFD) and its end cut after the
 *     LAST complete newline, so an unfinished trailing line is left for
 *     the next delta instead of being covered twice;
 *   - `fromByte`/`toByte` are the exact byte range the returned text
 *     covers, so a watermark stamped at `toByte` never overlaps the next
 *     delta and never claims bytes the text does not carry;
 *   - a file that shrank below the offset falls back to the FULL content
 *     with the shrink named (the full-reprocess direction);
 *   - the read ceiling is enforced with the existing bounded-read refusal
 *     vocabulary (`larger than the read limit`), and a non-regular file
 *     refuses the same way.
 */

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readTail } from "../../../../src/core/brain/ingest/tail-read.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-tail-read-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(tmp, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("readTail - appended deltas", () => {
  test("returns the appended text from the offset, byte range exact", () => {
    const path = write("log.txt", "line1\nline2\n");
    const tail = readTail(path, 6);
    expect(tail).toEqual({
      kind: "appended",
      text: "line2\n",
      fromByte: 6,
      toByte: 12,
    });
  });

  test("from byte 0 the delta is the complete-line content", () => {
    const path = write("log.txt", "line1\nline2\n");
    expect(readTail(path, 0)).toEqual({
      kind: "appended",
      text: "line1\nline2\n",
      fromByte: 0,
      toByte: 12,
    });
  });

  test("an unfinished trailing line is left for the next delta", () => {
    const path = write("log.txt", "a\nb\ncde");
    expect(readTail(path, 0)).toEqual({
      kind: "appended",
      text: "a\nb\n",
      fromByte: 0,
      toByte: 4,
    });
  });

  test("an appended range with no complete line covers nothing", () => {
    const path = write("log.txt", "abc\nXYZ");
    expect(readTail(path, 4)).toEqual({
      kind: "appended",
      text: "",
      fromByte: 4,
      toByte: 4,
    });
  });

  test("an offset at end of file covers nothing", () => {
    const path = write("log.txt", "abc\n");
    expect(readTail(path, 4)).toEqual({
      kind: "appended",
      text: "",
      fromByte: 4,
      toByte: 4,
    });
  });

  test("a mid-codepoint offset snaps forward to a UTF-8-safe boundary", () => {
    // h(1) é(2) l l o \n - offset 2 lands inside the two-byte é.
    const path = write("log.txt", "héllo\n");
    const tail = readTail(path, 2);
    expect(tail.kind).toBe("appended");
    if (tail.kind !== "appended") return;
    expect(tail.text).toBe("llo\n");
    expect(tail.fromByte).toBe(3);
    expect(tail.toByte).toBe(7);
    expect(tail.text.includes("\uFFFD")).toBe(false);
  });

  test("multi-byte characters inside the delta decode cleanly", () => {
    const appended = "café — naïve 中文 \u{1F600}\nsecond line\n";
    const path = write("log.txt", "base\n");
    appendFileSync(path, appended, "utf8");
    const tail = readTail(path, 5);
    expect(tail).toEqual({
      kind: "appended",
      text: appended,
      fromByte: 5,
      toByte: 5 + Buffer.byteLength(appended, "utf8"),
    });
  });

  test("two appends yield two non-overlapping deltas whose text is exactly the appends", () => {
    const path = write("log.txt", "one\n");
    appendFileSync(path, "two\n", "utf8");
    const first = readTail(path, 4);
    expect(first).toEqual({ kind: "appended", text: "two\n", fromByte: 4, toByte: 8 });

    appendFileSync(path, "three\n", "utf8");
    const second = readTail(path, 8);
    expect(second).toEqual({ kind: "appended", text: "three\n", fromByte: 8, toByte: 14 });
  });
});

describe("readTail - shrink fallback", () => {
  test("a file that shrank below the offset falls back to the full content, named", () => {
    const path = write("log.txt", "rewritten small\n");
    const tail = readTail(path, 1024);
    expect(tail).toEqual({
      kind: "shrank",
      text: "rewritten small\n",
      fromByte: 0,
      toByte: 16,
    });
  });

  test("a shrunken file still refuses past the ceiling", () => {
    const path = write("log.txt", "x".repeat(2048));
    const tail = readTail(path, 4096, { maxBytes: 1024 });
    expect(tail).toEqual({ kind: "unread", unread: "larger than the read limit" });
  });
});

describe("readTail - bounded ceiling and refusals", () => {
  test("an appended range past the ceiling refuses with the bounded-read vocabulary", () => {
    const path = write("log.txt", "base\n");
    appendFileSync(path, "y".repeat(2048) + "\n", "utf8");
    expect(readTail(path, 5, { maxBytes: 1024 })).toEqual({
      kind: "unread",
      unread: "larger than the read limit",
    });
  });

  test("a directory refuses as not a regular file", () => {
    const dir = join(tmp, "dir");
    mkdirSync(dir, { recursive: true });
    expect(readTail(dir, 0)).toEqual({ kind: "unread", unread: "not a regular file" });
  });
});
