/**
 * The dream pass's store-only signal moves are batched
 * (`writeStoreSignalStates`): one `appendRecords` batch per partition per
 * batch of signals, each record placed by its signal's privacy,
 * and a batch that fails leaves its signals live, so a rerun writes only
 * those, with no duplicate record.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { writeSignal } from "../../../src/core/brain/signal.ts";
import { writeStoreSignalStates } from "../../../src/core/brain/signal-state.ts";
import * as appender from "../../../src/core/store/appender.ts";
import { SIGNAL_STATE_KIND } from "../../../src/core/store/fold-signals.ts";
import { holdStoreEntities } from "../../../src/core/store/read/store-entities.ts";
import { readSignals } from "../../../src/core/store/read/signals.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";

/** A small batch: the batching is the property, not the production size. */
const BATCH = 4;

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function signals(e: StoreEnv, count: number): string[] {
  return Array.from(
    { length: count },
    (_, n) =>
      writeSignal(e.vault, {
        topic: `t${n}`,
        signal: "positive" as const,
        agent: "claude",
        principle: n === 0 ? "see <private>the secret</private>" : `Principle ${n}`,
        created_at: "2026-11-06T10:00:00Z",
        date: "2026-11-06",
        slug: `batch-${n}`,
      }).id,
  );
}

function stateRecords(e: StoreEnv, partition: "shared" | "private"): string[] {
  return partitionRecords(e.storeRoot, partition)
    .filter((r) => r.kind === SIGNAL_STATE_KIND)
    .map((r) => String(r.body["signal"]));
}

describe("batched store-only signal moves", () => {
  test("one append per partition per batch, each record where its signal lives", () => {
    env = makeStoreEnv("osb-signal-batch-", { dualWrite: false });
    switchDevice(env.storeRoot);
    const ids = signals(env, BATCH + 3);
    const calls = spyOn(appender, "appendRecords");
    let result: ReturnType<typeof writeStoreSignalStates>;
    try {
      result = writeStoreSignalStates({
        vault: env.vault,
        moves: ids.map((id) => ({ id, state: "consumed" as const })),
        authority: "agent",
        held: holdStoreEntities(),
        batchSize: BATCH,
      });
      // The first batch: one shared append and one private (the secret);
      // the second: one shared append.
      expect(calls).toHaveBeenCalledTimes(3);
    } finally {
      calls.mockRestore();
    }
    expect(result.failed).toEqual([]);
    expect([...result.written].toSorted()).toEqual([...ids].toSorted());
    expect(stateRecords(env, "private")).toEqual([ids[0]!]);
    expect(stateRecords(env, "shared").toSorted()).toEqual(ids.slice(1).toSorted());
    expect(readSignals({ vault: env.vault }).every((s) => s.state === "consumed")).toBe(true);
  });

  test("a failed batch leaves its signals live, and a rerun writes them once", () => {
    env = makeStoreEnv("osb-signal-batch-", { dualWrite: false });
    switchDevice(env.storeRoot);
    const ids = signals(env, BATCH + 3).slice(1);
    const real = appender.appendRecords;
    let call = 0;
    const spy = spyOn(appender, "appendRecords").mockImplementation((...args) => {
      call += 1;
      if (call === 2) throw new Error("injected append failure");
      return real(...args);
    });
    let first: ReturnType<typeof writeStoreSignalStates>;
    try {
      first = writeStoreSignalStates({
        vault: env.vault,
        moves: ids.map((id) => ({ id, state: "archived" as const })),
        authority: "agent",
        held: holdStoreEntities(),
        batchSize: BATCH,
      });
    } finally {
      spy.mockRestore();
    }
    expect(first.written).toHaveLength(BATCH);
    expect(first.failed).toHaveLength(ids.length - BATCH);
    // The rerun, as the dream pass makes it: only the signals still live.
    const held = holdStoreEntities();
    const live = ids.filter((id) => held.current()?.signals.get(id)?.state === "active");
    expect(live.toSorted()).toEqual(first.failed.map((f) => f.id).toSorted());
    const second = writeStoreSignalStates({
      vault: env.vault,
      moves: live.map((id) => ({ id, state: "archived" as const })),
      authority: "agent",
      held,
      batchSize: BATCH,
    });
    expect(second.failed).toEqual([]);
    const written = stateRecords(env, "shared");
    expect(written).toHaveLength(ids.length);
    expect(new Set(written).size).toBe(ids.length);
  });
});
