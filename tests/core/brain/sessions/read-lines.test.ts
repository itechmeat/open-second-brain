/**
 * The shared session line reader.
 *
 * Every adapter used to do `readFileSync(path, "utf8").split("\n")`, which
 * handled the awkward cases by accident: a trailing newline, a missing one,
 * a blank line in the middle, a CRLF ending, an empty file. A chunked reader
 * has to handle each of them on purpose, and gets one more case the whole-file
 * read could never hit - a multi-byte character straddling a chunk boundary,
 * which a naive per-chunk decode turns into U+FFFD.
 *
 * These tests pin all of it, plus the reader's own retained-bytes accounting,
 * which is what `streaming-memory.test.ts` asserts the bound on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lineReaderRetainedBytes,
  readFirstLine,
  readLines,
  resetLineReaderRetainedBytes,
} from "../../../../src/core/brain/sessions/read-lines.ts";

function fixture(content: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-read-lines-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, content);
  return path;
}

async function collect(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(path)) out.push(line);
  return out;
}

/**
 * The chunk sizes this runtime's file stream actually hands out for
 * `path`, read the same way {@link readLines} reads it.
 *
 * The bounds below used to be hand-picked round numbers with about 3.8x
 * of slack (a measured 262,144-byte window against a 1,000,000-byte
 * bound), and a round number cannot tell a reader holding ONE chunk from
 * one holding four - which is the module's whole invariant. Measuring the
 * ceiling instead makes that invariant - "never more than one chunk plus
 * the partial line carried into it" - the thing the test asserts.
 */
async function streamChunkBytes(path: string): Promise<ReadonlyArray<number>> {
  const reader = Bun.file(path).stream().getReader();
  const sizes: number[] = [];
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done === true || chunk.value === undefined) break;
      sizes.push(chunk.value.byteLength);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return sizes;
}

/** Longest line of `lines` in bytes - the largest carry the reader can hold. */
function longestLineBytes(lines: ReadonlyArray<string>): number {
  return lines.reduce((max, line) => Math.max(max, Buffer.byteLength(line, "utf8")), 0);
}

describe('readLines — the cases split("\\n") handled by accident', () => {
  test("a trailing newline does not produce a phantom final line", async () => {
    expect(await collect(fixture("a\nb\n"))).toEqual(["a", "b"]);
  });

  test("a missing trailing newline still yields the last line", async () => {
    expect(await collect(fixture("a\nb"))).toEqual(["a", "b"]);
  });

  test("a blank line in the middle is yielded, not swallowed", async () => {
    expect(await collect(fixture("a\n\nb\n"))).toEqual(["a", "", "b"]);
  });

  test("a CRLF ending does not leak its carriage return into the line", async () => {
    expect(await collect(fixture("a\r\nb\r\n"))).toEqual(["a", "b"]);
    // A lone CR inside the line is content, not a terminator.
    expect(await collect(fixture("a\rb\r\n"))).toEqual(["a\rb"]);
  });

  test("an empty file yields nothing", async () => {
    expect(await collect(fixture(""))).toEqual([]);
  });

  test("a file that is a single newline yields one empty line", async () => {
    expect(await collect(fixture("\n"))).toEqual([""]);
  });
});

describe("readLines — multi-byte characters across chunk boundaries", () => {
  /**
   * Irregular line lengths of mostly 3- and 4-byte characters over more than
   * a megabyte: whatever chunk size the runtime picks, boundaries land inside
   * a character. A per-chunk decode without `{ stream: true }` yields U+FFFD.
   */
  test("characters straddling a chunk boundary survive intact", async () => {
    const expected: string[] = [];
    for (let i = 0; i < 8000; i++) {
      expected.push(`${"a".repeat(i % 7)}${"\u{1F9E0}\u2026".repeat(20)}${i}`);
    }
    const path = fixture(`${expected.join("\n")}\n`);
    expect(Bun.file(path).size).toBeGreaterThan(1_000_000);

    const got = await collect(path);
    expect(got.length).toBe(expected.length);
    expect(got.join("\n")).toBe(expected.join("\n"));
    expect(got.some((l) => l.includes("\uFFFD"))).toBe(false);
  });
});

