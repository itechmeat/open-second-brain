/**
 * Every adapter reads its session through the shared line reader, and that
 * reader's window stays bounded while the adapter iterates.
 *
 * The five adapters used to `readFileSync(path, "utf8")` and then `split("\n")`,
 * so peak retained memory was roughly twice the file size BEFORE the first turn
 * was yielded, and the `async *` generator bought nothing - it iterated an array
 * that was already fully materialised. This suite drives each adapter over a
 * synthetic session an order of magnitude larger than the largest fixture in the
 * tree (2 KB) and asserts that the reader's window over that file stays inside
 * the invariant `read-lines.ts` states: one chunk plus the partial line carried
 * into it.
 *
 * ## What this suite does NOT claim
 *
 * It does not claim `iterate` holds no copy of the file ANYWHERE. The header
 * used to say exactly that, and the accounting cannot support it: an adapter
 * that streamed through `readLines` and ALSO did `readFileSync(path, "utf8")`,
 * keeping the string alive for the whole iteration, was measured reporting the
 * same 262,144-byte high-water mark and passing every assertion below while
 * 9.84 MB stayed resident. The narrower claim - the one asserted here - is
 * still the regression that mattered: the old path went through no reader at
 * all, so it recorded ZERO, and a bound with a `> 0` floor rejects it.
 *
 * A residency assertion is what would close the gap, and the next section is
 * the measurement record explaining why there is not one: the numbers do not
 * discriminate. A flaky 60 MB bound would be a worse test than an exact bound
 * with a stated blind spot, so the claim is narrowed rather than faked.
 *
 * ## Why the reader's own accounting and not `process.memoryUsage()`
 *
 * Both were measured. `rss` deltas across a full `Bun.gc(true)` baseline varied
 * between 0 MB and 66 MB run to run for the SAME code path, and `heapUsed`
 * failed to discriminate at all: on a 34 MB fixture the streaming path reported
 * a ~30 MB delta, because what dominates the JSC heap mid-iteration is
 * uncollected `JSON.parse` garbage, not the reader's window. A memory assertion
 * that reports 30 MB for a reader retaining 256 KB is not a bound, and one that
 * swings 60 MB between identical runs is a flaky test. So the reader keeps its
 * own high-water mark of the bytes it holds (see `read-lines.ts`) and this suite
 * asserts on that: an exact, deterministic number the old whole-file path could
 * not have satisfied, since it retained the entire file by construction.
 *
 * For the record, on a 10.79 MB synthetic Claude session: the old
 * `readFileSync` + `split("\n")` retained 12.06 MB of resident memory before
 * yielding turn one; the reader's high-water mark over the same file is
 * 263,040 bytes, and does not grow with the file.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAdapter } from "../../../../src/core/brain/sessions/claude.ts";
import { codexAdapter } from "../../../../src/core/brain/sessions/codex.ts";
import { grokAdapter } from "../../../../src/core/brain/sessions/grok.ts";
import { hermesAdapter } from "../../../../src/core/brain/sessions/hermes.ts";
import { opencodeAdapter } from "../../../../src/core/brain/sessions/opencode.ts";
import {
  lineReaderRetainedBytes,
  resetLineReaderRetainedBytes,
} from "../../../../src/core/brain/sessions/read-lines.ts";
import type { SessionAdapter } from "../../../../src/core/brain/sessions/types.ts";

/** Turn count per synthetic file. Sized so every file clears 8 MB. */
const TURNS = 12_000;
/** Padding that makes each line realistically large without being pathological. */
const BODY = "the quick brown fox jumps over the lazy dog. ".repeat(16);

/**
 * A synthetic session, with the one number a bound on the reader needs
 * besides the file itself: the longest line in it, which is the largest
 * partial line the reader can carry across a chunk boundary.
 */
interface Fixture {
  readonly path: string;
  readonly longestLineBytes: number;
}

function write(name: string, lines: readonly string[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "osb-streaming-"));
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return {
    path,
    longestLineBytes: lines.reduce((max, l) => Math.max(max, Buffer.byteLength(l, "utf8")), 0),
  };
}

/**
 * The largest chunk this runtime's file stream hands out for `path`, read
 * exactly the way `readLines` reads it.
 *
 * Measured rather than assumed, because the bound below is the module's
 * invariant and not a round number: `size / 8` on an 8 MB file leaves room
 * for four chunks, so a reader that buffered four before yielding would
 * have passed it.
 */
