/**
 * The dream owner gate at every entry point (design D2, spec "Only the
 * owner's device runs a live pass"): on a device that is not the owner
 * each live path is refused, writes nothing to the store or the vault and
 * asks no model; every preview still answers there; and a device that
 * holds the role through an unsettled claim is refused once, then passes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  claimDreamOwner,
  releaseDreamOwner,
  takeDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import * as ownerModule from "../../../../src/core/brain/dream-owner/owner.ts";
import { assertDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import { DREAM_STEP, runDreamStep } from "../../../../src/core/brain/dream-step.ts";
import {
  applyDreamBundle,
  discardDreamBundle,
  retriageDreamBundle,
  stageDream,
} from "../../../../src/core/brain/dream-stage.ts";
import { buildLaneTasks } from "../../../../src/core/brain/maintenance/lane-tasks.ts";
import { LANE_TASK, runMaintenance } from "../../../../src/core/brain/maintenance/lane.ts";
import { buildReviewCandidates } from "../../../../src/core/brain/review-candidates.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import * as decideAuto from "../../../../src/core/topics/decide-auto.ts";
import { TRANSPORT_REACH } from "../../../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../../src/mcp/index.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";
import { runCli } from "../../../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let storeRoot: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dream-gate-doors-"));
  vault = join(tmp, "vault");
  storeRoot = join(tmp, "store");
  configPath = join(tmp, "config.yaml");
  // A vault with no `Brain/` tree: the brain lives in the store.
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
  // dev-a owns the role, its claim settled by one look.
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
  // Every call below runs as dev-b.
  process.env["O2B_DEVICE_ID"] = "dev-b";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Every file under the store and the vault, with a hash of its bytes. */
function listing(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        out.set(relative(tmp, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(storeRoot);
  walk(vault);
  return out;
}

/** Run `fn` with the decide entry counted, and the count of model calls. */
async function countingDecides(fn: () => Promise<void>): Promise<number> {
  let calls = 0;
  const spy = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation(async () => {
    calls += 1;
    return undefined;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return calls;
}

async function makeServer(): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dream-gate-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

let callId = 10;
async function tool(args: Record<string, unknown>, name = "brain_dream") {
  const server = await makeServer();
  callId += 1;
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: callId,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      // oxlint-disable-next-line no-underscore-dangle -- the MCP wire field name
      _meta?: Record<string, { code?: string }>;
      content?: Array<{ text?: string }>;
    };
    error?: { code: number; message: string; data?: { code?: string } };
  };
}

/** The wire code of a refused tool call, on either channel. */
function wireCode(r: Awaited<ReturnType<typeof tool>>): string | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- the MCP wire field name
  return r.error?.data?.code ?? r.result?._meta?.["open-second-brain/error"]?.code;
}

const RUN_ID = "stage-20261120-120000";

/** The lane's own journal rows (the maintenance-journal ledger), not a dream write. */
const lane = (p: string): boolean => p.includes("maintenance-journal");

/** The CLI in-process, on this test's machine config. */
function cli(args: string[]) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
}

type Door = { readonly name: string; readonly run: () => Promise<void> };

