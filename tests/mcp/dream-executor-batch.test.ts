/**
 * The batch protocol of a dream session (`dream_agent_batch` above 1): a
 * take hands out up to the run's batch, an answer carries a list, and
 * each item is taken, rechecked, leased, validated and recorded exactly as
 * one item of the one-item protocol, which a batch of 1 keeps word for
 * word.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DREAM_RUN_ENV, DREAM_TOKEN_ENV } from "../../src/core/brain/dream-queue/dream-session.ts";
import { produceWork, type ProduceSpec } from "../../src/core/brain/dream-queue/queue.ts";
import { readDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { createDreamRun, readDreamRunCalls } from "../../src/core/brain/dream-queue/run-record.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import {
  dreamSessionTask,
  openDreamExecutor,
  type DreamExecutorServer,
} from "../../src/mcp/dream-executor.ts";
import {
  FIXTURE_CLOSED,
  registerFixtureOperations,
  type FixtureOperations,
} from "../helpers/dream-queue-fixtures.ts";
import { closedFixture, type ClosedFixture } from "../core/topics/fixtures/closed-fixture.ts";

let f: ClosedFixture;
let ops: FixtureOperations;
const PINNED = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
let pinnedBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  f = closedFixture();
  ops = registerFixtureOperations("release");
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

function spec(subject: string): ProduceSpec {
  return {
    operation: FIXTURE_CLOSED,
    subject,
    occurrence: `2026-12-01/${subject}`,
    input: subject,
    prompt_version: "1",
    schema_version: "1",
    answer_schema: { enum: ["yes", "no"] },
    after: [],
    resources: [],
    evidence: [`ev-${subject}`],
    payload: { question: `about ${subject}?` },
    sources: ["shared"],
  };
}

function open(batch: number | undefined, itemBudget = 50) {
  const owner = readDreamOwner(f.a).owner!;
  const run = createDreamRun(f.a.deviceStateDir, {
    ownerRevision: owner.revision,
    budgetMs: 600_000,
    operations: [FIXTURE_CLOSED],
    privateAllowed: true,
    itemBudget,
    ...(batch !== undefined ? { batch } : {}),
    agent: "fake-agent",
    now: f.still(),
  });
  const opened = openDreamExecutor({
    env: { [DREAM_RUN_ENV]: run.record.run, [DREAM_TOKEN_ENV]: run.token },
    configPath: f.configPath,
    vault: null,
    now: f.still,
  });
  if (!opened.ok) throw new Error(opened.reason);
  return { server: opened.server, run: run.record.run };
}

function rpc(server: DreamExecutorServer, method: string, params?: unknown): any {
  return server.handle({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
}

function call(server: DreamExecutorServer, name: string, args: Record<string, unknown> = {}): any {
  const out = rpc(server, "tools/call", { name, arguments: args }).result;
  return { ...JSON.parse(out.content[0].text), isError: out.isError === true };
}

function leases(): number {
  return readStreamRecords(f.a.root, "shared", { stream: "dream-work" }).records.filter(
    (r) => r.kind === "dream-work-lease",
  ).length;
}

describe("batch 1 is the one-item protocol", () => {
  test("the tools, the task and a take are those of a run with no batch", () => {
    produceWork(f.queue, spec("s1"));
    const old = open(undefined);
    const one = open(1);
    expect(rpc(one.server, "tools/list").result).toEqual(rpc(old.server, "tools/list").result);
    expect(rpc(one.server, "initialize", {}).result.instructions).toBe(dreamSessionTask(one.run));
    const taken = call(one.server, "dream_work_take");
    expect(taken.item.payload).toEqual({ question: "about s1?" });
    expect(taken).not.toHaveProperty("items");
  });
});

describe("a batch of 3", () => {
  test("the task and the tools say so", () => {
    const { server, run } = open(3);
    expect(rpc(server, "initialize", {}).result.instructions).toBe(dreamSessionTask(run, 3));
    expect(dreamSessionTask(run, 3)).not.toBe(dreamSessionTask(run));
    const tools = rpc(server, "tools/list").result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "dream_work_take",
      "dream_work_answer",
      "dream_work_finish",
    ]);
    expect(tools[0].inputSchema.properties.max.maximum).toBe(3);
    expect(tools[1].inputSchema.required).toEqual(["answers", "model"]);
  });

  test("a take hands out up to 3 items, each with its own lease and call line", () => {
    for (const s of ["s1", "s2", "s3", "s4"]) produceWork(f.queue, spec(s));
    const { server, run } = open(3);
    const first = call(server, "dream_work_take");
    expect(first.items.map((i: any) => i.payload.question)).toEqual([
      "about s1?",
      "about s2?",
      "about s3?",
    ]);
    expect(leases()).toBe(3);
    const second = call(server, "dream_work_take", { max: 2 });
    expect(second.items.map((i: any) => i.payload.question)).toEqual(["about s4?"]);
    expect(call(server, "dream_work_take")).toMatchObject({ items: [], reason: "empty" });
    const takes = readDreamRunCalls(f.a.deviceStateDir, run).filter(
      (c) => c.tool === "dream_work_take",
    );
    expect(takes.map((c) => c.outcome)).toEqual(["item", "item", "item", "item", "empty"]);
  });

  test("the item budget caps a batch", () => {
    for (const s of ["s1", "s2", "s3"]) produceWork(f.queue, spec(s));
    const { server } = open(3, 2);
    expect(call(server, "dream_work_take").items).toHaveLength(2);
    expect(call(server, "dream_work_take")).toMatchObject({ items: [], reason: "item-budget" });
  });

  test("an answer list: each entry is checked and recorded on its own", () => {
    for (const s of ["s1", "s2", "s3"]) produceWork(f.queue, spec(s));
    const { server } = open(3);
    const items = call(server, "dream_work_take").items;
    const answered = call(server, "dream_work_answer", {
      model: "m-1",
      answers: [
        { id: items[0].id, generation: items[0].generation, value: "yes" },
        { id: items[1].id, generation: items[1].generation, value: "maybe" },
        { id: items[2].id, generation: 99, value: "no" },
      ],
    });
    expect(answered.isError).toBe(false);
    expect(answered.results.map((r: any) => [r.id, r.status])).toEqual([
      [items[0].id, "accepted"],
      [items[1].id, "failed"],
      [items[2].id, "refused"],
    ]);
    const records = readStreamRecords(f.a.root, "shared", { stream: "dream-work" }).records;
    const answers = records.filter((r) => r.kind === "dream-work-answer");
    expect(answers.map((r) => [r.body["item"], r.body["model"], r.body["agent"]])).toEqual([
      [items[0].id, "m-1", "fake-agent"],
    ]);
    // The entry with the right generation is still answerable once.
    const again = call(server, "dream_work_answer", {
      model: "m-1",
      answers: [{ id: items[2].id, generation: items[2].generation, value: "no" }],
    });
    expect(again.results[0].status).toBe("accepted");
  });

  test("a list longer than the batch is refused and changes nothing", () => {
    for (const s of ["s1", "s2", "s3", "s4"]) produceWork(f.queue, spec(s));
    const { server } = open(3);
    const items = [
      ...call(server, "dream_work_take").items,
      ...call(server, "dream_work_take").items,
    ];
    expect(items).toHaveLength(4);
    const answered = call(server, "dream_work_answer", {
      model: "m-1",
      answers: items.map((i: any) => ({ id: i.id, generation: i.generation, value: "yes" })),
    });
    expect(answered.isError).toBe(true);
    const records = readStreamRecords(f.a.root, "shared", { stream: "dream-work" }).records;
    expect(records.filter((r) => r.kind === "dream-work-answer")).toEqual([]);
  });

  test("a list with no entry or no model is refused and changes nothing", () => {
    const { server } = open(3);
    expect(call(server, "dream_work_answer", { model: "m", answers: [] }).isError).toBe(true);
    expect(
      call(server, "dream_work_answer", { answers: [{ id: "x", generation: 1 }] }).isError,
    ).toBe(true);
  });
});
