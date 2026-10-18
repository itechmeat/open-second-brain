/**
 * The destination-keyed write aggregate (actionable-now batch, A3 /
 * t_69fec179).
 *
 * Seeds go through `appendLogEvent` only - never hand-written logs - so
 * the fixtures stay in lockstep with production output. The exceptions
 * are hand-written shard lines on purpose: the unreadable-day torn line
 * is the warning path the reader exists to survive, and the sub-second
 * foreign line exercises a timestamp shape the writer never stamps.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { listLogShardFiles } from "../../../../src/core/brain/log-jsonl.ts";
import {
  DEFAULT_WRITE_DESTINATION_WINDOW_DAYS,
  WRITE_DESTINATION_COVERAGE_NOTE,
  WRITE_DESTINATION_KIND,
  listWriteDestinations,
} from "../../../../src/core/brain/notes/write-destinations.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-destinations-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

interface NoteWriteSeed {
  readonly timestamp: string;
  readonly agent: string;
  readonly target: string;
  readonly deviceId?: string;
}

function seedNoteWrite(input: NoteWriteSeed): void {
  appendLogEvent(
    vault,
    {
      timestamp: input.timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent: input.agent,
      body: {
        write_id: `nw_${input.timestamp.replace(/\D/g, "")}_${input.target}`,
        op: "update",
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

interface WriteSessionSeed {
  readonly timestamp: string;
  readonly agent: string;
  readonly target: string;
  readonly deviceId?: string;
  /** Terminal status; defaults to `done` (the committed case). */
  readonly status?: "done" | "failed";
  /** The terminal-failure reason `auditTerminal` records for a failed session. */
  readonly reason?: string;
}

function seedWriteSession(input: WriteSessionSeed): void {
  const status = input.status ?? "done";
  appendLogEvent(
    vault,
    {
      timestamp: input.timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.writeSession,
      agent: input.agent,
      body: {
        session_id: `ws_${input.timestamp.replace(/\D/g, "")}`,
        kind: "artifact",
        status,
        target: input.target,
        attempts: "1",
        review: "not-required",
        ...(status === "failed" && input.reason !== undefined ? { reason: input.reason } : {}),
      },
    },
    { deviceId: input.deviceId ?? "" },
  );
}

