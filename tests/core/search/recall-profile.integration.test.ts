/**
 * Selectable recall profiles end-to-end through `search()` (Recall &
 * Working-Memory Quality Suite, t_98c39dd6 profile-half).
 *
 * A profile resolves to the same knob tuple the self-tuning grid ranges
 * over and is applied through `applyTunedParameters`. The observable
 * signal here is traversal depth (`maxHops`): `fast` is single-hop,
 * `thorough` is two-hop, so a note two links away from the query anchor
 * is reached under `thorough` but not under `fast`. An explicitly
 * selected profile takes precedence over a persisted self-tuning grid
 * point; an unknown profile fails loud before any store I/O.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { TUNING_SCHEMA_VERSION } from "../../../src/core/search/tuning-store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const QUERY = "lattice resonance survey";
const FAR = "Brain/notes/far.md";

/**
 * anchor (matches the query) -> mid -> far. `far` shares no query terms,
 * so it can only surface via two hops of link traversal.
 */
async function seedChain(): Promise<void> {
  // Wikilink targets are full vault-relative paths so they resolve to the
  // linked document (the store resolves links by exact path equality).
  writeMd(
    vault,
    "Brain/notes/anchor.md",
    "# Anchor\n\nLattice resonance survey anchor. See [[Brain/notes/mid.md|mid]].\n",
  );
  writeMd(vault, "Brain/notes/mid.md", "# Mid\n\nBridge node. See [[Brain/notes/far.md|far]].\n");
  writeMd(vault, "Brain/notes/far.md", "# Far\n\nDistant unrelated cartography.\n");
  const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
  await indexVault(config);
}

function persistTunedDepthOne(): void {
  const dir = join(vault, "Brain", "search");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tuning.json"),
    JSON.stringify({
      schema: TUNING_SCHEMA_VERSION,
      chosen: {
        poolMultiplier: 5,
        traversalDepth: 1,
        learnedWeights: false,
        expansion: false,
      },
      evaluated: [],
      dataset_hash: "deadbeef",
      evaluated_at: "2026-06-14T00:00:00.000Z",
    }) + "\n",
  );
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("recall-profile"));
});

afterEach(() => {
  cleanup();
});

describe("recall profiles through search()", () => {
  test("the three profile names are all accepted and return the anchor hit", async () => {
    await seedChain();
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    const outcomes = await Promise.all(
      ["fast", "balanced", "thorough"].map((profile) =>
        search(config, { query: QUERY, limit: 10, profile }),
      ),
    );
    for (const outcome of outcomes) {
      expect(outcome.results.some((r) => r.path === "Brain/notes/anchor.md")).toBe(true);
    }
  });

  test("thorough (two-hop) reaches a note fast (one-hop) cannot", async () => {
    await seedChain();
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    const fast = await search(config, { query: QUERY, limit: 10, profile: "fast" });
    const thorough = await search(config, { query: QUERY, limit: 10, profile: "thorough" });
    expect(fast.results.some((r) => r.path === FAR)).toBe(false);
    expect(thorough.results.some((r) => r.path === FAR)).toBe(true);
  });

  test("an explicit profile takes precedence over a persisted self-tuning grid point", async () => {
    await seedChain();
    persistTunedDepthOne();
    // Self-tuning is armed and the persisted grid point is depth-1, but the
    // explicit thorough profile (depth-2) must win, so far is still reached.
    const config = makeConfig({ vault, dbPath, mmrLambda: 1, selfTuningEnabled: true });
    const outcome = await search(config, { query: QUERY, limit: 10, profile: "thorough" });
    expect(outcome.results.some((r) => r.path === FAR)).toBe(true);
  });

  test("with no profile and self-tuning off, the far note stays unreached (byte-identical default)", async () => {
    await seedChain();
    // Default maxHops in the fixture is 1, so the two-hop far note is out of
    // reach when no profile widens traversal - the unchanged baseline.
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.some((r) => r.path === FAR)).toBe(false);
  });

  test("an unknown profile fails loud with a typed SearchError", async () => {
    await seedChain();
    const config = makeConfig({ vault, dbPath, mmrLambda: 1 });
    await expect(search(config, { query: QUERY, limit: 10, profile: "turbo" })).rejects.toThrow(
      SearchError,
    );
  });
});
