/**
 * Every live pass records the day (design D4, spec "Every live pass
 * records the day"): the dream verb, the MCP dream tool and the
 * maintenance lane's dream task write the day record on the owner's
 * device, and nothing on a device that is not the owner.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import { assertDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import {
  dreamTriggerClaimPath,
  dreamTriggerRecordPath,
  readDreamTriggerRecord,
  updateDreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";
import { buildLaneTasks } from "../../../../src/core/brain/maintenance/lane-tasks.ts";
import { LANE_TASK, runMaintenance } from "../../../../src/core/brain/maintenance/lane.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { TRANSPORT_REACH } from "../../../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../../src/mcp/index.ts";
import * as dayCheck from "../../../../src/core/brain/dream-trigger/check.ts";
import * as decideAuto from "../../../../src/core/topics/decide-auto.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";
import { homeEnv } from "../../../helpers/platform.ts";
import { runCli } from "../../../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let storeRoot: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-trigger-doors-"));
  vault = join(tmp, "vault");
  storeRoot = join(tmp, "store");
  configPath = join(tmp, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "note.md"), "# A note\n");
  initStore({ root: storeRoot });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", STORE_ROOT_ENV, "O2B_DEVICE_ID", "VAULT_DIR"]) {
    saved[key] = process.env[key];
  }
  delete process.env["VAULT_DIR"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[STORE_ROOT_ENV] = storeRoot;
  claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", {
    writer: "o2b",
    authority: "human",
  });
  withDeviceId("dev-a", () => {
    try {
      assertDreamOwner(vault, { live: true, configPath });
    } catch {
      // the first look notes the claim
    }
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function record() {
  return readDreamTriggerRecord(dreamTriggerRecordPath(storeRoot), storeRoot);
}

async function viaCli(): Promise<unknown> {
  return runCli(["brain", "dream"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
}

async function viaTool(): Promise<unknown> {
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_dream", arguments: { action: "run" } },
  });
}

async function viaLane(): Promise<unknown> {
  const set = buildLaneTasks({
    vault,
    configPath,
    searchConfig: resolveSearchConfig({ vault, configPath }),
    now: new Date(),
    forceCost: false,
    safeguardFor: () => ({ operation: "dream", timeoutMs: 60_000, checkpoint: () => {} }),
  });
  return runMaintenance(vault, {
    holder: "test",
    now: new Date(),
    force: true,
    tasks: [set.tasks.find((t) => t.name === LANE_TASK.dream)!],
  });
}

async function viaRun(): Promise<unknown> {
  return runCli(["dream", "run"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
}

const DOORS = [
  { name: "the dream verb", run: viaCli, by: "cli" },
  { name: "the MCP dream tool", run: viaTool, by: "mcp" },
  { name: "the maintenance lane", run: viaLane, by: "lane" },
] as const;

describe("every live pass records the day", () => {
  for (const door of DOORS) {
    test(`${door.name} records the outcome on the owner's device`, async () => {
      process.env["O2B_DEVICE_ID"] = "dev-a";
      expect(record()).toBeNull();
      await door.run();
      const r = record();
      expect(r).not.toBeNull();
      expect(r!.last_run?.by).toBe(door.by);
      expect(r!.day).toBe(new Date().toISOString().slice(0, 10));
      expect(r!.owner).toMatchObject({ device: "dev-a", mine: true });
    });

    test(`${door.name} records nothing on a device that is not the owner`, async () => {
      process.env["O2B_DEVICE_ID"] = "dev-b";
      await door.run();
      expect(existsSync(dreamTriggerRecordPath(storeRoot))).toBe(false);
    });
  }
});

describe("a whole live run holds the trigger's claim", () => {
  const RUNS = [...DOORS, { name: "o2b dream run", run: viaRun, by: "cli" }] as const;
  for (const door of RUNS) {
    test(`${door.name} holds the claim through its front door and gives it back`, async () => {
      process.env["O2B_DEVICE_ID"] = "dev-a";
      const claimPath = dreamTriggerClaimPath(dreamTriggerRecordPath(storeRoot));
      const original = decideAuto.prepareClosedQuestions;
      const seen: unknown[] = [];
      const front = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation((...args) => {
        seen.push(
          existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, "utf8")).worker_pid : null,
        );
        return original(...args);
      });
      try {
        await door.run();
      } finally {
        front.mockRestore();
      }
      // While the front door runs, a session's day check finds a claim
      // whose worker (this process) lives, and starts nothing.
      expect(seen).toEqual([process.pid]);
      expect(existsSync(claimPath)).toBe(false);
    });
  }

  for (const door of RUNS) {
    test(`${door.name} refuses while another run holds the claim, naming it, before its front door`, async () => {
      process.env["O2B_DEVICE_ID"] = "dev-a";
      const claimPath = dreamTriggerClaimPath(dreamTriggerRecordPath(storeRoot));
      mkdirSync(join(claimPath, ".."), { recursive: true });
      // A worker the trigger started, alive (this process stands in for it).
      const theirs = JSON.stringify({
        token: "t0",
        at: Date.now(),
        pid: process.pid,
        worker_pid: process.pid,
      });
      writeFileSync(claimPath, theirs);
      const front = spyOn(decideAuto, "prepareClosedQuestions");
      let out: unknown;
      try {
        out = await door.run();
        expect(front).not.toHaveBeenCalled();
      } finally {
        front.mockRestore();
      }
      expect(JSON.stringify(out)).toContain("dream run claim busy");
      expect(JSON.stringify(out)).toContain(`run by process ${process.pid}`);
      expect(readFileSync(claimPath, "utf8")).toBe(theirs);
      expect(record()).toBeNull();
    });
  }

  test("a claim whose worker is gone is taken over, and the run records its day", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const claimPath = dreamTriggerClaimPath(dreamTriggerRecordPath(storeRoot));
    mkdirSync(join(claimPath, ".."), { recursive: true });
    const gone = Bun.spawn([process.execPath, "-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, ...homeEnv(join(tmp, "home")) },
    });
    await gone.exited;
    writeFileSync(
      claimPath,
      JSON.stringify({ token: "t0", at: Date.now(), pid: gone.pid, worker_pid: gone.pid }),
    );
    await viaCli();
    expect(existsSync(claimPath)).toBe(false);
    expect(record()?.last_run?.by).toBe("cli");
  });
});

describe("the MCP server's day check", () => {
  test("runs on the vault the server serves, not the configured one", async () => {
    const served = join(tmp, "served");
    mkdirSync(served, { recursive: true });
    const checks = spyOn(dayCheck, "dreamDayCheck").mockImplementation(() => ({ started: false }));
    try {
      const server = new MCPServer({ vault: served, configPath }, { reach: TRANSPORT_REACH.local });
      await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      expect(checks.mock.calls).toHaveLength(1);
      expect(checks.mock.calls[0]![1]).toMatchObject({ vault: served });
    } finally {
      checks.mockRestore();
    }
  });
});

describe("the MCP owner tool", () => {
  test("giving the role up clears this machine's cached owner check", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const path = dreamTriggerRecordPath(storeRoot);
    updateDreamTriggerRecord(path, storeRoot, (r) => ({ ...r, owner_checked_day: "2026-11-20" }));
    const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    const reply = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "tools/call",
      params: { name: "brain_dream_owner", arguments: { operation: "release" } },
    });
    expect(JSON.stringify(reply)).toContain("released");
    expect(record()?.owner_checked_day).toBeNull();
  });
});
