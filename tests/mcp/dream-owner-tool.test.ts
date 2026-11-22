/**
 * `brain_dream_owner` (design D4): `status` at local and remote reach
 * (remote sees device and agent names, no host paths), `take` and
 * `release` at local reach, both refused at remote reach with nothing
 * recorded, and no forced operation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let storeRoot: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dream-owner-tool-"));
  storeRoot = join(tmp, "store");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "agent_name: claude\n");
  initStore({ root: storeRoot });
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", STORE_ROOT_ENV, "VAULT_DIR"])
    saved[key] = process.env[key];
  delete process.env["VAULT_DIR"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[STORE_ROOT_ENV] = storeRoot;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(reach: TransportReach, args: Record<string, unknown>) {
  const server = new MCPServer({ vault: null, configPath }, { reach });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dream-owner-tool-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_dream_owner", arguments: args },
  })) as {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    error?: { code: number; message: string };
  };
}

/** Run `run` as `device`, restoring the device id after the promise settles. */
async function withDeviceId<T>(device: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env["O2B_DEVICE_ID"];
  process.env["O2B_DEVICE_ID"] = device;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["O2B_DEVICE_ID"];
    else process.env["O2B_DEVICE_ID"] = previous;
  }
}

const owner = () => readDreamOwner(openStore({ root: storeRoot, device: "dev-a" })).owner;

describe("brain_dream_owner", () => {
  test("take adopts an unbound brain at local reach; status names the owner", async () => {
    await withDeviceId("dev-a", async () => {
      const taken = await call(TRANSPORT_REACH.local, { operation: "take" });
      expect(taken.result?.structuredContent).toMatchObject({
        status: "taken",
        device: "dev-a",
        agent: "claude",
      });
      const status = await call(TRANSPORT_REACH.local, {});
      expect(status.result?.structuredContent).toMatchObject({
        owner: { device: "dev-a", agent: "claude" },
        is_owner: true,
      });
    });
    expect(owner()).toMatchObject({ device: "dev-a", agent: "claude" });
  });

  test("take with another agent on the owner's device changes the agent", async () => {
    await withDeviceId("dev-a", async () => {
      await call(TRANSPORT_REACH.local, { operation: "take" });
      const res = await call(TRANSPORT_REACH.local, { operation: "take", owner_agent: "codex" });
      expect(res.result?.structuredContent).toMatchObject({ status: "agent-changed" });
    });
    expect(owner()?.agent).toBe("codex");
  });

  test("status at remote reach names devices and agents and no host path", async () => {
    await withDeviceId("dev-a", () => call(TRANSPORT_REACH.local, { operation: "take" }));
    const res = await withDeviceId("dev-b", () => call(TRANSPORT_REACH.remote, {}));
    const body = res.result?.structuredContent;
    expect(body).toMatchObject({ owner: { device: "dev-a", agent: "claude" }, is_owner: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain(tmp);
    expect(text).not.toContain(storeRoot);
  });

  test("take and release at remote reach are refused and record nothing", async () => {
    await withDeviceId("dev-b", async () => {
      const take = await call(TRANSPORT_REACH.remote, { operation: "take" });
      expect(take.error?.message ?? "").toContain("local reach only");
      const release = await call(TRANSPORT_REACH.remote, { operation: "release" });
      expect(release.error?.message ?? "").toContain("local reach only");
    });
    expect(owner()).toBeNull();
  });

  test("release at local reach gives the role up; a non-owner is refused", async () => {
    await withDeviceId("dev-a", () => call(TRANSPORT_REACH.local, { operation: "take" }));
    const refused = await withDeviceId("dev-b", () =>
      call(TRANSPORT_REACH.local, { operation: "release" }),
    );
    expect(refused.error?.message ?? "").toContain("not the dream owner");
    const released = await withDeviceId("dev-a", () =>
      call(TRANSPORT_REACH.local, { operation: "release" }),
    );
    expect(released.result?.structuredContent).toMatchObject({ status: "released" });
    expect(owner()).toBeNull();
  });

  test("there is no force operation", async () => {
    const res = await withDeviceId("dev-a", () =>
      call(TRANSPORT_REACH.local, { operation: "force" }),
    );
    expect(res.error ?? res.result?.isError).toBeTruthy();
    expect(owner()).toBeNull();
  });
});
