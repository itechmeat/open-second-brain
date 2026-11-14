/**
 * The schema pack on a store-only machine (design D14 item 3, task 2.11):
 * `schema_apply_mutations` / `o2b brain schema apply` write the pack as
 * shared `brain.schema.<field>` settings records and audit to the store,
 * readers see the stored pack, and nothing under `Brain/` changes. An
 * unswitched machine keeps writing `_brain.yaml`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { applySchemaAdminMutations } from "../../../src/core/brain/schema-admin.ts";
import { assessSchemaPackIntegrity } from "../../../src/core/brain/schema-integrity.ts";
import { SCHEMA_AUDIT_STORE_NAME } from "../../../src/core/brain/schema-mutate-store.ts";
import type { SchemaMutation } from "../../../src/core/brain/schema-mutate.ts";
import { STORE_SCHEMA_PACK_SOURCE } from "../../../src/core/brain/schema-pack-store.ts";
import { loadSchemaPack, readSchemaPackSource } from "../../../src/core/brain/schema-pack.ts";
import { SETTING_SET_KIND, SETTING_UNSET_KIND } from "../../../src/core/store/constants.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import {
  brainTreeDigest,
  ledgerRows,
  partitionRecords,
  switchDevice,
} from "./store-only/fixtures.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const ADD_PAPER: SchemaMutation = { op: "add_type", category: "page_types", token: "paper" };
const ALIAS: SchemaMutation = { op: "add_alias", token: "paper", alias: "article" };

function schemaRecords(e: StoreEnv) {
  return partitionRecords(e.storeRoot, "shared").filter(
    (r) =>
      (r.kind === SETTING_SET_KIND || r.kind === SETTING_UNSET_KIND) &&
      String(r.body["key"]).startsWith("brain.schema."),
  );
}

function schemaAuditRows(e: StoreEnv): unknown[] {
  return [
    ...ledgerRows(e.storeRoot, "shared", "reliability-audit"),
    ...ledgerRows(e.storeRoot, "private", "reliability-audit"),
  ].filter((row) => (row as { audit_dir?: string }).audit_dir === "schema-mutations");
}

describe("schema apply on a store-only machine", () => {
  test("writes brain.schema.* records, audits to the store, and leaves Brain/ alone", async () => {
    env = makeStoreEnv("osb-schema-store-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);

    const result = await applySchemaAdminMutations(env.vault, [ADD_PAPER, ALIAS], {
      actor: "test",
    });
    expect(result.audit_path).toBe(SCHEMA_AUDIT_STORE_NAME);
    expect(brainTreeDigest(env.vault)).toBe(before);

    const records = schemaRecords(env);
    expect(records.map((r) => [r.body["key"], r.body["value"]])).toEqual([
      ["brain.schema.aliases", ["paper=article"]],
      ["brain.schema.page_types", ["paper"]],
    ]);
    // Not from the CLI: an agent wrote these.
    expect(records.every((r) => r.body["authority"] === "agent")).toBe(true);
    expect(schemaAuditRows(env)).toHaveLength(1);

    const source = readSchemaPackSource(env.vault);
    expect(source.path).toBe(STORE_SCHEMA_PACK_SOURCE);
    expect(source.present).toBe(true);
    expect(source.pack.declarations.page_types).toEqual(["paper"]);
    expect(source.pack.aliases).toEqual({ paper: ["article"] });

    const integrity = assessSchemaPackIntegrity(env.vault);
    expect(integrity.status).toBe("ok");
    expect(integrity).toMatchObject({ audit_path: SCHEMA_AUDIT_STORE_NAME });
  });

  test("a field the pack drops is unset; the next apply builds on the stored pack", async () => {
    env = makeStoreEnv("osb-schema-store-unset-");
    switchDevice(env.storeRoot);
    await applySchemaAdminMutations(env.vault, [ADD_PAPER, ALIAS], { actor: "t" });
    await applySchemaAdminMutations(
      env.vault,
      [{ op: "remove_alias", token: "paper", alias: "article" }],
      { actor: "t" },
    );
    const last = schemaRecords(env).at(-1)!;
    expect(last.kind).toBe(SETTING_UNSET_KIND);
    expect(last.body["key"]).toBe("brain.schema.aliases");
    const pack = loadSchemaPack(env.vault);
    expect(pack.aliases).toEqual({});
    expect(pack.declarations.page_types).toEqual(["paper"]);
  });

  test("the CLI writes with human authority, and an agent cannot change that field", async () => {
    env = makeStoreEnv("osb-schema-store-cli-");
    switchDevice(env.storeRoot);
    const cli = await runCli(
      ["brain", "schema", "apply", "--mutation", JSON.stringify(ADD_PAPER), "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath } },
    );
    expect(cli.returncode).toBe(0);
    expect(schemaRecords(env)[0]!.body["authority"]).toBe("human");

    const server = new MCPServer({ vault: env.vault, configPath: env.configPath });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: {
        name: "schema_apply_mutations",
        arguments: {
          mutations: [{ op: "add_type", category: "page_types", token: "memo" }],
        },
      },
    })) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
    const answer = JSON.stringify(r);
    expect(r.error !== undefined || r.result?.isError === true).toBe(true);
    expect(answer).toContain("human_value_in_force");
    expect(schemaRecords(env)).toHaveLength(1);
    expect(loadSchemaPack(env.vault).declarations.page_types).toEqual(["paper"]);
  });
});

describe("schema apply on an unswitched machine", () => {
  test("writes _brain.yaml and no schema settings record", async () => {
    env = makeStoreEnv("osb-schema-legacy-");
    const result = await applySchemaAdminMutations(env.vault, [ADD_PAPER], { actor: "t" });
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toContain("    - paper");
    expect(result.audit_path).toContain("schema-mutations");
    expect(schemaRecords(env)).toHaveLength(0);
    expect(readSchemaPackSource(env.vault).path).toBe(brainConfigPath(env.vault));
    expect(assessSchemaPackIntegrity(env.vault).status).toBe("ok");
  });
});
