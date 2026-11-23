/**
 * The dream day check in the MCP server (change `dream-session-trigger`,
 * design D2): at `initialize`, and at the first tool call of a new UTC day
 * (a long-lived server, a host whose plugin never sends `initialize`);
 * one check per day of a server, none on its other calls. The note goes
 * into the instructions of `initialize`, at local reach only. The check
 * itself is spied (`check.ts` is tested on its own); the clock is set.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as check from "../../src/core/brain/dream-trigger/check.ts";
import { forgetDreamOwnerCheck } from "../../src/core/brain/dream-trigger/forget.ts";
import {
  emptyDreamTriggerRecord,
  updateDreamTriggerRecord,
  writeDreamTriggerRecord,
} from "../../src/core/brain/dream-trigger/record.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { makeTriggerFixture, type TriggerFixture } from "../core/brain/dream-trigger/fixture.ts";

let f: TriggerFixture;
let calls: Array<{ notes: boolean | undefined }>;
let spy: ReturnType<typeof spyOn>;
let note: string | undefined;

beforeEach(() => {
  f = makeTriggerFixture();
  calls = [];
  note = undefined;
  spy = spyOn(check, "dreamDayCheck").mockImplementation((_config, options = {}) => {
    calls.push({ notes: options.notes });
    return note === undefined ? { started: false } : { started: false, note };
  });
  setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
});

afterEach(() => {
  setSystemTime();
  spy.mockRestore();
  f.cleanup();
});

let id = 0;

async function initialize(target: MCPServer): Promise<string> {
  id += 1;
  const res = (await target.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  })) as { result: { instructions: string } };
  return res.result.instructions;
}

async function call(target: MCPServer): Promise<void> {
  id += 1;
  await target.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name: "brain_dream_owner", arguments: {} },
  });
}

function server(reach: "local" | "remote" = "local"): MCPServer {
  return new MCPServer(
    { vault: null, configPath: f.configPath },
    { reach: reach === "local" ? TRANSPORT_REACH.local : TRANSPORT_REACH.remote },
  );
}

describe("the dream day check of an MCP server", () => {
  test("one check at initialize, none on the calls of the same day", async () => {
    const s = server();
    await initialize(s);
    await call(s);
    await call(s);
    expect(calls).toEqual([{ notes: true }]);
  });

  test("a long-lived server checks again at its first call of a new day", async () => {
    const s = server();
    await initialize(s);
    await call(s);
    setSystemTime(new Date("2026-11-21T00:00:01.000Z"));
    await call(s);
    await call(s);
    expect(calls).toEqual([{ notes: true }, { notes: false }]);
  });

  test("a server that never got initialize checks at its first call", async () => {
    const s = server();
    await call(s);
    await call(s);
    expect(calls).toEqual([{ notes: false }]);
  });

  test("the check is given the config the server read at its start", async () => {
    const s = server();
    await initialize(s);
    expect(spy.mock.calls[0]![0]).toMatchObject({ path: f.configPath, exists: true });
  });

  test("a config that could not be read at the start is read again at the next check", async () => {
    // A folder where the config file belongs: the read at the start fails.
    const broken = join(f.tmp, "broken.yaml");
    mkdirSync(broken);
    const s = new MCPServer({ vault: null, configPath: broken }, { reach: TRANSPORT_REACH.local });
    await initialize(s);
    expect(spy.mock.calls[0]![0]).toBeNull();
    // Repaired: the next day's check reads it.
    rmSync(broken, { recursive: true });
    writeFileSync(broken, "agent_name: claude\n");
    setSystemTime(new Date("2026-11-21T00:00:01.000Z"));
    await call(s);
    expect(spy.mock.calls[1]![0]).toMatchObject({ path: broken, exists: true });
  });

  test("a verb on this machine that clears the owner check makes the next call look again", async () => {
    writeDreamTriggerRecord(f.recordPath, {
      ...emptyDreamTriggerRecord(f.storeRoot),
      owner: { device: "dev-b", agent: "codex", revision: null, mine: false },
      owner_checked_day: "2026-11-20",
    });
    const s = server();
    await initialize(s);
    await call(s);
    // A write that keeps today's owner check changes nothing.
    updateDreamTriggerRecord(f.recordPath, f.storeRoot, (r) => ({ ...r, failures: 1 }));
    await call(s);
    expect(calls).toEqual([{ notes: true }]);
    // This machine took the role: the owner check is cleared (`forget.ts`).
    forgetDreamOwnerCheck(f.configPath);
    await call(s);
    await call(s);
    expect(calls).toEqual([{ notes: true }, { notes: false }]);
  });

  test("the note goes into the instructions at local reach only", async () => {
    note =
      "Dream is owned by dev-b (codex) and last covered 2026-11-15. To run it here: o2b dream owner --here";
    const local = await initialize(server("local"));
    expect(local.endsWith(`\n\n${note}`)).toBe(true);
    const remote = await initialize(server("remote"));
    expect(remote).not.toContain(note);
    expect(calls).toEqual([{ notes: true }, { notes: false }]);
  });
});
