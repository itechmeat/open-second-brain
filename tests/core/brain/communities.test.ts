/**
 * Community detection + cluster note materialization
 * (link-recall-intelligence, t_4ba927ec): deterministic synchronous
 * label propagation over the resolved doc-level link graph; every
 * community of size >= minSize materializes one derived cluster note
 * under Brain/clusters/ (regenerated each run, stale notes removed,
 * non-generated files never touched). No LLM prose - the digest is a
 * deterministic projection.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectCommunities,
  materializeClusterNotes,
} from "../../../src/core/brain/link-graph/communities.ts";
import { DEFAULT_TIER_MAP } from "../../../src/core/brain/frontmatter-tiers.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const NOW = new Date("2026-06-05T12:00:00Z");

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-comm-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const link = (targets: string[]) => targets.map((t) => `[[${t}]]`).join(" and ");

/** Two 4-cliques (deploy-*, cook-*) and one isolated note. */
function writeTwoCommunities(): void {
  const deploy = ["deploy-a", "deploy-b", "deploy-c", "deploy-d"];
  const cook = ["cook-a", "cook-b", "cook-c", "cook-d"];
  for (const group of [deploy, cook]) {
    for (const name of group) {
      const others = group.filter((g) => g !== name);
      writeFileSync(
        join(vault, `${name}.md`),
        `# ${name}\n\nSee ${link(others)} for the rest of the series.\n`,
      );
    }
  }
  writeFileSync(join(vault, "loner.md"), "# Loner\n\nNo links here.\n");
}

async function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return fn(store);
  } finally {
    await store.close();
  }
}

describe("detectCommunities", () => {
  test("finds the two seeded communities deterministically", async () => {
    writeTwoCommunities();
    await indexVault(config);
    const first = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    const second = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    const memberSets = first.map((c) => c.members.map((m) => m.path).toSorted());
    expect(memberSets).toContainEqual(["cook-a.md", "cook-b.md", "cook-c.md", "cook-d.md"]);
    expect(memberSets).toContainEqual(["deploy-a.md", "deploy-b.md", "deploy-c.md", "deploy-d.md"]);
    // Most-central member leads (full clique - degree ties break by path).
    expect(first[0]!.members[0]!.internalDegree).toBeGreaterThanOrEqual(
      first[0]!.members.at(-1)!.internalDegree,
    );
  });

  test("communities below minSize are ignored", async () => {
    writeFileSync(join(vault, "pair-a.md"), "# Pair A\n\nSee [[pair-b]].\n");
    writeFileSync(join(vault, "pair-b.md"), "# Pair B\n\nSee [[pair-a]].\n");
    await indexVault(config);
    const communities = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    expect(communities).toEqual([]);
  });

  test("a bipartite star terminates within the iteration cap", async () => {
    // Hub-and-spokes: synchronous propagation oscillates without a cap.
    writeFileSync(
      join(vault, "hub.md"),
      "# Hub\n\n[[spoke-a]] [[spoke-b]] [[spoke-c]] [[spoke-d]]\n",
    );
    for (const s of ["spoke-a", "spoke-b", "spoke-c", "spoke-d"]) {
      writeFileSync(join(vault, `${s}.md`), `# ${s}\n\nBack to [[hub]].\n`);
    }
    await indexVault(config);
    const communities = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    expect(communities.length).toBeLessThanOrEqual(1);
  });
});

describe("materializeClusterNotes", () => {
  test("writes one derived note per community and registers the tier kind", async () => {
    writeTwoCommunities();
    await indexVault(config);
    const communities = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    const result = await withStore((store) =>
      materializeClusterNotes(vault, communities, { store, now: NOW }),
    );
    expect(result.written).toHaveLength(2);
    expect(result.removed).toEqual([]);

    const dir = join(vault, "Brain", "clusters");
    const files = readdirSync(dir).toSorted();
    expect(files).toHaveLength(2);
    const [fm, body] = parseFrontmatter(join(dir, files[0]!));
    expect(fm["kind"]).toBe("brain-cluster");
    expect(fm["generated_at"]).toBe("2026-06-05T12:00:00Z");
    expect(Number(fm["size"])).toBeGreaterThanOrEqual(4);
    expect(body).toContain("Auto-generated");
    expect(DEFAULT_TIER_MAP["brain-cluster"]).toBeDefined();
  });

  test("a vanished community's note is removed on the next run", async () => {
    writeTwoCommunities();
    await indexVault(config);
    const communities = await withStore((store) => detectCommunities(store, { minSize: 4 }));
    await withStore((store) => materializeClusterNotes(vault, communities, { store, now: NOW }));

    const onlyFirst = communities.slice(0, 1);
    const second = await withStore((store) =>
      materializeClusterNotes(vault, onlyFirst, { store, now: NOW }),
    );
    expect(second.removed).toHaveLength(1);
    expect(readdirSync(join(vault, "Brain", "clusters"))).toHaveLength(1);
  });

  test("non-generated files in Brain/clusters/ are never touched", async () => {
    writeTwoCommunities();
    await indexVault(config);
    mkdirSync(join(vault, "Brain", "clusters"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "clusters", "hand-written.md"),
      "# My own cluster analysis\n\nDo not delete.\n",
    );
    const second = await withStore((store) =>
      materializeClusterNotes(vault, [], { store, now: NOW }),
    );
    expect(second.removed).toEqual([]);
    expect(existsSync(join(vault, "Brain", "clusters", "hand-written.md"))).toBe(true);
  });
});