const cliRefused =
  (args: string[]): (() => Promise<void>) =>
  async () => {
    const res = await cli(["brain", "dream", ...args]);
    expect(res.returncode).toBe(1);
    const errors = res.stderr.split("\n").filter((l) => l.startsWith("error:"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not the dream owner");
    expect(errors[0]).toContain("dev-a");
    expect(errors[0]).toContain("o2b dream owner --here");
  };

const toolRefused =
  (args: Record<string, unknown>): (() => Promise<void>) =>
  async () => {
    const r = await tool(args);
    expect(wireCode(r)).toBe("dream_not_owner");
  };

const REFUSED: ReadonlyArray<Door> = [
  { name: "the dream verb, live", run: cliRefused([]) },
  { name: "the dream verb, --step heal-enrich", run: cliRefused(["--step", "heal-enrich"]) },
  { name: "the dream verb, stage", run: cliRefused(["stage"]) },
  { name: "the dream verb, apply", run: cliRefused(["apply", RUN_ID]) },
  { name: "the dream verb, discard", run: cliRefused(["discard", RUN_ID]) },
  { name: "the dream verb, retriage", run: cliRefused(["retriage", RUN_ID]) },
  { name: "the MCP dream tool, action=run", run: toolRefused({ action: "run" }) },
  { name: "the MCP dream tool, step heal-enrich", run: toolRefused({ step: "heal-enrich" }) },
  { name: "the MCP dream tool, stage", run: toolRefused({ action: "stage" }) },
  { name: "the MCP dream tool, apply", run: toolRefused({ action: "apply", run_id: RUN_ID }) },
  { name: "the MCP dream tool, discard", run: toolRefused({ action: "discard", run_id: RUN_ID }) },
  {
    name: "the MCP dream tool, retriage",
    run: toolRefused({ action: "retriage", run_id: RUN_ID }),
  },
];

describe("a device that is not the owner", () => {
  for (const door of REFUSED) {
    test(`refuses ${door.name}, writes nothing and asks no model`, async () => {
      const before = listing();
      const calls = await countingDecides(door.run);
      expect(calls).toBe(0);
      expect(listing()).toEqual(before);
    });
  }

  test("skips the lane's dream task with the reason; the other tasks run", async () => {
    const before = listing();
    let otherRan = false;
    const calls = await countingDecides(async () => {
      const set = buildLaneTasks({
        vault,
        configPath,
        searchConfig: resolveSearchConfig({ vault, configPath }),
        now: new Date(),
        forceCost: false,
        safeguardFor: () => ({ operation: "dream", timeoutMs: 60_000, checkpoint: () => {} }),
      });
      const dreamTask = set.tasks.find((t) => t.name === LANE_TASK.dream)!;
      const result = await runMaintenance(vault, {
        holder: "test",
        now: new Date(),
        force: true,
        tasks: [
          dreamTask,
          {
            name: LANE_TASK.bridges,
            run: async () => {
              otherRan = true;
            },
          },
        ],
      });
      const row = result.tasks.find((t) => t.name === LANE_TASK.dream)!;
      expect(row.ok).toBe(true);
      expect(row.skipped).toContain("not the dream owner");
      expect(result.tasks.every((t) => t.ok)).toBe(true);
    });
    expect(calls).toBe(0);
    expect(otherRan).toBe(true);
    // The lane journals its own rows (the maintenance-journal ledger);
    // nothing else changed.
    const after = new Map([...listing()].filter(([p]) => !lane(p)));
    expect(after).toEqual(new Map([...before].filter(([p]) => !lane(p))));
  });
});

describe("the owner's lane task when the role moves during the verdicts", () => {
  test("the refused pass is a skip, not a failed task", async () => {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const original = decideAuto.prepareClosedQuestions;
    const spy = spyOn(decideAuto, "prepareClosedQuestions").mockImplementation(
      (...args: Parameters<typeof original>) => {
        // Another device takes the role while the verdicts are decided.
        takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
          writer: "o2b",
          authority: "human",
          force: true,
        });
        return original(...args);
      },
    );
    try {
      const set = buildLaneTasks({
        vault,
        configPath,
        searchConfig: resolveSearchConfig({ vault, configPath }),
        now: new Date(),
        forceCost: false,
        safeguardFor: () => ({ operation: "dream", timeoutMs: 60_000, checkpoint: () => {} }),
      });
      const dreamTask = set.tasks.find((t) => t.name === LANE_TASK.dream)!;
      const result = await runMaintenance(vault, {
        holder: "test",
        now: new Date(),
        force: true,
        tasks: [dreamTask],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const row = result.tasks.find((t) => t.name === LANE_TASK.dream)!;
      expect(row.ok).toBe(true);
      expect(row.skipped).toContain("not the dream owner");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the heal-enrich writing step", () => {
  test("holds the pass lock and rechecks before running when ownership changes", () => {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const original = ownerModule.withDreamPassLock;
    let released = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!released) {
        released = true;
        releaseDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), {
          writer: "o2b",
          now: () => Date.now() + 100_000,
        });
      }
      return original(...args);
    });
    try {
      expect(() => runDreamStep(vault, DREAM_STEP.healEnrich, { configPath })).toThrow(
        expect.objectContaining({ reason: "ownership-changed", code: "dream_not_owner" }),
      );
    } finally {
      spy.mockRestore();
      process.env["O2B_DEVICE_ID"] = "dev-b";
    }
  });
});

