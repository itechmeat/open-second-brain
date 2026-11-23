/**
 * The exact profile of a dream session (change `dream-launched-agent`,
 * design D3; spec "The session works only through three operations", "A
 * run authorises the operations, a marker does not", "The session is
 * kept apart"; task 2.1). The server is driven in process over its
 * JSON-RPC handler against a temp store whose dream owner is this device.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DREAM_RUN_ENV, DREAM_TOKEN_ENV } from "../../src/core/brain/dream-queue/dream-session.ts";
import { produceWork, type ProduceSpec } from "../../src/core/brain/dream-queue/queue.ts";
import { readDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import {
  createDreamRun,
  dreamRunsDir,
  readDreamRun,
  readDreamRunCalls,
} from "../../src/core/brain/dream-queue/run-record.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import { INSTALL_TOOL_PROFILE_NAMES } from "../../src/core/brain/policy/blocks/install.ts";
import {
  DREAM_EXECUTOR_PROFILE,
  dreamSessionTask,
  openDreamExecutor,
  type DreamExecutorServer,
} from "../../src/mcp/dream-executor.ts";
import { resolveToolSurface, TOOL_SURFACE_PROFILES } from "../../src/mcp/profiles.ts";
import {
  FIXTURE_CLOSED,
  FIXTURE_TEXT,
  registerFixtureOperations,
  type FixtureOperations,
} from "../helpers/dream-queue-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";
import { closedFixture, type ClosedFixture } from "../core/topics/fixtures/closed-fixture.ts";

let f: ClosedFixture;
let ops: FixtureOperations;
const PINNED = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
let pinnedBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  f = closedFixture();
  ops = registerFixtureOperations("release");
  // The server opens the store as a process of this device would: the
  // device id and the state base of the fixture's device `dev-a`.
  pinnedBefore = Object.fromEntries(PINNED.map((k) => [k, process.env[k]]));
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env["XDG_STATE_HOME"] = join(f.m.parent, "state", "dev-a");
  process.env["LOCALAPPDATA"] = join(f.m.parent, "state", "dev-a");
});

afterEach(() => {
  for (const k of PINNED) {
    if (pinnedBefore[k] === undefined) delete process.env[k];
    else process.env[k] = pinnedBefore[k];
  }
  ops.unregister();
  f.cleanup();
});

function spec(operation: string, subject: string): ProduceSpec {
  return {
    operation,
    subject,
    occurrence: `2026-12-01/${subject}`,
    input: subject,
    prompt_version: "1",
    schema_version: "1",
    answer_schema: operation === FIXTURE_TEXT ? { type: "text" } : { enum: ["yes", "no"] },
    after: [],
    resources: [],
    evidence: [`ev-${subject}`],
    payload: { question: `about ${subject}?` },
    sources: ["shared"],
  };
}

function newRun(
  options: { operations?: string[]; itemBudget?: number; budgetMs?: number; agent?: string } = {},
) {
  const owner = readDreamOwner(f.a).owner!;
  return createDreamRun(f.a.deviceStateDir, {
    ownerRevision: owner.revision,
    budgetMs: options.budgetMs ?? 600_000,
    operations: options.operations ?? [FIXTURE_CLOSED, FIXTURE_TEXT],
    privateAllowed: true,
    itemBudget: options.itemBudget ?? 50,
    agent: options.agent ?? "fake-agent",
    now: f.still(),
  });
}

function open(env: Record<string, string | undefined>): ReturnType<typeof openDreamExecutor> {
  return openDreamExecutor({ env, configPath: f.configPath, vault: null, now: f.still });
}

function serverFor(run: { record: { run: string }; token: string }): DreamExecutorServer {
  const opened = open({ [DREAM_RUN_ENV]: run.record.run, [DREAM_TOKEN_ENV]: run.token });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.server;
}

function rpc(server: DreamExecutorServer, method: string, params?: unknown): any {
  return server.handle({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
}

function call(server: DreamExecutorServer, name: string, args: Record<string, unknown> = {}): any {
  const out = rpc(server, "tools/call", { name, arguments: args }).result;
  return { ...JSON.parse(out.content[0].text), isError: out.isError === true };
}

function workCount(): number {
  return readStreamRecords(f.a.root, "shared", { stream: "dream-work" }).records.length;
}

describe("the surface", () => {
  test("exactly three tools, no capability tool, no resources, no prompts", () => {
    const server = serverFor(newRun());
    const init = rpc(server, "initialize", { protocolVersion: "2025-06-18" }).result;
    expect(Object.keys(init.capabilities)).toEqual(["tools"]);
    expect(init.instructions).toBe(
      dreamSessionTask(newRun().record.run).replace(
        /session \S+/,
        init.instructions.match(/session \S+/)[0],
      ),
    );
    expect(init.instructions.startsWith("open-second-brain-dream-session ")).toBe(true);
    const names = rpc(server, "tools/list").result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["dream_work_take", "dream_work_answer", "dream_work_finish"]);
    expect(rpc(server, "resources/list").result).toEqual({ resources: [] });
    expect(rpc(server, "resources/templates/list").result).toEqual({ resourceTemplates: [] });
    expect(rpc(server, "prompts/list").result).toEqual({ prompts: [] });
    expect(rpc(server, "resources/read", { uri: "brain://x" }).error).toBeDefined();
    expect(call(server, "second_brain_capabilities").isError).toBe(true);
  });

  test("the profile is not a setting value and not an install profile", () => {
    expect(Object.keys(TOOL_SURFACE_PROFILES)).not.toContain(DREAM_EXECUTOR_PROFILE);
    expect(INSTALL_TOOL_PROFILE_NAMES).not.toContain(DREAM_EXECUTOR_PROFILE);
    expect(resolveToolSurface({ profileName: DREAM_EXECUTOR_PROFILE }).unknownProfile).toBe(
      DREAM_EXECUTOR_PROFILE,
    );
  });

  test("refuses to start without a live run", () => {
    expect(open({}).ok).toBe(false);
    expect(open({ [DREAM_RUN_ENV]: "0b0c3a2e-1111-4222-8333-444455556666" }).ok).toBe(false);
    const run = newRun();
    expect(open({ [DREAM_RUN_ENV]: run.record.run, [DREAM_TOKEN_ENV]: "f".repeat(64) }).ok).toBe(
      false,
    );
    const expired = newRun({ budgetMs: 1 });
    f.setClock(f.still() + 10);
    expect(open({ [DREAM_RUN_ENV]: expired.record.run, [DREAM_TOKEN_ENV]: expired.token }).ok).toBe(
      false,
    );
  });
});

describe("o2b mcp --tool-profile dream-executor", () => {
  test("refuses to start with the marker and no run's token", async () => {
    const r = await runCli(["mcp", "--tool-profile", "dream-executor", "--config", f.configPath], {
      env: { [DREAM_RUN_ENV]: "0b0c3a2e-1111-4222-8333-444455556666" },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("refuses to start");
  });

  test("the config key cannot select it", async () => {
    const r = await runCli(["mcp", "--config", f.configPath], {
      env: { OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE: "dream-executor" },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown tool profile");
  });
});

describe("the three operations", () => {
  test("take returns one item or nothing with a reason", () => {
    const server = serverFor(newRun());
    expect(call(server, "dream_work_take")).toMatchObject({ item: null, reason: "empty" });
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    const taken = call(server, "dream_work_take");
    expect(taken.item).toMatchObject({
      operation: FIXTURE_CLOSED,
      generation: 1,
      payload: { question: "about s1?" },
      evidence: ["ev-s1"],
      answer_shape: { enum: ["yes", "no"] },
    });
    expect(typeof taken.item.question).toBe("string");
    expect(taken.item).not.toHaveProperty("lease_token");
  });

  test("answer accepts with a receipt, with the run's agent and the stated model", () => {
    const server = serverFor(newRun({ agent: "the-run-agent" }));
    produceWork(f.queue, spec(FIXTURE_TEXT, "t1"));
    const { item } = call(server, "dream_work_take");
    const answered = call(server, "dream_work_answer", {
      id: item.id,
      generation: item.generation,
      text: "a summary",
      model: "model-x",
      agent: "a-claimed-agent",
    });
    expect(answered).toMatchObject({ status: "accepted", isError: false });
    expect(typeof answered.receipt).toBe("string");
    const [stored] = f.items(FIXTURE_TEXT);
    expect(stored!.answer).toMatchObject({ agent: "the-run-agent", model: "model-x" });
  });

  test("a new server instance can answer a lease saved in the run record", () => {
    const run = newRun();
    const takingServer = serverFor(run);
    produceWork(f.queue, spec(FIXTURE_TEXT, "across-processes"));
    const { item } = call(takingServer, "dream_work_take");
    const leaseToken = f.items(FIXTURE_TEXT)[0]!.lease!.lease_token;
    const runFile = join(dreamRunsDir(f.a.deviceStateDir), `${run.record.run}.json`);
    expect(readFileSync(runFile, "utf8")).toContain(leaseToken);
    expect(JSON.stringify(readDreamRun(f.a.deviceStateDir, run.record.run))).not.toContain(
      leaseToken,
    );
    expect(item).not.toHaveProperty("lease_token");

    const answeringServer = serverFor(run);
    expect(
      call(answeringServer, "dream_work_answer", {
        id: item.id,
        generation: item.generation,
        text: "answered by another process",
        model: "model-y",
      }),
    ).toMatchObject({ status: "accepted", isError: false });
  });

  test("a stale generation, a changed input and a wrong shape are refused with the queue's reason", () => {
    const server = serverFor(newRun());
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s2"));
    const first = call(server, "dream_work_take").item;
    const wrong = call(server, "dream_work_answer", {
      id: first.id,
      generation: first.generation,
      value: "maybe",
      model: "m",
    });
    expect(wrong).toMatchObject({ status: "failed", reason: "the value must be yes or no" });
    const stale = call(server, "dream_work_answer", {
      id: first.id,
      generation: first.generation + 5,
      value: "yes",
      model: "m",
    });
    expect(stale.status).toBe("refused");
    const second = call(server, "dream_work_take").item;
    ops.inputs.set("s2", "changed");
    const changed = call(server, "dream_work_answer", {
      id: second.id,
      generation: second.generation,
      value: "yes",
      model: "m",
    });
    expect(changed.status).toBe("superseded");
  });

  test("finish releases the run's leases", () => {
    const server = serverFor(newRun());
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    call(server, "dream_work_take");
    expect(call(server, "dream_work_finish")).toMatchObject({ released: 1 });
    expect(f.items(FIXTURE_CLOSED)[0]!.state).toBe("waiting");
    expect(call(server, "dream_work_finish")).toMatchObject({ released: 0 });
  });

  test("the item budget stops take", () => {
    const run = newRun({ itemBudget: 1 });
    const server = serverFor(run);
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s2"));
    expect(call(server, "dream_work_take").item).not.toBeNull();
    expect(call(server, "dream_work_take")).toMatchObject({ item: null, reason: "item-budget" });
    expect(readDreamRunCalls(f.a.deviceStateDir, run.record.run).map((c) => c.outcome)).toEqual([
      "item",
      "item-budget",
    ]);
  });

  test("only the run's operations are offered", () => {
    const server = serverFor(newRun({ operations: [FIXTURE_TEXT] }));
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    expect(call(server, "dream_work_take")).toMatchObject({ item: null, reason: "empty" });
  });

  test("a call once the run expired is refused and writes nothing", () => {
    const run = newRun({ budgetMs: 60_000 });
    const server = serverFor(run);
    produceWork(f.queue, spec(FIXTURE_CLOSED, "s1"));
    const { item } = call(server, "dream_work_take");
    const before = workCount();
    const calls = readDreamRunCalls(f.a.deviceStateDir, run.record.run).length;
    f.setClock(f.still() + 120_000);
    for (const [name, args] of [
      ["dream_work_take", {}],
      ["dream_work_answer", { id: item.id, generation: item.generation, value: "yes", model: "m" }],
      ["dream_work_finish", {}],
    ] as const) {
      expect(call(server, name, args).isError).toBe(true);
    }
    expect(workCount()).toBe(before);
    expect(readDreamRunCalls(f.a.deviceStateDir, run.record.run)).toHaveLength(calls);
  });
});
