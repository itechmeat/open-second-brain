/**
 * One read of the store's schema records per apply (task 3.12, design D19
 * item 1): the pack an apply starts from, the records that decide it and
 * the entries a repair may remove all come from one fold of the shared
 * settings stream, so a record that syncs in while an apply runs can
 * neither be removed as a repair nor build a pack its audit row does not
 * attest. A record under a schema list key that holds no list is rejected
 * by the fold, so it can never hide the stored list.
 */
import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  BrainSettingError,
  setBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import {
  assessSchemaPackIntegrity,
  computeSchemaPackDigest,
} from "../../../src/core/brain/schema-integrity.ts";
import { applySchemaMutationsToStore } from "../../../src/core/brain/schema-mutate-store.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import {
  loadSchemaPack,
  parseSchemaPack,
  readStoreSchemaPack,
  renderSchemaBlock,
} from "../../../src/core/brain/schema-pack.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_ENTRY_KIND, SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { foldSettings } from "../../../src/core/store/fold-settings.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";
import { compareHlc, parseHlc } from "../../../src/core/store/hlc.ts";
import { shardMonth, shardPath } from "../../../src/core/store/store-paths.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { importBrainSettings } from "../../../src/core/store-migration/brain-settings.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  setSystemTime();
});

let step = 0;
function tick(): Date {
  step += 1;
  const now = new Date(Date.UTC(2031, 0, 1, 12, 0, step));
  setSystemTime(now);
  return now;
}

const addType = (token: string): SchemaMutation => ({
  op: "add_type",
  category: "page_types",
  token,
});

/** A shared settings record another device wrote, delivered into `env`'s store. */
function peerRecord(e: StoreEnv, kind: string, body: Record<string, unknown>): string {
  tick();
  return appendRecord(openStore({ root: e.storeRoot, device: "dev-peer" }), {
    partition: "shared",
    stream: "settings",
    kind,
    agent: "peer",
    body,
  }).record.id;
}

const schemaEntries = (root: string) =>
  partitionRecords(root, "shared").filter((r) => r.kind === SETTING_ENTRY_KIND);

/** A store-only machine whose pack the migration imported: `page_types: [paper, memo]`. */
function importedStore(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix);
  writeFileSync(
    brainConfigPath(e.vault),
    "schema_version: 1\nschema:\n  page_types:\n    - paper\n    - memo\n",
  );
  tick();
  importBrainSettings(e.vault, openStore({ root: e.storeRoot, device: "dev-a" }), "migrator");
  switchDevice(e.storeRoot);
  return e;
}

describe("the store's schema pack read once", () => {
  test("returns the pack and the records deciding it from one fold", () => {
    env = importedStore("osb-schema-snapshot-read-");
    const snapshot = readStoreSchemaPack();
    expect(snapshot.source.present).toBe(true);
    expect(snapshot.source.pack).toEqual(loadSchemaPack(env.vault));
    expect(snapshot.fields).toEqual({ page_types: ["paper", "memo"] });
    const imported = partitionRecords(env.storeRoot, "shared").filter(
      (r) => r.kind === SETTING_SET_KIND && r.body["key"] === "brain.schema.page_types",
    );
    expect(snapshot.deciding.map((r) => r.id)).toEqual(imported.map((r) => r.id));
  });
});

describe("an entry another device adds while an apply runs", () => {
  test("is never removed as a repair, and the apply's row does not attest it", async () => {
    env = importedStore("osb-schema-snapshot-repair-");
    const e = env;
    let peer = "";
    await applySchemaMutationsToStore(e.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
      next: (current) => {
        // The peer's entry syncs in after the apply read the pack.
        peer = peerRecord(e, SETTING_ENTRY_KIND, {
          authority: "human",
          key: "brain.schema.page_types",
          entry: "idea",
          present: true,
        });
        return parseSchemaPack(
          `schema_version: 1\n${renderSchemaBlock(current).replace(
            "    - memo\n",
            "    - memo\n    - person\n",
          )}`,
        );
      },
    });
    const removals = schemaEntries(e.storeRoot).filter((r) => r.body["present"] === false);
    expect(removals).toEqual([]);
    expect(loadSchemaPack(e.vault).declarations.page_types?.toSorted()).toEqual([
      "idea",
      "memo",
      "paper",
      "person",
    ]);
    // The peer's record is no record this apply saw: still unattested.
    await expect(
      applySchemaAdminMutations(e.vault, [addType("memo2")], {
        actor: "operator-ann",
        now: tick(),
        authority: "human",
      }),
    ).rejects.toMatchObject({ code: "unattested_schema_records", records: [peer] });
  });
});

