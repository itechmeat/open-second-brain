/**
 * `brain_changes` (task 1.9): the MCP front door of the change probe.
 *
 *   1. At local reach it returns a neighbour's record id under its topic
 *      and scope, after the watermark of an earlier call.
 *   2. Below local reach it answers nothing, by name: brain store records
 *      reach local callers only, the rule search applies to them too.
 *   3. A malformed watermark is an invalid-params error naming the fix.
 *   4. A page larger than a preview still carries its watermark inline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../src/core/search/brain-store/constants.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { CHANGES_REACH_REASON, CHANGES_TOOLS } from "../../src/mcp/brain/changes-tools.ts";
import { ArtifactStore } from "../../src/mcp/artifact-store.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { buildMcpToolResult } from "../../src/mcp/server.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "../core/search/fixtures/brain-store-index.ts";

const handler = CHANGES_TOOLS.find((t) => t.name === "brain_changes")!.handler;
const ENV_KEYS = [STORE_ROOT_ENV, STORE_CATCH_UP_INTERVAL_ENV, "XDG_STATE_HOME", "LOCALAPPDATA"];

let fx: StoreIndexFixture;
let ctx: ServerContext;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  fx = makeStoreIndexFixture("osb-mcp-changes-");
  fx.open(LOCAL_DEVICE);
  const state = fx.dirs(LOCAL_DEVICE).env;
  process.env[STORE_ROOT_ENV] = fx.root;
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  process.env["XDG_STATE_HOME"] = state["XDG_STATE_HOME"];
  process.env["LOCALAPPDATA"] = state["LOCALAPPDATA"];
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  ctx = { vault: fx.vault, configPath, repoRoot: null, reach: TRANSPORT_REACH.local };
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fx.cleanup();
});

function neighbour(text: string, scope?: string, topic?: string) {
  return appendRecord(fx.open(REMOTE_DEVICE), {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    ...(scope !== undefined ? { scope } : {}),
    ...(topic !== undefined ? { topic } : {}),
    body: { text },
  }).record;
}

describe("brain_changes", () => {
  // The grouping itself is the core probe's (tests/core/search/brain-store-changes.test.ts);
  // here the tool reaches the configured store and the watermark round-trips.
  test("returns a neighbour's record id after the watermark it handed out", async () => {
    neighbour("an earlier decision");
    const first = (await handler(ctx, {})) as Record<string, unknown>;
    expect(first).toMatchObject({ measured: true, storeInUse: true, count: 1 });

    const record = neighbour("pick the north bank");
    const after = (await handler(ctx, { since: first["watermark"] })) as Record<string, unknown>;
    const groups = after["groups"] as ReadonlyArray<{ readonly ids: ReadonlyArray<string> }>;
    expect(groups.flatMap((g) => g.ids)).toEqual([record.id]);
  });

  test("below local reach nothing is reported, by name", async () => {
    neighbour("a decision");
    const res = (await handler({ ...ctx, reach: TRANSPORT_REACH.remote }, {})) as Record<
      string,
      unknown
    >;
    expect(res).toMatchObject({ measured: false, reason: CHANGES_REACH_REASON });
    expect(res["groups"]).toBeUndefined();
  });

  test("a malformed watermark is an invalid-params error", async () => {
    await expect(handler(ctx, { since: "yesterday" })).rejects.toBeInstanceOf(MCPError);
    await expect(handler(ctx, { since: "yesterday" })).rejects.toThrow("not a watermark");
  });
});

describe("brain_changes through the MCP result builder", () => {
  test("a page too large for a preview keeps its watermark inline", async () => {
    for (let i = 0; i < 80; i++) neighbour(`decision ${i}`);
    const tool = CHANGES_TOOLS.find((t) => t.name === "brain_changes")!;
    const structured = await tool.handler(ctx, { limit: 60 });
    const artifacts = new ArtifactStore({ vault: fx.vault, runId: "run-changes" });
    const result = buildMcpToolResult(tool, structured, artifacts) as {
      content: Array<{ text: string }>;
    };
    const text = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(text["preview_truncated"]).toBeUndefined();
    expect(text).toMatchObject({ truncated: true, count: 60 });
    expect(text["watermark"]).toBe((structured as Record<string, unknown>)["watermark"]);
  });
});
