/**
 * Seeded LongMemEval sampling (wiring-shipped-seams wave, t_4501c662):
 * abstention exclusion before selection, question-type strata with
 * largest-remainder apportionment, and a determinism contract - the
 * same seed and cap select the same subset on every call, dataset file
 * order cannot change it, and no clock or ambient randomness exists.
 */

import { describe, expect, test } from "bun:test";

import {
  LONGMEMEVAL_ABSTENTION_TYPE,
  LongMemEvalSampleError,
  isLongMemEvalAbstention,
  sampleLongMemEvalEntries,
  type LongMemEvalSampleEntry,
} from "../../../src/core/bench/longmemeval-sample.ts";

/** A minimal entry shaped the way the sampler reads it. */
function sampleEntry(qId: string, questionType: string): LongMemEvalSampleEntry {
  return { q_id: qId, question_type: questionType };
}

/** Three strata of four, so apportionment has remainders to work with. */
function population(): LongMemEvalSampleEntry[] {
  const entries: LongMemEvalSampleEntry[] = [];
  for (const stratum of ["a", "b", "c"]) {
    for (let i = 1; i <= 4; i += 1) {
      entries.push(sampleEntry(`${stratum}-${i}`, `type-${stratum}`));
    }
  }
  return entries;
}

test("the abstention rule keeps both spellings: the explicit type and the official id suffix", () => {
  expect(isLongMemEvalAbstention(sampleEntry("q1", LONGMEMEVAL_ABSTENTION_TYPE))).toBe(true);
  expect(isLongMemEvalAbstention(sampleEntry("official_abs", "single-hop"))).toBe(true);
  expect(isLongMemEvalAbstention(sampleEntry("q1", "single-hop"))).toBe(false);
  expect(isLongMemEvalAbstention(sampleEntry("absurd", "single-hop"))).toBe(false);
});

test("abstention entries are excluded before selection and the count flows through", () => {
  const entries = [
    sampleEntry("q-keep", "single-hop"),
    sampleEntry("abs-explicit", "abstention"),
    sampleEntry("official_abs", "single-hop"),
    sampleEntry("q-keep-2", "multi-hop"),
  ];
  const { entries: selected, receipt } = sampleLongMemEvalEntries(entries, {
    seed: "seed-1",
    cap: 10,
  });
  expect(selected.map((e) => e.q_id).toSorted()).toEqual(["q-keep", "q-keep-2"]);
  expect(receipt.abstention_excluded).toBe(2);
  expect(receipt.population).toBe(2);
  expect(receipt.selected).toBe(2);
});

test("strata are the distinct present question_type values, sorted ascending", () => {
  const entries = [
    sampleEntry("q1", "temporal-reasoning"),
    sampleEntry("q2", "single-hop"),
    sampleEntry("q3", "temporal-reasoning"),
  ];
  const { receipt } = sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 3 });
  expect(receipt.strata).toEqual([
    { question_type: "single-hop", population: 1, selected: 1 },
    { question_type: "temporal-reasoning", population: 2, selected: 2 },
  ]);
});

test("the cap is apportioned by largest remainder and its sum is exact", () => {
  // Populations 1/2/4 over a total of 7 with cap 3: quotas 3/7, 6/7 and
  // 12/7 leave bases 0/0/1 and 2 surplus seats for the two largest
  // fractional remainders (beta .857, gamma .714) - alpha's .429 buys
  // nothing.
  const entries = [
    sampleEntry("a-1", "alpha"),
    sampleEntry("b-1", "beta"),
    sampleEntry("b-2", "beta"),
    sampleEntry("c-1", "gamma"),
    sampleEntry("c-2", "gamma"),
    sampleEntry("c-3", "gamma"),
    sampleEntry("c-4", "gamma"),
  ];
  const { entries: selected, receipt } = sampleLongMemEvalEntries(entries, {
    seed: "seed-1",
    cap: 3,
  });
  expect(selected).toHaveLength(3);
  expect(receipt.selected).toBe(3);
  expect(receipt.strata).toEqual([
    { question_type: "alpha", population: 1, selected: 0 },
    { question_type: "beta", population: 2, selected: 1 },
    { question_type: "gamma", population: 4, selected: 2 },
  ]);
});

