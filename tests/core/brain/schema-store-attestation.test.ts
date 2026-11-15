/**
 * What an audit row of a store-only schema apply attests (task 3.12,
 * design D19 item 1): the records its own apply wrote, plus records rows
 * it has seen already attest, never every record that happens to decide
 * the pack. A deciding record no row attests is a finding the apply
 * refuses over, unless the operator adopts it by name. The migration's
 * import attests its records with a baseline row, and rows written before
 * rows named records keep the digest comparison.
 */
import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { appendAuditRecord } from "../../../src/core/reliability/audit.ts";
import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import {
  assessSchemaPackIntegrity,
  computeSchemaPackDigest,
  schemaMutationAuditDir,
} from "../../../src/core/brain/schema-integrity.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_ENTRY_KIND, SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { bodyChecksum, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { importBrainSettings } from "../../../src/core/store-migration/brain-settings.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { ledgerRows, partitionRecords, switchDevice } from "./store-only/fixtures.ts";
import { sync, twoMachines, use, type Machine } from "./store-only/two-machines.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  setSystemTime();
});

let step = 0;
/** A fixed clock past the fixtures' own wall time, one second per step. */
function tick(): Date {
  step += 1;
  const now = new Date(Date.UTC(2030, 0, 1, 12, 0, step));
  setSystemTime(now);
  return now;
}

const addType = (token: string): SchemaMutation => ({
  op: "add_type",
  category: "page_types",
  token,
});

async function apply(
  m: Machine | StoreEnv,
  mutations: SchemaMutation[],
  extra: { adoptUnattested?: boolean; authority?: "human" | "agent"; reason?: string } = {},
) {
  if ("device" in m) use(m);
  return await applySchemaAdminMutations(m.vault, mutations, {
    actor: "operator-ann",
    now: tick(),
    authority: "human",
    ...extra,
  });
}

/** One shared settings record no apply wrote. */
function forge(m: Machine, kind: string, body: Record<string, unknown>): string {
  use(m);
  tick();
  return appendRecord(openStore({ root: m.storeRoot, device: m.device }), {
    partition: "shared",
    stream: "settings",
    kind,
    agent: "other-tool",
    body,
  }).record.id;
}

const forgedEntry = {
  authority: "agent",
  key: "brain.schema.page_types",
  entry: "forged",
  present: true,
};

type Row = { audit_dir?: string; record?: { action?: string; details?: Record<string, unknown> } };
const schemaRows = (root: string, partition: "shared" | "private") =>
  (ledgerRows(root, partition, "reliability-audit") as Row[]).filter(
    (row) => row.audit_dir === "schema-mutations",
  );

