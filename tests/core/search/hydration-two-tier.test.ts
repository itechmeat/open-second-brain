/**
 * Two-tier hydration (recall-quality, task C5).
 *
 * The candidate pool used to hydrate EVERY candidate's full `c.content`
 * before any ranking, while content is only ever consumed by rows that
 * survive into the ranked pool (the result stamp, MMR tokenization, the
 * relevance/cross-encoder reranks). The cut:
 *
 *   - the POOL hydrates metadata-only (`hydrateChunkRefs`: no `c.content`
 *     in the projection - scoring reads ids, paths, hashes, mtimes and
 *     authored instants, never bodies);
 *   - the CONTENT hydrates for the ranked rows only - bounded by the rank
 *     cap, not the pool - before the first content consumer (MMR) inside
 *     the assembly, so the answer is byte-identical: same content, same
 *     scores, same order.
 *
 * The byte-identity is EXECUTED here, not asserted from a snapshot: the
 * same fixture is searched twice, once with the pool hydration swapped for
 * the full-content form (pre-cut behaviour), once as shipped, and the two
 * outcome shapes must be deep-equal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import type { SearchOutcome } from "../../../src/core/search/types.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { hydrateChunkRefs } from "../../../src/core/search/store/chunks.ts";
import { Database } from "bun:sqlite";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("hydration-two-tier"));
});
afterEach(() => cleanup());

/** A doc whose body matches the shared term, with per-doc filler text. */
function doc(name: string, filler: string): string {
  return [
    "---",
    `title: ${name}`,
    "---",
    "",
    `# ${name}`,
    "",
    "harmonics lattice resonance",
    filler,
    "",
  ].join("\n");
}

/** Sixty matching candidates: strictly more than the default rank cap of 50. */
async function seedWideVault(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    writeMd(
      vault,
      `notes/d${String(i).padStart(2, "0")}.md`,
      doc(`D${i}`, `filler ${i} unique token${i}`),
    );
  }
  await indexVault(makeConfig({ vault, dbPath }));
}

describe("hydrateChunkRefs", () => {
  test("projects every metadata column and no content", async () => {
    await seedWideVault();
    const db = new Database(dbPath, { readonly: true });
    try {
      const ids = db
        .query<{ id: number }, []>("SELECT id FROM chunks ORDER BY id LIMIT 3")
        .all()
        .map((r) => r.id);
      const refs = hydrateChunkRefs(db, ids);
      expect(refs.size).toBe(3);
      for (const [chunkId, ref] of refs) {
        expect(ids).toContain(chunkId);
        expect(ref.chunkId).toBe(chunkId);
        expect(typeof ref.path).toBe("string");
        expect(typeof ref.mtime).toBe("number");
        expect(typeof ref.startLine).toBe("number");
        expect(typeof ref.endLine).toBe("number");
        expect(typeof ref.contentHash).toBe("string");
        expect(typeof ref.documentHash).toBe("string");
        expect(ref.title !== undefined).toBe(true);
        // The metadata tier carries the content placeholder, never a body.
        expect(ref.content).toBe("");
      }
    } finally {
      db.close();
    }
  });

  test("returns an empty map for no ids", async () => {
    await seedWideVault();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(hydrateChunkRefs(db, []).size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("the two-tier cut over a live search", () => {
  test("content hydrates against the rank cap, never the pool", async () => {
    await seedWideVault();
    // MMR off and traversal off collapse the rank cap to `limit`, so the
    // keyword pool (limit * poolMultiplier = 15) is strictly wider than
    // the cap (5) and the cut is observable in both directions.
    const cfg = makeConfig({ vault, dbPath, mmrLambda: 1, maxHops: 0 });
    const refsCalls: number[] = [];
    const contentCalls: number[] = [];
    const originalRefs = Store.prototype.hydrateChunkRefs;
    const originalContent = Store.prototype.hydrateChunks;
    Store.prototype.hydrateChunkRefs = function (ids: ReadonlyArray<number>) {
      refsCalls.push(ids.length);
      return originalRefs.call(this, ids);
    };
    Store.prototype.hydrateChunks = function (ids: ReadonlyArray<number>) {
      contentCalls.push(ids.length);
      return originalContent.call(this, ids);
    };
    try {
      const outcome = await search(cfg, {
        query: "harmonics",
        limit: 5,
        keywordOnly: true,
      });
      // The pool tier ran once, over every candidate.
      expect(refsCalls.length).toBe(1);
      expect(refsCalls[0]!).toBe(15);
      // The content tier stayed within the rank cap on every call.
      expect(contentCalls.length).toBeGreaterThan(0);
      for (const size of contentCalls) {
        expect(size).toBeLessThanOrEqual(5);
        expect(size).toBeLessThan(refsCalls[0]!);
      }
      expect(outcome.results.length).toBe(5);
    } finally {
      Store.prototype.hydrateChunkRefs = originalRefs;
      Store.prototype.hydrateChunks = originalContent;
    }
  });

  test("results are byte-identical to the full-content pool hydration", async () => {
    await seedWideVault();
    const cfg = makeConfig({ vault, dbPath, mmrLambda: 0.5 });
    const originalRefs = Store.prototype.hydrateChunkRefs;
    // Pre-cut behaviour: the pool hydration carries content, so the
    // assembly never needs its content tier.
    Store.prototype.hydrateChunkRefs = function (ids: ReadonlyArray<number>) {
      return Store.prototype.hydrateChunks.call(this, ids);
    };
    let reference: SearchOutcome;
    try {
      reference = await search(cfg, { query: "harmonics", limit: 5, keywordOnly: true });
    } finally {
      Store.prototype.hydrateChunkRefs = originalRefs;
    }
    const cut = await search(cfg, { query: "harmonics", limit: 5, keywordOnly: true });
    expect(cut.results.length).toBe(reference.results.length);
    expect(cut.results.map((r) => r.path)).toEqual(reference.results.map((r) => r.path));
    for (let i = 0; i < cut.results.length; i++) {
      expect(cut.results[i]!.content).toBe(reference.results[i]!.content);
      expect(cut.results[i]!.content.length).toBeGreaterThan(0);
      expect(cut.results[i]!.keywordScore).toBe(reference.results[i]!.keywordScore);
      expect(cut.results[i]!.reasons).toEqual(reference.results[i]!.reasons);
      expect(cut.results[i]!.startLine).toBe(reference.results[i]!.startLine);
      expect(cut.results[i]!.endLine).toBe(reference.results[i]!.endLine);
      // The fused score carries the recency Weibull over real mtimes, so
      // two searches at two wall-clock instants drift at the 1e-8 level -
      // the cross-run clock flavour `rank-clock-determinism.test.ts`
      // pins WITHIN one call. A cut that lost content before MMR would
      // not drift: it would re-order rows and change reasons, both of
      // which are asserted exact above.
      expect(Math.abs(cut.results[i]!.score - reference.results[i]!.score)).toBeLessThan(1e-6);
    }
  });

  test("the returned rows carry real content, not the metadata placeholder", async () => {
    await seedWideVault();
    const outcome = await search(makeConfig({ vault, dbPath }), {
      query: "harmonics",
      limit: 5,
      keywordOnly: true,
    });
    expect(outcome.results.length).toBeGreaterThan(0);
    for (const r of outcome.results) {
      expect(r.content).toContain("harmonics lattice resonance");
    }
  });
});
