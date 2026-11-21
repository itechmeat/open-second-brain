/**
 * `Brain/_vault-map.yaml` (the role tokens `o2b vault map`, the note walk
 * and graph import resolve) had no destination in the migration: the dry
 * run listed it as unmapped, the automatic migration refused on it, and
 * once the legacy tree left the vault the built-in folder names applied
 * silently. Its text now becomes the operator-only shared setting
 * `vault_map.document`, as `_permissions.yaml` becomes
 * `permissions.document`; a machine that switched before this release
 * reads the copy its removal kept in the device-local legacy archive once
 * and stores it.
 */
import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as settingsWrite from "../../../src/core/brain/policy/settings-write.ts";
import { unsetBrainSetting } from "../../../src/core/brain/policy/settings-write.ts";
import { loadVaultMap } from "../../../src/core/brain/portability/role-tokens.ts";
import { VAULT_MAP_SETTING } from "../../../src/core/brain/portability/vault-map-document.ts";
import {
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
  STORE_LINE_CAP_BYTES,
} from "../../../src/core/store/constants.ts";
import { blobPath } from "../../../src/core/store/store-paths.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { planMigrationDryRun } from "../../../src/core/store-migration/dry-run.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { readRemovalMarker } from "../../../src/core/store-migration/removal-marker.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

const PEER = "dev-b";

const MAP = "# role tokens\ninbox: 00 Inbox\nprojects: 10 Projects\n";

function settingRecords(b: MigrationBench) {
  return b
    .records()
    .filter((r) => r.kind === SETTING_SET_KIND && r.body["key"] === VAULT_MAP_SETTING);
}

test("the migration carries the vault map into the operator's setting", () => {
  bench = makeMigrationBench("osb-vault-map-");
  const { vault } = bench;
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(planMigrationDryRun(vault).unmapped.map((e) => e.path)).not.toContain(
    "Brain/_vault-map.yaml",
  );

  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  const records = settingRecords(bench);
  expect(records).toHaveLength(1);
  expect(records[0]!.body["authority"]).toBe("human");
  expect(records[0]!.body["value"]).toBe(MAP);

  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
  const map = loadVaultMap(vault);
  expect(map["inbox"]).toBe("00 Inbox");
  expect(map["projects"]).toBe("10 Projects");
  expect(map["areas"]).toBe("areas");
});

test("a machine that switched before reads the archived vault map once and stores it", () => {
  bench = makeMigrationBench("osb-vault-map-archive-");
  const { vault } = bench;
  // As a release without the import left it: the migration ran, the map
  // stayed in the tree with no setting, and the removal archived it.
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(settingRecords(bench)).toHaveLength(0);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  const marker = readRemovalMarker(bench.store(), vault);
  expect(marker).not.toBeNull();
  expect(readFileSync(join(marker!.archive, "Brain", "_vault-map.yaml"), "utf8")).toBe(MAP);

  expect(loadVaultMap(vault)["inbox"]).toBe("00 Inbox");
  const stored = settingRecords(bench);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.body["value"]).toBe(MAP);
  // Read once: the setting answers from now on, even with the archive gone.
  rmSync(marker!.archive, { recursive: true, force: true });
  expect(loadVaultMap(vault)["projects"]).toBe("10 Projects");
  expect(settingRecords(bench)).toHaveLength(1);
});

test("an operator's unset of the carried-over vault map is not undone by the archive", () => {
  bench = makeMigrationBench("osb-vault-map-unset-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  expect(loadVaultMap(vault)["inbox"]).toBe("00 Inbox");
  expect(settingRecords(bench)).toHaveLength(1);

  // The operator unsets it to go back to the built-in folder names. The
  // archive still holds the old map; the unset is a decision, not a
  // setting that never existed, so the map is not carried over again.
  unsetBrainSetting({ vault, authority: "human", agent: "operator" }, VAULT_MAP_SETTING);
  expect(loadVaultMap(vault)["inbox"]).toBe("inbox");
  expect(loadVaultMap(vault)["projects"]).toBe("projects");
  expect(settingRecords(bench)).toHaveLength(1);
});

test("the archived vault map is not carried over while a settings shard cannot be read", () => {
  bench = makeMigrationBench("osb-vault-map-unseen-");
  const { vault, storeRoot } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);

  // A peer carried the map over and its operator unset it there: the peer's
  // settings shard holds both records, this machine's holds none.
  const peer = openStore({ root: storeRoot, device: PEER });
  const record = (kind: string, body: Record<string, unknown>) =>
    appendRecord(peer, {
      partition: "shared",
      stream: "settings",
      kind,
      agent: "u",
      body,
    }).path;
  record(SETTING_SET_KIND, {
    authority: "human",
    key: VAULT_MAP_SETTING,
    value: MAP,
  });
  const shard = record(SETTING_UNSET_KIND, {
    authority: "human",
    key: VAULT_MAP_SETTING,
  });
  expect(loadVaultMap(vault)["inbox"]).toBe("inbox");
  expect(settingRecords(bench)).toHaveLength(1);

  // The peer's shard goes missing: the operator's unset is unseen, so the
  // archive is no proof that no record exists. Nothing is written.
  rmSync(shard);
  expect(loadVaultMap(vault)["inbox"]).toBe("inbox");
  expect(loadVaultMap(vault)["projects"]).toBe("projects");
  expect(settingRecords(bench)).toHaveLength(0);
});

test("the archived vault map is not carried over while a settings record waits for its blob", () => {
  bench = makeMigrationBench("osb-vault-map-pending-");
  const { vault, storeRoot } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);

  // The peer's unset arrives without its body blob: the record is not
  // readable yet, so it may be the operator's reset. Nothing is written.
  const peer = openStore({ root: storeRoot, device: PEER });
  const { record } = appendRecord(peer, {
    partition: "shared",
    stream: "settings",
    kind: SETTING_UNSET_KIND,
    agent: "u",
    body: { authority: "human", key: VAULT_MAP_SETTING, note: "x".repeat(STORE_LINE_CAP_BYTES) },
  });
  rmSync(blobPath(join(storeRoot, "shared"), record.sum), { force: true });
  expect(loadVaultMap(vault)["inbox"]).toBe("inbox");
  expect(settingRecords(bench)).toHaveLength(0);
});

// Captured at module load, before a `mock.module` call can replace it.
const realCarryOver = settingsWrite.carryOverBrainSetting;

test("a carry-over refused because the operator set the map meanwhile answers that map", () => {
  bench = makeMigrationBench("osb-vault-map-raced-");
  const { vault, storeRoot } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  bench.fx.write("Brain/_vault-map.yaml", MAP);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);

  // The operator's map lands on a peer between the reader's look at the
  // setting and the carry-over's own read, which then refuses.
  const theirs = "inbox: 01 Their Inbox\n";
  mock.module("../../../src/core/brain/policy/settings-write.ts", () => ({
    ...settingsWrite,
    carryOverBrainSetting(...args: Parameters<typeof realCarryOver>) {
      appendRecord(openStore({ root: storeRoot, device: PEER }), {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "u",
        body: { authority: "human", key: VAULT_MAP_SETTING, value: theirs },
      });
      return realCarryOver(...args);
    },
  }));
  let inbox: string | undefined;
  try {
    inbox = loadVaultMap(vault)["inbox"];
  } finally {
    mock.module("../../../src/core/brain/policy/settings-write.ts", () => settingsWrite);
  }
  expect(inbox).toBe("01 Their Inbox");
  expect(settingRecords(bench).map((r) => r.body["value"])).toEqual([theirs]);
});
