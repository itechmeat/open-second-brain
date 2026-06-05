/**
 * Bridge discovery (link-recall-intelligence, t_ab540afe): an
 * orphan-first pass over the vec index proposing links between
 * embedding-near notes that share NO existing edge - reviewable
 * proposal artifact, persistent dismissals, operator-initiated accept
 * that writes one `related:` wikilink into the source frontmatter.
 * Read-only against note bodies; fail-soft without a vec layer.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptBridge,
  bridgePairKey,
  discoverBridges,
  dismissBridge,
  readDismissedBridges,
  writeBridgeProposals,
} from "../../../src/core/brain/link-graph/bridge-discovery.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const NOW = new Date("2026-06-05T12:00:00Z");

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bridge-"));
  config = makeConfig({
    vault,
    dbPath: join(vault, "index.sqlite"),
    semantic: { enabled: true, provider: "local", dimension: 256 },
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Two notes about the same topic that never name each other. */
function writeTwinNotes(): void {
  writeFileSync(
    join(vault, "alpha-deploy.md"),
    "# Canary deployment runbook\n\nShip the canary release to one production instance, watch error rates, expand the deployment gradually, roll back on regression.\n",
  );
  writeFileSync(
    join(vault, "beta-deploy.md"),
    "# Deployment safety checklist\n\nCanary release first: one production instance, watch error rates, expand deployment gradually, roll back the release on regression.\n",
  );
  writeFileSync(
    join(vault, "borscht.md"),
    "# Borscht\n\nBeets, cabbage, carrots, dill, sour cream. Simmer slowly until tender.\n",
  );
}

async function withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

describe("discoverBridges", () => {
  test("proposes the embedding-near unlinked pair and skips the distractor", async () => {
    writeTwinNotes();
    await indexVault(config, { embeddings: true });
    const report = await withStore((store) => discoverBridges(store, { minSimilarity: 0.5 }));
    expect(report.vecAvailable).toBe(true);
    expect(report.proposals.length).toBeGreaterThanOrEqual(1);
    const pair = report.proposals[0]!;
    expect([pair.source, pair.target].toSorted()).toEqual(["alpha-deploy.md", "beta-deploy.md"]);
    expect(pair.similarity).toBeGreaterThan(0.5);
    expect(
      report.proposals.some((p) => p.source === "borscht.md" || p.target === "borscht.md"),
    ).toBe(false);
  });

  test("an existing edge in either direction suppresses the pair", async () => {
    writeTwinNotes();
    writeFileSync(
      join(vault, "alpha-deploy.md"),
      "# Canary deployment runbook\n\nSee [[beta-deploy]]. Ship the canary release to one production instance, watch error rates, expand the deployment gradually, roll back on regression.\n",
    );
    await indexVault(config, { embeddings: true });
    const report = await withStore((store) => discoverBridges(store, { minSimilarity: 0.5 }));
    expect(
      report.proposals.some(
        (p) =>
          bridgePairKey(p.source, p.target) === bridgePairKey("alpha-deploy.md", "beta-deploy.md"),
      ),
    ).toBe(false);
  });

  test("dismissed pairs stay out of the report", async () => {
    writeTwinNotes();
    await indexVault(config, { embeddings: true });
    const dismissed = new Set([bridgePairKey("alpha-deploy.md", "beta-deploy.md")]);
    const report = await withStore((store) =>
      discoverBridges(store, { minSimilarity: 0.5, dismissed }),
    );
    expect(
      report.proposals.some(
        (p) =>
          bridgePairKey(p.source, p.target) === bridgePairKey("alpha-deploy.md", "beta-deploy.md"),
      ),
    ).toBe(false);
  });

  test("a vault indexed without embeddings fails soft with a reason", async () => {
    writeTwinNotes();
    await indexVault(config);
    const report = await withStore((store) => discoverBridges(store, {}));
    expect(report.vecAvailable).toBe(false);
    expect(report.proposals).toEqual([]);
    expect(report.reason).toMatch(/embedding|vec/i);
  });

  test("the similarity threshold filters weak pairs", async () => {
    writeTwinNotes();
    await indexVault(config, { embeddings: true });
    const strict = await withStore((store) => discoverBridges(store, { minSimilarity: 0.999 }));
    expect(strict.proposals).toEqual([]);
  });
});

describe("proposal artifact + dismiss state", () => {
  test("writeBridgeProposals regenerates a marked markdown artifact", async () => {
    writeTwinNotes();
    await indexVault(config, { embeddings: true });
    const report = await withStore((store) => discoverBridges(store, { minSimilarity: 0.5 }));
    const path = writeBridgeProposals(vault, report, { now: NOW });
    expect(path).toBe(join(vault, "Brain", "proposals", "bridges.md"));
    const [fm, body] = parseFrontmatter(path);
    expect(fm["kind"]).toBe("brain-bridge-proposals");
    expect(fm["generated_at"]).toBe("2026-06-05T12:00:00Z");
    expect(body).toContain("alpha-deploy.md");
    expect(body).toContain("beta-deploy.md");

    const empty = writeBridgeProposals(
      vault,
      { proposals: [], scannedCandidates: 0, vecAvailable: true },
      { now: NOW },
    );
    expect(readFileSync(empty, "utf8")).toContain("No bridge proposals");
  });

  test("dismissBridge persists across runs and readDismissedBridges round-trips", () => {
    expect(readDismissedBridges(vault).size).toBe(0);
    dismissBridge(vault, "a.md", "b.md");
    dismissBridge(vault, "b.md", "a.md"); // unordered - same pair
    const dismissed = readDismissedBridges(vault);
    expect(dismissed.size).toBe(1);
    expect(dismissed.has(bridgePairKey("a.md", "b.md"))).toBe(true);
  });
});

describe("acceptBridge", () => {
  test("writes one related wikilink into the source frontmatter, idempotently", async () => {
    writeTwinNotes();
    await indexVault(config, { embeddings: true });
    const first = acceptBridge(vault, "alpha-deploy.md", "beta-deploy.md");
    expect(first.changed).toBe(true);
    const [fm, body] = parseFrontmatter(join(vault, "alpha-deploy.md"));
    expect(fm["related"]).toEqual("[[beta-deploy]]");
    expect(body).toContain("Canary deployment runbook");

    const again = acceptBridge(vault, "alpha-deploy.md", "beta-deploy.md");
    expect(again.changed).toBe(false);
  });

  test("appends to an existing related list without clobbering", async () => {
    writeFileSync(join(vault, "src.md"), '---\nrelated: "[[existing]]"\n---\n\n# Src\n\nBody.\n');
    writeFileSync(join(vault, "tgt.md"), "# Tgt\n\nBody.\n");
    const result = acceptBridge(vault, "src.md", "tgt.md");
    expect(result.changed).toBe(true);
    const [fm] = parseFrontmatter(join(vault, "src.md"));
    expect(fm["related"]).toEqual(["[[existing]]", "[[tgt]]"]);
  });

  test("refuses paths outside the vault and missing notes", () => {
    expect(() => acceptBridge(vault, "../escape.md", "x.md")).toThrow(/outside the vault/);
    expect(() => acceptBridge(vault, "ghost.md", "also-ghost.md")).toThrow(/does not exist/);
  });
});
