/**
 * The claim graph on a switched vault whose legacy `Brain/` tree was
 * removed: it is built from the store's preferences, retired preferences,
 * signals and `theses` lane entries, the same nodes the legacy tree gave,
 * and its rebuild writes nothing into the vault.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildClaimGraph, rebuildClaimGraph } from "../../../src/core/brain/claim-graph.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../store-migration/fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

const THESIS =
  "---\nid: thesis-cache\ntopic: caching\nprinciple: Cache reads, never writes.\n" +
  "contradicts: [pref-write-cache]\n---\n\nWhy.\n";

test("the claim graph reads the store once the legacy tree is gone", () => {
  bench = makeMigrationBench("osb-claims-store-");
  const { vault } = bench;
  mkdirSync(join(vault, "Brain", "theses"), { recursive: true });
  writeFileSync(join(vault, "Brain", "theses", "thesis-cache.md"), THESIS);
  const now = new Date("2026-11-20T00:00:00Z");
  const before = buildClaimGraph(vault, { now });
  expect(before.nodes.some((n) => n.path === "Brain/theses/thesis-cache.md")).toBe(true);
  expect(before.node_count).toBeGreaterThan(1);

  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  expect(existsSync(join(vault, "Brain"))).toBe(false);

  const after = buildClaimGraph(vault, { now });
  // Keyed by id, so the order of the two walks does not matter.
  const shape = (g: typeof before) =>
    g.nodes
      .map((n) => [n.id, n.topic, n.principle, n.superseded_by, n.contradicts, n.tombstoned])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
  expect(shape(after)).toEqual(shape(before));

  const rebuilt = rebuildClaimGraph(vault, { now });
  expect(rebuilt.node_count).toBe(before.node_count);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});