describe("an unattested record under an apply", () => {
  test("the apply refuses with a named reason, and another machine's apply attests nothing of it", async () => {
    env = makeStoreEnv("osb-schema-attest-forged-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    sync(a, b);
    forge(b, SETTING_ENTRY_KIND, forgedEntry);
    await expect(apply(b, [addType("memo")])).rejects.toMatchObject({
      code: "unattested_schema_records",
    });
    // A never saw the forged record; its apply cannot attest it.
    await apply(a, [addType("person")]);
    sync(a, b);
    sync(b, a);
    for (const m of [a, b]) {
      use(m);
      expect(loadSchemaPack(m.vault).declarations.page_types).toContain("forged");
      expect(assessSchemaPackIntegrity(m.vault).status).toBe("modified");
    }
  });

  test("the operator adopts it by name: the row records the adoption and the pack is attested again", async () => {
    env = makeStoreEnv("osb-schema-attest-adopt-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    sync(a, b);
    const forged = forge(b, SETTING_ENTRY_KIND, forgedEntry);
    await apply(b, [addType("memo")], { adoptUnattested: true, authority: "human" });
    const [row] = schemaRows(b.storeRoot, "shared").slice(-1);
    expect(row?.record?.details).toMatchObject({ adopted: [forged], adopted_by: "operator-ann" });
    sync(b, a);
    for (const m of [a, b]) {
      use(m);
      expect(assessSchemaPackIntegrity(m.vault).status).toBe("ok");
    }
  });

  test("an agent cannot adopt", async () => {
    env = makeStoreEnv("osb-schema-attest-agent-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    sync(a, b);
    forge(b, SETTING_ENTRY_KIND, forgedEntry);
    await expect(
      apply(b, [addType("memo")], { adoptUnattested: true, authority: "agent" }),
    ).rejects.toMatchObject({ code: "unattested_schema_records" });
  });

  test("the CLI adopts with --adopt-unattested and names the operator", async () => {
    env = makeStoreEnv("osb-schema-attest-cli-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    sync(a, b);
    const forged = forge(b, SETTING_ENTRY_KIND, forgedEntry);
    const args = ["brain", "schema", "apply", "--mutation", JSON.stringify(addType("memo"))];
    const opts = { env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: b.configPath } };
    const refused = await runCli([...args, "--actor", "ann"], opts);
    expect(refused.returncode).not.toBe(0);
    expect(refused.stderr).toContain("--adopt-unattested");
    const adopted = await runCli([...args, "--actor", "ann", "--adopt-unattested"], opts);
    expect(adopted.returncode).toBe(0);
    const [row] = schemaRows(b.storeRoot, "shared").slice(-1);
    expect(row?.record?.details).toMatchObject({ adopted: [forged], adopted_by: "ann" });
  });
});

describe("a record the attestation names", () => {
  test("is attested only in the version the row saw: another body under its id is a finding", async () => {
    env = makeStoreEnv("osb-schema-attest-reused-id-");
    const [a] = twoMachines(env);
    await apply(a, [addType("paper")]);
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
    const original = partitionRecords(a.storeRoot, "shared").find(
      (r) => r.kind === SETTING_ENTRY_KIND && r.body["entry"] === "paper",
    )!;
    // Another version of the attested record: same id, another body, a
    // checksum that matches it. Ordered first among the versions of the id.
    const body = { ...original.body, authority: "agent", entry: "forged" };
    const forged: StoreRecord = { ...original, body, sum: bodyChecksum(body) };
    appendFileSync(shardHolding(a.storeRoot, original.id), `${JSON.stringify(forged)}\n`);
    use(a);
    expect(loadSchemaPack(a.vault).declarations.page_types).toEqual(["forged"]);
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("modified");
    await expect(apply(a, [addType("memo")])).rejects.toMatchObject({
      code: "unattested_schema_records",
    });
  });
});

describe("a record under brain.schema. that no pack field reads", () => {
  test("is not attested and does not hold up the next apply", async () => {
    env = makeStoreEnv("osb-schema-attest-not-a-field-");
    const [a] = twoMachines(env);
    await apply(a, [addType("paper")]);
    forge(a, SETTING_SET_KIND, { authority: "human", key: "brain.schema.notes", value: ["x"] });
    use(a);
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
    await apply(a, [addType("memo")]);
    expect(loadSchemaPack(a.vault).declarations.page_types).toEqual(["paper", "memo"]);
  });
});

/** The shard file of `root/shared/settings` that holds record `id`. */
function shardHolding(root: string, id: string): string {
  const dir = join(root, "shared", "settings");
  const found = (readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => join(dir, rel))
    .find((path) => path.endsWith(".jsonl") && readFileSync(path, "utf8").includes(id));
  if (found === undefined) throw new Error(`no settings shard holds ${id}`);
  return found;
}

describe("adoption on its own", () => {
  test("o2b brain schema apply --adopt-unattested adopts with no mutation and changes no entry", async () => {
    env = makeStoreEnv("osb-schema-attest-adopt-only-");
    const [a, b] = twoMachines(env);
    await apply(a, [addType("paper")]);
    sync(a, b);
    const forged = forge(b, SETTING_ENTRY_KIND, forgedEntry);
    use(b);
    const before = loadSchemaPack(b.vault);
    const opts = { env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: b.configPath } };
    const adopted = await runCli(
      ["brain", "schema", "apply", "--adopt-unattested", "--actor", "ann"],
      opts,
    );
    expect(adopted.stderr).toBe("");
    expect(adopted.returncode).toBe(0);
    const [row] = schemaRows(b.storeRoot, "shared").slice(-1);
    expect(row?.record?.details).toMatchObject({
      applied: 0,
      adopted: [forged],
      adopted_by: "ann",
    });
    expect(loadSchemaPack(b.vault)).toEqual(before);
    expect(assessSchemaPackIntegrity(b.vault).status).toBe("ok");
    // Without the flag, an apply still needs a mutation.
    const bare = await runCli(["brain", "schema", "apply", "--actor", "ann"], opts);
    expect(bare.returncode).not.toBe(0);
    expect(bare.stderr).toContain("--mutation");
  });
});

describe("adoption on its own on an unswitched machine", () => {
  test("is refused, and _brain.yaml is left as it is", async () => {
    env = makeStoreEnv("osb-schema-attest-adopt-unswitched-", { dualWrite: false });
    const config = "schema_version: 1\nschema:\n  page_types: [ Paper ]\n";
    writeFileSync(brainConfigPath(env.vault), config);
    const opts = { env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: env.configPath } };
    const refused = await runCli(
      ["brain", "schema", "apply", "--adopt-unattested", "--actor", "ann"],
      opts,
    );
    expect(refused.returncode).not.toBe(0);
    expect(refused.stderr).toContain("store-only machine");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(config);
  });
});

describe("the migration's import", () => {
  test("attests the records it wrote, so the first apply after the switch goes through", async () => {
    env = makeStoreEnv("osb-schema-attest-import-");
    writeFileSync(
      brainConfigPath(env.vault),
      "schema_version: 1\nschema:\n  page_types:\n    - paper\n    - memo\n",
    );
    tick();
    importBrainSettings(env.vault, openStore({ root: env.storeRoot, device: "dev-a" }), "migrator");
    switchDevice(env.storeRoot);
    await apply(env, [addType("person")]);
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper", "memo", "person"]);
    expect(assessSchemaPackIntegrity(env.vault).status).toBe("ok");
  });
});

describe("audit rows written before rows named records", () => {
  test("keep the digest comparison, and an apply over the pack they attest goes through", async () => {
    env = makeStoreEnv("osb-schema-attest-legacy-");
    switchDevice(env.storeRoot);
    const [a] = twoMachines(env);
    forge(a, SETTING_SET_KIND, {
      authority: "human",
      key: "brain.schema.page_types",
      value: ["paper"],
    });
    use(a);
    // A row of that time: a digest, no `decided`.
    appendAuditRecord(
      schemaMutationAuditDir(a.vault),
      {
        timestamp: tick().toISOString(),
        actor: "old",
        action: "schema_apply_mutations",
        target: "store:shared/settings/brain.schema",
        ok: true,
        details: { applied: 1, pack_digest: computeSchemaPackDigest(loadSchemaPack(a.vault)) },
      },
      a.vault,
      { attestsShared: true },
    );
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
    await apply(a, [addType("memo")]);
    expect(assessSchemaPackIntegrity(a.vault).status).toBe("ok");
  });
});

describe("a shared row whose mutations are withheld", () => {
  test("still names the records it attests", async () => {
    env = makeStoreEnv("osb-schema-attest-withheld-");
    switchDevice(env.storeRoot);
    await apply(env, [addType("paper")], { reason: "<private>why</private>" });
    const [row] = schemaRows(env.storeRoot, "shared");
    expect(row?.record?.details?.["withheld"]).toBeDefined();
    expect(row?.record?.details?.["mutations"]).toBeUndefined();
    const decided = row?.record?.details?.["decided"];
    expect(Array.isArray(decided) && decided.length > 0).toBe(true);
  });
});
