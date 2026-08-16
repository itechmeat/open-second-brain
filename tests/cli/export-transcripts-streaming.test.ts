/**
 * `o2b brain export --format transcripts-jsonl` must not hold the corpus.
 *
 * The producer already streams and says so. `streamTranscriptConversations`
 * is a generator whose docblock promises "the corpus is never held whole",
 * and `read-lines.ts` beneath it never materialises a file. The CONSUMER
 * collected every released record into an array and `join`ed it, which put
 * the corpus in memory twice over and made both promises worthless - on a
 * release whose whole subject is not materialising transcripts.
 *
 * ## What is asserted, and why it is not a memory number
 *
 * Peak RSS was tried first and does not discriminate. On this workstation
 * a 63 MB corpus grew the child process's peak resident set by ~66 MB
 * whether the records were spooled or buffered, because what dominates is
 * uncollected `JSON.parse` garbage rather than anything the loop retains -
 * the same finding `sessions/streaming-memory.test.ts` records for the
 * layer below, and the same reason it measures the reader's own window
 * instead.
 *
 * So the property is asserted directly: record N is written before record
 * N+1 is asked for. That is exact, deterministic, and it is what "the
 * corpus is never held whole" MEANS for a consumer. A buffering consumer
 * produces every record before it writes any of them and fails the first
 * assertion here by construction.
 *
 * The second half of the pair is the guarantee a naive streaming fix would
 * have traded away: a refusal must leave nothing written. That one is
 * observable from outside and is asserted end-to-end in
 * `tests/cli/brain-export.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { spoolTranscriptCorpus } from "../../src/cli/brain/verbs/export.ts";
import {
  TRANSCRIPT_EXPORT_SCHEMA_VERSION,
  type TranscriptConversation,
  type TranscriptExportSummary,
} from "../../src/core/brain/export-transcripts.ts";

function conversation(index: number): TranscriptConversation {
  const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
  return {
    schema: TRANSCRIPT_EXPORT_SCHEMA_VERSION,
    runtime: "claude",
    session_id: `s${index}.jsonl`,
    started_at: at,
    ended_at: at,
    message_count: 1,
    messages: [{ turn_id: `t-${index}`, role: "user", timestamp: at, text: `turn ${index}` }],
  };
}

const SUMMARY: TranscriptExportSummary = {
  scanned: 4,
  exported: 4,
  other_runtime: 0,
  outside_window: 0,
  no_messages: 0,
  empty: 0,
};

describe("the transcript consumer writes as it reads", () => {
  test("each record is written before the next one is produced", async () => {
    const trace: string[] = [];
    async function* records(): AsyncGenerator<TranscriptConversation, TranscriptExportSummary> {
      for (let i = 0; i < 4; i++) {
        trace.push(`produced ${i}`);
        yield conversation(i);
      }
      return SUMMARY;
    }

    const outcome = await spoolTranscriptCorpus(records(), (line) => {
      trace.push(`wrote ${(JSON.parse(line) as { session_id: string }).session_id}`);
    });

    expect(outcome).toMatchObject({ kind: "written", written: 4, redacted: false });
    // Strictly interleaved. A consumer holding the corpus produces all
    // four and only then writes all four.
    expect(trace).toEqual([
      "produced 0",
      "wrote s0.jsonl",
      "produced 1",
      "wrote s1.jsonl",
      "produced 2",
      "wrote s2.jsonl",
      "produced 3",
      "wrote s3.jsonl",
    ]);
  });

  test("nothing is written once a record is refused, and the walk stops there", async () => {
    const trace: string[] = [];
    async function* records(): AsyncGenerator<TranscriptConversation, TranscriptExportSummary> {
      trace.push("produced 0");
      yield conversation(0);
      trace.push("produced 1");
      yield { ...conversation(1), session_id: "sk-live-9f2ba7c1d4e8.jsonl" };
      trace.push("produced 2");
      yield conversation(2);
      return SUMMARY;
    }

    const outcome = await spoolTranscriptCorpus(records(), (line) => {
      trace.push(`wrote ${(JSON.parse(line) as { session_id: string }).session_id}`);
    });

    expect(outcome.kind).toBe("refused");
    // The generator is abandoned at the refusal: record 2 is never asked
    // for, so no transcript after the offending one is even opened.
    expect(trace).toEqual(["produced 0", "wrote s0.jsonl", "produced 1"]);
    if (outcome.kind === "refused") {
      // And the refusal does not echo the name it refused.
      expect(outcome.detail).not.toContain("sk-live-9f2ba7c1d4e8");
      expect(outcome.detail).toContain("session_id");
    }
  });

  test("the summary rides out of the generator rather than being discarded", async () => {
    async function* records(): AsyncGenerator<TranscriptConversation, TranscriptExportSummary> {
      return { ...SUMMARY, scanned: 7, exported: 0, empty: 7 };
    }
    const outcome = await spoolTranscriptCorpus(records(), () => {
      throw new Error("nothing to write");
    });
    expect(outcome).toMatchObject({ kind: "written", written: 0 });
    if (outcome.kind === "written") expect(outcome.summary.empty).toBe(7);
  });
});
