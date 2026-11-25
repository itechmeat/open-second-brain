/**
 * A dream session's server keeps its reads between calls (the planning
 * inputs and the queue, read through kept tails): every take and answer
 * still rechecks the item against the store as it is at that call, so a
 * change another writer makes while an item is out is seen exactly as a
 * fresh read sees it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DREAM_RUN_ENV, DREAM_TOKEN_ENV } from "../../src/core/brain/dream-queue/dream-session.ts";
import { produceWork } from "../../src/core/brain/dream-queue/queue.ts";
import { readDreamOwner } from "../../src/core/brain/dream-owner/owner.ts";
import { createDreamRun, readDreamRunCalls } from "../../src/core/brain/dream-queue/run-record.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import {
  closedProduceSpec,
  closedQuestion,
  readTopicQuestionState,
} from "../../src/core/topics/decide-operations.ts";
import { openDreamExecutor, type DreamExecutorServer } from "../../src/mcp/dream-executor.ts";
import { closedFixture, type ClosedFixture } from "../core/topics/fixtures/closed-fixture.ts";

let f: ClosedFixture;
const PINNED = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
let pinnedBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  f = closedFixture();
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
  f.cleanup();
});

let lastRun = "";

function server(): DreamExecutorServer {
  const owner = readDreamOwner(f.a).owner!;
  const run = createDreamRun(f.a.deviceStateDir, {
    ownerRevision: owner.revision,
    budgetMs: 600_000,
    operations: ["human-readable"],
    privateAllowed: false,
    itemBudget: 50,
    agent: "fake-agent",
    now: f.still(),
  });
  lastRun = run.record.run;
  const opened = openDreamExecutor({
    env: { [DREAM_RUN_ENV]: run.record.run, [DREAM_TOKEN_ENV]: run.token },
    configPath: f.configPath,
    vault: null,
    now: f.still,
  });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.server;
}

function call(s: DreamExecutorServer, name: string, args: Record<string, unknown> = {}): any {
  const out = s.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return JSON.parse((out as any).result.content[0].text);
}

function produce(note: string): void {
  const state = readTopicQuestionState(f.a, f.still())!;
  produceWork(f.queue, closedProduceSpec(closedQuestion(state, "human-readable", note)!));
}

function judge(note: string): void {
  appendRecord(f.a, {
    partition: "shared",
    stream: "log",
    kind: "history-verdict",
    agent: "elsewhere",
    body: { authority: "agent", record: note, keep: false },
  });
}

describe("a session's server between calls", () => {
  test("sees a note judged by another writer while its item is out", () => {
    const notes = [f.note("A note to keep"), f.note("A note judged meanwhile")];
    for (const note of notes) produce(note);
    const s = server();
    const taken = [call(s, "dream_work_take").item, call(s, "dream_work_take").item];
    const bySubject = new Map(taken.map((item) => [item.evidence[0], item]));
    judge(notes[1]!);
    const kept = bySubject.get(notes[0])!;
    const judged = bySubject.get(notes[1])!;
    expect(
      call(s, "dream_work_answer", { id: kept.id, generation: 1, value: 0.9, model: "m" }),
    ).toMatchObject({ status: "accepted" });
    expect(
      call(s, "dream_work_answer", { id: judged.id, generation: 1, value: 0.9, model: "m" }),
    ).toMatchObject({ status: "cancelled", reason: "subject gone" });
  });

  test("takes an item produced after its first take", () => {
    const first = f.note("A first note");
    produce(first);
    const s = server();
    const one = call(s, "dream_work_take").item;
    expect(one.evidence).toEqual([first]);
    expect(call(s, "dream_work_take")).toMatchObject({ item: null, reason: "empty" });
    const second = f.note("A note written during the session");
    produce(second);
    expect(call(s, "dream_work_take").item.evidence).toEqual([second]);
    // Each tool call's line in the run's call log says how long the server took.
    const calls = readDreamRunCalls(f.a.deviceStateDir, lastRun);
    expect(calls.map((c) => c.tool)).toEqual([
      "dream_work_take",
      "dream_work_take",
      "dream_work_take",
    ]);
    for (const c of calls) expect(typeof c.ms).toBe("number");
  });
});
