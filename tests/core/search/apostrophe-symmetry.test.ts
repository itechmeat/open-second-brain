/**
 * Apostrophe symmetry on the retrieval path (what-the-index-already-knew,
 * task A).
 *
 * The entity identity kernel now folds typographic quote variants. The
 * SEARCH side needed no such fold - it is already symmetric - but only by
 * accident of two independent choices that nothing pinned:
 *
 *   - the word lane is built with `unicode61 remove_diacritics 2`, which
 *     classifies U+0027 and U+2019 alike as separators, so both forms of
 *     `Taylor's` produce the same tokens;
 *   - the trigram lane is asymmetric at raw SQL level - `"taylor's"` and
 *     `"taylor’s"` are different trigram sequences - and is saved by its
 *     PLANNER, which splits the query on `[^\p{L}\p{N}]+` and so never
 *     emits a term containing either apostrophe.
 *
 * Either choice could be changed by someone who did not know it was
 * load-bearing. This file is the lock: both query forms must retrieve the
 * same rows through the real lanes, and the same assertion run against a
 * deliberately non-symmetric tokenizer must FAIL, so the lock is proved
 * discriminating rather than vacuously true.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runFtsQuery } from "../../../src/core/search/fts.ts";
import { Store } from "../../../src/core/search/store.ts";
import { DEFAULT_FTS_TOKENIZE } from "../../../src/core/search/schema.ts";
import { planTrigramPrefilter } from "../../../src/core/search/trigram-prefilter.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

/** The same phrase in both apostrophe forms. */
const ASCII_QUERY = "Taylor's Version";
const TYPOGRAPHIC_QUERY = "Taylor’s Version";

/** Where each form is stored, so neither query can win by exact-match luck. */
const ASCII_DOC = "Notes/ascii.md";
const TYPOGRAPHIC_DOC = "Notes/typographic.md";

const LIMIT = 20;

/**
 * A tokenizer that treats U+2019 as a token CHARACTER while U+0027 stays a
 * separator - the shape of a well-meant "keep smart quotes intact" config
 * change. `taylor’s` becomes one token and `taylor's` becomes two, so the
 * two query forms stop matching each other's documents.
 */
const ASYMMETRIC_FTS_TOKENIZE = `${DEFAULT_FTS_TOKENIZE} tokenchars ’`;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("apostrophe-symmetry");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/** A seeded store plus the document-id to path mapping its lanes report. */
interface Fixture {
  readonly store: Store;
  readonly paths: ReadonlyMap<number, string>;
}

/** A store holding one document per apostrophe form, under `ftsTokenize`. */
async function fixture(ftsTokenize: string): Promise<Fixture> {
  const store = await Store.open(
    { ...makeConfig({ vault, dbPath }), ftsTokenize },
    { mode: "write", loadVec: false },
  );
  const paths = new Map<number, string>();
  const seed = (path: string, content: string, hash: string) => {
    const doc = store.upsertDocument({
      path,
      title: path,
      contentHash: hash,
      mtime: 1700000000,
      size: content.length,
    });
    store.replaceChunks(doc, [
      {
        chunkIndex: 0,
        content,
        contentHash: `${hash}-c0`,
        startLine: 1,
        endLine: 1,
        tokenCount: 4,
      },
    ]);
    paths.set(doc, path);
  };
  seed(ASCII_DOC, `Re-recording ${ASCII_QUERY} in the studio`, "h-ascii");
  seed(TYPOGRAPHIC_DOC, `Re-recording ${TYPOGRAPHIC_QUERY} in the studio`, "h-typo");
  return { store, paths };
}

/** Hit document ids resolved to paths, sorted - the rows a lane returned. */
function hitPaths(fx: Fixture, hits: ReadonlyArray<{ readonly documentId: number }>): string[] {
  return hits
    .map((hit) => fx.paths.get(hit.documentId) ?? `unknown-document-${hit.documentId}`)
    .toSorted();
}

/** The document paths the WORD lane returns for `query`, sorted. */
function wordLanePaths(fx: Fixture, query: string): string[] {
  return hitPaths(fx, runFtsQuery(fx.store, query, { limit: LIMIT }));
}

/** The document paths the TRIGRAM lane returns for `query`, sorted. */
function trigramLanePaths(fx: Fixture, query: string): string[] {
  const plan = planTrigramPrefilter(query);
  if (plan.mode !== "match") return [];
  return hitPaths(fx, fx.store.trigramCandidates(plan.ftsQuery, { limit: LIMIT }).hits);
}

describe("both apostrophe forms retrieve the same rows", () => {
  test("the word lane is symmetric and reaches both documents", async () => {
    const fx = await fixture(DEFAULT_FTS_TOKENIZE);
    try {
      const ascii = wordLanePaths(fx, ASCII_QUERY);
      expect(ascii).toEqual([ASCII_DOC, TYPOGRAPHIC_DOC]);
      expect(wordLanePaths(fx, TYPOGRAPHIC_QUERY)).toEqual(ascii);
    } finally {
      await fx.store.close();
    }
  });

  test("the trigram lane is symmetric and reaches both documents", async () => {
    const fx = await fixture(DEFAULT_FTS_TOKENIZE);
    try {
      const ascii = trigramLanePaths(fx, ASCII_QUERY);
      expect(ascii).toEqual([ASCII_DOC, TYPOGRAPHIC_DOC]);
      expect(trigramLanePaths(fx, TYPOGRAPHIC_QUERY)).toEqual(ascii);
    } finally {
      await fx.store.close();
    }
  });

  test("the planner is why the trigram lane is symmetric", () => {
    const ascii = planTrigramPrefilter(ASCII_QUERY);
    const typographic = planTrigramPrefilter(TYPOGRAPHIC_QUERY);
    expect(ascii).toEqual(typographic);
    expect(ascii.mode).toBe("match");
    if (ascii.mode !== "match") throw new Error("unreachable: asserted above");
    for (const term of ascii.terms) {
      expect(`${term}: ${/['’]/.test(term)}`).toBe(`${term}: false`);
    }
  });
});

describe("the symmetry check can fail", () => {
  test("the trigram index itself is asymmetric - only the planner hides it", async () => {
    const fx = await fixture(DEFAULT_FTS_TOKENIZE);
    try {
      // Bypassing `planTrigramPrefilter` and querying the shadow with the
      // apostrophe-bearing terms directly: the trigram sequences differ, so
      // each form reaches only its own document. A planner change that let
      // an apostrophe into a term would land exactly here.
      const ascii = hitPaths(fx, fx.store.trigramCandidates('"taylor\'s"', { limit: LIMIT }).hits);
      const typographic = hitPaths(
        fx,
        fx.store.trigramCandidates('"taylor’s"', { limit: LIMIT }).hits,
      );
      expect(ascii).toEqual([ASCII_DOC]);
      expect(typographic).toEqual([TYPOGRAPHIC_DOC]);
    } finally {
      await fx.store.close();
    }
  });

  test("a non-symmetric tokenizer splits the two forms apart", async () => {
    const fx = await fixture(ASYMMETRIC_FTS_TOKENIZE);
    try {
      const ascii = wordLanePaths(fx, ASCII_QUERY);
      const typographic = wordLanePaths(fx, TYPOGRAPHIC_QUERY);
      // The assertion the symmetry test makes, inverted: under this
      // tokenizer each form reaches only its own document, so a test that
      // passed here would be passing on nothing.
      expect(ascii).toEqual([ASCII_DOC]);
      expect(typographic).toEqual([TYPOGRAPHIC_DOC]);
      expect(ascii).not.toEqual(typographic);
    } finally {
      await fx.store.close();
    }
  });
});
