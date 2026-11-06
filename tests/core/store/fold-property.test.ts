/**
 * Property tests of the folds (task 1.6): for random record sets from
 * several devices, every delivery a file-sync tool can produce (shards in
 * any order, lines delivered twice, partial shards completed later) folds
 * to exactly the state of the complete set. Each seed is reproducible.
 */
import { describe, expect, test } from "bun:test";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldPinned, pinnedFingerprint } from "../../../src/core/store/fold-pinned.ts";
import {
  foldPreferences,
  preferencesFingerprint,
} from "../../../src/core/store/fold-preferences.ts";
import { foldSettings, settingsFingerprint } from "../../../src/core/store/fold-settings.ts";
import { authored, pick, rec, seededRandom, shuffled } from "./fixtures/fold-records.ts";

const T = Date.UTC(2026, 10, 6, 12, 0, 0);
const DEVICES = ["dev-a", "dev-b", "dev-c"];
const AUTHORITIES = ["human", "agent", "agent", "model"] as const;
const PREFS = ["p1", "p2", "p3"];
const FIELDS = ["principle", "status", "scope", "applied_count"];
const SETTINGS: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = [
  ["topics.new_min_records", [1, 3, 8, 0]],
  ["view.language", ["en", "ru", "not a tag"]],
  ["view.writer", ["dev-a", "dev-b"]],
  ["future.knob", [true, { n: 1 }]],
];

function randomBody(rng: () => number): { kind: string; body: Record<string, unknown> } {
  const authority = rng() < 0.05 ? undefined : pick(rng, AUTHORITIES);
  const withAuthority = (body: Record<string, unknown>) =>
    authority === undefined ? body : authored(authority, body);
  const roll = rng();
  if (roll < 0.25) {
    const fields: Record<string, unknown> = {};
    for (const field of FIELDS)
      if (rng() < 0.5) fields[field] = `${field}-${Math.floor(rng() * 4)}`;
    return {
      kind: "preference-set",
      body: withAuthority({ preference: pick(rng, PREFS), fields }),
    };
  }
  if (roll < 0.32)
    return { kind: "preference-remove", body: withAuthority({ preference: pick(rng, PREFS) }) };
  if (roll < 0.5) {
    return {
      kind: "preference-evidence",
      body: {
        preference: pick(rng, PREFS),
        result: pick(rng, ["applied", "violated", "outdated"]),
      },
    };
  }
  if (roll < 0.62)
    return { kind: "pinned-set", body: withAuthority({ content: `pin-${Math.floor(rng() * 5)}` }) };
  if (roll < 0.67) return { kind: "pinned-clear", body: withAuthority({}) };
  const [key, values] = pick(rng, SETTINGS);
  if (roll < 0.92)
    return { kind: "setting-set", body: withAuthority({ key, value: pick(rng, values) }) };
  return { kind: "setting-unset", body: withAuthority({ key }) };
}

/** One shard per device, records in the order the device wrote them. */
function randomShards(rng: () => number): StoreRecord[][] {
  return DEVICES.map((device) => {
    const records: StoreRecord[] = [];
    let physical = T;
    let counter = 0;
    const count = 10 + Math.floor(rng() * 30);
    for (let i = 0; i < count; i++) {
      // Small steps so devices often share a millisecond and stamps tie.
      const step = Math.floor(rng() * 3);
      if (step === 0) counter += 1;
      else {
        physical += step;
        counter = 0;
      }
      records.push(rec({ device, physical, counter, rng, ...randomBody(rng) }));
    }
    return records;
  });
}

function state(records: ReadonlyArray<StoreRecord>): unknown {
  const preferences = foldPreferences(records);
  const pinned = foldPinned(records);
  return {
    preferences: preferencesFingerprint(preferences),
    preferenceHistory: [...preferences.preferences.values()].map((p) => p.history.map((r) => r.id)),
    pinned: pinnedFingerprint(pinned),
    pinnedHistory: pinned.history.map((e) => e.record.id),
    settings: settingsFingerprint(foldSettings(records)),
  };
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

describe("fold properties", () => {
  test.each(SEEDS)("seed %i: shards delivered in any device order fold the same", (seed) => {
    const rng = seededRandom(seed);
    const shards = randomShards(rng);
    const expected = state(shards.flat());
    for (let round = 0; round < 3; round++) {
      expect(state(shuffled(rng, shards).flat())).toEqual(expected);
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
    "seed %i: a prefix read again beside the complete shards folds to the full state",
    (seed) => {
      const rng = seededRandom(2000 + seed);
      const shards = randomShards(rng);
      const expected = state(shards.flat());
      // A prefix of each shard (what a sync still in flight delivered) read
      // again together with the complete shards, in any order.
      const partial = shards.map((shard) => shard.slice(0, Math.floor(rng() * shard.length)));
      expect(state([...partial.flat(), ...shuffled(rng, shards).flat()])).toEqual(expected);
    },
  );
});
