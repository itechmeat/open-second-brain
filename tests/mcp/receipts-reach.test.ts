/**
 * `brain_receipts` compact at the caller's reach (storage-lifecycle
 * wave review).
 *
 * Compact is the destructive half of the receipts surface: it rewrites
 * named ledger shards in place and reports whole-ledger byte totals -
 * the same figure class the storage report refuses to take below local
 * reach (`brain_storage`). Below local reach the fold is therefore not
 * planned at all: a named refusal, no shard plan, no byte totals, and
 * no write lane entered. Scan stays readable at any reach - a read-only
 * inventory withholds nothing a caller could not ask for another way.
 *
 * Claims pinned here:
 *
 *   1. A remote caller gets the named reach refusal, never a plan.
 *   2. The refusal carries no shard plan and no byte figures.
 *   3. A hand-built context that established nothing answers at the
 *      narrowest reach (fail closed): refused, not run.
 *   4. At local reach the same tool previews the fold.
 *   5. Scan stays readable below local reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuityLogDir } from "../../src/core/brain/continuity/store.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { RECEIPT_COMPACTION_OPERATION } from "../../src/core/brain/receipts/types.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { RECEIPT_COMPACT_REACH_REASON, RECEIPT_TOOLS } from "../../src/mcp/brain/receipt-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const receipts = RECEIPT_TOOLS.find((tool) => tool.name === "brain_receipts")!.handler;

const SHARD = "continuity:2026-08.jsonl";

let vault: string;
let configHome: string;
let ctx: ServerContext;

function continuityLine(kind: string, createdAt: string): string {
  const id = `ctn_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}_${kind}`;
  return `${JSON.stringify({
    schema: "o2b.continuity.v1",
    id,
    kind,
    createdAt,
    sourceRefs: [],
    payload: {},
    private: false,
    redacted: false,
  })}\n`;
}

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-receipts-reach-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-receipts-reach-cfg-"));
  writeFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  mkdirSync(continuityLogDir(vault), { recursive: true });
  writeFileSync(
    join(continuityLogDir(vault), "2026-08.jsonl"),
    [continuityLine("recall_telemetry", "2026-08-10T12:00:00Z")].join(""),
    "utf8",
  );
  ctx = { vault, configPath: join(configHome, "config.yaml"), repoRoot: null };
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("brain_receipts compact at the caller's reach", () => {
  test("below local reach the fold is not planned and the refusal is named", async () => {
    const res = (await receipts(
      { ...ctx, reach: TRANSPORT_REACH.remote },
      { mode: "compact", shards: [SHARD] },
    )) as Record<string, unknown>;
    expect(res["operation"]).toBe(RECEIPT_COMPACTION_OPERATION);
    expect(res["measured"]).toBe(false);
    expect(res["reason"]).toBe(RECEIPT_COMPACT_REACH_REASON);
    expect(String(res["detail"])).toContain("local reach");
  });

  test("the refusal carries no shard plan and no byte figures", async () => {
    const res = (await receipts(
      { ...ctx, reach: TRANSPORT_REACH.remote },
      { mode: "compact", shards: [SHARD] },
    )) as Record<string, unknown>;
    const rendered = JSON.stringify(res);
    expect(res["shards"]).toBeUndefined();
    expect(res["totals"]).toBeUndefined();
    expect(res["groups"]).toBeUndefined();
    expect(rendered).not.toContain("bytes");
    expect(rendered).not.toContain(vault);
  });

  test("a context that established nothing answers at the narrowest reach", async () => {
    // No `reach` field: a hand-built context proved nothing about who is
    // asking, so the destructive mode must not treat it as local.
    const res = (await receipts(ctx, { mode: "compact", shards: [SHARD] })) as Record<
      string,
      unknown
    >;
    expect(res["measured"]).toBe(false);
    expect(res["reason"]).toBe(RECEIPT_COMPACT_REACH_REASON);
  });

  test("at local reach the same tool previews the fold", async () => {
    const res = (await receipts(
      { ...ctx, reach: TRANSPORT_REACH.local },
      { mode: "compact", shards: [SHARD] },
    )) as Record<string, unknown>;
    expect(res["dry_run"]).toBe(true);
    expect(res["totals"]).toBeDefined();
  });

  test("scan stays readable below local reach", async () => {
    const res = (await receipts({ ...ctx, reach: TRANSPORT_REACH.remote }, {})) as Record<
      string,
      unknown
    >;
    expect(res["operation"]).toBe(RECEIPT_COMPACTION_OPERATION);
    expect(res["totals"]).toBeDefined();
    expect((res["shards"] as ReadonlyArray<unknown>).length).toBe(1);
  });
});
