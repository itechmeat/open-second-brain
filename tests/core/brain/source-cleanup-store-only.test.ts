/**
 * `delete_by_source` removals on a store-only machine: a retired
 * preference page is forgotten by its preference record, and the user's
 * original files are removed only behind the vault adapter's guard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadPreference,
  moveToRetired,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import { deleteBySource, removeFile } from "../../../src/core/brain/source-cleanup.ts";
import { storeMemoryPageAt } from "../../../src/core/brain/memory-pages.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  bindVaultToStore,
  VaultBindingMismatchError,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-07T12:00:00Z");

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-cleanup-store-", { dualWrite: false });
  appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
  return e;
}

describe("source cleanup removals once switched", () => {
  test("a retired preference page is removed by its preference record", () => {
    env = switchedEnv();
    const written = writePreference(
      env.vault,
      {
        slug: "gone",
        topic: "t",
        principle: "principle gone",
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-30T00:00:00Z",
        status: "confirmed",
        evidenced_by: [],
      },
      { authority: "agent" },
    );
    moveToRetired(env.vault, written.path, "stale-no-evidence", { now: NOW, retired_by: "@t" });
    const rel = "Brain/retired/ret-gone.md";
    expect(storeMemoryPageAt(env.vault, rel)).not.toBeNull();
    expect(removeFile(env.vault, rel)).toBe(true);
    expect(storeMemoryPageAt(env.vault, rel)).toBeNull();
    expect(loadPreference(env.vault, "gone")).toBeNull();
  });

  test("originals of a vault that is not the one bound to the store are not removed", () => {
    env = switchedEnv();
    mkdirSync(join(env.vault, "notes"), { recursive: true });
    const original = join(env.vault, "notes", "a.md");
    writeFileSync(original, "# A\n");
    const other = join(env.parent, "other-vault");
    mkdirSync(other, { recursive: true });
    bindVaultToStore(other, { configPath: env.configPath });
    expect(() =>
      deleteBySource(env!.vault, "notes/a.md", { confirm: true, includeOriginals: true, now: NOW }),
    ).toThrow(VaultBindingMismatchError);
    expect(existsSync(original)).toBe(true);
  });
});
