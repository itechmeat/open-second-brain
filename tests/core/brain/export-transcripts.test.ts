/**
 * The transcript dataset builder (`o2b brain export --format
 * transcripts-jsonl`).
 *
 * Two properties carry the unit. The first is that a conversation record
 * is a CONVERSATION - ordered messages under one session, never a slice -
 * because a harness handed an assistant reply whose prompt was filtered
 * away learns from a prompt nobody wrote. The second is that nothing this
 * walk cannot account for is silently dropped: a `.jsonl` no adapter
 * recognises refuses the whole export, the same answer `collectExportRows`
 * gives a preference file it cannot parse.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  streamTranscriptConversations,
  TRANSCRIPT_EXPORT_SCHEMA_VERSION,
  type TranscriptConversation,
  type TranscriptExportOptions,
  type TranscriptExportSummary,
} from "../../../src/core/brain/export-transcripts.ts";
import { redactForEgress } from "../../../src/core/egress/guard.ts";
import { EGRESS_OUTCOME } from "../../../src/core/egress/guard.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "o2b-transcript-export-"));
}

function write(dir: string, name: string, lines: ReadonlyArray<unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

/** A two-turn Claude Code transcript: one user line, one assistant line. */
function claudeLines(opts: { readonly at: string; readonly uuid?: string }): unknown[] {
  return [
    {
      parentUuid: null,
      sessionId: "sess-1",
      entrypoint: "cli",
      type: "user",
      uuid: opts.uuid ?? "u-1",
      timestamp: opts.at,
      message: { role: "user", content: "how do I export a transcript" },
    },
    {
      parentUuid: opts.uuid ?? "u-1",
      sessionId: "sess-1",
      entrypoint: "cli",
      type: "assistant",
      uuid: "a-1",
      timestamp: opts.at,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "with the export verb" },
          { type: "tool_use", name: "Read", id: "call-1", input: { path: "/etc/passwd" } },
        ],
      },
    },
    // A queue-operation line is not a turn, and a payload-less turn carries
    // nothing a dataset can learn from; neither may become a message.
    { type: "queue-operation", op: "enqueue" },
  ];
}

function codexLines(at: string): unknown[] {
  return [
    { timestamp: at, type: "session_meta", payload: { originator: "codex_exec" } },
    {
      timestamp: at,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    },
  ];
}

/** Drain the stream into its records and its summary. */
async function drain(
  options: TranscriptExportOptions,
): Promise<{ records: TranscriptConversation[]; summary: TranscriptExportSummary }> {
  const records: TranscriptConversation[] = [];
  const it = streamTranscriptConversations(options);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const step = await it.next();
    if (step.done === true) return { records, summary: step.value };
    records.push(step.value);
  }
}

