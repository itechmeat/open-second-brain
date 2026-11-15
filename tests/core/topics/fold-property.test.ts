/**
 * Property tests of the topic fold (task 3.1): for random topic record
 * sets from several devices (creates, renames, goals, statuses, items and
 * their removals, completions, assignments, merges, splits, links and
 * undos of earlier records), every delivery a file-sync tool can produce
 * folds to exactly the state of the complete set. Each seed is
 * reproducible.
 */
import { describe, expect, test } from "bun:test";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { pick, rec, seededRandom, seededUlid, shuffled } from "../store/fixtures/fold-records.ts";

const T = Date.UTC(2026, 10, 6, 12, 0, 0);
const DEVICES = ["dev-a", "dev-b", "dev-c"];
const AUTHORITIES = ["human", "agent", "agent", "model"] as const;
const idRng = seededRandom(99);
const TOPICS = [0, 1, 2].map((i) => seededUlid(idRng, T - 1000 + i));
const ITEMS = ["i1", "i2", "i3", "i4"];
const ITEM_KINDS = ["decision", "open-question", "log-entry", "milestone"] as const;
const RECORDS = [0, 1].map((i) => seededUlid(idRng, T - 500 + i));

function randomBody(
  rng: () => number,
  written: ReadonlyArray<string>,
): { kind: string; body: Record<string, unknown> } {
  const authority = pick(rng, AUTHORITIES);
  const other = pick(rng, TOPICS);
  const roll = rng();
  const body = (kind: string, rest: Record<string, unknown>) => ({
    kind,
    body: { authority, ...rest },
  });
  if (roll < 0.12)
    return body("topic-create", { title: `t-${Math.floor(rng() * 4)}`, scope: "project:x" });
  if (roll < 0.2) return body("topic-rename", { title: `r-${Math.floor(rng() * 4)}` });
  if (roll < 0.27)
    return body("topic-goal", { goal: rng() < 0.2 ? null : `g-${Math.floor(rng() * 4)}` });
  if (roll < 0.33)
    return body("topic-status", { status: pick(rng, ["active", "done", "on-hold"]) });
  if (roll < 0.55) {
    const kind = pick(rng, ITEM_KINDS);
    const item = pick(rng, ITEMS);
    if (rng() < 0.15) return body(kind, { item, removed: true });
    return body(kind, {
      item,
      text: `x-${Math.floor(rng() * 4)}`,
      ...(kind === "log-entry" ? { class: pick(rng, ["blocker", "routine"]) } : {}),
    });
  }
  if (roll < 0.6)
    return body("milestone-done", {
      milestone: pick(rng, ITEMS),
      ...(rng() < 0.5 ? { evidence: "ci" } : {}),
    });
  if (roll < 0.64) return body("question-resolved", { question: pick(rng, ITEMS) });
  if (roll < 0.7) return body("assign", { record: pick(rng, RECORDS) });
  if (roll < 0.73) return body("unassign", { record: pick(rng, RECORDS) });
  if (roll < 0.78) return body("merge", { into: other });
  if (roll < 0.81) return body("split", { into: other, items: [pick(rng, ITEMS)] });
  if (roll < 0.86) return body("link", { to: other, ...(rng() < 0.3 ? { removed: true } : {}) });
  if (roll < 0.97 && written.length > 0) return body("undo", { record: pick(rng, written) });
  // A malformed record: rejected the same way in every delivery.
  return body("topic-status", { status: "sideways" });
}

/** One shard per device, records in the order the device wrote them. */
function randomShards(rng: () => number): StoreRecord[][] {
  const written: string[] = [];
  return DEVICES.map((device) => {
    const records: StoreRecord[] = [];
    let physical = T;
    let counter = 0;
    const count = 15 + Math.floor(rng() * 30);
    for (let i = 0; i < count; i++) {
      const step = Math.floor(rng() * 3);
      if (step === 0) counter += 1;
      else {
        physical += step;
        counter = 0;
      }
      const record = rec({
        device,
        physical,
        counter,
        rng,
        topic: pick(rng, TOPICS),
        ...randomBody(rng, written),
      });
      written.push(record.id);
      records.push(record);
    }
    return records;
  });
}

function state(records: ReadonlyArray<StoreRecord>): unknown {
  const fold = foldTopics(records);
  return {
    topics: [...fold.topics.values()].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    canonical: TOPICS.map((t) => fold.canonical(t)),
    assignments: [...fold.assignments].toSorted(),
    blocked: [...fold.blockedRoutes].toSorted(),
    voided: [...fold.voided].toSorted(),
    rejected: fold.rejected.map((r) => r.id).toSorted(),
  };
}

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

describe("topic fold properties", () => {
  test("the generated sets exercise items, merges, assignments, undos and rejections", () => {
    const folds = SEEDS.map((seed) => foldTopics(randomShards(seededRandom(seed)).flat()));
    const topics = folds.flatMap((f) => [...f.topics.values()]);
    expect(topics.some((t) => t.items.length > 0)).toBe(true);
    expect(topics.some((t) => t.mergedInto !== null)).toBe(true);
    expect(topics.some((t) => t.items.some((i) => i.done !== undefined))).toBe(true);
    expect(folds.some((f) => f.assignments.size > 0 && f.voided.size > 0)).toBe(true);
    expect(folds.some((f) => f.blockedRoutes.size > 0 && f.rejected.length > 0)).toBe(true);
  });

  test.each(SEEDS)("seed %i: shards delivered in any device order fold the same", (seed) => {
    const rng = seededRandom(seed);
    const shards = randomShards(rng);
    const expected = state(shards.flat());
    for (let round = 0; round < 3; round++) {
      expect(state(shuffled(rng, shuffled(rng, shards).flat()))).toEqual(expected);
    }
  });

  test.each(SEEDS)("seed %i: duplicated lines in a shuffled delivery are applied once", (seed) => {
    const rng = seededRandom(1000 + seed);
    const all = randomShards(rng).flat();
    const expected = state(all);
    const duplicates = all.filter(() => rng() < 0.3);
    expect(state(shuffled(rng, [...all, ...duplicates, ...duplicates]))).toEqual(expected);
  });

  test.each(SEEDS)(
    "seed %i: a partial delivery read again beside the full one folds the same",
    (seed) => {
      const rng = seededRandom(2000 + seed);
      const shards = randomShards(rng);
      const expected = state(shards.flat());
      const partial = shards.map((shard) => shard.slice(0, Math.floor(rng() * shard.length)));
      expect(state([...partial.flat(), ...shuffled(rng, shards).flat()])).toEqual(expected);
    },
  );
});