test("remainder ties break by stratum name ascending", () => {
  // Two strata of 2 with cap 1: both quotas are 0.5, so the one surplus
  // seat goes to the lexicographically first stratum.
  const entries = [
    sampleEntry("b-1", "beta"),
    sampleEntry("b-2", "beta"),
    sampleEntry("a-1", "alpha"),
    sampleEntry("a-2", "alpha"),
  ];
  const { receipt } = sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 1 });
  expect(receipt.strata).toEqual([
    { question_type: "alpha", population: 2, selected: 1 },
    { question_type: "beta", population: 2, selected: 0 },
  ]);
});

test("mathematically equal remainders tie exactly, so the name tie-break applies", () => {
  // The reviewer's case (pr-251 L1): total 6, cap 2. The fractional
  // remainder of pop 4 is 8/6 - 1 and of pop 1 is 2/6 - 0; both are
  // mathematically 1/3, but as doubles they differ (pop 1 computes
  // 0.3333333333333333, pop 4 computes 0.33333333333333326), so a float
  // comparison hands the surplus seat to beta and the documented name
  // tie-break never applies. The remainders are compared as integers
  // ((cap*pop) mod total): all three strata tie at 2 and the seat goes
  // to the lexicographically first stratum, whose quota (4/3) leaves it
  // one seat short of its population.
  const entries = [
    sampleEntry("a-1", "alpha"),
    sampleEntry("a-2", "alpha"),
    sampleEntry("a-3", "alpha"),
    sampleEntry("a-4", "alpha"),
    sampleEntry("b-1", "beta"),
    sampleEntry("c-1", "gamma"),
  ];
  const { receipt } = sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 2 });
  expect(receipt.strata).toEqual([
    { question_type: "alpha", population: 4, selected: 2 },
    { question_type: "beta", population: 1, selected: 0 },
    { question_type: "gamma", population: 1, selected: 0 },
  ]);
  expect(receipt.selected).toBe(2);
});

test("the same seed and cap select the same subset on every call", () => {
  const entries = population();
  const first = sampleLongMemEvalEntries(entries, { seed: "run-9", cap: 4 });
  const second = sampleLongMemEvalEntries(entries, { seed: "run-9", cap: 4 });
  expect(first.entries.map((e) => e.q_id)).toEqual(second.entries.map((e) => e.q_id));
  // The module takes no clock and draws no ambient randomness, so the
  // result is a pure function of (entries, seed, cap) - repeated here
  // after the first call consumed the PRNG stream.
  const third = sampleLongMemEvalEntries(entries.toReversed(), { seed: "run-9", cap: 4 });
  expect(third.entries.map((e) => e.q_id)).toEqual(first.entries.map((e) => e.q_id));
});

test("a different seed selects a different subset at the same cap", () => {
  const entries = population();
  const bySeed = sampleLongMemEvalEntries(entries, { seed: "run-9", cap: 4 });
  const otherSeed = sampleLongMemEvalEntries(entries, { seed: "run-10", cap: 4 });
  expect(otherSeed.entries.map((e) => e.q_id)).not.toEqual(bySeed.entries.map((e) => e.q_id));
});

test("the seed is normalized once, in the sampler: padded input selects the bare subset", () => {
  // pr-251 L2: the CLI used to trim --sample-seed while the API path
  // hashed the seed as given, so the same input produced different
  // subsets depending on the surface. The sampler trims before hashing
  // - the one normalization point - so padded and bare input select the
  // identical subset.
  const entries = population();
  const bare = sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 4 });
  const padded = sampleLongMemEvalEntries(entries, { seed: "  seed-1\t", cap: 4 });
  expect(padded.entries.map((e) => e.q_id)).toEqual(bare.entries.map((e) => e.q_id));
  expect(padded.receipt).toEqual(bare.receipt);
});

test("a different cap selects a different subset at the same seed", () => {
  const entries = population();
  const byCap = sampleLongMemEvalEntries(entries, { seed: "run-9", cap: 4 });
  const smallerCap = sampleLongMemEvalEntries(entries, { seed: "run-9", cap: 3 });
  expect(smallerCap.entries).toHaveLength(3);
  expect(smallerCap.entries.map((e) => e.q_id)).not.toEqual(byCap.entries.map((e) => e.q_id));
});

