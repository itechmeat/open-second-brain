/**
 * The core functions of the dream work queue on a fixture store (design
 * D3, D4, D6; spec "An answer is accepted only against the current
 * input", "Accepted is not finished", "Failed work is retried, then
 * parked", "An item that lost its subject is closed", "One live lease per
 * item").
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
  releaseIfRequested,
  takeDreamOwner,
  withDreamPassLock,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import * as ownerModule from "../../../../src/core/brain/dream-owner/owner.ts";
import { DreamNotOwnerError } from "../../../../src/core/brain/dream-owner/gate.ts";
import {
  answerWork,
  applyAccepted,
  cancelWork,
  DreamQueueIncompleteSnapshotError,
  DreamQueueItemError,
  DreamQueueValidationError,
  dreamQueueOn,
  dreamQueueForPass,
  produceWork,
  queueStatusAt,
  readDreamWork,
  releaseWork,
  retryWork,
  takeWork,
  type DreamQueue,
  type ProduceSpec,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import {
  DREAM_QUEUE_LOCK,
  DREAM_QUEUE_STATE_DIR,
  DREAM_WORK_BACKOFF_MS,
  DREAM_WORK_LEASE_MS,
} from "../../../../src/core/brain/dream-queue/constants.ts";
import { dreamWorkOperation } from "../../../../src/core/brain/dream-queue/operations.ts";
import * as localLock from "../../../../src/core/store/local-lock.ts";
import * as appender from "../../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import { listShards } from "../../../../src/core/store/shard-list.ts";
import { blobPath, partitionDir } from "../../../../src/core/store/store-paths.ts";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";
import { join } from "node:path";
import { homeEnv } from "../../../helpers/platform.ts";
import {
  FIXTURE_CLOSED,
  FIXTURE_TEXT,
  registerFixtureOperations,
  type FixtureOperations,
} from "../../../helpers/dream-queue-fixtures.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let clock = NOW;
const now = () => clock;
const human = { writer: "o2b", authority: "human" as const, now: () => (clock += 1) };

let m: Machines;
let ops: FixtureOperations;
let a: StoreHandle;
let q: DreamQueue;

function bindOwner(store: StoreHandle): void {
  claimDreamOwner(store, "claude", human);
  claimSettled(store, readDreamOwner(store, now));
}

function spec(subject: string, extra: Partial<ProduceSpec> = {}): ProduceSpec {
  return {
    operation: FIXTURE_CLOSED,
    subject,
    occurrence: "2026-11-20/1",
    input: subject,
    prompt_version: "1",
    schema_version: "1",
    answer_schema: { enum: ["yes", "no"] },
    after: [],
    resources: [],
    evidence: [],
    payload: { question: `about ${subject}?` },
    sources: ["shared"],
    ...extra,
  };
}

function workRecords(store: StoreHandle, partition: "shared" | "private" = "shared") {
  return readStreamRecords(store.root, partition, { stream: "dream-work" }).records;
}

function stateOf(id: string) {
  return readDreamWork(q.store, { now: clock }).items.get(id)!;
}

beforeEach(() => {
  clock = NOW;
  m = makeMachines(["dev-a", "dev-b"], "osb-dream-queue-");
  ops = registerFixtureOperations();
  a = m.open("dev-a");
  bindOwner(a);
  q = dreamQueueOn(a, { vault: null, writer: "o2b", now });
});

afterEach(() => {
  ops.unregister();
  m.cleanup();
});

describe("produceWork", () => {
  test("producing the same work twice gives one item", () => {
    const first = produceWork(q, spec("s1"));
    const second = produceWork(q, spec("s1"));
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(workRecords(a).filter((r) => r.kind === "dream-work-item")).toHaveLength(1);
  });

  test("invalid record bodies are rejected before append", () => {
    const before = workRecords(a).length;
    expect(() => produceWork(q, spec(""))).toThrow(DreamQueueValidationError);
    expect(workRecords(a)).toHaveLength(before);
  });

  test("an item recorded by one process is found waiting by a fresh process", () => {
    const { id } = produceWork(q, spec("s1"));
    const src = (rel: string) => JSON.stringify(join(import.meta.dir, "../../../../src", rel));
    const state = join(m.parent, "state", "dev-a");
    const code =
      `import { openStore } from ${src("core/store/store-open.ts")};\n` +
      `import { readDreamWork } from ${src("core/brain/dream-queue/queue.ts")};\n` +
      `const dirs = { platform: process.platform, home: ${JSON.stringify(state)}, ` +
      `env: { XDG_STATE_HOME: ${JSON.stringify(state)}, LOCALAPPDATA: ${JSON.stringify(state)} } };\n` +
      `const store = openStore({ root: ${JSON.stringify(m.root("dev-a"))}, device: "dev-a", dirs });\n` +
      `const item = readDreamWork(store, { now: ${NOW} }).items.get(${JSON.stringify(id)});\n` +
      `console.log("answer=" + JSON.stringify({ state: item?.state }));\n`;
    const child = Bun.spawnSync([process.execPath, "-e", code], {
      env: {
        ...homeEnv(join(m.parent, "home", "dev-a")),
        XDG_CONFIG_HOME: join(m.parent, "config"),
        XDG_DATA_HOME: join(m.parent, "data"),
        XDG_STATE_HOME: state,
        XDG_CACHE_HOME: join(m.parent, "cache"),
        OPEN_SECOND_BRAIN_CONFIG: join(m.parent, "config.yaml"),
        [STORE_ROOT_ENV]: m.root("dev-a"),
        O2B_DEVICE_ID: "dev-a",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const match = /answer=(\{.*\})/.exec(child.stdout.toString());
    expect(match?.[1], child.stderr.toString()).toBeDefined();
    expect(JSON.parse(match![1]!)).toEqual({ state: "waiting" });
  });
});

describe("takeWork", () => {
  test("a competing same-generation lease returns busy", () => {
    produceWork(q, spec("competing-lease"));
    const original = appender.appendRecord;
    const append = spyOn(appender, "appendRecord");
    let injected = false;
    append.mockImplementation((...args) => {
      if (args[1].kind === "dream-work-lease" && !injected) {
        injected = true;
        original(
          args[0],
          {
            ...args[1],
            body: { ...args[1].body, lease_token: "winner" },
          },
          args[2],
        );
      }
      return original(...args);
    });
    try {
      expect(takeWork(q, { run: "r1" })).toEqual({ item: null, reason: "busy" });
    } finally {
      append.mockRestore();
    }
    expect(injected).toBe(true);
  });

  test("a device that is not the owner is refused and writes nothing", () => {
    produceWork(q, spec("s1"));
    m.sync();
    const b = m.open("dev-b");
    const qb = dreamQueueOn(b, { vault: null, writer: "o2b", now });
    expect(() => takeWork(qb, { run: "r" })).toThrow(DreamNotOwnerError);
    expect(workRecords(b).filter((r) => r.device === "dev-b")).toEqual([]);
  });

  test("ownership is rechecked after acquiring the queue lock", () => {
    const b = m.open("dev-b");
    m.sync();
    const original = localLock.withLocalLock;
    const lock = spyOn(localLock, "withLocalLock");
    const target = join(a.deviceStateDir, DREAM_QUEUE_STATE_DIR, DREAM_QUEUE_LOCK);
    lock.mockImplementation((...args) =>
      args[0] === target
        ? original(
            args[0],
            () => {
              takeDreamOwner(b, "codex", { ...human, force: true });
              m.sync();
              return args[1]();
            },
            args[2],
          )
        : original(...args),
    );
    try {
      expect(() => produceWork(q, spec("after-transfer"))).toThrow(DreamNotOwnerError);
    } finally {
      lock.mockRestore();
    }
    expect(workRecords(a).filter((r) => r.kind === "dream-work-item")).toEqual([]);
  });

  test("a release before the queue pass lock refuses the append", () => {
    m.sync();
    const b = m.open("dev-b");
    const original = ownerModule.withDreamPassLock;
    const lock = spyOn(ownerModule, "withDreamPassLock");
    let transferred = false;
    lock.mockImplementation((...args) => {
      if (args[0].device === "dev-a" && !transferred) {
        transferred = true;
        expect(takeDreamOwner(b, "codex", { ...human, force: false }).status).toBe("requested");
        m.sync();
        expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBe("dev-b");
        m.sync();
      }
      return original(...args);
    });
    try {
      expect(() => produceWork(q, spec("after-release"))).toThrow(DreamNotOwnerError);
    } finally {
      lock.mockRestore();
    }
    expect(transferred).toBe(true);
    expect(workRecords(a).filter((record) => record.kind === "dream-work-item")).toEqual([]);
  });

  test("a concurrent release waits until the queue append completes", () => {
    m.sync();
    const b = m.open("dev-b");
    const original = appender.appendRecord;
    const append = spyOn(appender, "appendRecord");
    let moved = false;
    append.mockImplementation((...args) => {
      if (args[1].kind === "dream-work-item" && !moved) {
        moved = true;
        expect(takeDreamOwner(b, "codex", { ...human, force: false }).status).toBe("requested");
        m.sync();
        expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBeNull();
        expect(readDreamOwner(a, now).owner?.device).toBe("dev-a");
      }
      return original(...args);
    });
    let produced: ReturnType<typeof produceWork> | undefined;
    try {
      produced = produceWork(q, spec("before-release"));
    } finally {
      append.mockRestore();
    }
    expect(moved).toBe(true);
    expect(produced?.created).toBe(true);
    expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBe("dev-b");
    m.sync();
    expect(readDreamWork(b, { now: clock }).rejected).toEqual([]);
  }, 15_000);

  test("confirmation folds a force claim that arrived after the gate", () => {
    const b = m.open("dev-b");
    const original = appender.appendRecord;
    const append = spyOn(appender, "appendRecord");
    let transferred = false;
    append.mockImplementation((...args) => {
      if (args[1].kind === "dream-work-item" && !transferred) {
        transferred = true;
        takeDreamOwner(b, "codex", { ...human, force: true, now: () => clock - 100 });
        m.sync();
      }
      return original(...args);
    });
    try {
      expect(() => produceWork(q, spec("owner-race"))).toThrow(DreamQueueItemError);
    } finally {
      append.mockRestore();
    }
    expect(transferred).toBe(true);
    expect(readDreamWork(a, { now: clock }).items.size).toBe(0);
  });

  test("a pass-owned queue does not release a pending transfer under the pass lock", () => {
    m.sync();
    const b = m.open("dev-b");
    expect(takeDreamOwner(b, "codex", { ...human, force: false }).status).toBe("requested");
    m.sync();
    const owner = readDreamOwner(a, now).owner!;
    const passQueue = dreamQueueForPass(a, owner, { vault: null, writer: "o2b", now });
    withDreamPassLock(a, () => produceWork(passQueue, spec("during-pass")));
    expect(readDreamOwner(a, now).owner?.device).toBe("dev-a");
    expect(readDreamOwner(a, now).pending?.device).toBe("dev-b");
  });

  test("two takes give different items", () => {
    produceWork(q, spec("s1"));
    produceWork(q, spec("s2"));
    const one = takeWork(q, { run: "r1" });
    const two = takeWork(q, { run: "r2" });
    expect(one.item?.id).toBeDefined();
    expect(two.item?.id).toBeDefined();
    expect(one.item!.id).not.toBe(two.item!.id);
    expect(takeWork(q, { run: "r3" })).toEqual({ item: null, reason: "empty" });
  });

  test("a take while the lock is held returns nothing with the reason busy", () => {
    produceWork(q, spec("s1"));
    const target = join(a.deviceStateDir, DREAM_QUEUE_STATE_DIR, DREAM_QUEUE_LOCK);
    const result = localLock.withLocalLock(target, () => takeWork(q, { run: "r", budgetMs: 50 }));
    expect(result).toEqual({ item: null, reason: "busy" });
  });

  test("a mutation refuses an incomplete stream while status remains readable", () => {
    const produced = produceWork(q, spec("incomplete"));
    readDreamWork(a, { now: clock });
    const shard = listShards(partitionDir(a.root, "shared"), { stream: "dream-work" })[0]!;
    renameSync(shard.path, `${shard.path}.hidden`);
    const status = readDreamWork(a, { now: clock });
    expect(status.unreadable).toContain(`shared/${shard.rel}`);
    expect(status.items.has(produced.id)).toBe(false);
    expect(() => takeWork(q, { run: "r-incomplete" })).toThrow(DreamQueueIncompleteSnapshotError);
    expect(workRecords(a).filter((record) => record.kind === "dream-work-lease")).toEqual([]);
  });

  test("a pending owner record during confirmation makes the snapshot incomplete", () => {
    produceWork(q, spec("pending-owner"));
    const original = appender.appendRecord;
    const append = spyOn(appender, "appendRecord");
    let inserted = false;
    append.mockImplementation((...args) => {
      const result = original(...args);
      if (args[1].kind === "dream-work-lease" && !inserted) {
        inserted = true;
        const pending = original(args[0], {
          partition: "shared",
          stream: "settings",
          kind: "dream-owner-claim",
          agent: "o2b",
          body: { device: "dev-a", agent: "claude", force: false, padding: "x".repeat(40_000) },
        });
        rmSync(blobPath(partitionDir(a.root, "shared"), pending.record.sum));
      }
      return result;
    });
    let caught: unknown;
    try {
      takeWork(q, { run: "pending-owner" });
    } catch (error) {
      caught = error;
    } finally {
      append.mockRestore();
    }
    expect(inserted).toBe(true);
    expect(caught).toBeInstanceOf(DreamQueueIncompleteSnapshotError);
    expect((caught as DreamQueueIncompleteSnapshotError).unreadable).toContain(
      "shared/dream-owner-claim:1",
    );
    expect(workRecords(a).filter((record) => record.kind === "dream-work-lease")).toHaveLength(1);
  });

  test("an incomplete status keeps readable items but reports no ready backlog", () => {
    const partial = produceWork(q, spec("partial"));
    produceWork(q, spec("unreadable", { sources: ["shared", "private"] }));
    const shard = listShards(partitionDir(a.root, "private"), { stream: "dream-work" })[0]!;
    renameSync(shard.path, `${shard.path}.hidden`);

    const status = queueStatusAt(a.root, { now: clock });
    expect(status.available).toBe(true);
    if (!status.available) return;
    expect(status.items.map((item) => item.id)).toContain(partial.id);
    expect(status.unreadable).toContain(`private/${shard.rel}`);
    expect(status.ready).toBe(0);
    expect(status.oldest_ready).toBeNull();
    expect(status.backlog).toBe(false);
  });

  test("an expired lease is released once by the next take, which takes the item again", () => {
    const { id } = produceWork(q, spec("s1"));
    expect(takeWork(q, { run: "r1" }).item?.generation).toBe(1);
    clock += DREAM_WORK_LEASE_MS + 1;
    const again = takeWork(q, { run: "r2" });
    expect(again.item?.id).toBe(id);
    expect(again.item?.generation).toBe(2);
    const released = workRecords(a).filter(
      (r) => r.kind === "dream-work-attempt" && r.body["outcome"] === "released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]!.body["generation"]).toBe(1);
  });

  test("settle closes a dependant of a cancelled item under the cancel rule, once", () => {
    const pred = produceWork(q, spec("pred"));
    const dep = produceWork(q, spec("dep", { after: [pred.id] }));
    cancelWork(q, pred.id, "not needed");
    takeWork(q, { run: "r1" });
    takeWork(q, { run: "r2" });
    const closes = workRecords(a).filter(
      (r) => r.kind === "dream-work-closed" && r.body["item"] === dep.id,
    );
    expect(closes).toHaveLength(1);
    expect(stateOf(dep.id).state).toBe("closed");
  });

  test("take skips an item before its retry time and one whose operation is unknown", () => {
    const failing = produceWork(q, spec("f"));
    const t = takeWork(q, { run: "r1" });
    answerWork(q, {
      item: failing.id,
      generation: t.item!.generation,
      lease_token: t.item!.lease_token,
      value: "maybe",
      agent: "a",
      model: "m",
    });
    const unknown = produceWork(q, spec("u", { operation: "not-registered" }));
    expect(takeWork(q, { run: "r2" })).toEqual({ item: null, reason: "empty" });
    expect(stateOf(unknown.id).unknown_operation).toBe(true);
    clock += DREAM_WORK_BACKOFF_MS[0] + 1;
    expect(takeWork(q, { run: "r3" }).item?.id).toBe(failing.id);
  });

  test("a changed input supersedes the item and the successor is offered", () => {
    const { id } = produceWork(q, spec("s1"));
    ops.inputs.set("s1", "s1-changed");
    const taken = takeWork(q, { run: "r1" });
    expect(taken.item).not.toBeNull();
    expect(taken.item!.id).not.toBe(id);
    expect(taken.item!.payload).toEqual({ now: "s1-changed" });
    const old = stateOf(id);
    expect(old.state).toBe("closed");
    expect(old.closed).toMatchObject({ reason: "superseded", successor: taken.item!.id });
  });

  test("an input that returns to a closed identity leaves current work actionable", () => {
    const first = produceWork(q, spec("recurring", { input: "A" }));
    ops.inputs.set("recurring", "B");
    const second = takeWork(q, { run: "r1" }).item!;
    expect(second.id).not.toBe(first.id);
    ops.inputs.set("recurring", "A");
    expect(
      answerWork(q, {
        item: second.id,
        generation: second.generation,
        lease_token: second.lease_token,
        value: "yes",
        agent: "a",
        model: "m",
      }),
    ).toMatchObject({ status: "superseded" });
    const state = readDreamWork(a, { now: clock });
    const actionable = [...state.items.values()].filter((item) => item.state !== "closed");
    expect(actionable).toHaveLength(1);
    expect(actionable[0]!.id).not.toBe(first.id);
    expect(actionable[0]!.state).toBe("waiting");
    expect(actionable[0]!.body.payload).toEqual({ now: "A" });
  });

  test("a crash after writing a supersession successor leaves the old item open", () => {
    const { id } = produceWork(q, spec("s1"));
    ops.inputs.set("s1", "s1-changed");
    const original = appender.appendRecord;
    const append = spyOn(appender, "appendRecord");
    let crashed = false;
    append.mockImplementation((...args) => {
      const result = original(...args);
      if (args[1].kind === "dream-work-item" && !crashed) {
        crashed = true;
        throw new Error("simulated process stop after successor write");
      }
      return result;
    });
    try {
      expect(() => takeWork(q, { run: "r1" })).toThrow("simulated process stop");
    } finally {
      append.mockRestore();
    }
    expect(stateOf(id).state).toBe("waiting");
    const successor = workRecords(a).find(
      (r) => r.kind === "dream-work-item" && r.body["input_hash"] !== stateOf(id).body.input_hash,
    );
    expect(successor).toBeDefined();
    const resumed = takeWork(q, { run: "r2" });
    expect(resumed.item?.id).toBe(successor?.body["id"] as string | undefined);
    expect(stateOf(id).closed).toMatchObject({
      reason: "superseded",
      successor: successor?.body["id"],
    });
  });

  test("a missing subject cancels the item", () => {
    const { id } = produceWork(q, spec("gone"));
    ops.inputs.set("gone", null);
    expect(takeWork(q, { run: "r1" })).toEqual({ item: null, reason: "empty" });
    expect(stateOf(id).closed).toMatchObject({ reason: "cancelled", note: "subject gone" });
  });
});

describe("answerWork", () => {
  test("an answer under a replaced generation is refused and changes nothing", () => {
    const { id } = produceWork(q, spec("s1"));
    const firstLease = takeWork(q, { run: "r1" }).item!;
    clock += DREAM_WORK_LEASE_MS + 1;
    takeWork(q, { run: "r2" });
    const before = stateOf(id);
    const res = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: firstLease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    expect(res.status).toBe("refused");
    const after = stateOf(id);
    expect(after.state).toBe(before.state);
    expect(after.generation).toBe(2);
  });

  test("a mismatched generation is refused without recording an attempt", () => {
    const { id } = produceWork(q, spec("mismatched-generation"));
    const first = takeWork(q, { run: "r1" }).item!;
    releaseWork(q, { item: id, generation: 1, lease_token: first.lease_token });
    const current = takeWork(q, { run: "r2" }).item!;
    const before = workRecords(a).filter((r) => r.kind === "dream-work-attempt").length;
    expect(
      answerWork(q, {
        item: id,
        generation: 1,
        lease_token: current.lease_token,
        value: "yes",
        agent: "a",
        model: "m",
      }).status,
    ).toBe("refused");
    expect(workRecords(a).filter((r) => r.kind === "dream-work-attempt")).toHaveLength(before);
  });

  test("an answer outside the schema records a failed attempt with backoff", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    const res = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "maybe",
      agent: "a",
      model: "m",
    });
    expect(res).toMatchObject({ status: "failed", reason: "the value must be yes or no" });
    const folded = stateOf(id);
    expect(folded.state).toBe("waiting");
    expect(folded.attempts).toBe(1);
    expect(folded.retry_at).toBe(new Date(clock + DREAM_WORK_BACKOFF_MS[0]).toISOString());
  });

  test("the same answer twice returns the first receipt and writes once", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    const first = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    const second = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    expect(first.status).toBe("accepted");
    expect(second).toEqual(first);
    expect(workRecords(a).filter((r) => r.kind === "dream-work-answer")).toHaveLength(1);
  });

  test("a text answer is accepted for a text operation", () => {
    const { id } = produceWork(q, spec("t", { operation: FIXTURE_TEXT }));
    const lease = takeWork(q, { run: "r1" }).item!;
    const res = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      text: "A summary.",
      agent: "a",
      model: "m",
    });
    expect(res.status).toBe("accepted");
    expect(stateOf(id).answer?.text).toBe("A summary.");
  });

  test("a changed input supersedes on answer and the attempt is recorded", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    ops.inputs.set("s1", "other");
    const res = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    expect(res.status).toBe("superseded");
    expect(stateOf(id).state).toBe("closed");
    const refused = workRecords(a).filter(
      (r) => r.kind === "dream-work-attempt" && r.body["outcome"] === "refused",
    );
    expect(refused).toHaveLength(1);
    expect(takeWork(q, { run: "r2" }).item?.id).toBe((res as { successor: string }).successor);
  });

  test("an unavailable current input leaves the live lease for the executor to release", () => {
    const { id } = produceWork(q, spec("temporarily-unreadable"));
    const lease = takeWork(q, { run: "r1" }).item!;
    ops.unavailable.add("temporarily-unreadable");
    const res = answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    expect(res).toMatchObject({ status: "unavailable", reason: "current input is unavailable" });
    expect(stateOf(id).state).toBe("leased");
    expect(stateOf(id).attempts).toBe(0);
  });
});

describe("applyAccepted", () => {
  test("accepted work with a newly introduced blocker is not applied", () => {
    const accepted = produceWork(
      q,
      spec("accepted-later", {
        occurrence: "2026-11-20/02",
        resources: ["shared-resource"],
      }),
    );
    const lease = takeWork(q, { run: "r1" }).item!;
    answerWork(q, {
      item: accepted.id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    produceWork(
      q,
      spec("earlier-blocker", {
        occurrence: "2026-11-20/01",
        resources: ["shared-resource"],
      }),
    );
    expect(stateOf(accepted.id).blocked_by).not.toEqual([]);
    expect(applyAccepted(q).applied).not.toContain(accepted.id);
    expect(ops.calls.writes).toBe(0);
  });

  test("accepted, then a crash, then the next apply applies once", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    expect(stateOf(id).state).toBe("accepted");
    // The process ends here; a fresh queue handle is the next pass.
    const next = dreamQueueOn(m.open("dev-a"), { vault: null, writer: "o2b", now });
    expect(applyAccepted(next).applied).toEqual([id]);
    expect(applyAccepted(next).applied).toEqual([]);
    expect(stateOf(id).state).toBe("finished");
    expect(ops.calls.writes).toBe(1);
  });

  test("apply run twice writes its effects once", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    const folded = stateOf(id);
    const op = dreamWorkOperation(FIXTURE_CLOSED)!;
    const context = { store: a, vault: null, now: Date.now() };
    const first = op.apply(folded, folded.answer!, context);
    const second = op.apply(folded, folded.answer!, context);
    expect(second).toEqual(first);
    expect(ops.calls.writes).toBe(1);
  });
});

describe("release, retry and cancel", () => {
  test("release ends the lease with no wait", () => {
    const { id } = produceWork(q, spec("s1"));
    const lease = takeWork(q, { run: "r1" }).item!;
    expect(
      releaseWork(q, { item: id, generation: 1, lease_token: lease.lease_token }).released,
    ).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: "waiting", ready: true, retry_at: null });
  });

  test("retry offers a parked item again and cancel closes an item, both as a person", () => {
    const { id } = produceWork(q, spec("s1"));
    for (let i = 0; i < 5; i++) {
      const t = takeWork(q, { run: `r${i}` });
      expect(t.item?.id).toBe(id);
      answerWork(q, {
        item: id,
        generation: t.item!.generation,
        lease_token: t.item!.lease_token,
        value: "bad",
        agent: "a",
        model: "m",
      });
      clock += 7 * 60 * 60_000;
    }
    expect(stateOf(id).state).toBe("parked");
    retryWork(q, id);
    expect(stateOf(id)).toMatchObject({ state: "waiting", attempts: 0 });
    const retry = workRecords(a).find((r) => r.kind === "dream-work-retry")!;
    expect(retry.body["authority"]).toBe("human");
    cancelWork(q, id, "no longer wanted");
    expect(stateOf(id).closed).toMatchObject({ reason: "cancelled", note: "no longer wanted" });
    const close = workRecords(a).find((r) => r.kind === "dream-work-closed")!;
    expect(close.body["authority"]).toBe("human");
  });
});

describe("the queue lock", () => {
  test("no entry point takes the lock twice", () => {
    const lockTarget = join(a.deviceStateDir, DREAM_QUEUE_STATE_DIR, DREAM_QUEUE_LOCK);
    const counts: number[] = [];
    const spy = spyOn(localLock, "withLocalLock");
    try {
      const count = (fn: () => unknown): void => {
        const before = spy.mock.calls.filter((c) => c[0] === lockTarget).length;
        fn();
        counts.push(spy.mock.calls.filter((c) => c[0] === lockTarget).length - before);
      };
      count(() => produceWork(q, spec("s1")));
      ops.inputs.set("s1", "changed");
      const taken: Array<ReturnType<typeof takeWork>> = [];
      count(() => taken.push(takeWork(q, { run: "r1" })));
      const item = taken[0]!.item!;
      count(() =>
        answerWork(q, {
          item: item.id,
          generation: item.generation,
          lease_token: item.lease_token,
          value: "yes",
          agent: "a",
          model: "m",
        }),
      );
      count(() => applyAccepted(q));
      const other = produceWork(q, spec("s2")).id;
      takeWork(q, { run: "r2" });
      count(() =>
        releaseWork(q, { item: other, generation: 1, lease_token: stateOf(other).lease_token! }),
      );
      count(() => cancelWork(q, other, "x"));
      count(() => expect(() => retryWork(q, other)).toThrow());
    } finally {
      spy.mockRestore();
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});
