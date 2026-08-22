/**
 * `brain_extract_signals` MCP tool (salience-lifecycle-enrichment,
 * unit 2, t_1dace26d). Claims pinned here:
 *
 *  1. Called without `items` the tool is the read-only plan phase and
 *     returns exactly one needs-llm-step envelope.
 *  2. Called with `items` it commits, and the written signals carry the
 *     new `auto_extract` source type.
 *  3. An over-cap payload is refused as a caller error, not a server
 *     fault, and nothing is written.
 *  4. The tool is full-tier, absent from the writer surface.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTO_EXTRACT_PER_SESSION_CAP } from "../../src/core/brain/extract-signals.ts";
import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const TOOL = "brain_extract_signals";
const SESSION = "sess-mcp";
let tmp: string;
let vault: string;
let ctx: ServerContext;

function tool() {
  return findTool(buildToolTable("full"), TOOL);
}

function inboxCount(): number {
  const dir = join(vault, "Brain", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
}

const ITEM = {
  topic: "heading-style",
  signal: "positive",
  principle: "Name the release theme in the heading.",
  confidence: 0.88,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-extract-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      {
        turnId: "t1",
        timestamp: "2026-08-22T09:01:00Z",
        role: "user",
        text: "Always name the release theme in the heading.",
      },
    ],
    createdAt: "2026-08-22T10:00:00Z",
  });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("without items it plans and returns one needs-llm-step envelope", async () => {
  const res = (await tool().handler(ctx, { session: SESSION })) as {
    phase: string;
    turns_mined: ReadonlyArray<{ turn_id: string }>;
    llm_step: { status: string; step: string; target_path: string };
  };
  expect(res.phase).toBe("plan");
  expect(res.turns_mined.map((t) => t.turn_id)).toEqual(["t1"]);
  expect(res.llm_step.status).toBe("needs-llm-step");
  expect(res.llm_step.step).toBe("extract-signals");
  expect(res.llm_step.target_path).toBe("Brain/inbox");
  expect(inboxCount()).toBe(0);
});

test("with items it commits them as auto_extract signals", async () => {
  const res = (await tool().handler(ctx, { session: SESSION, items: [ITEM] })) as {
    phase: string;
    written: ReadonlyArray<{ topic: string }>;
  };
  expect(res.phase).toBe("commit");
  expect(res.written.map((w) => w.topic)).toEqual(["heading-style"]);
  expect(inboxCount()).toBe(1);
});

test("an over-cap payload is refused and writes nothing", async () => {
  const items = Array.from({ length: AUTO_EXTRACT_PER_SESSION_CAP + 1 }, (_v, i) => ({
    ...ITEM,
    topic: `topic-${i}`,
  }));
  await expect(Promise.resolve(tool().handler(ctx, { session: SESSION, items }))).rejects.toThrow(
    String(AUTO_EXTRACT_PER_SESSION_CAP),
  );
  expect(inboxCount()).toBe(0);
});

test("is a full-tier tool, absent from the writer surface", () => {
  expect(buildToolTable("full").find((t) => t.name === TOOL)).toBeDefined();
  expect(buildToolTable("writer").find((t) => t.name === TOOL)).toBeUndefined();
});