describe("listWriteDestinations", () => {
  test("folds both kinds into one row per destination with agents, devices and kinds", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "alpha", target: "Notes/One.md" });
    seedNoteWrite({ timestamp: "2026-03-04T02:00:00Z", agent: "beta", target: "Notes/One.md" });
    seedWriteSession({
      timestamp: "2026-03-05T03:00:00Z",
      agent: "alpha",
      target: "Notes/One.md",
      deviceId: "laptop",
    });

    const result = listWriteDestinations(vault, {
      until: "2026-03-05",
      now: new Date("2026-03-05T12:00:00Z"),
    });
    expect(result.warnings).toEqual([]);
    expect(result.destinations).toHaveLength(1);
    const row = result.destinations[0]!;
    expect(row.target).toBe("Notes/One.md");
    expect(row.kinds).toEqual([
      WRITE_DESTINATION_KIND.noteWrite,
      WRITE_DESTINATION_KIND.writeSession,
    ]);
    expect(row.note_writes).toBe(2);
    expect(row.write_sessions).toBe(1);
    expect([...row.agents]).toEqual(["alpha", "beta"]);
    expect([...row.devices]).toEqual(["", "laptop"]);
    expect(row.last_write).toBe("2026-03-05T03:00:00Z");
  });

  test("a destination touched only by a write-session audit still appears, honestly", () => {
    seedWriteSession({
      timestamp: "2026-03-04T01:00:00Z",
      agent: "alpha",
      target: "Reports/Q1.md",
    });
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations).toHaveLength(1);
    const row = result.destinations[0]!;
    expect(row.target).toBe("Reports/Q1.md");
    expect(row.kinds).toEqual([WRITE_DESTINATION_KIND.writeSession]);
    expect(row.note_writes).toBe(0);
    expect(row.write_sessions).toBe(1);
  });

  test("a failed write-session audit is not a write; only done sessions count", () => {
    // `auditTerminal` emits a failed row for a session that died before
    // anything landed (abandoned / retry-cap / expired): no bytes moved,
    // so the aggregate must not claim a write.
    seedWriteSession({
      timestamp: "2026-03-04T01:00:00Z",
      agent: "alpha",
      target: "Notes/One.md",
      status: "failed",
      reason: "abandoned",
    });
    seedWriteSession({
      timestamp: "2026-03-04T02:00:00Z",
      agent: "alpha",
      target: "Notes/One.md",
    });
    seedWriteSession({
      timestamp: "2026-03-04T03:00:00Z",
      agent: "alpha",
      target: "Notes/Ghost.md",
      status: "failed",
      reason: "retry-cap",
    });
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["Notes/One.md"]);
    const row = result.destinations[0]!;
    expect(row.write_sessions).toBe(1);
    expect(row.writes).toBe(1);
    expect(row.last_write).toBe("2026-03-04T02:00:00Z");
  });

  test("events of neither recorded kind never create a row, and the note says so", () => {
    appendLogEvent(
      vault,
      {
        timestamp: "2026-03-04T01:00:00Z",
        eventType: BRAIN_LOG_EVENT_KIND.note,
        agent: "alpha",
        body: { text: "a milestone" },
      },
      { deviceId: "" },
    );
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations).toEqual([]);
    // The coverage note states the honesty contract rather than implying
    // the aggregate is complete.
    expect(result.coverage_note).toBe(WRITE_DESTINATION_COVERAGE_NOTE);
    expect(result.coverage_note.length).toBeGreaterThan(40);
  });

  test("an until-only query anchors the default window on until, not on the present", () => {
    seedNoteWrite({ timestamp: "2026-02-25T01:00:00Z", agent: "a", target: "Ancient.md" });
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "Old.md" });
    // No `now` at all: the wall clock is years past the seeded day, so a
    // now-anchored default would answer a clean, wrong empty.
    const result = listWriteDestinations(vault, { until: "2026-03-04" });
    // The until day itself is the seventh day of the default window.
    expect(result.window).toEqual({
      since: "2026-02-26T00:00:00Z",
      until: "2026-03-04T23:59:59.999Z",
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["Old.md"]);
  });

  test("a given now does not drag an until-only window back to the present", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "Old.md" });
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2031-01-01T00:00:00Z"),
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["Old.md"]);
  });

  test("the default window covers seven days and since/until narrow the walk", () => {
    expect(DEFAULT_WRITE_DESTINATION_WINDOW_DAYS).toBe(7);
    seedNoteWrite({ timestamp: "2026-03-01T01:00:00Z", agent: "a", target: "Old.md" });
    seedNoteWrite({ timestamp: "2026-03-10T01:00:00Z", agent: "a", target: "New.md" });
    // `now` pins the walk: 2026-03-10 minus 6 days reaches 2026-03-04, so
    // the March 1 write is outside the default window.
    const result = listWriteDestinations(vault, {
      until: "2026-03-10",
      now: new Date("2026-03-10T12:00:00Z"),
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["New.md"]);
    const narrowed = listWriteDestinations(vault, {
      since: "2026-03-01",
      until: "2026-03-01",
    });
    expect(narrowed.destinations.map((d) => d.target)).toEqual(["Old.md"]);
  });

  test("an unreadable day yields a warning and not an empty group", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md" });
    // A torn line on the SAME day: the parseable rows survive and the
    // warning rides out beside them.
    const shards = listLogShardFiles(vault);
    expect(shards.length).toBeGreaterThan(0);
    appendFileSync(shards[0]!.path, "not-json\n");
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.destinations.map((d) => d.target)).toEqual(["One.md"]);
  });

  test("rows order by target and equal-second seeds keep their order inside a row", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "beta", target: "Zed.md" });
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "alpha", target: "Zed.md" });
    seedNoteWrite({ timestamp: "2026-03-04T02:00:00Z", agent: "a", target: "Aye.md" });
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["Aye.md", "Zed.md"]);
    expect([...result.destinations[1]!.agents]).toEqual(["beta", "alpha"]);
  });

  test("last_write orders by instant when a sub-second foreign line meets a whole-second one", () => {
    // The JSONL reader admits foreign sub-second timestamps the writer
    // never stamps, and a plain string compare orders `…56.789Z` before
    // `…56Z` - the exact reason `log-window.ts` compares instants. The
    // hand-written shard line is the second fixture exception: a foreign
    // line is by definition not production output.
    seedNoteWrite({ timestamp: "2026-03-04T12:34:56Z", agent: "a", target: "Same.md" });
    const shards = listLogShardFiles(vault);
    expect(shards.length).toBeGreaterThan(0);
    appendFileSync(
      shards[0]!.path,
      `${JSON.stringify({
        ts: "2026-03-04T12:34:56.789Z",
        kind: "note-write",
        payload: { target: "Same.md", agent: "foreign" },
      })}\n`,
      "utf8",
    );
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations).toHaveLength(1);
    expect(result.destinations[0]!.note_writes).toBe(2);
    expect(result.destinations[0]!.last_write).toBe("2026-03-04T12:34:56.789Z");
  });

  test("filters by agent, device and exact path", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md" });
    seedNoteWrite({
      timestamp: "2026-03-04T02:00:00Z",
      agent: "b",
      target: "One.md",
      deviceId: "laptop",
    });
    seedNoteWrite({ timestamp: "2026-03-04T03:00:00Z", agent: "a", target: "Two.md" });
    seedWriteSession({
      timestamp: "2026-03-04T04:00:00Z",
      agent: "b",
      target: "Three.md",
      deviceId: "laptop",
    });

    const byAgent = listWriteDestinations(vault, {
      agent: "a",
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(byAgent.destinations.map((d) => d.target)).toEqual(["One.md", "Two.md"]);
    const byAgentRow = byAgent.destinations[0]!;
    // The kinds field only names the kinds the FILTERED events contributed.
    expect(byAgentRow.kinds).toEqual([WRITE_DESTINATION_KIND.noteWrite]);

    const byDevice = listWriteDestinations(vault, {
      device: "laptop",
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(byDevice.destinations.map((d) => d.target)).toEqual(["One.md", "Three.md"]);

    const byPath = listWriteDestinations(vault, {
      path: "Three.md",
      until: "2026-03-04",
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(byPath.destinations).toHaveLength(1);
    expect(byPath.destinations[0]!.write_sessions).toBe(1);
  });

  test("limit truncates and total_matched reports the pre-truncation count", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "A.md" });
    seedNoteWrite({ timestamp: "2026-03-04T02:00:00Z", agent: "a", target: "B.md" });
    seedNoteWrite({ timestamp: "2026-03-04T03:00:00Z", agent: "a", target: "C.md" });
    const result = listWriteDestinations(vault, {
      until: "2026-03-04",
      limit: 2,
      now: new Date("2026-03-04T12:00:00Z"),
    });
    expect(result.destinations.map((d) => d.target)).toEqual(["A.md", "B.md"]);
    expect(result.total_matched).toBe(3);
    expect(result.limit).toBe(2);
  });

  test("a query writes nothing to the vault", () => {
    seedNoteWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "a", target: "One.md" });
    const fingerprint = (): string =>
      readdirSync(vault, { withFileTypes: true })
        .map((e) => {
          const abs = join(vault, e.name);
          return e.isDirectory()
            ? `d:${e.name}:${readdirSync(abs).toSorted().join(",")}`
            : `f:${e.name}:${readFileSync(abs, "utf8")}`;
        })
        .toSorted()
        .join("\n");
    const before = fingerprint();
    listWriteDestinations(vault, { until: "2026-03-04", now: new Date("2026-03-04T12:00:00Z") });
    expect(fingerprint()).toBe(before);
  });
});
