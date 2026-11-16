/**
 * Concurrent schema applies on two store-only machines (task 3.12, design
 * D19 item 1): each apply writes one `setting-entry` record per entry it
 * adds or removes, so edits two devices make before they sync both
 * survive, and both machines converge on one pack whatever order the sync
 * delivers the shards in. The merged pack stays attested.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import { assessSchemaPackIntegrity } from "../../../src/core/brain/schema-integrity.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import { storeSchemaFields } from "../../../src/core/brain/schema-pack-store.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_ENTRY_KIND, SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { importBrainSettings } from "../../../src/core/store-migration/brain-settings.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { sync, twoMachines, use, type Machine } from "./store-only/two-machines.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  setSystemTime();
});

/** A fixed clock past the fixtures' own wall time: each step is one second after the one before. */
let step = 0;
function tick(): Date {
  step += 1;
  const now = new Date(Date.UTC(2030, 0, 1, 12, 0, step));
  setSystemTime(now);
  return now;
}

async function apply(m: Machine, mutations: SchemaMutation[]): Promise<void> {
  use(m);
  const now = tick();
  await applySchemaAdminMutations(m.vault, mutations, {
    actor: m.device,
    now,
    authority: "human",
  });
}

const addType = (token: string): SchemaMutation => ({
  op: "add_type",
  category: "page_types",
  token,
});
const removeType = (token: string): SchemaMutation => ({
  op: "remove_type",
  category: "page_types",
  token,
});

function pageTypes(m: Machine): ReadonlyArray<string> | undefined {
  use(m);
  return loadSchemaPack(m.vault).declarations.page_types;
}

describe("schema field lists edited on two devices at once", () => {
  for (const order of ["a-first", "b-first"] as const) {
    test(`converge to one set on both machines (sync ${order})`, async () => {
      env = makeStoreEnv(`osb-schema-merge-${order}-`);
      const [a, b] = twoMachines(env);
      await apply(a, [addType("paper"), addType("report")]);
      sync(a, b);
      expect(pageTypes(b)).toEqual(["paper", "report"]);

      // Before either syncs: A adds one type and removes another, B adds a
      // third and removes `paper`, which A then removes and adds back later.
      await apply(a, [addType("person"), removeType("report")]);
      await apply(b, [addType("memo"), removeType("paper")]);
      await apply(a, [removeType("paper")]);
      await apply(a, [addType("paper")]);

      if (order === "a-first") {
        sync(a, b);
        sync(b, a);
      } else {
        sync(b, a);
        sync(a, b);
      }
      // `paper`: A's add is later than B's remove, so the add wins (later
      // clock within one authority, design D4).
      const expected = ["person", "memo", "paper"];
      expect(pageTypes(a)).toEqual(expected);
      expect(pageTypes(b)).toEqual(expected);

      // The merged pack is no single apply's output, and it is still attested.
      for (const m of [a, b]) {
        use(m);
        expect(assessSchemaPackIntegrity(m.vault).status).toBe("ok");
      }
    });
  }
});

/** Append one shared settings record as machine `m`, outside any schema apply. */
function rawSetting(m: Machine, kind: string, body: Record<string, unknown>): void {
  use(m);
  tick();
  appendRecord(openStore({ root: m.storeRoot, device: m.device }), {
    partition: "shared",
    stream: "settings",
    kind,
    agent: "other-tool",
    body,
  });
}

