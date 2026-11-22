/**
 * The doctor's dream owner section (design D7 item 1), through `o2b brain
 * doctor` and `brain_doctor`: a brain with no owner, a device that is not
 * the owner, a pending transfer, and a declared `primary_agent` that
 * differs from the owner's agent. All advice, never a warning.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimDreamOwner, takeDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let storeRoot: string;
let configPath: string;
const human = { writer: "o2b", authority: "human" as const };

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-dream-owner-doctor-"));
  storeRoot = join(parent, "store");
  configPath = join(parent, "config.yaml");
  writeFileSync(configPath, "agent_name: claude\n");
  initStore({ root: storeRoot });
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const env = (device: string) => ({
  OPEN_SECOND_BRAIN_CONFIG: configPath,
  [STORE_ROOT_ENV]: storeRoot,
  O2B_DEVICE_ID: device,
});

type Finding = { code: string; message: string };

async function doctor(device: string): Promise<{ uncertain: Finding[]; warnings: Finding[] }> {
  const res = await runCli(["brain", "doctor", "--json"], { env: env(device) });
  const out = JSON.parse(res.stdout) as {
    uncertain?: Finding[];
    warnings?: Finding[];
  };
  return { uncertain: out.uncertain ?? [], warnings: out.warnings ?? [] };
}

const codes = (findings: Finding[]) =>
  findings.map((f) => f.code).filter((c) => c.startsWith("dream-owner"));

describe("doctor and the dream owner", () => {
  test("a brain with no owner names a declared primary_agent as requested", async () => {
    expect(
      (await runCli(["brain", "set-primary", "hermes"], { env: env("dev-a") })).returncode,
    ).toBe(0);
    const out = await doctor("dev-a");
    expect(codes(out.uncertain)).toEqual(["dream-owner-unbound"]);
    expect(out.uncertain.find((f) => f.code === "dream-owner-unbound")!.message).toContain(
      "hermes",
    );
    expect(codes(out.warnings)).toEqual([]);
  });

  test("another device is told where dream runs only when this machine's agent is the declared one", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", human);
    expect(codes((await doctor("dev-a")).uncertain)).toEqual([]);
    // A device that previews is the normal state: nothing to report.
    expect(codes((await doctor("dev-b")).uncertain)).toEqual([]);
    // The declared primary agent is the agent dev-b runs as (claude): say where dream runs.
    expect(
      (await runCli(["brain", "set-primary", "claude"], { env: env("dev-a") })).returncode,
    ).toBe(0);
    const other = await doctor("dev-b");
    expect(codes(other.uncertain)).toEqual(["dream-owner-elsewhere"]);
    expect(other.uncertain.find((f) => f.code === "dream-owner-elsewhere")!.message).toContain(
      "dev-a",
    );
  });

  test("a pending transfer is reported, and the owner's device is told to release it", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", human);
    takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
      ...human,
      force: false,
    });
    const owner = await doctor("dev-a");
    expect(codes(owner.uncertain)).toEqual(["dream-owner-pending"]);
    expect(owner.uncertain[0]!.message).toContain("This device must release it");
  });

  test("a declared primary_agent that differs from the owner's agent is reported", async () => {
    expect(
      (await runCli(["brain", "set-primary", "hermes"], { env: env("dev-a") })).returncode,
    ).toBe(0);
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", human);
    expect(codes((await doctor("dev-a")).uncertain)).toEqual(["dream-owner-agent-differs"]);
  });

  test("brain_doctor carries the same finding", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", human);
    expect(
      (await runCli(["brain", "set-primary", "claude"], { env: env("dev-a") })).returncode,
    ).toBe(0);
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env("dev-b"))) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const server = new MCPServer({ vault: null, configPath }, { reach: TRANSPORT_REACH.local });
      await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "dream-owner-doctor", version: "0" },
        },
      });
      const r = (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: "tools/call",
        params: { name: "brain_doctor", arguments: {} },
      })) as { result?: { structuredContent?: Record<string, unknown> } };
      expect(JSON.stringify(r.result?.structuredContent ?? {})).toContain("dream-owner-elsewhere");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
