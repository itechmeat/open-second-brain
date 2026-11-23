/**
 * Private evidence stays in the private partition (design D5, spec
 * "Private evidence stays in the private partition").
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
  releaseIfRequested,
  takeDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import {
  answerWork,
  applyAccepted,
  dreamQueueOn,
  produceWork,
  produceWorkBatch,
  queueStatusAt,
  takeWork,
  type ProduceSpec,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import {
  FIXTURE_CLOSED,
  registerFixtureOperations,
  type FixtureOperations,
} from "../../../helpers/dream-queue-fixtures.ts";
import { makeTestStore } from "../../../helpers/test-store.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let clock = NOW;
const now = () => clock;
const human = { writer: "o2b", authority: "human" as const, now: () => (clock += 1) };

const spec = (
  subject: string,
  sources: ProduceSpec["sources"],
  resources: ProduceSpec["resources"] = [],
): ProduceSpec => ({
  operation: FIXTURE_CLOSED,
  subject,
  occurrence: "2026-11-20/1",
  input: subject,
  prompt_version: "1",
  schema_version: "1",
  answer_schema: {},
  after: [],
  resources,
  evidence: [`pref-${subject}`],
  payload: { about: subject },
  sources,
});

let ops: FixtureOperations;
beforeEach(() => {
  clock = NOW;
  ops = registerFixtureOperations();
});
afterEach(() => ops.unregister());

describe("partitions", () => {
  let m: Machines;
  beforeEach(() => {
    m = makeMachines(["dev-a", "dev-b"], "osb-dream-queue-part-");
  });
  afterEach(() => m.cleanup());

  test("status excludes resource items a shared-only owner cannot take", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    produceWork(
      dreamQueueOn(a, { vault: null, writer: "o2b", now }),
      spec("public-resource", ["shared"], ["topic:x"]),
    );
    m.sync();
    rmSync(join(m.root("dev-b"), "private"), { recursive: true, force: true });
    const b = m.open("dev-b");
    takeDreamOwner(b, "codex", { ...human, force: true });
    const status = queueStatusAt(m.root("dev-b"), { now: clock });
    expect(status.available).toBe(true);
    if (!status.available) return;
    expect(status.ready).toBe(0);
    expect(status.items[0]?.ready).toBe(false);
  });

  test("an item built from a private record is written to private with all its later records", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    const q = dreamQueueOn(a, { vault: null, writer: "o2b", now });
    const { id, partition } = produceWork(q, spec("secret", ["shared", "private"]));
    expect(partition).toBe("private");
    const lease = takeWork(q, { run: "r" }).item!;
    answerWork(q, {
      item: id,
      generation: 1,
      lease_token: lease.lease_token,
      value: "yes",
      agent: "a",
      model: "m",
    });
    applyAccepted(q);
    const shared = readStreamRecords(a.root, "shared", { stream: "dream-work" }).records;
    const priv = readStreamRecords(a.root, "private", { stream: "dream-work" }).records;
    expect(shared).toEqual([]);
    expect(priv.map((r) => r.kind)).toEqual([
      "dream-work-item",
      "dream-work-lease",
      "dream-work-answer",
      "dream-work-applied",
    ]);
  });

  test("a device that never held private shows nothing of it and never takes it", () => {
    // dev-b never held `private`: its copy has no private partition.
    rmSync(join(m.root("dev-b"), "private"), { recursive: true, force: true });
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    const qa = dreamQueueOn(a, { vault: null, writer: "o2b", now });
    const secret = produceWork(qa, spec("secret", ["private"]));
    const open = produceWork(qa, spec("open", ["shared"]));
    m.sync();
    rmSync(join(m.root("dev-b"), "private"), { recursive: true, force: true });
    const b = m.open("dev-b");
    expect(b.partitions.has("private")).toBe(false);
    takeDreamOwner(b, "codex", { ...human, force: false });
    m.sync();
    releaseIfRequested(a, readDreamOwner(a, now), human);
    m.sync();
    rmSync(join(m.root("dev-b"), "private"), { recursive: true, force: true });
    const status = queueStatusAt(m.root("dev-b"), { now: clock });
    expect(status.available).toBe(true);
    if (!status.available) return;
    expect(status.private).toBe("absent");
    expect(status.items.map((i) => i.id)).toEqual([open.id]);
    expect(JSON.stringify(status)).not.toContain("secret");
    const qb = dreamQueueOn(m.open("dev-b"), { vault: null, writer: "o2b", now });
    expect(takeWork(qb, { run: "r1" }).item?.id).toBe(open.id);
    expect(takeWork(qb, { run: "r2" })).toEqual({ item: null, reason: "empty" });
    expect(secret.partition).toBe("private");
  });

  test("a shared item waits behind earlier private work after owner moves to shared-only device", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    const qa = dreamQueueOn(a, { vault: null, writer: "o2b", now });
    const privateItem = produceWork(qa, spec("secret", ["private"], ["rung:fact"]));
    produceWork(qa, spec("public", ["shared"], ["rung:fact"]));
    // Both items share a resource; the private subject is never copied into shared.
    m.sync();
    const privateRecords = readStreamRecords(a.root, "private", { stream: "dream-work" }).records;
    const first = privateRecords.find((record) => record.body["id"] === privateItem.id)!;
    expect(first).toBeDefined();
    rmSync(join(m.root("dev-b"), "private"), { recursive: true, force: true });
    const b = m.open("dev-b");
    takeDreamOwner(b, "codex", { ...human, force: true });
    const qb = dreamQueueOn(b, { vault: null, writer: "o2b", now });
    const shared = readStreamRecords(b.root, "shared", { stream: "dream-work" }).records;
    expect(JSON.stringify(shared)).not.toContain("secret");
    const later = shared.find((record) => record.body["subject"] === "public");
    expect(later?.body["private_resource_barriers"]).toEqual([
      expect.not.stringContaining("rung:fact"),
    ]);
    expect(takeWork(qb, { run: "r1" })).toEqual({ item: null, reason: "empty" });
  });

  test("batch production keeps barriers from queued and earlier batch private work", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    const q = dreamQueueOn(a, { vault: null, writer: "o2b", now });
    produceWork(q, spec("queued-private", ["private"], ["record:r1"]));
    const batch = produceWorkBatch(q, [
      spec("batch-private", ["private"], ["record:r2"]),
      spec("shared-queued-resource", ["shared"], ["record:r1"]),
      spec("shared-batch-resource", ["shared"], ["record:r2"]),
    ]);
    const records = readStreamRecords(a.root, "shared", { stream: "dream-work" }).records;
    const shared = new Map(records.map((record) => [record.body["subject"], record.body]));
    expect(shared.get("shared-queued-resource")?.["private_resource_barriers"]).toHaveLength(1);
    expect(shared.get("shared-batch-resource")?.["private_resource_barriers"]).toHaveLength(1);
    expect(batch.items.map((item) => item.created)).toEqual([true, true, true]);
  });
});

test("a device whose held-partition ledger shows private lost says private work is unknown", () => {
  const store = makeTestStore("osb-dream-queue-lost-");
  try {
    const a = openStore({ root: store.root, device: "dev-a" });
    claimDreamOwner(a, "claude", human);
    claimSettled(a, readDreamOwner(a, now));
    produceWork(dreamQueueOn(a, { vault: null, writer: "o2b", now }), spec("secret", ["private"]));
    renameSync(join(store.root, "private", "store.json"), join(store.root, "private-store.json"));
    const status = queueStatusAt(store.root, { now: clock });
    expect(status.available).toBe(true);
    if (!status.available) return;
    expect(status.private).toBe("unknown");
    expect(status.items).toEqual([]);
    expect(JSON.stringify(status)).not.toContain("secret");
  } finally {
    store.cleanup();
  }
});