describe("schema field lists imported as whole lists", () => {
  test("the migration's whole list reads, and applies on two machines edit it per entry", async () => {
    env = makeStoreEnv("osb-schema-merge-import-");
    const [a, b] = twoMachines(env);
    use(a);
    tick();
    writeFileSync(
      brainConfigPath(a.vault),
      "schema_version: 1\nschema:\n  page_types:\n    - note\n    - paper\n",
    );
    importBrainSettings(a.vault, openStore({ root: a.storeRoot, device: a.device }), "migrator");
    expect(pageTypes(a)).toEqual(["note", "paper"]);
    sync(a, b);
    await apply(b, [addType("memo"), removeType("note")]);
    await apply(a, [addType("person")]);
    sync(a, b);
    sync(b, a);
    expect(pageTypes(a)).toEqual(["paper", "memo", "person"]);
    expect(pageTypes(b)).toEqual(["paper", "memo", "person"]);
    use(a);
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
  });
  test("an entry no audited apply wrote still reports the merged pack as modified", async () => {
    env = makeStoreEnv("osb-schema-merge-forged-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    await apply(b, [addType("memo")]);
    sync(a, b);
    sync(b, a);
    use(a);
    expect(assessSchemaPackIntegrity(a.vault)).toMatchObject({ status: "ok", merged: true });
    rawSetting(a, SETTING_ENTRY_KIND, {
      authority: "agent",
      key: "brain.schema.page_types",
      entry: "forged",
      present: true,
    });
    expect(pageTypes(a)).toContain("forged");
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("modified");
  });
});

describe("references across fields edited on two devices at once", () => {
  test("a removed type and a reference to it added elsewhere read as one consistent pack", async () => {
    env = makeStoreEnv("osb-schema-merge-refs-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper"), addType("note"), { op: "add_link_type", token: "cites" }]);
    sync(a, b);
    // A removes `paper`; B, before it syncs, adds an alias, a prefix and a
    // link constraint pair that name it.
    await apply(a, [removeType("paper")]);
    await apply(b, [
      { op: "add_alias", token: "paper", alias: "article" },
      { op: "add_prefix", prefix: "ppr", token: "paper" },
      { op: "add_link_constraint", link_type: "cites", source: "paper", target: "note" },
    ]);
    sync(a, b);
    sync(b, a);
    for (const m of [a, b]) {
      use(m);
      const pack = loadSchemaPack(m.vault);
      expect(pack.declarations.page_types).toEqual(["note"]);
      // The references to the undeclared type are dropped on read, the
      // cascade `remove_type` applies, on every machine alike.
      expect(pack.aliases).toEqual({});
      expect(pack.prefixes).toEqual({});
      // A pair with an undeclared endpoint would still match a page whose
      // frontmatter keeps `type: paper`, so it is dropped, and with it the
      // link type's key once no pair remains.
      expect(pack.link_constraints).toEqual({});
    }
    // A later unrelated apply works on either machine, and writes the
    // repair as entry removals, so the next machine reads it from records.
    await apply(a, [addType("memo")]);
    await apply(b, [addType("person")]);
    sync(a, b);
    sync(b, a);
    for (const m of [a, b]) {
      use(m);
      const pack = loadSchemaPack(m.vault);
      expect(pack.declarations.page_types).toEqual(["note", "memo", "person"]);
      expect(pack.aliases).toEqual({});
      expect(storeSchemaFields()["aliases"]).toBeUndefined();
      expect(storeSchemaFields()["prefixes"]).toBeUndefined();
      expect(storeSchemaFields()["link_constraints"]).toBeUndefined();
      expect(assessSchemaPackIntegrity(m.vault).status).toBe("ok");
    }
  });
});

describe("a keyed field edited on two devices at once", () => {
  test("a concurrent change of one prefix keeps the later value, other prefixes merge", async () => {
    env = makeStoreEnv("osb-schema-merge-keyed-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper"), addType("project"), addType("person")]);
    sync(a, b);
    await apply(a, [{ op: "add_prefix", prefix: "p", token: "paper" }]);
    await apply(b, [
      { op: "add_prefix", prefix: "p", token: "project" },
      { op: "add_prefix", prefix: "who", token: "person" },
    ]);
    sync(a, b);
    sync(b, a);
    for (const m of [a, b]) {
      use(m);
      expect(loadSchemaPack(m.vault).prefixes).toEqual({ p: "project", who: "person" });
      expect(assessSchemaPackIntegrity(m.vault).status).toBe("ok");
    }
  });
});

describe("records under brain.schema. that are no pack field", () => {
  test("do not turn a merged pack into modified", async () => {
    env = makeStoreEnv("osb-schema-merge-outside-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    await apply(b, [addType("memo")]);
    sync(a, b);
    sync(b, a);
    use(a);
    expect(assessSchemaPackIntegrity(a.vault)).toMatchObject({ status: "ok", merged: true });
    rawSetting(a, SETTING_SET_KIND, {
      authority: "agent",
      key: "brain.schema.page_types.extra",
      value: ["x"],
    });
    rawSetting(a, SETTING_SET_KIND, {
      authority: "agent",
      key: "brain.schema.notes",
      value: "not a list",
    });
    expect(assessSchemaPackIntegrity(a.vault)).toMatchObject({ status: "ok", merged: true });
  });
});
