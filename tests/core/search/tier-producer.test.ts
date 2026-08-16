/**
 * The tier producer (a-label-is-not-a-boundary, U4).
 *
 * `tier:` shipped as a documented, hand-editable frontmatter knob with a
 * ranker input (`tierByDoc`), a weight table and a breakdown line - and no
 * producer. Nothing in the pipeline populated the map, so a page stamped
 * `tier: peripheral` scored bit-identically to an untagged one: the label
 * named a boundary and nothing stood behind it.
 *
 * These tests drive the SHIPPED search entry point rather than the ranker
 * directly. `tests/core/search/ranker-tier.test.ts` already proves the
 * ranker honours a hand-supplied map, which is exactly the assertion that
 * passed while the knob did nothing.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const QUERY = "gearbox lubrication policy";

/** One page body, identical but for the tier stamp, so tier is the only variable. */
function pageBody(tier: string | null): string {
  const tierLine = tier === null ? "" : `tier: ${tier}\n`;
  return `---\n${tierLine}---\n\n# Policy\n\nGearbox lubrication policy applies before deployment.\n`;
}

function tierReason(reasons: ReadonlyArray<string>): string | null {
  return reasons.find((r) => r.startsWith("tier: ")) ?? null;
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("tier-producer"));
});

afterEach(() => {
  cleanup();
});

describe("tier reaches the ranker from frontmatter", () => {
  test("core outranks untagged, which outranks peripheral", async () => {
    writeMd(vault, "notes/core.md", pageBody("core"));
    writeMd(vault, "notes/plain.md", pageBody(null));
    writeMd(vault, "notes/peripheral.md", pageBody("peripheral"));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);

    const outcome = await search(config, { query: QUERY, limit: 10 });
    const score = (path: string): number => outcome.results.find((r) => r.path === path)!.score;
    expect(score("notes/core.md")).toBeGreaterThan(score("notes/plain.md"));
    expect(score("notes/peripheral.md")).toBeLessThan(score("notes/plain.md"));
  });

  test("the breakdown names the tier multiplier that moved the score", async () => {
    writeMd(vault, "notes/peripheral.md", pageBody("peripheral"));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);

    const outcome = await search(config, { query: QUERY, limit: 10 });
    const row = outcome.results.find((r) => r.path === "notes/peripheral.md");
    expect(row).toBeDefined();
    // Before the producer existed this read `tier: 1` at best, and in
    // practice was absent entirely because the multiplier never moved.
    expect(tierReason(row!.reasons)).not.toBeNull();
  });

  test("an untagged vault ranks exactly as it did before tiers had a producer", async () => {
    // The non-regression anchor: `supporting` is the identity weight, so a
    // vault that never stamped a tier must produce no tier layer at all -
    // not a layer that happens to multiply by one.
    writeMd(vault, "notes/a.md", pageBody(null));
    writeMd(vault, "notes/b.md", pageBody(null));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);

    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.every((r) => tierReason(r.reasons) === null)).toBe(true);
  });

  test("an unrecognised tier value stays at the default rather than demoting the page", async () => {
    // `readTier` folds a typo back to the default; the producer must not
    // turn that into an omission that reads as a distinct tier.
    writeMd(vault, "notes/typo.md", pageBody("cor"));
    writeMd(vault, "notes/plain.md", pageBody(null));
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);

    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.every((r) => tierReason(r.reasons) === null)).toBe(true);
  });
});
