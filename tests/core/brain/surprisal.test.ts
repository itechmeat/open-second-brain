/**
 * Surprisal-based novelty sampling (t_fddfe64a): inbox signals rank
 * by embedding-space distance to their nearest indexed neighbours
 * over the EXISTING sqlite-vec index - no provider calls. Without a
 * vec index novelty reads null and every consumer stays
 * byte-identical; the score never changes which signals get
 * processed, only how review surfaces order them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

import { buildReviewCandidates } from "../../../src/core/brain/review-candidates.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { scoreSignalNovelty } from "../../../src/core/brain/surprisal.ts";
import { Store } from "../../../src/core/search/store.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let configHome: string;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("surprisal"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-surprisal-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  cleanup();
  rmSync(configHome, { recursive: true, force: true });
});

function vecConfig(): ResolvedSearchConfig {
  const semantic: Partial<ResolvedEmbeddingConfig> = {
    enabled: true,
    baseUrl: "https://x/v1",
    model: "m1",
    apiKey: "k",
    dimension: 4,
  };
  return makeConfig({ vault, dbPath, semantic });
}

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
}

async function plantEmbeddings(
  config: ResolvedSearchConfig,
  byPath: Record<string, number[]>,
): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    for (const [path, vector] of Object.entries(byPath)) {
      const docId = store.getDocumentIdByPath(path);
      expect(docId).not.toBeNull();
      const chunks = store.chunksForDocument(docId!);
      expect(chunks.length).toBeGreaterThan(0);
      store.vecUpsert(chunks[0]!.id, vector, "m1", 4, `eh-${path}`);
    }
  } finally {
    await store.close();
  }
}

function seedSignal(slug: string, principle: string): { id: string; relPath: string } {
  const res = writeSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "claude",
    principle,
    created_at: "2026-06-01T10:00:00Z",
    date: "2026-06-01",
    slug,
  });
  return { id: res.id, relPath: `Brain/inbox/${res.id}.md` };
}

describe("scoreSignalNovelty", () => {
  test("an outlier signal scores higher novelty than one inside a cluster", async () => {
    if (!sqliteVecLoadable()) return;
    writeMd(vault, "Brain/notes/a.md", "# A\n\nCluster note alpha.\n");
    writeMd(vault, "Brain/notes/b.md", "# B\n\nCluster note bravo.\n");
    const near = seedSignal("near", "A rule close to the cluster");
    const far = seedSignal("far", "A rule about something entirely new");
    const config = vecConfig();
    await indexVault(config);
    await plantEmbeddings(config, {
      "Brain/notes/a.md": unit([1, 0, 0, 0]),
      "Brain/notes/b.md": unit([0.95, 0.05, 0, 0]),
      [near.relPath]: unit([0.9, 0.1, 0, 0]),
      [far.relPath]: unit([0, 0, 0, 1]),
    });

    const scored = await scoreSignalNovelty(config, [near, far]);
    const nearScore = scored.find((s) => s.id === near.id)!;
    const farScore = scored.find((s) => s.id === far.id)!;
    expect(nearScore.novelty).not.toBeNull();
    expect(farScore.novelty).not.toBeNull();
    expect(farScore.novelty!).toBeGreaterThan(nearScore.novelty!);
  });

  test("signals without an indexed embedding read null novelty", async () => {
    if (!sqliteVecLoadable()) return;
    const sig = seedSignal("plain", "A rule with no embedding");
    const config = vecConfig();
    await indexVault(config);
    const scored = await scoreSignalNovelty(config, [sig]);
    expect(scored[0]!.novelty).toBeNull();
  });

  test("a vault without a vec index degrades to all-null, never throws", async () => {
    const sig = seedSignal("no-vec", "A rule in a keyword-only vault");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);
    const scored = await scoreSignalNovelty(config, [sig]);
    expect(scored[0]!.novelty).toBeNull();
  });
});

describe("review-candidates novelty annotation", () => {
  test("signal_novelty appears only when at least one signal scores", async () => {
    if (!sqliteVecLoadable()) return;
    writeMd(vault, "Brain/notes/a.md", "# A\n\nCluster note alpha.\n");
    const sig = seedSignal("scored", "A scored signal rule");
    const config = vecConfig();
    await indexVault(config);
    await plantEmbeddings(config, {
      "Brain/notes/a.md": unit([1, 0, 0, 0]),
      [sig.relPath]: unit([0, 1, 0, 0]),
    });

    const report = await buildReviewCandidates(vault, {
      now: new Date("2026-06-02T10:00:00Z"),
      searchConfig: config,
    });
    expect(report.signal_novelty).toBeDefined();
    expect(report.signal_novelty![0]!.id).toBe(sig.id);
    expect(report.signal_novelty![0]!.novelty).not.toBeNull();
  });

  test("without embeddings the report stays byte-identical (no field)", async () => {
    seedSignal("unscored", "An unscored signal rule");
    const config = makeConfig({ vault, dbPath });
    await indexVault(config);
    const withConfig = await buildReviewCandidates(vault, {
      now: new Date("2026-06-02T10:00:00Z"),
      searchConfig: config,
    });
    const without = await buildReviewCandidates(vault, {
      now: new Date("2026-06-02T10:00:00Z"),
    });
    expect(withConfig.signal_novelty).toBeUndefined();
    expect(withConfig).toEqual(without);
  });
});
