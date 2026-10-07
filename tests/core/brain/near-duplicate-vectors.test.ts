/**
 * Stored-vector tier for retire siblings (near-duplicate defense, A4).
 *
 * Each status comes from a real fixture index (or its absence): the tier
 * reads vectors the indexer already paid for and never embeds anything. A
 * source scan pins that by construction: neither this module nor the
 * write-side widening collector imports from the embeddings layer, and
 * `detectSemanticDedup` still has no production caller.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  storedVectorSimilarities,
  storedVectorSimilarity,
} from "../../../src/core/brain/near-duplicate-vectors.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const MODEL = "nd-model";
const OTHER_MODEL = "nd-older-model";
const DIMENSION = 4;
const VEC_LOADABLE = sqliteVecLoadable();

const PROBE = "Brain/preferences/pref-old.md";
const NEAR = "Brain/preferences/pref-near.md";
const FAR = "Brain/preferences/pref-far.md";
const UNINDEXED = "Brain/preferences/pref-unindexed.md";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("nd-vectors"));
});

afterEach(() => cleanup());

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
}

function vecConfig(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      baseUrl: "https://x/v1",
      model: MODEL,
      apiKey: "k",
      dimension: DIMENSION,
      ...semantic,
    },
  });
}

function writePref(relPath: string, principle: string): void {
  writeMd(vault, relPath, `---\ntopic: t\nprinciple: ${principle}\n---\n\n${principle}\n`);
}

async function plant(
  config: ResolvedSearchConfig,
  byPath: Record<string, { vector: number[]; model?: string; frontmatter?: number[] }>,
): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    for (const [path, planted] of Object.entries(byPath)) {
      const docId = store.getDocumentIdByPath(path);
      expect(docId).not.toBeNull();
      for (const chunk of store.chunksForDocument(docId!)) {
        // Chunk 0 is the page's frontmatter block (see `writePref`).
        const vector =
          chunk.chunkIndex === 0 ? (planted.frontmatter ?? planted.vector) : planted.vector;
        store.vecUpsert(
          chunk.id,
          unit(vector),
          planted.model ?? MODEL,
          DIMENSION,
          `eh-${path}-${chunk.id}`,
        );
      }
    }
  } finally {
    await store.close();
  }
}

async function indexedFixture(config: ResolvedSearchConfig): Promise<void> {
  writePref(PROBE, "Run the formatter before every commit");
  writePref(NEAR, "Format the code before each commit");
  writePref(FAR, "Use tabs inside makefiles");
  await indexVault(config);
}

describe("storedVectorSimilarity", () => {
  test("a missing index reports index_missing with no scores", async () => {
    const result = await storedVectorSimilarity(vecConfig(), PROBE, [NEAR]);
    expect(existsSync(dbPath)).toBe(false);
    expect(result.status).toBe("index_missing");
    expect(result.scores.size).toBe(0);
  });

  test("a store without sqlite-vec reports vec_unavailable", async () => {
    const config = vecConfig();
    await indexedFixture(config);
    const result = await storedVectorSimilarity(config, PROBE, [NEAR], { loadVec: false });
    expect(result.status).toBe("vec_unavailable");
    expect(result.scores.size).toBe(0);
  });

  test.skipIf(!VEC_LOADABLE)(
    "an indexed probe with no stored vector reports not_embedded, not used",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      await plant(config, { [NEAR]: { vector: [1, 0, 0, 0] } });
      const result = await storedVectorSimilarity(config, PROBE, [NEAR]);
      expect(result.status).toBe("not_embedded");
      expect(result.scores.size).toBe(0);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "frontmatter chunks are never compared: matching frontmatter alone scores nothing",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      // Identical frontmatter vectors, orthogonal principle vectors.
      await plant(config, {
        [PROBE]: { frontmatter: [1, 0, 0, 0], vector: [0, 1, 0, 0] },
        [NEAR]: { frontmatter: [1, 0, 0, 0], vector: [0, 0, 1, 0] },
      });
      const result = await storedVectorSimilarity(config, PROBE, [NEAR]);
      expect(result.status).toBe("used");
      expect(result.scores.get(NEAR)).toBeCloseTo(0, 5);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a probe whose only stored vector is its frontmatter reports not_embedded",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      const store = await Store.open(config, { mode: "write" });
      try {
        const docId = store.getDocumentIdByPath(PROBE)!;
        const fm = store.chunksForDocument(docId).find((c) => c.chunkIndex === 0)!;
        store.vecUpsert(fm.id, unit([1, 0, 0, 0]), MODEL, DIMENSION, "eh-probe-fm");
      } finally {
        await store.close();
      }
      await plant(config, { [NEAR]: { vector: [1, 0, 0, 0] } });
      const result = await storedVectorSimilarity(config, PROBE, [NEAR]);
      expect(result.status).toBe("not_embedded");
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a probe stored under another model reports model_mismatch",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      await plant(config, {
        [PROBE]: { vector: [1, 0, 0, 0], model: OTHER_MODEL },
        [NEAR]: { vector: [1, 0, 0, 0], model: OTHER_MODEL },
      });
      const result = await storedVectorSimilarity(config, PROBE, [NEAR]);
      expect(result.status).toBe("model_mismatch");
      expect(result.scores.size).toBe(0);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a configured dimension that differs from the stored one reports model_mismatch",
    async () => {
      await indexedFixture(vecConfig());
      await plant(vecConfig(), {
        [PROBE]: { vector: [1, 0, 0, 0] },
        [NEAR]: { vector: [1, 0, 0, 0] },
      });
      const result = await storedVectorSimilarity(vecConfig({ dimension: 8 }), PROBE, [NEAR]);
      expect(result.status).toBe("model_mismatch");
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "used: each candidate scores its max chunk-pair cosine; incomparable rows are unscored",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      await plant(config, {
        [PROBE]: { vector: [1, 0, 0, 0] },
        [NEAR]: { vector: [1, 0.05, 0, 0] },
        [FAR]: { vector: [0, 0, 0, 1], model: OTHER_MODEL },
      });
      const result = await storedVectorSimilarity(config, PROBE, [NEAR, FAR, UNINDEXED]);
      expect(result.status).toBe("used");
      expect([...result.scores.keys()]).toEqual([NEAR]);
      expect(result.scores.get(NEAR)).toBeCloseTo(1 / Math.hypot(1, 0.05), 5);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "several probes over one store: one result per probe, in order",
    async () => {
      const config = vecConfig();
      await indexedFixture(config);
      await plant(config, {
        [PROBE]: { vector: [1, 0, 0, 0] },
        [NEAR]: { vector: [1, 0.05, 0, 0] },
      });
      const results = await storedVectorSimilarities(config, [FAR, PROBE], [PROBE, NEAR]);
      expect(results.map((r) => r.status)).toEqual(["not_embedded", "used"]);
      expect([...results[1]!.scores.keys()]).toEqual([NEAR]);
      const mismatched = await storedVectorSimilarities(
        vecConfig({ dimension: 8 }),
        [PROBE, NEAR],
        [],
      );
      expect(mismatched.map((r) => r.status)).toEqual(["model_mismatch", "model_mismatch"]);
    },
  );
});

const REPO = resolve(import.meta.dir, "../../..");
const EMBEDDINGS_DIR = join(REPO, "src", "core", "search", "embeddings") + sep;
const SPEND_FREE_MODULES = [
  "src/core/brain/near-duplicate-vectors.ts",
  "src/core/brain/page-lint-widening.ts",
];

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
    (m) => (m[1] ?? m[2])!,
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

describe("spend gates by construction", () => {
  test("neither spend-free module imports from the embeddings layer", () => {
    for (const rel of SPEND_FREE_MODULES) {
      const abs = join(REPO, rel);
      // The widening collector belongs to another lane and may not exist yet.
      if (!existsSync(abs)) continue;
      const offending = importSpecifiers(readFileSync(abs, "utf8"))
        .filter((spec) => spec.startsWith("."))
        .map((spec) => resolve(dirname(abs), spec))
        .filter((target) => target.startsWith(EMBEDDINGS_DIR));
      expect({ module: rel, offending }).toEqual({ module: rel, offending: [] });
    }
  });

  test("detectSemanticDedup has no caller outside tests", () => {
    const callers = sourceFiles(join(REPO, "src"))
      .filter((abs) => /\bdetectSemanticDedup\b/.test(stripComments(readFileSync(abs, "utf8"))))
      .map((abs) => relative(REPO, abs).split(sep).join("/"));
    expect(callers).toEqual(["src/core/brain/hygiene/detectors/dedup.ts"]);
    const own = stripComments(
      readFileSync(join(REPO, "src/core/brain/hygiene/detectors/dedup.ts"), "utf8"),
    );
    expect(own.match(/\bdetectSemanticDedup\b/g)).toEqual(["detectSemanticDedup"]);
  });
});

/** Drop line and block comments so a doc mention is not counted as a caller. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