describe("readFirstLine — stops at the first newline", () => {
  test("returns the first line of a multi-line file", async () => {
    expect(await readFirstLine(fixture("first\nsecond\nthird\n"))).toBe("first");
  });

  test("returns the whole content when there is no newline at all", async () => {
    expect(await readFirstLine(fixture("only"))).toBe("only");
  });

  test("returns the empty string for an empty file", async () => {
    expect(await readFirstLine(fixture(""))).toBe("");
  });

  test("strips the CR of a CRLF first line", async () => {
    expect(await readFirstLine(fixture("first\r\nsecond\r\n"))).toBe("first");
  });

  test("reads exactly one chunk when the first line is short", async () => {
    const path = fixture(`head\n${"x".repeat(4_000_000)}\n`);
    const size = Bun.file(path).size;
    const [firstChunk] = await streamChunkBytes(path);
    resetLineReaderRetainedBytes();
    expect(await readFirstLine(path)).toBe("head");
    // Equality, not "less than a round number". The eager form this
    // module exists to remove - `readFileSync` then `indexOf("\n")` -
    // records ZERO, because it never enters the chunk loop, and a bound
    // written only as an upper limit is satisfied by zero. A reader that
    // buffered four chunks before yielding fails the same assertion from
    // the other side.
    expect(lineReaderRetainedBytes()).toBe(firstChunk!);
    // And the chunk really is a small window on this file, rather than
    // the runtime having handed the whole thing over in one piece.
    expect(lineReaderRetainedBytes()).toBeLessThan(size / 8);
  });
});

describe("the reader's retained-bytes accounting", () => {
  test("reset drops the high-water mark to zero", async () => {
    await collect(fixture(`${"line\n".repeat(1000)}`));
    resetLineReaderRetainedBytes();
    expect(lineReaderRetainedBytes()).toBe(0);
  });

  test("the window is one chunk plus the partial line, and nothing more", async () => {
    const line = "y".repeat(200);
    const path = fixture(`${`${line}\n`.repeat(20_000)}`);
    const size = Bun.file(path).size;
    expect(size).toBeGreaterThan(4_000_000);
    const chunks = await streamChunkBytes(path);
    const largestChunk = Math.max(...chunks);
    expect(chunks.length).toBeGreaterThan(1);
    resetLineReaderRetainedBytes();
    let chars = 0;
    let seen = 0;
    for await (const line of readLines(path)) {
      chars += line.length;
      seen++;
    }
    expect(seen).toBe(20_000);
    expect(chars).toBe(20_000 * 200);
    // The module's stated invariant, asserted from both sides rather than
    // against a round number: at least one whole chunk was held (a reader
    // that materialised the file and split it records nothing at all),
    // and never more than one chunk plus the longest line that can be
    // carried across a boundary (a reader buffering two chunks doubles
    // this and fails).
    expect(lineReaderRetainedBytes()).toBeGreaterThanOrEqual(largestChunk);
    expect(lineReaderRetainedBytes()).toBeLessThanOrEqual(largestChunk + longestLineBytes([line]));
  });

  test("a file with no line terminator is reported at its true cost", async () => {
    // The carry IS the retained window when nothing terminates it, and
    // the accounting says so rather than reporting the chunk alone. An
    // accounting that counted only the chunk would report a 4 MB window
    // as 256 KB, and every bound above it would be measuring nothing.
    const path = fixture("z".repeat(4_000_000));
    resetLineReaderRetainedBytes();
    expect((await collect(path)).length).toBe(1);
    expect(lineReaderRetainedBytes()).toBeGreaterThanOrEqual(4_000_000);
  });

  test("the carry does not survive the loop that made it", async () => {
    const tail = "TAIL-WITH-NO-NEWLINE";
    expect(await collect(fixture(`a\n${tail}`))).toEqual(["a", tail]);
    // A carry hoisted to module scope - the obvious way to save an
    // allocation per call - would prepend the previous file's unterminated
    // tail to this one, and would keep those bytes retained between runs.
    resetLineReaderRetainedBytes();
    expect(await collect(fixture("b\n"))).toEqual(["b"]);
    expect(lineReaderRetainedBytes()).toBe(2);
  });
});
