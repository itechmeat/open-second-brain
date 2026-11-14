/**
 * `brain_foresight` answers at the caller's reach (private-is-not-a-
 * suggestion). The extract fold reads the raw continuity store, which
 * carries private records the read model would drop, and a record's text
 * becomes the item title with its refs as sources - so below local reach
 * the fold must withhold the private partition, while a local caller
 * still sees it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-foresight-reach-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-foresight-reach-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  // One readable extract and one private one, both inside the lookback
  // window (the fold looks back thirty days); the private flag is the
  // store's own judgment (write time).
  const dayMs = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * dayMs).toISOString();
  appendContinuityRecord(vault, {
    kind: "pre_compact_extract",
    createdAt: at(3),
    sourceRefs: [{ id: "sess-open", kind: "session" }],
    payload: { extract_type: "commitment", text: "Ship the readable commitment" },
  });
  appendContinuityRecord(vault, {
    kind: "pre_compact_extract",
    createdAt: at(2),
    sourceRefs: [{ id: "sess-private", kind: "session" }],
    payload: { extract_type: "commitment", text: "ZZPrivate commitment text" },
    private: true,
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function foresight(reach: TransportReach): Promise<Record<string, unknown>> {
  const tool = BRAIN_TOOLS.find((t) => t.name === "brain_foresight")!;
  const ctx: ServerContext = { vault, reach, configPath, repoRoot: null };
  return (await tool.handler(ctx, {})) as Record<string, unknown>;
}

describe("brain_foresight at remote reach", () => {
  test("a private extract is absent from the report, its text and refs with it", async () => {
    const remote = await foresight(TRANSPORT_REACH.remote);
    const body = JSON.stringify(remote);
    expect(body).not.toContain("ZZPrivate commitment text");
    expect(body).not.toContain("sess-private");
    // The readable extract keeps its place.
    expect(body).toContain("Ship the readable commitment");
  });

  test("local reach keeps the private extract in the report", async () => {
    const local = await foresight(TRANSPORT_REACH.local);
    expect(JSON.stringify(local)).toContain("ZZPrivate commitment text");
  });
});
