/**
 * Operations on a switched machine judge no legacy item they only match by
 * key and checksum (change migration-sync-conflict-copies, follow-up 8):
 * the rollback's match of the restored tree builds records for their
 * content alone, and an import pass skips an item its journal holds whole
 * without building its records. Counted, never timed: ten times the
 * legacy rows must not mean ten times the calls.
 */
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";

import * as storePrivacy from "../../../src/core/store/store-privacy.ts";
import * as catalogue from "../../../src/core/store-migration/catalogue.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { removeLegacyTree } from "../../../src/core/store-migration/removal.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

/** A switched bench whose legacy tree holds `rows` extra log rows naming a preference. */
function switchedWith(rows: number): MigrationBench {
  const b = makeMigrationBench("osb-judging-counts-");
  const text =
    Array.from({ length: rows }, (_, i) =>
      JSON.stringify({
        ts: `2026-11-08T10:00:${String(i % 60).padStart(2, "0")}Z`,
        kind: "apply-evidence",
        payload: { pref_id: "pref-open", n: i },
        prev: null,
        h: "0".repeat(64),
      }),
    ).join("\n") + "\n";
  b.fx.write("Brain/log/2026-11-08.dev-a.jsonl", text);
  expect(runMigration(b.vault, FAST).ok).toBe(true);
  return b;
}

function counting<T>(target: object, name: string, run: () => T): number {
  let calls = 0;
  const real = (target as Record<string, (...a: unknown[]) => unknown>)[name]!;
  const spy = spyOn(
    target as Record<string, (...a: unknown[]) => unknown>,
    name,
  ).mockImplementation((...args: unknown[]) => {
    calls += 1;
    return real(...args);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return calls;
}

/** Preference judgements the rollback makes over a bench with `rows` extra rows. */
const judged = (rows: number): number => {
  bench = switchedWith(rows);
  const b = bench;
  const n = counting(storePrivacy, "storePreferenceIdIsPrivate", () => rollback(b.vault));
  b.cleanup();
  bench = null;
  return n;
};

/** Records the removal builds over a bench with `rows` extra rows. */
const built = (rows: number): number => {
  bench = switchedWith(rows);
  const b = bench;
  const n = counting(catalogue, "itemRecords", () =>
    removeLegacyTree(b.vault, b.store(), { agent: "t", force: true }),
  );
  b.cleanup();
  bench = null;
  return n;
};

test("the rollback judges no preference reference of the rows it matches", () => {
  expect(judged(400)).toBe(judged(40));
});

test("the removal's imports build no record for an item the journal holds whole", () => {
  expect(built(400)).toBe(built(40));
});
