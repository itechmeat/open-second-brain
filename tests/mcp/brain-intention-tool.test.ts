import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-intention-tool-"));
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  ctx = { vault: tmp, configPath: null, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function intentionTool() {
  return findTool(buildToolTable("full"), "brain_intention");
}

test("set / show / list / move round-trip through the consolidated tool", async () => {
  const tool = intentionTool();
  const set = (await tool.handler(ctx, {
    operation: "set",
    scope: "ws-1",
    text: "Ship the suite",
  })) as { scope: string; version: number };
  expect(set.scope).toBe("ws-1");
  expect(set.version).toBe(1);

  const show = (await tool.handler(ctx, { operation: "show", scope: "ws-1" })) as {
    present: boolean;
    text: string;
  };
  expect(show.present).toBe(true);
  expect(show.text).toBe("Ship the suite");

  const list = (await tool.handler(ctx, { operation: "list" })) as {
    intentions: Array<{ scope: string }>;
  };
  expect(list.intentions.map((i) => i.scope)).toEqual(["ws-1"]);

  const move = (await tool.handler(ctx, { operation: "move", scope: "ws-1" })) as {
    archive_path: string;
  };
  expect(move.archive_path).toContain("history");

  const after = (await tool.handler(ctx, { operation: "show", scope: "ws-1" })) as {
    present: boolean;
  };
  expect(after.present).toBe(false);
});

test("invalid operations and missing arguments are rejected", () => {
  const tool = intentionTool();
  expect(() => tool.handler(ctx, { operation: "archive" })).toThrow();
  expect(() => tool.handler(ctx, { operation: "set", scope: "ws" })).toThrow();
  expect(() => tool.handler(ctx, { operation: "show" })).toThrow();
});
