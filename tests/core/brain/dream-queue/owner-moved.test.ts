/**
 * The owner moved (spec "Work that needs a model is a durable item",
 * scenario "The owner moved"; task 3.4): work produced and leased on the
 * first device folds the same on the second once the role is
 * transferred; the old lease is judged by its generation and owner, and
 * the second device takes the item after the lease expires.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
  releaseIfRequested,
  takeDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { DREAM_WORK_LEASE_MS } from "../../../../src/core/brain/dream-queue/constants.ts";
import {
  answerWork,
  dreamQueueOn,
  produceWork,
  readDreamWork,
  takeWork,
} from "../../../../src/core/brain/dream-queue/queue.ts";
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
beforeEach(() => {
  clock = NOW;
  m = makeMachines(["dev-a", "dev-b"], "osb-dream-queue-moved-");
  ops = registerFixtureOperations();
});
afterEach(() => {
  ops.unregister();
  m.cleanup();
});

function summary(store: StoreHandle) {
  const state = readDreamWork(store, { now: clock });
  return state.order.map((id) => {
    const i = state.items.get(id)!;
    return { id, state: i.state, generation: i.generation };
  });
}

test("the second device folds the same states and takes the item after expiry", () => {
  const a = m.open("dev-a");
  claimDreamOwner(a, "claude", human);
  claimSettled(a, readDreamOwner(a, now));
  const qa = dreamQueueOn(a, { vault: null, writer: "o2b", now });
  const spec = (subject: string) => ({
    operation: FIXTURE_CLOSED,
    subject,
    occurrence: "2026-11-20/1",
    input: subject,
    prompt_version: "1",
    schema_version: "1",
    answer_schema: {},
    after: [],
    resources: [],
    evidence: [],
    payload: {},
    sources: ["shared" as const],
  });
  const { id } = produceWork(qa, spec("s1"));
  const firstLease = takeWork(qa, { run: "r1" }).item!;
  expect(firstLease.generation).toBe(1);

  // Transfer: dev-b asks, dev-a releases, both sync.
  m.sync();
  const b = m.open("dev-b");
  expect(takeDreamOwner(b, "codex", { ...human, force: false }).status).toBe("requested");
  m.sync();
  expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBe("dev-b");
  m.sync();
  expect(readDreamOwner(b, now).owner?.device).toBe("dev-b");

  expect(summary(b)).toEqual(summary(a));
  expect(summary(b)).toEqual([{ id, state: "leased", generation: 1 }]);

  const qb = dreamQueueOn(b, { vault: null, writer: "o2b", now });
  // An answer under the lease the previous owner granted is refused.
  const late = answerWork(qb, {
    item: id,
    generation: 1,
    lease_token: firstLease.lease_token,
    value: "yes",
    agent: "a",
    model: "m",
  });
  expect(late.status).toBe("refused");
  expect(readDreamWork(b, { now: clock }).rejected).toEqual([]);
  // The new owner produces, takes and is answered as before.
  const fresh = produceWork(qb, spec("s2"));
  const taken = takeWork(qb, { run: "r2" });
  expect(taken.item?.id).toBe(fresh.id);
  expect(
    answerWork(qb, {
      item: fresh.id,
      generation: 1,
      lease_token: taken.item!.lease_token,
      value: "no",
      agent: "a",
      model: "m",
    }).status,
  ).toBe("accepted");
  // Before the old lease expires the item is not offered; after, dev-b takes it.
  expect(takeWork(qb, { run: "r3" })).toEqual({ item: null, reason: "empty" });
  clock += DREAM_WORK_LEASE_MS + 1;
  const again = takeWork(qb, { run: "r4" });
  expect(again.item).toMatchObject({ id, generation: 2 });
  m.sync();
  expect(summary(a)).toEqual(summary(b));
  expect(readDreamWork(a, { now: clock }).rejected).toEqual([]);
});
