/**
 * `brain_write_destinations` (actionable-now batch, A4 / t_69fec179):
 * the MCP exposure of the destination-keyed write aggregate, beside
 * `brain_writes`. Read-only; limit + cursor pagination; reach filtering
 * drops a withheld page from rows AND totals before counting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { recordNoteWrite } from "../../src/core/brain/notes/write-record.ts";
import { WRITE_DESTINATION_COVERAGE_NOTE } from "../../src/core/brain/notes/write-destinations.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-destinations-tool-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-write-destinations-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapQuiet(vault, configPath);
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Log dir only - the aggregate reads, so nothing else is needed. */
function bootstrapQuiet(vaultPath: string, configPath: string): void {
  mkdirSync(join(vaultPath, "Brain", "log"), { recursive: true });
  void configPath;
}

const tool = (name: string) => BRAIN_TOOLS.find((t) => t.name === name)!;

const call = async (args: Record<string, unknown>) =>
  (await tool("brain_write_destinations").handler(ctx, args)) as Record<string, unknown>;

/** The destination a recorded write names is a file that landed: the
 * remote-reach rule reads it, and a log row over a missing file fails
 * closed, so the fixtures land real bytes like the seams do. */
function landTarget(target: string): void {
  const abs = join(vault, target);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteFileSync(abs, `body of ${target}\n`);
}

function seedNoteWrite(timestamp: string, agent: string, target: string, deviceId = ""): void {
  landTarget(target);
  appendLogEvent(
    vault,
    {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent,
      body: {
        write_id: `nw_${timestamp.replace(/\D/g, "")}_${target}`,
        op: "update",
        target,
        hash_before: "a".repeat(64),
        hash_after: "b".repeat(64),
        bytes_before: "10",
        bytes_after: "20",
        agent,
      },
    },
    { deviceId },
  );
}

function seedWriteSession(timestamp: string, agent: string, target: string): void {
  landTarget(target);
  appendLogEvent(
    vault,
    {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.writeSession,
      agent,
      body: {
        session_id: `ws_${timestamp.replace(/\D/g, "")}`,
        kind: "artifact",
        status: "done",
        target,
        attempts: "1",
        review: "not-required",
      },
    },
    { deviceId: "" },
  );
}

interface DestinationsReply {
  readonly total_matched: number;
  readonly returned: number;
  readonly destinations: ReadonlyArray<Record<string, unknown>>;
  readonly window: { readonly since: string | null; readonly until: string | null };
  readonly warnings: ReadonlyArray<unknown>;
  readonly coverage_note: string;
  readonly next_cursor: string | null;
}

describe("brain_write_destinations registration", () => {
  test("is registered, read-only by shape, takes no required argument, and is budget-exempt", () => {
    const def = tool("brain_write_destinations");
    expect(def).toBeDefined();
    expect(def.inputSchema.required ?? []).toEqual([]);
    // Bounded by the limit in the handler; exempt from the preview budget
    // with a written bounded-summary reason in registry-guard.ts.
    expect(def.previewBudget).toBeUndefined();
  });

  test("the schema names exactly the aggregate's filters", () => {
    const schema = tool("brain_write_destinations").inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
      "agent",
      "cursor",
      "device",
      "limit",
      "path",
      "since",
      "until",
    ]);
  });
});