describe("transcript conversation records", () => {
  test("one record per session file, messages in transcript order", async () => {
    const dir = tempDir();
    try {
      write(dir, "one.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      const { records, summary } = await drain({ source: dir });
      expect(records.length).toBe(1);
      const record = records[0]!;
      expect(record.schema).toBe(TRANSCRIPT_EXPORT_SCHEMA_VERSION);
      expect(record.runtime).toBe("claude");
      expect(record.session_id).toBe("one.jsonl");
      expect(record.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(record.messages.map((m) => m.text)).toEqual([
        "how do I export a transcript",
        "with the export verb",
      ]);
      expect(record.message_count).toBe(2);
      expect(record.started_at).toBe("2026-08-01T10:00:00.000Z");
      expect(record.ended_at).toBe("2026-08-01T10:00:00.000Z");
      expect(summary.scanned).toBe(1);
      expect(summary.exported).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a message carries tool NAMES and never tool inputs", async () => {
    // The input of a `Read` is a host path and the input of a `Bash` is a
    // command line; a conversation dataset is not a tool-trace dataset, and
    // carrying the arguments would widen the corpus for nobody's benefit.
    const dir = tempDir();
    try {
      write(dir, "one.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      const { records } = await drain({ source: dir });
      expect(records[0]!.messages[1]!.tools).toEqual(["Read"]);
      expect(JSON.stringify(records[0])).not.toContain("/etc/passwd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nested directory is walked and the records are path-ordered", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "nested"));
      write(dir, "a.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      write(join(dir, "nested"), "b.jsonl", claudeLines({ at: "2026-08-02T10:00:00.000Z" }));
      const { records } = await drain({ source: dir });
      expect(records.map((r) => r.session_id)).toEqual(["a.jsonl", "b.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a single file is a legal source", async () => {
    const dir = tempDir();
    try {
      const path = write(dir, "one.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      const { records } = await drain({ source: path });
      expect(records.map((r) => r.session_id)).toEqual(["one.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the runtime filter keeps one runtime and counts what it set aside", async () => {
    const dir = tempDir();
    try {
      write(dir, "a-claude.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      write(dir, "b-codex.jsonl", codexLines("2026-08-01T11:00:00.000Z"));
      const { records, summary } = await drain({ source: dir, runtime: "codex" });
      expect(records.map((r) => r.runtime)).toEqual(["codex"]);
      expect(summary.scanned).toBe(2);
      expect(summary.other_runtime).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unregistered runtime is refused by name", async () => {
    const dir = tempDir();
    try {
      write(dir, "one.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      await expect(drain({ source: dir, runtime: "cursor" })).rejects.toThrow(/cursor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the window selects whole conversations by their start", async () => {
    const dir = tempDir();
    try {
      write(dir, "old.jsonl", claudeLines({ at: "2026-07-01T10:00:00.000Z" }));
      write(dir, "new.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      const { records, summary } = await drain({
        source: dir,
        since: new Date("2026-07-15T00:00:00.000Z"),
      });
      expect(records.map((r) => r.session_id)).toEqual(["new.jsonl"]);
      // Not sliced: the kept conversation is whole.
      expect(records[0]!.message_count).toBe(2);
      expect(summary.outside_window).toBe(1);

      const until = await drain({ source: dir, until: new Date("2026-07-15T00:00:00.000Z") });
      expect(until.records.map((r) => r.session_id)).toEqual(["old.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a .jsonl no adapter recognises refuses the export by name", async () => {
    // The same answer the preference export gives an unparseable rule: a
    // corpus that quietly omits a transcript reads exactly like a machine
    // that never recorded it.
    const dir = tempDir();
    try {
      write(dir, "one.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      write(dir, "stranger.jsonl", [{ hello: "world" }]);
      await expect(drain({ source: dir })).rejects.toThrow(/stranger\.jsonl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a source that does not exist is refused, not reported as an empty corpus", async () => {
    const dir = tempDir();
    try {
      await expect(drain({ source: join(dir, "absent") })).rejects.toThrow(/absent/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a transcript with no learnable turn is reported, never emitted empty", async () => {
    const dir = tempDir();
    try {
      write(dir, "empty.jsonl", [
        { parentUuid: null, sessionId: "s", entrypoint: "cli", type: "queue-operation" },
      ]);
      const { records, summary } = await drain({ source: dir });
      expect(records).toEqual([]);
      expect(summary.scanned).toBe(1);
      expect(summary.no_messages).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zero-byte transcript is counted, not made into a refusal", async () => {
    // Claude Code leaves these behind whenever a session opens and is
    // killed before the first turn flushes, and "move this file out of
    // the source directory" does not scale to a store that holds a
    // thousand transcripts. A file with no bytes has nothing to omit.
    const dir = tempDir();
    try {
      write(dir, "good.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      writeFileSync(join(dir, "flushed-nothing.jsonl"), "", "utf8");
      const { records, summary } = await drain({ source: dir });
      expect(records.map((r) => r.session_id)).toEqual(["good.jsonl"]);
      expect(summary.scanned).toBe(2);
      expect(summary.empty).toBe(1);
      // Every scanned file on exactly one counter, still.
      expect(
        summary.exported +
          summary.other_runtime +
          summary.outside_window +
          summary.no_messages +
          summary.empty,
      ).toBe(summary.scanned);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file whose first line is blank but whose second is a turn still refuses", async () => {
    // The complement of the case above, and the reason the empty check
    // reads the file's SIZE rather than trusting an empty first line:
    // this file has content, so skipping it would be the silent omission
    // the refusal exists to prevent.
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, "leading-blank.jsonl"),
        "\n" + JSON.stringify({ hello: "world" }) + "\n",
        "utf8",
      );
      await expect(drain({ source: dir })).rejects.toThrow(/leading-blank\.jsonl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--since refuses a transcript whose first turn carries no timestamp", async () => {
    // The docblock on `startInstant` forbids treating an unreadable
    // timestamp as either inside or outside the window, "both readings
    // are a guess, and one of them silently drops a transcript". Every
    // adapter synthesises the epoch for a missing timestamp, which parses
    // fine and sorts before any realistic `--since` - so the guarantee
    // held only for a malformed string, which no adapter ever emits, and
    // the case that does occur took the forbidden path.
    const dir = tempDir();
    try {
      write(dir, "clockless.jsonl", [
        {
          parentUuid: null,
          sessionId: "sess-1",
          entrypoint: "cli",
          type: "user",
          uuid: "u-1",
          message: { role: "user", content: "no timestamp on this line" },
        },
      ]);
      await expect(
        drain({ source: dir, since: new Date("2026-07-15T00:00:00.000Z") }),
      ).rejects.toThrow(/clockless\.jsonl.*no timestamp/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clockless transcript still exports when no window is asked for", async () => {
    // Refusing over a field nobody read would be a refusal for its own
    // sake; the window is the only thing that depends on the value.
    const dir = tempDir();
    try {
      write(dir, "clockless.jsonl", [
        {
          parentUuid: null,
          sessionId: "sess-1",
          entrypoint: "cli",
          type: "user",
          uuid: "u-1",
          message: { role: "user", content: "no timestamp on this line" },
        },
      ]);
      const { records } = await drain({ source: dir });
      expect(records.map((r) => r.session_id)).toEqual(["clockless.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a BARE high-entropy session filename is refused, not exported verbatim", async () => {
    // The identifier branch tests identifier values for VENDOR prefixes
    // only, on the argument that "record ids and slugs are long mixed runs
    // by construction". That argument is about ids this vault generates.
    // `session_id` is a foreign harness's filename, so an unexplained
    // 24-character mixed run in it is not an id by construction - and it
    // used to export with exit 0 while its `sk-`-prefixed sibling refused
    // the whole run.
    const dir = tempDir();
    try {
      write(dir, "Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5.jsonl", claudeLines({ at: "2026-08-01T10:00:00.000Z" }));
      const { records } = await drain({ source: dir });
      const verdict = redactForEgress("brain-export", records[0]!, { foreignIdentifiers: true });
      expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedSecretIdentifier);
      if (verdict.outcome === EGRESS_OUTCOME.refusedSecretIdentifier) {
        expect(verdict.secretIdentifiers).toContain("session_id");
        // Locations, not values: the refusal must not echo the name.
        expect(verdict.detail).not.toContain("Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a BARE high-entropy turn id is refused too", async () => {
    const dir = tempDir();
    try {
      write(
        dir,
        "one.jsonl",
        claudeLines({ at: "2026-08-01T10:00:00.000Z", uuid: "Xk7Qp2Rm9Wz4Tn6Yb8Vc3Ld5" }),
      );
      const { records } = await drain({ source: dir });
      const verdict = redactForEgress("brain-export", records[0]!, { foreignIdentifiers: true });
      expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedSecretIdentifier);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a uuid-named transcript is NOT refused: it is a content address", async () => {
    // The widening must not refuse every Claude Code session, whose files
    // are named by uuid - hex and dashes, which the redactor already
    // carves out as an identifier shape a bundle has to carry unchanged.
    const dir = tempDir();
    try {
      write(
        dir,
        "f47ac10b-58cc-4372-a567-0e02b2c3d479.jsonl",
        claudeLines({
          at: "2026-08-01T10:00:00.000Z",
          uuid: "a5d9e0f1-2b3c-4d5e-8f90-1a2b3c4d5e6f",
        }),
      );
      const { records } = await drain({ source: dir });
      const verdict = redactForEgress("brain-export", records[0]!, { foreignIdentifiers: true });
      expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a secret-shaped turn id lands where the egress guard refuses it", async () => {
    // The record shape is what decides whether the guard can see a
    // credential at all: an identifier is never rewritten, so it has to sit
    // under a key the structural redactor reads as an identity.
    const dir = tempDir();
    try {
      write(
        dir,
        "one.jsonl",
        claudeLines({ at: "2026-08-01T10:00:00.000Z", uuid: "sk-live-9f2ba7c1d4e8" }),
      );
      const { records } = await drain({ source: dir });
      const verdict = redactForEgress("brain-export", records[0]!);
      expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedSecretIdentifier);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
