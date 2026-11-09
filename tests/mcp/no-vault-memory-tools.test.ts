/**
 * The memory-contract MCP tools on a server with no vault (spec
 * brain-store, scenario "No vault configured"; design D14, task 2.10):
 * feedback, evidence, notes, pinned context, the context bootstrap,
 * search, changes, dream, doctor and status answer from the brain store.
 * The `vault_required` refusals are owned by `no-vault-server.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import {
  isStoreRecordPath,
  STORE_CATCH_UP_INTERVAL_ENV,
} from "../../src/core/search/brain-store/constants.ts";
import { readStoreId } from "../../src/core/store/store-open.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { partitionRecords } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
let savedInterval: string | undefined;
afterEach(() => {
  env?.cleanup();
  env = null;
  if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
  else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
});

function serverWithoutVault(prefix: string): MCPServer {
  env = makeStoreEnv(prefix, { legacyTree: false, configureVault: false });
  savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  // Local reach: the stdio transport an agent on this machine uses.
  return new MCPServer(
    { vault: null, configPath: env.configPath },
    { reach: TRANSPORT_REACH.local },
  );
}

async function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await server.callTool(name, args);
  return (result["structuredContent"] ?? result) as Record<string, unknown>;
}

describe("memory-contract tools with no vault", () => {
  test("brain_feedback then brain_search returns the record", async () => {
    const server = serverWithoutVault("osb-novault-mcp-search-");
    const written = await call(server, "brain_feedback", {
      topic: "kingfisher-naming",
      signal: "positive",
      principle: "Prefer kingfisher naming for heron migrations.",
    });
    expect(written["id"]).toMatch(/^sig-/);

    const found = await call(server, "brain_search", { query: "kingfisher heron migrations" });
    const results = found["results"] as ReadonlyArray<{ path: string }>;
    expect(results.some((r) => isStoreRecordPath(r.path))).toBe(true);
  });

  test("evidence, note, pinned context, context, changes, dream, doctor and status answer", async () => {
    const server = serverWithoutVault("osb-novault-mcp-tools-");
    const fb = await call(server, "brain_feedback", {
      topic: "plain-words",
      signal: "positive",
      principle: "Use plain words in reports.",
      force_confirmed: true,
    });
    const prefId = fb["preference_id"] as string;
    expect(prefId).toMatch(/^pref-/);

    await call(server, "brain_apply_evidence", {
      pref_id: prefId,
      artifact: "[[report]]",
      result: "applied",
    });
    await call(server, "brain_note", { text: "shipped without a vault" });
    // Both land in the store as log events, nowhere else.
    const events = partitionRecords(env!.storeRoot, "shared")
      .concat(partitionRecords(env!.storeRoot, "private"))
      .filter((r) => r.kind === "log-event");
    const evidence = events.filter((r) => JSON.stringify(r.body).includes("[[report]]"));
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence[0]!.body)).toContain(prefId);
    expect(
      events.filter((r) => JSON.stringify(r.body).includes("shipped without a vault")),
    ).toHaveLength(1);

    const pinned = await call(server, "brain_pinned_context", {
      operation: "write",
      content: "current task: no-vault brain",
    });
    expect(String(pinned["path"])).toMatch(/^store:/);
    const read = await call(server, "brain_pinned_context", { operation: "read" });
    expect(read["content"]).toContain("no-vault brain");

    const context = await call(server, "brain_context", {});
    expect(JSON.stringify(context)).toContain("Use plain words in reports.");

    const changes = await call(server, "brain_changes", {});
    expect(changes["measured"]).toBe(true);
    expect(changes["storeInUse"]).toBe(true);

    const dream = await call(server, "brain_dream", {});
    expect(dream["run_id"]).toEqual(expect.any(String));
    expect(String(dream["run_id"]).length).toBeGreaterThan(0);

    const doctor = await call(server, "brain_doctor", {});
    expect(doctor["errors"]).toEqual([]);

    const status = await call(server, "second_brain_status", {});
    expect(status["vault_exists"]).toBe(false);
    expect(status["vault_path"]).toBeNull();
    expect(status["brain"]).toBeUndefined();
    expect(status["store"]).toMatchObject({
      root: { path: env!.storeRoot },
      initialized: true,
      store_id: readStoreId(join(env!.storeRoot, "shared")),
      device_id: "dev-a",
      error: null,
    });
  });
});