describe("a record under a schema list key that holds no list", () => {
  test("is rejected by the fold and cannot hide the stored list, imported or merged per entry", async () => {
    env = importedStore("osb-schema-scalar-");
    const scalar = peerRecord(env, SETTING_SET_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      value: "oops",
    });
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo"]);
    const records = partitionRecords(env.storeRoot, "shared");
    expect(foldSettings(records).rejected.map((r) => r.id)).toContain(scalar);
    // The same once the key folds per entry.
    await applySchemaAdminMutations(env.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
    });
    peerRecord(env, SETTING_SET_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      value: 7,
    });
    peerRecord(env, SETTING_SET_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      value: ["paper\n  link_types:\n    - forged"],
    });
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo", "person"]);
    expect(loadSchemaPack(env.vault).link_types).toEqual([]);
    expect(assessSchemaPackIntegrity(env.vault).status).toBe("ok");
    // Lists, removals and entries keep working.
    peerRecord(env, SETTING_SET_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      value: ["paper"],
    });
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper"]);
  });

  test("is refused by the settings writer, on a store-only and on an unswitched machine", () => {
    env = importedStore("osb-schema-scalar-write-");
    const ctx = { vault: env.vault, authority: "human" as const, agent: "ann" };
    expect(() => setBrainSetting(ctx, "schema.page_types", "oops")).toThrow(BrainSettingError);
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo"]);
    env.cleanup();
    env = makeStoreEnv("osb-schema-scalar-write-legacy-", { dualWrite: false });
    const config = "schema_version: 1\nschema:\n  page_types:\n    - paper\n";
    writeFileSync(brainConfigPath(env.vault), config);
    expect(() =>
      setBrainSetting({ ...ctx, vault: env!.vault }, "schema.page_types", "oops"),
    ).toThrow(BrainSettingError);
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(config);
  });
});

describe("an empty batch with --adopt-unattested on an unswitched machine", () => {
  test("is refused when the batch is given as an empty list too, and _brain.yaml is left as it is", async () => {
    env = makeStoreEnv("osb-schema-adopt-empty-list-", { dualWrite: false });
    const config = "schema_version: 1\nschema:\n  page_types: [ Paper ]\n";
    writeFileSync(brainConfigPath(env.vault), config);
    const opts = { env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: env.configPath } };
    const refused = await runCli(
      ["brain", "schema", "apply", "--adopt-unattested", "--mutation", "[]", "--actor", "ann"],
      opts,
    );
    expect(refused.returncode).not.toBe(0);
    expect(refused.stderr).toContain("store-only machine");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(config);
  });

  test("is refused by the lane itself, whoever calls it", async () => {
    env = makeStoreEnv("osb-schema-adopt-empty-lane-", { dualWrite: false });
    const config = "schema_version: 1\nschema:\n  page_types: [ Paper ]\n";
    writeFileSync(brainConfigPath(env.vault), config);
    await expect(
      applySchemaAdminMutations(env.vault, [], {
        actor: "ann",
        now: tick(),
        authority: "human",
        adoptUnattested: true,
      }),
    ).rejects.toThrow("store-only machine");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(config);
    expect(computeSchemaPackDigest(loadSchemaPack(env.vault))).toBeString();
  });
});

describe("a record no apply wrote that leaves the pack as it was", () => {
  test("makes the integrity read report the pack as modified, as the next apply refuses it", async () => {
    env = importedStore("osb-schema-unattested-same-pack-");
    await applySchemaAdminMutations(env.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
    });
    expect(assessSchemaPackIntegrity(env.vault).status).toBe("ok");
    const before = computeSchemaPackDigest(loadSchemaPack(env.vault));
    // Another device sets an entry the pack already holds: same pack, new record.
    const forged = peerRecord(env, SETTING_ENTRY_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      entry: "person",
      present: true,
    });
    expect(computeSchemaPackDigest(loadSchemaPack(env.vault))).toBe(before);
    const integrity = assessSchemaPackIntegrity(env.vault);
    expect(integrity.status).toBe("modified");
    expect(JSON.stringify(integrity.mismatches)).toContain(forged);
    await expect(
      applySchemaAdminMutations(env.vault, [addType("memo2")], {
        actor: "operator-ann",
        now: tick(),
        authority: "human",
      }),
    ).rejects.toMatchObject({ code: "unattested_schema_records", records: [forged] });
  });
});

/** A dangling prefix (`p=ghost`, a type nobody declared) another device wrote. */
function danglingPrefix(e: StoreEnv): string {
  return peerRecord(e, SETTING_ENTRY_KIND, {
    authority: "human",
    key: "brain.schema.prefixes",
    entry: "p=ghost",
    present: true,
  });
}

