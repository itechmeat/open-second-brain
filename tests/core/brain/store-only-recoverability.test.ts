/**
 * A destructive operation's recovery point on a switched machine: the
 * snapshot archives the device-local state root, and the brain records
 * the operation removes live in the store, which no snapshot holds. So
 * the verdict beside the archive must not read `covered` (the word every
 * caller renders as "this is reversible"): it names the store records as
 * not covered. An unswitched machine's verdict is unchanged.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RECOVERABILITY_BLOCKER } from "../../../src/core/brain/gates/recoverability.ts";
import { deleteBySource } from "../../../src/core/brain/source-cleanup.ts";
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

const NOW = new Date("2026-11-20T12:00:00Z");
const SOURCE = "notes/leaked.md";

function seed(vault: string): void {
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE), "# Leaked\n\nA secret the owner wants gone.\n");
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "sources", "leaked.md"),
    `---\nkind: brain-source\nsource_path: ${SOURCE}\n---\n\nSummary of the leaked note.\n`,
  );
}

test("a switched machine's recovery point does not claim the store records it lacks", () => {
  bench = makeMigrationBench("osb-recoverability-store-");
  const { vault } = bench;
  seed(vault);
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);

  const done = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });
  expect(done.deleted).toEqual(["Brain/sources/leaked.md"]);
  expect(done.snapshotRunId).not.toBeNull();
  expect(done.recoverability.state).not.toBe("covered");
  expect(done.recoverability.coverage).not.toContain("brain_top_level");
  expect(done.recoverability.blockers).toContain(RECOVERABILITY_BLOCKER.brainRecordsInStore);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

test("an unswitched machine's recovery point still covers the Brain tree", () => {
  bench = makeMigrationBench("osb-recoverability-legacy-");
  const { vault } = bench;
  seed(vault);
  const done = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });
  expect(done.deleted).toEqual(["Brain/sources/leaked.md"]);
  expect(done.recoverability).toEqual({
    state: "covered",
    coverage: ["brain_top_level"],
    blockers: [],
  });
});
