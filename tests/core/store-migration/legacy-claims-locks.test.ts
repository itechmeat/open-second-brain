/**
 * The dry run's walk claims a `.lock` sibling with the mapped file it is
 * the lock of (change auto-store-migration): a live writer's lock - the
 * managed-file upgrade worker's, a metrics append's - must never turn into an unmapped entry that stops
 * the migration. A `.lock` whose target nothing claims stays reported.
 * (The automatic migration worker's own lock is kept outside the vault,
 * in the device-local folder of all stores, so the walk never meets it.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unclaimedEntries } from "../../../src/core/store-migration/legacy-claims.ts";
import { migrationCatalogue } from "../../../src/core/store-migration/catalogue.ts";
import { legacyRootNames } from "../../../src/core/store-migration/catalogue.ts";
import { makeLegacyVault, UNMAPPED_LEGACY_ENTRIES } from "./fixtures/legacy-vault.ts";

let fx: ReturnType<typeof makeLegacyVault>;

beforeEach(() => {
  fx = makeLegacyVault("osb-claims-locks-");
  for (const rel of UNMAPPED_LEGACY_ENTRIES) {
    rmSync(join(fx.vault, ...rel.split("/")), { force: true });
  }
});

afterEach(() => fx.cleanup());

function unmapped(): string[] {
  const catalogue = migrationCatalogue(fx.vault);
  const locators = catalogue.flatMap((entry) => entry.locators);
  return unclaimedEntries(
    fx.vault,
    legacyRootNames(fx.vault, catalogue).map((top) => join(fx.vault, top)),
    locators,
  ).map((e) => e.path);
}

describe("the search index rebuild's staging siblings", () => {
  // A background reindex the same start launched can hold its staging
  // build open in any SQLite journal mode while the worker's dry run walks
  // the tree; each sibling belongs to the index surface.
  test.each([".new", ".new-wal", ".new-shm", ".new-journal"])(
    "brain.sqlite%s is not unmapped",
    (suffix) => {
      mkdirSync(join(fx.vault, ".open-second-brain"), { recursive: true });
      writeFileSync(join(fx.vault, ".open-second-brain", `brain.sqlite${suffix}`), "");

      expect(unmapped()).toEqual([]);
    },
  );
});

describe("a .lock sibling of a claimed file", () => {
  test("the managed-file upgrade worker's lock is a mapped surface, not unmapped", () => {
    // The same start can launch the upgrade worker and the migration
    // worker; the upgrade worker's claim must not stop the migration.
    mkdirSync(join(fx.vault, ".open-second-brain"), { recursive: true });
    writeFileSync(join(fx.vault, ".open-second-brain", "self-heal-upgrade.lock"), "claim");

    expect(unmapped()).toEqual([]);
  });

  test("a lock directory beside a mapped ledger is not unmapped", () => {
    // proper-lockfile's sibling is a directory while a writer holds it.
    mkdirSync(join(fx.vault, "Brain", "metrics", "recall.jsonl.lock"), { recursive: true });
    writeFileSync(join(fx.vault, "Brain", "metrics", "recall.jsonl.lock", "lockfile"), "held\n");

    expect(unmapped()).toEqual([]);
  });

  test("a .lock whose target nothing claims stays reported", () => {
    const stray = join(fx.vault, ".open-second-brain", "unknown-state.json.lock");
    mkdirSync(join(stray, ".."), { recursive: true });
    writeFileSync(stray, "{}");

    expect(unmapped()).toEqual([".open-second-brain/unknown-state.json.lock"]);
  });
});