test("dataset file order cannot change the selected subset", () => {
  const entries = population();
  const inOrder = sampleLongMemEvalEntries(entries, { seed: "order", cap: 5 });
  const ids = inOrder.entries.map((e) => e.q_id);
  expect(sampleLongMemEvalEntries(entries.toReversed(), { seed: "order", cap: 5 }).entries).toEqual(
    inOrder.entries,
  );
  const rotated = [...entries.slice(5), ...entries.slice(0, 5)];
  expect(
    sampleLongMemEvalEntries(rotated, { seed: "order", cap: 5 }).entries.map((e) => e.q_id),
  ).toEqual(ids);
});

test("a cap at or above the population selects everyone", () => {
  const entries = [...population(), sampleEntry("abs-1", "abstention")];
  for (const cap of [12, 50]) {
    const { entries: selected, receipt } = sampleLongMemEvalEntries(entries, {
      seed: "seed-1",
      cap,
    });
    expect(selected).toHaveLength(12);
    expect(receipt.selected).toBe(12);
    expect(receipt.population).toBe(12);
    // The clamped cap lands in the receipt too: every stratum reports
    // exactly its own population - never the raw apportionment of an
    // unclamped cap, which at cap 50 would report 17 selected in a
    // stratum of 4 - and the per-stratum selections sum to the
    // population.
    expect(receipt.strata).toEqual([
      { question_type: "type-a", population: 4, selected: 4 },
      { question_type: "type-b", population: 4, selected: 4 },
      { question_type: "type-c", population: 4, selected: 4 },
    ]);
    expect(receipt.strata.reduce((sum, stratum) => sum + stratum.selected, 0)).toBe(12);
  }
});

test("selected entries come back in canonical question-id order", () => {
  const { entries: selected } = sampleLongMemEvalEntries(population(), {
    seed: "order-out",
    cap: 7,
  });
  const ids = selected.map((e) => e.q_id);
  expect(ids).toEqual(ids.toSorted());
});

test("a population of only abstention entries is a named error", () => {
  const entries = [sampleEntry("x_abs", "single-hop"), sampleEntry("y", "abstention")];
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 2 })).toThrow(
    LongMemEvalSampleError,
  );
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 2 })).toThrow(/abstention/);
});

test("an empty population is a named error", () => {
  expect(() => sampleLongMemEvalEntries([], { seed: "seed-1", cap: 2 })).toThrow(
    LongMemEvalSampleError,
  );
});

test("malformed options are refused by name", () => {
  const entries = population();
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 0 })).toThrow(
    LongMemEvalSampleError,
  );
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 1.5 })).toThrow(/cap/);
  expect(() => sampleLongMemEvalEntries(entries, { seed: "", cap: 2 })).toThrow(/seed/);
  expect(() => sampleLongMemEvalEntries(entries, { seed: "   ", cap: 2 })).toThrow(/seed/);
});

test("a duplicated question id is a named error, before any order-dependent step", () => {
  const entries = [...population(), sampleEntry("a-1", "type-a")];
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 4 })).toThrow(
    LongMemEvalSampleError,
  );
  expect(() => sampleLongMemEvalEntries(entries, { seed: "seed-1", cap: 4 })).toThrow(
    /'a-1' appears twice/,
  );
});

test("the sampler is pure: same inputs, same outputs, no input mutation", () => {
  const entries = population();
  const snapshot = entries.map((e) => e.q_id);
  const first = sampleLongMemEvalEntries(entries, { seed: "pure", cap: 6 });
  const second = sampleLongMemEvalEntries(entries, { seed: "pure", cap: 6 });
  expect(first.entries.map((e) => e.q_id)).toEqual(second.entries.map((e) => e.q_id));
  expect(entries.map((e) => e.q_id)).toEqual(snapshot);
});

describe("receipt fragment", () => {
  test("per-stratum population and selected counts are carried beside the totals", () => {
    const { receipt } = sampleLongMemEvalEntries(population(), { seed: "receipt", cap: 5 });
    expect(receipt.strata).toEqual([
      { question_type: "type-a", population: 4, selected: 2 },
      { question_type: "type-b", population: 4, selected: 2 },
      { question_type: "type-c", population: 4, selected: 1 },
    ]);
    expect(receipt.population).toBe(12);
    expect(receipt.selected).toBe(5);
    expect(receipt.abstention_excluded).toBe(0);
  });
});
