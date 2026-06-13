/**
 * Agent-ownership recall isolation in search (Unit 5 of the Vault
 * Integrity & Trust suite).
 *
 * A page tagged with an `owner:` is owner-private: hidden from a recall
 * scoped to a different agent, reachable when scoped to its own owner or
 * when no scope is requested. Ownerless pages are always reachable, and a
 * recall that requests no agent scope is byte-identical to today.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

describe("agent-scope isolation in search", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("agent-scope"));
  });
  afterEach(() => cleanup());

  async function seed(): Promise<ReturnType<typeof makeConfig>> {
    writeMd(vault, "shared.md", "# Shared\n\nshared lattice notes about widgets");
    writeMd(
      vault,
      "owned-by-a.md",
      "---\nowner: agent-a\n---\n# A\n\nprivate lattice notes about widgets",
    );
    writeMd(
      vault,
      "owned-by-b.md",
      "---\nowner: agent-b\n---\n# B\n\nprivate lattice notes about widgets",
    );
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    return cfg;
  }

  test("no scope requested: every page is returned (byte-identical default)", async () => {
    const cfg = await seed();
    const out = await search(cfg, { query: "lattice widgets", limit: 10 });
    expect(out.results.map((r) => r.path).toSorted()).toEqual([
      "owned-by-a.md",
      "owned-by-b.md",
      "shared.md",
    ]);
  });

  test("scoped to agent-a: shared + agent-a, never agent-b's private page", async () => {
    const cfg = await seed();
    const out = await search(cfg, { query: "lattice widgets", limit: 10, agentScope: "agent-a" });
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["owned-by-a.md", "shared.md"]);
  });

  test("scope is normalized (case/whitespace) like the owner token", async () => {
    const cfg = await seed();
    const out = await search(cfg, {
      query: "lattice widgets",
      limit: 10,
      agentScope: "  Agent-B ",
    });
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["owned-by-b.md", "shared.md"]);
  });

  test("an all-shared vault is unaffected by an agent scope", async () => {
    writeMd(vault, "a.md", "# A\n\nlattice alpha");
    writeMd(vault, "b.md", "# B\n\nlattice beta");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    const out = await search(cfg, { query: "lattice", limit: 10, agentScope: "agent-a" });
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["a.md", "b.md"]);
  });
});