describe("the staged dream lifecycle lock", () => {
  function forceTransferInsideLock(): ReturnType<typeof spyOn> {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const original = ownerModule.withDreamPassLock;
    let moved = false;
    return spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!moved) {
        moved = true;
        takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
          writer: "o2b",
          authority: "human",
          force: true,
        });
      }
      return original(...args);
    });
  }

  test("stage rechecks under the lock before writing its bundle", () => {
    const spy = forceTransferInsideLock();
    try {
      expect(() => stageDream(vault, { now: new Date(), configPath })).toThrow(
        expect.objectContaining({ reason: "ownership-changed", code: "dream_not_owner" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("discard rechecks under the lock before deleting a bundle", () => {
    const spy = forceTransferInsideLock();
    try {
      expect(() => discardDreamBundle(vault, RUN_ID, { configPath })).toThrow(
        expect.objectContaining({ reason: "ownership-changed", code: "dream_not_owner" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("retriage rechecks under the lock before reading the bundle", () => {
    const spy = forceTransferInsideLock();
    try {
      expect(() => retriageDreamBundle(vault, RUN_ID, { now: new Date(), configPath })).toThrow(
        expect.objectContaining({ reason: "ownership-changed", code: "dream_not_owner" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("apply rechecks under the lock before moving the staged bundle", () => {
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const staged = stageDream(vault, { now: new Date(), configPath });
    const original = ownerModule.withDreamPassLock;
    let locks = 0;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      locks += 1;
      if (locks === 2) {
        takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
          writer: "o2b",
          authority: "human",
          force: true,
        });
      }
      return original(...args);
    });
    try {
      expect(() => applyDreamBundle(vault, staged.runId, { now: new Date(), configPath })).toThrow(
        expect.objectContaining({ reason: "ownership-changed", code: "dream_not_owner" }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("previews on a device that is not the owner", () => {
  const PREVIEWS: ReadonlyArray<Door> = [
    {
      name: "the dream verb, --dry-run",
      run: async () => {
        expect((await cli(["brain", "dream", "--dry-run", "--json"])).returncode).toBe(0);
      },
    },
    {
      name: "the dream verb's count-guard preview",
      run: async () => {
        const res = await cli(["brain", "dream", "--dry-run", "--expect", "0", "--json"]);
        expect(res.returncode).toBe(0);
      },
    },
    {
      name: "the MCP dream tool, dry_run",
      run: async () => {
        const r = await tool({ action: "run", dry_run: true });
        expect(r.error).toBeUndefined();
        expect(r.result).toBeDefined();
        expect(wireCode(r)).toBeUndefined();
      },
    },
    {
      name: "the MCP dream tool's count-guard preview",
      run: async () => {
        const r = await tool({ action: "run", dry_run: true, expect: 0 });
        expect(r.error).toBeUndefined();
        expect(r.result).toBeDefined();
        expect(wireCode(r)).toBeUndefined();
      },
    },
    {
      name: "review-candidates",
      run: async () => {
        await buildReviewCandidates(vault);
      },
    },
    {
      name: "the summary verb",
      run: async () => {
        const res = await cli(["brain", "summary", "--json"]);
        expect(res.returncode).toBe(0);
        expect(res.stdout).not.toContain("dream_not_owner");
      },
    },
    {
      name: "the brief view tool",
      run: async () => {
        const r = await tool({ view: "operator" }, "brain_brief");
        expect(r.error).toBeUndefined();
        expect(r.result).toBeDefined();
        expect(wireCode(r)).toBeUndefined();
        expect(JSON.stringify(r.result?.structuredContent ?? {})).not.toContain("dream_error");
      },
    },
  ];
  for (const door of PREVIEWS) {
    test(`still answers: ${door.name}`, async () => {
      await door.run();
    });
  }
});

describe("an unsettled claim", () => {
  test("is refused a live pass once, and passes after the next catch-up", async () => {
    // dev-c takes over the role with a fresh claim of its own after dev-a gives it up.
    process.env["O2B_DEVICE_ID"] = "dev-a";
    expect((await cli(["dream", "owner", "--release"])).returncode).toBe(0);
    process.env["O2B_DEVICE_ID"] = "dev-c";
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-c" }), "codex", {
      writer: "o2b",
      authority: "human",
    });
    const first = await cli(["brain", "dream"]);
    expect(first.returncode).toBe(1);
    expect(first.stderr).toContain("waits one catch-up");
    const second = await cli(["brain", "dream", "--json"]);
    expect(second.returncode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      owner: { device: "dev-c", agent: "codex" },
      caller: "claude",
    });
  });
});
