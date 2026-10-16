/**
 * `brain_receipts` compact at the caller's reach (storage-lifecycle
 * wave review).
 *
 * Compact is the destructive half of the receipts surface: it rewrites
 * named ledger shards in place, under guarantees that are all host-local
 * - vault identity, the permissions-document consult, the recovery
 * point, the per-file locks. Below local reach the fold is therefore not
 * planned at all: a named refusal, no shard plan, no byte figures, and
 * no write lane entered. Scan stays readable at any reach - a read-only
 * inventory that withholds nothing a caller could not ask for another
 * way.
 *
 * Reach rationale, decided on review (L11): the refusal names the
 * host-local write lane, NOT the byte figures. It used to say it stopped
 * because compact "reports whole-ledger byte totals", while scan - and
 * the receipt-ledger-growth doctor check that reads the same scan, on
 * the host where reach has no meaning - return the same per-shard
 * figures at any reach. Figures were never the differentiator; the
 * destructive rewrite is. Dropping the figures below local reach was the
 * alternative and is worse: the scan's contract is to withhold nothing,
 * and the doctor has no reach to drop them at.
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
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
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

  test("a shard name outside the family grammar is INVALID_PARAMS, never an internal error", async () => {
    // L9: the `family:name` parser checks the family but not the name
    // grammar, and the grammar refusal used to surface as a plain Error
    // rethrown out of the handler - an internal error for what is the
    // caller's malformed argument. Validated up front, by name.
    for (const bad of ["continuity:../x", "continuity:.jsonl", "continuity:2026-08.jsonl.bak"]) {
      try {
        await receipts(
          { ...ctx, reach: TRANSPORT_REACH.local },
          { mode: "compact", shards: [bad] },
        );
        expect.unreachable(`'${bad}' must be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).code).toBe(INVALID_PARAMS);
        expect((err as MCPError).message).toContain("is not a continuity shard name");
      }
    }
  });

  test("a grammar-valid foreign shard is a refusal row, not invalid params", async () => {
    // The boundary the grammar cannot express: a well-formed
    // `<base>.<deviceId>.jsonl` name is a real shard - another device's,
    // so the core answers a named failure row rather than a parameter
    // error.
    writeFileSync(
      join(continuityLogDir(vault), "2026-08.telescope.jsonl"),
      continuityLine("recall_telemetry", "2026-08-10T12:00:00Z"),
      "utf8",
    );
    const res = (await receipts(
      { ...ctx, reach: TRANSPORT_REACH.local },
      { mode: "compact", shards: ["continuity:2026-08.telescope.jsonl"] },
    )) as { failures: Array<{ shard: string; message: string }> };
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.shard).toBe("continuity:2026-08.telescope.jsonl");
    expect(res.failures[0]!.message).toContain("owning device");
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