describe("a repair of a dangling keyed entry", () => {
  test("never removes a newer replacement of the same slot that arrived while the apply ran", async () => {
    env = importedStore("osb-schema-repair-replaced-");
    const e = env;
    danglingPrefix(e);
    expect(loadSchemaPack(e.vault).prefixes).toEqual({});
    await applySchemaMutationsToStore(e.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
      adoptUnattested: true,
      next: (current) => {
        // The peer replaces the prefix with a valid one after the apply read the pack.
        peerRecord(e, SETTING_ENTRY_KIND, {
          authority: "human",
          key: "brain.schema.prefixes",
          entry: "p=paper",
          present: true,
        });
        return parseSchemaPack(
          `schema_version: 1\n${renderSchemaBlock(current).replace(
            "    - memo\n",
            "    - memo\n    - person\n",
          )}`,
        );
      },
    });
    expect(loadSchemaPack(e.vault).prefixes).toEqual({ p: "paper" });
  });

  test("never removes a replacement written before the repair but delivered after it", async () => {
    env = importedStore("osb-schema-repair-late-replacement-");
    const e = env;
    const ghost = danglingPrefix(e);
    const ghostMs = Number(
      partitionRecords(e.storeRoot, "shared")
        .find((r) => r.id === ghost)!
        .hlc.split(".")[0],
    );
    await applySchemaAdminMutations(e.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
      adoptUnattested: true,
    });
    // Only now does sync deliver the peer's replacement, stamped before the
    // repair (half a second after `p=ghost`), so the repair never saw it:
    // its line lands in the peer's shard as a sync tool would put it there.
    const physical = ghostMs + 500;
    const line = buildRecord({
      hlc: { physical, counter: 0 },
      device: "dev-peer",
      agent: "peer",
      kind: SETTING_ENTRY_KIND,
      scope: null,
      topic: null,
      body: { authority: "human", key: "brain.schema.prefixes", entry: "p=paper", present: true },
    });
    appendFileSync(
      shardPath(e.storeRoot, "shared", { stream: "settings" }, "dev-peer", shardMonth(physical)),
      `${JSON.stringify(line)}\n`,
    );
    const repair = schemaEntries(e.storeRoot).find(
      (r) => r.body["present"] === false && r.body["entry"] === "p=ghost",
    );
    const replacement = schemaEntries(e.storeRoot).find((r) => r.body["entry"] === "p=paper");
    // The repair was written (no other record decided the slot when it
    // was) and orders after the replacement.
    expect(repair).toBeDefined();
    expect(compareHlc(parseHlc(replacement!.hlc)!, parseHlc(repair!.hlc)!)).toBeLessThan(0);
    expect(loadSchemaPack(e.vault).prefixes).toEqual({ p: "paper" });
  });
});

describe("an imported compound attribute key with spaces around its dot", () => {
  test("is no dangling reference: an unrelated apply keeps it", async () => {
    const e = makeStoreEnv("osb-schema-compound-spaced-");
    env = e;
    writeFileSync(
      brainConfigPath(e.vault),
      "schema_version: 1\nschema:\n  page_types:\n    - paper\n    - memo\n" +
        "  attributes:\n    - paper . year=Publication year\n",
    );
    tick();
    importBrainSettings(e.vault, openStore({ root: e.storeRoot, device: "dev-a" }), "migrator");
    switchDevice(e.storeRoot);
    expect(loadSchemaPack(e.vault).attributes).toEqual({ paper: { year: "Publication year" } });

    await applySchemaAdminMutations(e.vault, [addType("person")], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
    });

    expect(schemaEntries(e.storeRoot).filter((r) => r.body["present"] === false)).toEqual([]);
    expect(loadSchemaPack(e.vault).attributes).toEqual({ paper: { year: "Publication year" } });
  });
});

describe("an adoption-only apply on a store-only machine", () => {
  test("writes no entry record, a dangling one's repair included", async () => {
    env = importedStore("osb-schema-adopt-only-no-entries-");
    const dangling = danglingPrefix(env);
    const entries = schemaEntries(env.storeRoot).length;
    await applySchemaMutationsToStore(env.vault, [], {
      actor: "operator-ann",
      now: tick(),
      authority: "human",
      adoptUnattested: true,
      next: (current) => current,
    });
    expect(schemaEntries(env.storeRoot)).toHaveLength(entries);
    expect(readStoreSchemaPack().fields["prefixes"]).toEqual(["p=ghost"]);
    // The adoption itself is recorded: the dangling record is attested now.
    expect(assessSchemaPackIntegrity(env.vault).status).toBe("ok");
    expect(readStoreSchemaPack().deciding.map((r) => r.id)).toContain(dangling);
  });
});
