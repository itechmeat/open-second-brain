/**
 * A long-lived MCP server refuses writes once the install or the
 * machine's layout changed under it (`src/mcp/stale-server.ts`): it would
 * otherwise write what its old code knows, the legacy tree on a switched
 * machine included. The look runs on a write at most once a minute.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/index.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import * as o2bCommand from "../../src/core/maintenance/o2b-command.ts";
import {
  STALE_SERVER_CHECK_MS,
  STALE_SERVER_REFUSAL,
  StaleServerGuard,
  installedVersionOnDisk,
  type ServerFingerprint,
} from "../../src/mcp/stale-server.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../../src/core/version.ts";
import { makeTriggerFixture } from "../core/brain/dream-trigger/fixture.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-stale-server-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A guard over a machine the test changes, on a clock the test moves. */
function guarded(start: ServerFingerprint) {
  let machine = start;
  let clock = 1_000_000;
  let looks = 0;
  const guard = new StaleServerGuard({
    running: "2.0.2",
    read: () => {
      looks += 1;
      return machine;
    },
    now: () => clock,
  });
  return {
    guard,
    set: (next: ServerFingerprint) => {
      machine = next;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    looks: () => looks,
  };
}

test("the code on disk is this install's own version", () => {
  expect(installedVersionOnDisk()).toBe(OPEN_SECOND_BRAIN_VERSION);
});

test("a newer install refuses writes from then on, looked at once a minute at most", () => {
  const g = guarded({ version: "2.0.2", switched: true, legacy: false });
  expect(g.guard.reason()).toBeNull();
  const after = g.looks();
  g.set({ version: "2.0.3", switched: true, legacy: false });
  // Within the minute the install is not looked at again.
  g.tick(STALE_SERVER_CHECK_MS - 1);
  expect(g.guard.reason()).toBeNull();
  expect(g.looks()).toBe(after);
  g.tick(1);
  expect(g.guard.reason()).toContain("Open Second Brain 2.0.3 is installed");
  // Refused for good, with no further look.
  g.set({ version: "2.0.2", switched: true, legacy: false });
  g.tick(STALE_SERVER_CHECK_MS);
  expect(g.guard.reason()).toContain("2.0.3");
  expect(g.looks()).toBe(after + 1);
});

test("a machine that switched to the store after the server started refuses its writes", () => {
  const g = guarded({ version: "2.0.2", switched: false, legacy: true });
  expect(g.guard.reason()).toBeNull();
  g.set({ version: "2.0.2", switched: true, legacy: false });
  g.tick(STALE_SERVER_CHECK_MS);
  expect(g.guard.reason()).toContain("moved into the brain store after this server started");
});

test("a switch does not strand a server whose vault held no legacy tree", () => {
  const g = guarded({ version: "2.0.2", switched: false, legacy: false });
  g.set({ version: "2.0.2", switched: true, legacy: false });
  g.tick(STALE_SERVER_CHECK_MS);
  expect(g.guard.reason()).toBeNull();
});

test("an install that cannot be read is not a refusal", () => {
  const g = guarded({ version: null, switched: false, legacy: true });
  expect(g.guard.reason()).toBeNull();
});

test("the server refuses a write tool with a plain message and still answers a read", async () => {
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const g = guarded({ version: "2.0.3", switched: false, legacy: true });
  const server = new MCPServer({ vault }, { staleGuard: g.guard });
  let refused: unknown = null;
  try {
    await server.callTool("brain_note", { text: "a note the old server must not write" });
  } catch (err) {
    refused = err;
  }
  expect(refused).toBeInstanceOf(MCPError);
  const error = refused as MCPError;
  expect(error.message).toContain(`refused (${STALE_SERVER_REFUSAL})`);
  expect(error.message).toContain("restart the agent session");
  expect((error.data as { code?: string }).code).toBe(STALE_SERVER_REFUSAL);
  const status = await server.callTool("brain_status", {});
  expect(status).toBeDefined();
});

test("a stale server starts no dream pass, on a read call as much as on a write", async () => {
  // A machine whose dream pass is due today: the day check starts a
  // detached worker that writes the brain.
  const f = makeTriggerFixture();
  const spawns: Array<ReadonlyArray<string>> = [];
  const spy = spyOn(o2bCommand, "spawnSelfDetached").mockImplementation(((argv: string[]) => {
    spawns.push([...argv]);
    return { pid: 0, unref: () => {} } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof o2bCommand.spawnSelfDetached);
  try {
    const vault = join(tmp, "vault");
    mkdirSync(vault, { recursive: true });
    const g = guarded({ version: "2.0.3", switched: false, legacy: true });
    const server = new MCPServer({ vault, configPath: f.configPath }, { staleGuard: g.guard });
    // A read call: it must not start a write pass either.
    await server.callTool("brain_status", {});
    expect(spawns).toEqual([]);
  } finally {
    spy.mockRestore();
    f.cleanup();
  }
});
