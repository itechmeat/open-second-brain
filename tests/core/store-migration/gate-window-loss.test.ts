/**
 * Why every write is refused while a migration of the vault holds the gate,
 * rather than only the writes the migration's passes would not pick up.
 *
 * The migration re-scans the record sources until a pass imports nothing,
 * and a switched machine's transition import re-reads changed record files
 * after the switch. Neither reads a device-local surface again: the run
 * copies those into the device-local state once, right after its backups
 * (`local-state.ts`), and a switched machine reads only that copy. A write
 * into such a surface that lands after the copy (here after the last pass,
 * before the device-switched record) is in the legacy tree and nowhere the
 * switched machine looks: it is lost. So no lane may write during the run.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MigrationInProgressError } from "../../../src/core/migration-gate.ts";
import {
  addProviderProfile,
  loadProviderRegistry,
} from "../../../src/core/search/embeddings/registry.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { importLateLegacyWrites } from "../../../src/core/store-migration/transition.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

// Tests here run a whole migration; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const REGISTRY = join("Brain", "search", "embedding-providers.json");

const profile = (name: string) => ({
  name,
  baseUrl: "http://127.0.0.1:9/v1",
  defaultModel: "census-model",
  envKey: "CENSUS_PROVIDER_ENV",
});

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench("osb-gate-window-");
  dropUnparseable(bench.vault);
  // A device-local surface the migration moves: the registered providers.
  addProviderProfile(bench.vault, profile("before"));
});
afterEach(() => bench.cleanup());

test("a device-local write after the last pass would be lost, so the writer is refused", () => {
  let refused: unknown = null;
  const result = runMigration(bench.vault, {
    ...FAST,
    hooks: {
      beforeVerify: () => {
        // The writer itself, between the last pass and the switch: refused.
        try {
          addProviderProfile(bench.vault, profile("refused"));
        } catch (error) {
          refused = error;
        }
        // What it would have written had the gate let it through.
        const path = join(bench.vault, REGISTRY);
        const late = [...(JSON.parse(readFileSync(path, "utf8")) as unknown[]), profile("late")];
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(late, null, 2)}\n`);
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(refused).toBeInstanceOf(MigrationInProgressError);

  // The switched machine reads the copy the run took before its passes: the
  // late provider is in the legacy tree and not there.
  const names = () => loadProviderRegistry(bench.vault).map((p) => p.name);
  expect(readFileSync(join(bench.vault, REGISTRY), "utf8")).toContain('"late"');
  expect(names()).toEqual(["before"]);

  // The transition import, which re-reads every changed record file of the
  // legacy tree, does not carry a device-local surface either.
  importLateLegacyWrites(bench.vault, bench.store(), "@census", null);
  expect(names()).toEqual(["before"]);
});
