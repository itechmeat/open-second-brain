import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-calendar-tool-"));
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  ctx = { vault: tmp, configPath: null, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

test("brain_obligation add / done / list / show / remove round-trip", async () => {
  const ob = tool("brain_obligation");
  const add = (await ob.handler(ctx, {
    operation: "add",
    title: "Weekly Review",
    cadence: "weekly",
    anchor: "2026-06-22",
  })) as { obligation: { slug: string; next_due: string } };
  expect(add.obligation.slug).toBe("weekly-review");
  expect(add.obligation.next_due).toBe("2026-06-22");

  const done = (await ob.handler(ctx, {
    operation: "done",
    slug: "weekly-review",
    date: "2026-06-22",
  })) as { obligation: { next_due: string; last_done: string } };
  expect(done.obligation.last_done).toBe("2026-06-22");
  expect(done.obligation.next_due).toBe("2026-06-29");

  const list = (await ob.handler(ctx, { operation: "list" })) as {
    obligations: Array<{ slug: string }>;
  };
  expect(list.obligations.map((o) => o.slug)).toEqual(["weekly-review"]);

  const show = (await ob.handler(ctx, { operation: "show", slug: "weekly-review" })) as {
    present: boolean;
  };
  expect(show.present).toBe(true);

  const removed = (await ob.handler(ctx, { operation: "remove", slug: "weekly-review" })) as {
    archive_path: string;
  };
  expect(removed.archive_path).toContain("archive");
});

test("brain_obligation rejects bad operations and cadences", () => {
  const ob = tool("brain_obligation");
  expect(() => ob.handler(ctx, { operation: "frobnicate" })).toThrow();
  expect(() => ob.handler(ctx, { operation: "add", title: "X", cadence: "never" })).toThrow();
});

test("brain_agenda computes conflicts, focus blocks, and external organizers", async () => {
  const ag = tool("brain_agenda");
  const result = (await ag.handler(ctx, {
    events: [
      {
        id: "a",
        title: "Standup",
        start: "2026-06-19T09:00:00Z",
        end: "2026-06-19T09:30:00Z",
        organizer: "me@acme.io",
      },
      { id: "b", title: "Design", start: "2026-06-19T11:00:00Z", end: "2026-06-19T12:00:00Z" },
      {
        id: "c",
        title: "Vendor",
        start: "2026-06-19T11:30:00Z",
        end: "2026-06-19T12:30:00Z",
        organizer: "rep@vendor.com",
      },
    ],
    focus_min_minutes: 60,
    owner_domains: ["acme.io"],
  })) as {
    counts: { conflicts: number; focus_blocks: number; external_organizers: number };
  };
  expect(result.counts.conflicts).toBe(1);
  expect(result.counts.focus_blocks).toBe(1);
  expect(result.counts.external_organizers).toBe(1);
});

test("brain_agenda rejects malformed events", () => {
  const ag = tool("brain_agenda");
  expect(() => ag.handler(ctx, { events: "nope" })).toThrow();
  expect(() => ag.handler(ctx, { events: [{ start: "x" }] })).toThrow();
});