describe("brain_write_destinations listing", () => {
  test("returns the aggregate rows, the coverage note and the totals", async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "Notes/One.md");
    seedWriteSession("2026-03-04T02:00:00Z", "alpha", "Notes/One.md");
    seedWriteSession("2026-03-04T03:00:00Z", "beta", "Notes/Two.md");
    const reply = (await call({
      since: "2026-03-01",
      until: "2026-03-04",
    })) as unknown as DestinationsReply;
    expect(reply.total_matched).toBe(2);
    expect(reply.returned).toBe(2);
    expect(reply.next_cursor).toBeNull();
    expect(reply.coverage_note).toBe(WRITE_DESTINATION_COVERAGE_NOTE);
    const one = reply.destinations.find((d) => d["target"] === "Notes/One.md")!;
    expect(one["note_writes"]).toBe(1);
    expect(one["write_sessions"]).toBe(1);
    expect(one["kinds"]).toEqual(["note-write", "write-session"]);
  });

  test("the payload carries the exact covered window, implicit lower bound included", async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "One.md");
    // Both bounds explicit: `since` canonicalizes to that day's start and
    // `until` through that day's end - no default fills either edge.
    const reply = (await call({
      since: "2026-03-01",
      until: "2026-03-04",
    })) as unknown as DestinationsReply;
    expect(reply.window).toEqual({
      since: "2026-03-01T00:00:00Z",
      until: "2026-03-04T23:59:59.999Z",
    });

    // With `until` given and `since` omitted, the default 7-day lower
    // bound is anchored on it: the query is about the period ending
    // 2026-03-04, so the window opens six days earlier at that day's start.
    const anchored = (await call({ until: "2026-03-04" })) as unknown as DestinationsReply;
    expect(anchored.window).toEqual({
      since: "2026-02-26T00:00:00Z",
      until: "2026-03-04T23:59:59.999Z",
    });

    // No bounds: the upper end is now, and the payload says so instead of
    // letting a null read as an unbounded walk.
    const unbounded = (await call({})) as unknown as DestinationsReply;
    expect(unbounded.window).toEqual({
      since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/),
      until: null,
    });
  });

  test("filters agent, device, path and the time window", async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "One.md");
    seedNoteWrite("2026-03-04T02:00:00Z", "beta", "One.md", "laptop");
    seedWriteSession("2026-03-04T03:00:00Z", "beta", "Three.md");

    expect(
      (
        (await call({
          agent: "alpha",
          since: "2026-03-01",
          until: "2026-03-04",
        })) as unknown as DestinationsReply
      ).destinations.map((d) => d["target"]),
    ).toEqual(["One.md"]);
    // The device comes off the log shard: only One.md's second write ran
    // on laptop; the write-session row carries the un-sharded device.
    expect(
      (
        (await call({
          device: "laptop",
          since: "2026-03-01",
          until: "2026-03-04",
        })) as unknown as DestinationsReply
      ).destinations.map((d) => d["target"]),
    ).toEqual(["One.md"]);
    expect(
      (
        (await call({
          path: "Three.md",
          since: "2026-03-01",
          until: "2026-03-04",
        })) as unknown as DestinationsReply
      ).destinations,
    ).toHaveLength(1);
    expect(
      ((await call({ since: "2031-01-01", until: "2031-01-02" })) as unknown as DestinationsReply)
        .total_matched,
    ).toBe(0);
  });

  test('device "" selects the legacy un-sharded shard, not everything', async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "One.md");
    seedNoteWrite("2026-03-04T02:00:00Z", "beta", "One.md", "laptop");
    const reply = (await call({
      device: "",
      since: "2026-03-01",
      until: "2026-03-04",
    })) as unknown as DestinationsReply;
    expect(reply.total_matched).toBe(1);
    expect(reply.destinations[0]!["agents"]).toEqual(["alpha"]);
  });

  test("a malformed bound is INVALID_PARAMS naming the argument, not a silent empty", async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "One.md");
    for (const [field, value] of [
      ["since", "yesterday"],
      ["until", "03/01/2026"],
    ] as const) {
      const thrown = await call({ [field]: value }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(MCPError);
      const mcpError = thrown as MCPError;
      expect(mcpError.code).toBe(INVALID_PARAMS);
      expect(mcpError.message).toContain(field);
      expect(mcpError.message).toContain(value);
    }
  });

  test("limit + cursor round-trip reports total_matched across pages", async () => {
    seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "A.md");
    seedNoteWrite("2026-03-04T02:00:00Z", "alpha", "B.md");
    seedNoteWrite("2026-03-04T03:00:00Z", "alpha", "C.md");
    const first = (await call({
      since: "2026-03-01",
      until: "2026-03-04",
      limit: 2,
    })) as unknown as DestinationsReply;
    expect(first.destinations.map((d) => d["target"])).toEqual(["A.md", "B.md"]);
    expect(first.total_matched).toBe(3);
    expect(first.next_cursor).not.toBeNull();

    const second = (await call({
      since: "2026-03-01",
      until: "2026-03-04",
      limit: 2,
      cursor: first.next_cursor!,
    })) as unknown as DestinationsReply;
    expect(second.destinations.map((d) => d["target"])).toEqual(["C.md"]);
    expect(second.total_matched).toBe(3);
  });
});

describe("brain_write_destinations at remote reach", () => {
  const RESERVED = "notes/zzreservedzz.md";
  const OPEN = "notes/open.md";

  function seedBoth(): void {
    for (const [target, bytes] of [
      [OPEN, "open body"],
      [RESERVED, "---\nvisibility: [private]\n---\n\nreserved body"],
    ] as const) {
      const abs = join(vault, target);
      mkdirSync(dirname(abs), { recursive: true });
      atomicWriteFileSync(abs, bytes);
      recordNoteWrite(vault, {
        op: "create",
        target,
        before: null,
        after: { bytes },
        timestamp: "2026-03-04T01:00:00Z",
        agent: "claude",
      });
    }
  }

  const callAt = async (reach: "local" | "remote", args: Record<string, unknown>) =>
    (await tool("brain_write_destinations").handler({ ...ctx, reach }, args)) as Record<
      string,
      unknown
    >;

  test("a withheld page moves no row and no total", async () => {
    seedBoth();
    const local = (await callAt("local", {
      since: "2026-03-01",
      until: "2026-03-04",
    })) as unknown as DestinationsReply;
    expect(local.destinations.map((d) => d["target"]).toSorted()).toEqual(
      [OPEN, RESERVED].toSorted(),
    );
    expect(local.total_matched).toBe(2);

    const remote = (await callAt("remote", {
      since: "2026-03-01",
      until: "2026-03-04",
    })) as unknown as DestinationsReply;
    expect(remote.destinations.map((d) => d["target"])).toEqual([OPEN]);
    expect(remote.total_matched).toBe(1);
    expect(JSON.stringify(remote)).not.toContain("zzreservedzz");
  });
});
