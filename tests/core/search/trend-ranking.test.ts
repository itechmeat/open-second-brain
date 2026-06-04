/**
 * Freshness-trend ranking bias (Time-Aware Recall & Activation Suite,
 * t_ee09a6ce): preference pages stamped with a `freshness_trend` get a
 * bounded multiplier on the relevance portion of their score.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const QUERY = "gearbox lubrication policy";

function trendReason(reasons: ReadonlyArray<string>): string | null {
  return reasons.find((r) => r.startsWith("freshness_trend: ")) ?? null;
}

function prefBody(trend: string | null): string {
  const trendLine = trend === null ? "" : `freshness_trend: ${trend}\n`;
  return (
    `---\nkind: brain-preference\n${trendLine}---\n\n` +
    "# Rule\n\nGearbox lubrication policy applies before deployment.\n"
  );
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("trend-rank"));
});

afterEach(() => {
  cleanup();
});

describe("freshness-trend multiplier", () => {
  test("weakening and stale preferences are demoted below an unstamped twin", async () => {
    writeMd(vault, "Brain/preferences/pref-plain.md", prefBody(null));
    writeMd(vault, "Brain/preferences/pref-weak.md", prefBody("weakening"));
    writeMd(vault, "Brain/preferences/pref-stale.md", prefBody("stale"));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: QUERY, limit: 10 });
    const score = (path: string): number => outcome.results.find((r) => r.path === path)!.score;
    expect(score("Brain/preferences/pref-weak.md")).toBeLessThan(
      score("Brain/preferences/pref-plain.md"),
    );
    expect(score("Brain/preferences/pref-stale.md")).toBeLessThan(
      score("Brain/preferences/pref-weak.md"),
    );
    const weak = outcome.results.find((r) => r.path === "Brain/preferences/pref-weak.md");
    expect(trendReason(weak!.reasons)).toContain("weakening");
  });

  test("a strengthening preference is boosted above an unstamped twin", async () => {
    writeMd(vault, "Brain/preferences/pref-plain.md", prefBody(null));
    writeMd(vault, "Brain/preferences/pref-strong.md", prefBody("strengthening"));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: QUERY, limit: 10 });
    const strong = outcome.results.find((r) => r.path === "Brain/preferences/pref-strong.md");
    const plain = outcome.results.find((r) => r.path === "Brain/preferences/pref-plain.md");
    expect(strong!.score).toBeGreaterThan(plain!.score);
    expect(trendReason(strong!.reasons)).toContain("strengthening");
  });

  test("stable and new trends stay neutral, as do non-preference pages", async () => {
    writeMd(vault, "Brain/preferences/pref-stable.md", prefBody("stable"));
    writeMd(
      vault,
      "Brain/notes/imposter.md",
      "---\nfreshness_trend: stale\n---\n\n# Note\n\nGearbox lubrication policy memo.\n",
    );
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.every((r) => trendReason(r.reasons) === null)).toBe(true);
  });
});
