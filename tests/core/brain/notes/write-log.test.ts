/**
 * The note-write reader (who-wrote-what, Task A / t_662f4e82).
 *
 * The filters, the newest-first order, and the one fact that cannot come
 * from the payload: the device, which the reader takes off the log shard
 * the entry was read from.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { listNoteWrites } from "../../../../src/core/brain/notes/write-log.ts";
import { NOTE_WRITE_OP } from "../../../../src/core/brain/notes/write-record.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-log-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

interface SeedInput {
  readonly timestamp: string;
  readonly agent: string;
  readonly target: string;
  readonly op?: string;
  readonly deviceId?: string;
  readonly writeId?: string;
}

function seed(input: SeedInput): void {
  appendLogEvent(
    vault,
    {
      timestamp: input.timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent: input.agent,
      body: {
        write_id: input.writeId ?? `nw_${input.timestamp.replace(/\D/g, "")}_${input.target}`,
        op: input.op ?? NOTE_WRITE_OP.update,
        target: input.target,
        hash_before: "a".repeat(64),
        hash_after: "b".repeat(64),
        bytes_before: "10",
        bytes_after: "20",
        agent: input.agent,
      },
    },
    { deviceId: input.deviceId ?? "" },
  );
}

describe("listNoteWrites", () => {
  test("returns every recorded write newest first", () => {
    seed({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md" });
    seed({ timestamp: "2026-03-05T02:00:00Z", agent: "b", target: "Two.md" });
    seed({ timestamp: "2026-03-04T03:00:00Z", agent: "a", target: "Three.md" });

    const { writes, warnings } = listNoteWrites(vault);
    expect(warnings).toEqual([]);
    expect(writes.map((w) => w.target)).toEqual(["Two.md", "Three.md", "One.md"]);
  });

  test("projects the recorded fields, parsing the byte counts back to numbers", () => {
    seed({
      timestamp: "2026-03-04T01:00:00Z",
      agent: "agent-a",
      target: "Notes/One.md",
      op: NOTE_WRITE_OP.append,
      writeId: "nw_20260304010000_0123456789abcdef",
    });
    const record = listNoteWrites(vault).writes[0]!;
    expect(record.write_id).toBe("nw_20260304010000_0123456789abcdef");
    expect(record.op).toBe(NOTE_WRITE_OP.append);
    expect(record.target).toBe("Notes/One.md");
    expect(record.agent).toBe("agent-a");
    expect(record.bytes_before).toBe(10);
    expect(record.bytes_after).toBe(20);
    expect(record.hash_before).toBe("a".repeat(64));
    // The appender stamps the channel; the reader carries it through.
    expect(record.origin_channel).not.toBeNull();
  });

  test("the device comes off the shard the entry was read from", () => {
    seed({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md", deviceId: "laptop" });
    seed({ timestamp: "2026-03-04T02:00:00Z", agent: "a", target: "Two.md", deviceId: "desktop" });
    seed({ timestamp: "2026-03-04T03:00:00Z", agent: "a", target: "Three.md" });

    const byTarget = new Map(listNoteWrites(vault).writes.map((w) => [w.target, w.device]));
    expect(byTarget.get("One.md")).toBe("laptop");
    expect(byTarget.get("Two.md")).toBe("desktop");
    // The legacy un-sharded pair is the empty device, which is an answer.
    expect(byTarget.get("Three.md")).toBe("");
  });

  test("filters by agent, device, path and op", () => {
    seed({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md", deviceId: "laptop" });
    seed({ timestamp: "2026-03-04T02:00:00Z", agent: "b", target: "One.md", deviceId: "laptop" });
    seed({
      timestamp: "2026-03-04T03:00:00Z",
      agent: "a",
      target: "Two.md",
      deviceId: "desktop",
      op: NOTE_WRITE_OP.create,
    });

    expect(listNoteWrites(vault, { agent: "a" }).writes.map((w) => w.target)).toEqual([
      "Two.md",
      "One.md",
    ]);
    expect(listNoteWrites(vault, { device: "desktop" }).writes.map((w) => w.target)).toEqual([
      "Two.md",
    ]);
    expect(listNoteWrites(vault, { path: "One.md" }).writes.map((w) => w.agent)).toEqual([
      "b",
      "a",
    ]);
    expect(listNoteWrites(vault, { op: NOTE_WRITE_OP.create }).writes).toHaveLength(1);
    expect(listNoteWrites(vault, { agent: "a", path: "One.md" }).writes).toHaveLength(1);
  });

  test("a bare --until date covers the whole day it names", () => {
    seed({ timestamp: "2026-03-04T23:59:00Z", agent: "a", target: "Late.md" });
    seed({ timestamp: "2026-03-05T00:00:01Z", agent: "a", target: "Next.md" });

    expect(listNoteWrites(vault, { until: "2026-03-04" }).writes.map((w) => w.target)).toEqual([
      "Late.md",
    ]);
    expect(listNoteWrites(vault, { since: "2026-03-05" }).writes.map((w) => w.target)).toEqual([
      "Next.md",
    ]);
    expect(
      listNoteWrites(vault, { since: "2026-03-04T23:59:30Z" }).writes.map((w) => w.target),
    ).toEqual(["Next.md"]);
  });

  test("events of other kinds are not note writes", () => {
    appendLogEvent(
      vault,
      {
        timestamp: "2026-03-04T01:00:00Z",
        eventType: BRAIN_LOG_EVENT_KIND.note,
        agent: "a",
        body: { text: "a milestone" },
      },
      { deviceId: "" },
    );
    expect(listNoteWrites(vault).writes).toEqual([]);
  });

  test("a note-write line missing its target is not projected as a blank row", () => {
    appendLogEvent(
      vault,
      {
        timestamp: "2026-03-04T01:00:00Z",
        eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
        agent: "a",
        body: { write_id: "nw_1_x", op: NOTE_WRITE_OP.update },
      },
      { deviceId: "" },
    );
    expect(listNoteWrites(vault).writes).toEqual([]);
  });

  test("an empty vault reports no writes and no warnings", () => {
    expect(listNoteWrites(vault)).toEqual({ writes: [], warnings: [] });
  });
});
