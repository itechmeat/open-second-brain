import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { DREAM_HISTORY_SEEDS, runDreamHistory } from "../../helpers/dream-history.ts";

const baselinePath = join(import.meta.dir, "../../fixtures/dream-history/baseline.json");

describe("generated dream histories", () => {
  test("daily passes reproduce the committed baseline for every seed", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      readonly hashes: Readonly<Record<string, string>>;
      readonly readableSeed: number;
      readonly readableDump: string;
    };

    expect(Object.keys(baseline.hashes).map(Number)).toEqual([...DREAM_HISTORY_SEEDS]);
    for (const seed of Object.keys(baseline.hashes).map(Number)) {
      const result = runDreamHistory(seed);
      const expectedHash = baseline.hashes[String(seed)];
      if (expectedHash === undefined) throw new Error(`missing baseline hash for seed ${seed}`);
      expect(result.hash).toBe(expectedHash);
      if (seed === baseline.readableSeed) expect(result.dump).toBe(baseline.readableDump);
    }
  }, 30_000);
});
