/**
 * The queue additions of the closed questions (change
 * `dream-closed-questions`, task 1.1): a batch producer, an operation
 * applied by planning, a take filter, a release with its reason, a
 * failed attempt written by an executor, and the applied mark planning
 * writes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import {
  answerWork,
  applyAccepted,
  dreamQueueOn,
  failWork,
  markAppliedByPlanning,
  produceWork,
  produceWorkBatch,
  readDreamWork,
  releaseWork,
  takeWork,
  type DreamQueue,
  type ProduceSpec,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { registerDreamWorkOperation } from "../../../../src/core/brain/dream-queue/operations.ts";
import * as streamRead from "../../../../src/core/store/read/stream-read.ts";
import * as localLock from "../../../../src/core/store/local-lock.ts";
import { join } from "node:path";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";
import {
  FIXTURE_CLOSED,
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

const PLANNED = "fixture-planned";

function registerPlanned(): () => void {
  return registerDreamWorkOperation({
    name: PLANNED,
    closedPredecessor: "release",
    appliedBy: "planning",
    validate: () => null,
    currentInput: (item) => ({ input_hash: item.body.input_hash }),
    apply: () => {
      throw new Error("planning applies this operation");
    },
  });
}

function stateOf(id: string) {
  return readDreamWork(a, { now: clock }).items.get(id)!;
}

beforeEach(() => {
  clock = NOW;
  m = makeMachines(["dev-a"], "osb-dream-queue-add-");
  ops = registerFixtureOperations();
  a = m.open("dev-a");
  claimDreamOwner(a, "claude", human);
  claimSettled(a, readDreamOwner(a, now));
  q = dreamQueueOn(a, { vault: null, writer: "o2b", now });
});

afterEach(() => {
  ops.unregister();
  m.cleanup();
});

describe("produceWorkBatch", () => {
  test("writes every new item under one lock and confirms them on a complete reread", () => {
    const first = produceWork(q, spec("s1"));
    const locks = spyOn(localLock, "withLocalLock");
    const reads = spyOn(streamRead, "readStreamRecords");
    try {
      const batch = produceWorkBatch(q, [spec("s1"), spec("s2"), spec("s3")]);
      const queueLocks = locks.mock.calls.filter((call) =>
        String(call[0]).endsWith(join("dream-queue", "queue")),
      );
      expect(queueLocks).toHaveLength(1);
      // The entry and its confirmation each read the held partitions and owner settings.
      const queueReads = reads.mock.calls.filter((call) => call[2]?.stream === "dream-work");
      expect(queueReads.length).toBe(a.partitions.size * 2);
      const ownerReads = reads.mock.calls.filter((call) => call[2]?.stream === "settings");
      expect(ownerReads).toHaveLength(2);
      expect(batch.items.map((i) => i.created)).toEqual([false, true, true]);
      expect(batch.items[0]!.id).toBe(first.id);
    } finally {
      locks.mockRestore();
      reads.mockRestore();
    }
  });

  test("equals produceWork item by item", () => {
    const specs = [spec("x1"), spec("x2", { sources: ["private"] })];
    const batch = produceWorkBatch(q, specs);
    m.cleanup();
    m = makeMachines(["dev-a"], "osb-dream-queue-add-");
    a = m.open("dev-a");
    clock = NOW;
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    q = dreamQueueOn(a, { vault: null, writer: "o2b", now });
    const single = specs.map((s) => produceWork(q, s));
    expect(batch.items).toEqual(single);
  });
});

describe("an operation applied by planning", () => {
  test("applyAccepted skips it and leaves it accepted", () => {
    const remove = registerPlanned();
    try {
      const { id } = produceWork(q, spec("p1", { operation: PLANNED }));
      const taken = takeWork(q, { run: "r1" }).item!;
      expect(taken.id).toBe(id);
      answerWork(q, {
        item: id,
        generation: taken.generation,
        lease_token: taken.lease_token,
        value: "yes",
        agent: "a",
        model: "m",
      });
      const result = applyAccepted(q);
      expect(result).toEqual({ applied: [], failed: [] });
      expect(stateOf(id).state).toBe("accepted");
    } finally {
      remove();
    }
  });
});

describe("markAppliedByPlanning", () => {
  test("finishes an accepted item with the effects planning wrote", () => {
    const { id } = produceWork(q, spec("s1"));
    const taken = takeWork(q, { run: "r1" }).item!;
    answerWork(q, {
      item: id,
      generation: taken.generation,
      lease_token: taken.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    const answer = stateOf(id).answer!;
    const result = markAppliedByPlanning(q, [
      {
        item: id,
        generation: answer.generation,
        lease_token: answer.lease_token,
        receipt: answer.receipt,
        effects: ["rec-1"],
      },
    ]);
    expect(result).toEqual({ applied: [id], refused: [] });
    expect(stateOf(id).state).toBe("finished");
    expect(stateOf(id).applied?.effects).toEqual(["rec-1"]);
  });

  test("refuses an item that is not accepted", () => {
    const { id } = produceWork(q, spec("s1"));
    const result = markAppliedByPlanning(q, [
      {
        item: id,
        generation: 1,
        lease_token: "unacc",
        receipt: "unaccepted-receipt",
        effects: ["abstained"],
      },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ item: id, reason: "the item is waiting, not accepted" }]);
    expect(stateOf(id).state).toBe("waiting");
  });
});

describe("takeWork with a filter", () => {
  test("leases the first ready item the filter admits", () => {
    produceWork(q, spec("s1", { occurrence: "2026-11-20/1" }));
    const second = produceWork(q, spec("s2", { occurrence: "2026-11-20/2" }));
    const taken = takeWork(q, { run: "r1", filter: (item) => item.body.subject === "s2" });
    expect(taken.item?.id).toBe(second.id);
    expect(takeWork(q, { run: "r1", filter: () => false })).toEqual({
      item: null,
      reason: "empty",
    });
  });
});

describe("releaseWork with a reason", () => {
  test("the fold keeps the reason with the input it was given for", () => {
    const { id } = produceWork(q, spec("s1"));
    const taken = takeWork(q, { run: "r1" }).item!;
    expect(
      releaseWork(q, {
        item: id,
        generation: taken.generation,
        lease_token: taken.lease_token,
        reason: "shadow",
      }),
    ).toEqual({
      released: true,
    });
    const item = stateOf(id);
    expect(item.state).toBe("waiting");
    expect(item.attempts).toBe(0);
    expect(item.last_release).toEqual({ reason: "shadow", input_hash: item.body.input_hash });
  });

  test("a release with no reason keeps the old wording", () => {
    const { id } = produceWork(q, spec("s1"));
    const taken = takeWork(q, { run: "r1" }).item!;
    releaseWork(q, {
      item: id,
      generation: taken.generation,
      lease_token: taken.lease_token,
    });
    expect(stateOf(id).last_release?.reason).toBe("released by the worker");
  });
});

describe("failWork", () => {
  test("a failed attempt counts and sets the backoff", () => {
    const { id } = produceWork(q, spec("s1"));
    const taken = takeWork(q, { run: "r1" }).item!;
    expect(
      failWork(q, {
        item: id,
        generation: taken.generation,
        lease_token: "wrong",
        reason: "timeout",
      }),
    ).toEqual({ failed: false, retry_at: null });
    const result = failWork(q, {
      item: id,
      generation: taken.generation,
      lease_token: taken.lease_token,
      reason: "timeout",
    });
    expect(result.failed).toBe(true);
    const item = stateOf(id);
    expect(item.attempts).toBe(1);
    expect(item.last_reason).toBe("timeout");
    expect(item.retry_at).toBe(new Date(clock + 60_000).toISOString());
  });
});
