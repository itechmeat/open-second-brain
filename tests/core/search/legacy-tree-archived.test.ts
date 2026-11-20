/**
 * Once a machine switched to the brain store, its legacy `Brain/` tree is
 * an archive waiting for `--remove-legacy`: the index walks the vault's
 * notes without it, so a migrated signal answers once (as its store
 * record), not twice. A vault that never migrated keeps its `Brain/`
 * pages in the index.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { reindexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { legacyTreeArchived } from "../../../src/core/search/walker.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { switchDevice } from "../brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function seed(vault: string): void {
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "inbox", "sig-2026-11-01-dunlin.md"),
    "---\nkind: brain-signal\nid: sig-2026-11-01-dunlin\nprinciple: Dunlin mudflat rule\n---\n## Raw\nDunlin mudflat rule\n",
  );
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "log", "2026-11-01.md"),
    "# 2026-11-01\n\n## 10:00 note\nDunlin day\n",
  );
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, "Notes", "mudflat.md"), "# Mudflat\n\nDunlin notes.\n");
}

async function indexedPaths(config: ResolvedSearchConfig): Promise<string[]> {
  const index = await Store.open(config, { mode: "read" });
  try {
    return index
      .rawQuery<{ path: string }>("SELECT path FROM documents ORDER BY path")
      .map((r) => r.path);
  } finally {
    await index.close();
  }
}

test("a switched machine indexes the vault's notes without the legacy Brain/ tree", async () => {
  env = makeStoreEnv("osb-legacy-archived-", { dualWrite: false });
  seed(env.vault);
  switchDevice(env);
  const config = resolveSearchConfig({ vault: env.vault, configPath: env.configPath });
  expect(config.brainStore).not.toBeNull();
  expect(legacyTreeArchived(config)).toBe(true);
  await reindexVault(config);
  const paths = await indexedPaths(config);
  expect(paths).toContain("Notes/mudflat.md");
  expect(paths.filter((p) => p.startsWith("Brain/"))).toEqual([]);
});

// Symbolic links need a privilege on Windows that CI runners lack.
test.skipIf(IS_WINDOWS)(
  "a link into the archived Brain/ tree is left out with it, other links are not",
  async () => {
    env = makeStoreEnv("osb-legacy-archived-link-", { dualWrite: false });
    seed(env.vault);
    switchDevice(env);
    symlinkSync(join(env.vault, "Brain"), join(env.vault, "Archive"));
    symlinkSync(
      join(env.vault, "Brain", "inbox", "sig-2026-11-01-dunlin.md"),
      join(env.vault, "Notes", "dunlin-link.md"),
    );
    mkdirSync(join(env.vault, "Other"), { recursive: true });
    writeFileSync(join(env.vault, "Other", "kept.md"), "# Kept\n\nKept note.\n");
    symlinkSync(join(env.vault, "Other"), join(env.vault, "OtherLink"));
    const config = resolveSearchConfig({ vault: env.vault, configPath: env.configPath });
    await reindexVault(config);
    const paths = await indexedPaths(config);
    expect(paths.filter((p) => p.startsWith("Archive/"))).toEqual([]);
    expect(paths).not.toContain("Notes/dunlin-link.md");
    expect(paths).toContain("Other/kept.md");
    expect(paths).toContain("Notes/mudflat.md");
  },
);

test("a vault that never migrated keeps its Brain/ pages in the index", async () => {
  env = makeStoreEnv("osb-legacy-kept-", { dualWrite: false });
  seed(env.vault);
  const config = resolveSearchConfig({ vault: env.vault, configPath: env.configPath });
  expect(legacyTreeArchived(config)).toBe(false);
  await reindexVault(config);
  const paths = await indexedPaths(config);
  expect(paths).toContain("Notes/mudflat.md");
  expect(paths).toContain("Brain/inbox/sig-2026-11-01-dunlin.md");
  expect(paths).toContain("Brain/log/2026-11-01.md");
});