async function largestStreamChunkBytes(path: string): Promise<number> {
  const reader = Bun.file(path).stream().getReader();
  let max = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done === true || chunk.value === undefined) break;
      if (chunk.value.byteLength > max) max = chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return max;
}

function isoAt(i: number): string {
  return new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
}

function claudeFile(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        parentUuid: i === 0 ? null : `u-${i - 1}`,
        sessionId: "sess-streaming",
        entrypoint: "cli",
        type: i % 2 === 0 ? "user" : "assistant",
        uuid: `u-${i}`,
        timestamp: isoAt(i),
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `${BODY}${i}` },
      }),
    );
  }
  return write("claude.jsonl", lines);
}

function codexFile(): Fixture {
  const lines: string[] = [
    JSON.stringify({
      timestamp: isoAt(0),
      type: "session_meta",
      payload: { originator: "codex_exec", cli_version: "0.129.0" },
    }),
  ];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        timestamp: isoAt(i + 1),
        type: "response_item",
        payload: {
          type: "message",
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "input_text", text: `${BODY}${i}` }],
        },
      }),
    );
  }
  return write("codex.jsonl", lines);
}

function hermesFile(): Fixture {
  const lines: string[] = [JSON.stringify({ role: "session_meta", tools: [] })];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${BODY}${i}`,
        timestamp: isoAt(i + 1),
      }),
    );
  }
  return write("hermes.jsonl", lines);
}

function opencodeFile(): Fixture {
  const lines: string[] = [
    JSON.stringify({
      type: "session_meta",
      originator: "open-second-brain-opencode-plugin",
      format: 1,
      session_id: "ses_streaming",
    }),
  ];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        type: "turn",
        turnId: `t-${i}`,
        timestamp: isoAt(i + 1),
        role: i % 2 === 0 ? "user" : "assistant",
        text: `${BODY}${i}`,
      }),
    );
  }
  return write("opencode.jsonl", lines);
}

function grokFile(): Fixture {
  const lines: string[] = [];
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        timestamp: 1_781_213_002 + i,
        method: "session/update",
        params: {
          sessionId: "grok-streaming",
          update: {
            // Alternating roles so every chunk closes the previous buffer:
            // coalescing must not become an accumulator over the whole file.
            sessionUpdate: i % 2 === 0 ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: `${BODY}${i}` },
          },
        },
      }),
    );
  }
  return write("grok.jsonl", lines);
}

const CASES: ReadonlyArray<{
  readonly adapter: SessionAdapter;
  readonly build: () => Fixture;
  readonly expectedTurns: number;
}> = [
  { adapter: claudeAdapter, build: claudeFile, expectedTurns: TURNS },
  { adapter: codexAdapter, build: codexFile, expectedTurns: TURNS },
  { adapter: hermesAdapter, build: hermesFile, expectedTurns: TURNS },
  { adapter: opencodeAdapter, build: opencodeFile, expectedTurns: TURNS },
  { adapter: grokAdapter, build: grokFile, expectedTurns: TURNS },
];

describe("the line reader holds a bounded window while each adapter iterates", () => {
  for (const { adapter, build, expectedTurns } of CASES) {
    test(`${adapter.id} streams an 8 MB+ session within one chunk plus a line`, async () => {
      const { path, longestLineBytes } = build();
      const size = Bun.file(path).size;
      expect(size).toBeGreaterThan(8_000_000);
      const largestChunk = await largestStreamChunkBytes(path);
      // The invariant, as a number: one chunk, plus the partial line
      // carried into it.
      const bound = largestChunk + longestLineBytes;
      expect(bound).toBeLessThan(size / 8);

      resetLineReaderRetainedBytes();
      let turns = 0;
      let firstTurnRetained = -1;
      for await (const turn of adapter.iterate(path)) {
        if (firstTurnRetained < 0) firstTurnRetained = lineReaderRetainedBytes();
        expect(turn.turnId.length).toBeGreaterThan(0);
        turns++;
      }

      expect(turns).toBe(expectedTurns);
      // The whole-file path could satisfy none of these: it went through no
      // reader at all, so it recorded zero and fails the floor - and it had
      // the entire file in hand before turn one, so had it been accounted
      // for it would have failed the ceiling.
      expect(firstTurnRetained).toBeGreaterThan(0);
      expect(firstTurnRetained).toBeLessThanOrEqual(bound);
      expect(lineReaderRetainedBytes()).toBeGreaterThanOrEqual(largestChunk);
      expect(lineReaderRetainedBytes()).toBeLessThanOrEqual(bound);
    });
  }
});
