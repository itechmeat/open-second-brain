/**
 * A read of an older-schema index while another writer holds the index.
 *
 * The read upgrades such an index in place; with the writer lock taken
 * the upgrade cannot run, and a rebuild would only queue behind that
 * writer to discard its work, so none runs. The refusal says what was
 * tried: the in-place upgrade, refused by the lock. It used to say "the
 * automatic rebuild ... also failed" although no rebuild had run.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { openReadOrSelfHeal } from "../../../src/core/search/pipeline/store-open.ts";
import { Store } from "../../../src/core/search/store.ts";
import { stampSchemaVersion } from "../../helpers/schema-rewind.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let v: ReturnType<typeof createTempVault>;
let writer: Store | null = null;

beforeEach(() => {
  v = createTempVault("locked-upgrade");
  writeMd(v.vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
});
afterEach(async () => {
  try {
    await writer?.close();
  } finally {
    writer = null;
    v.cleanup();
  }
});

test("a read refused by another writer's lock names the upgrade it could not run, not a rebuild", async () => {
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg);
  // The writer takes the lock first (its own open would migrate the
  // schema), then the index is left on an older schema under it.
  writer = await Store.open(cfg, { mode: "write", loadVec: false });
  stampSchemaVersion(v.dbPath, 17);

  const refusal = await openReadOrSelfHeal(cfg).then(
    async (store) => {
      await store.close();
      return null;
    },
    (e: unknown) => e as Error,
  );

  expect(refusal).not.toBeNull();
  expect(refusal!.message).not.toContain("automatic rebuild");
  expect(refusal!.message).toContain(`the in-place upgrade of ${v.dbPath}`);
}, 30_000);
