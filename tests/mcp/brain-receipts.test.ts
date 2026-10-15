/**
 * `brain_receipts` at the MCP level (storage-lifecycle, Lane 3 task 3.4).
 *
 * Scan is the default and writes nothing. Compact requires explicit
 * `family:name` shards, previews without `apply`, and enforces the count
 * guard before mutating - a mismatched `expect` is an INVALID_PARAMS
 * envelope naming the count, and the vault is untouched. Compact is the
 * destructive half and answers at local reach only: below it the tool
 * refuses by name. The audit receipt_compaction record lands once per
 * confirmed run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuityLogDir, listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { metricsDir } from "../../src/core/brain/metrics.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { RECEIPT_SHARD_UNREADABLE } from "../../src/core/brain/receipts/scan.ts";
import {
  RECEIPT_COMPACTION_OPERATION,
  RECEIPT_MODES,
} from "../../src/core/brain/receipts/types.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { RECEIPT_COMPACT_REACH_REASON, RECEIPT_TOOLS } from "../../src/mcp/brain/receipt-tools.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { digestVaultTree } from "../helpers/vault-digest.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

const LEDGER_MONTH = "2026-08";

/** The schema stamp every aggregate line the fold engine writes carries. */
const RECEIPT_LEDGER_MONTH_AGGREGATE_MARKER = "o2b.receipt-fold.v1";

let vault: string;

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

function seedLedger(): void {
  const lines: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    lines.push(continuityLine("recall_telemetry", `${LEDGER_MONTH}-0${i + 1}T12:00:0${i}Z`));
  }
  mkdirSync(continuityLogDir(vault), { recursive: true });
  mkdirSync(metricsDir(vault), { recursive: true });
  writeFileSync(join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`), lines.join(""), "utf8");
}

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-receipts-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function init(server: MCPServer): Promise<void> {
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
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(server: MCPServer, args: Record<string, unknown>): Promise<any> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_receipts", arguments: args },
  })) as any;
}

describe("brain_receipts", () => {
  test("scan is the default mode and writes nothing", async () => {
    seedLedger();
    const server = new MCPServer({ vault });
    await init(server);
    const before = digestVaultTree(vault);
    const response = await call(server, {});
    const view = response.result.structuredContent;
    expect(view.operation).toBe(RECEIPT_COMPACTION_OPERATION);
    expect(view.totals.records).toBe(5);
    expect(view.totals.foldable).toBe(5);
    expect(view.shards[0]!.protected_records).toBe(0);
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("an unknown mode is an INVALID_PARAMS envelope naming the closed modes", async () => {
    const server = new MCPServer({ vault });
    await init(server);
    const response = await call(server, { mode: "vacuum" });
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("scan, compact");
  });

  test("compact without shard ids is an INVALID_PARAMS envelope", async () => {
    // Local reach: the reach refusal for the destructive mode is its own
    // test (`receipts-reach.test.ts`); this is the argument contract.
    const server = new MCPServer({ vault }, { reach: TRANSPORT_REACH.local });
    await init(server);
    const response = await call(server, { mode: "compact" });
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("shards");
  });

  test("compact previews without apply and writes nothing", async () => {
    seedLedger();
    const server = new MCPServer({ vault }, { reach: TRANSPORT_REACH.local });
    await init(server);
    const before = digestVaultTree(vault);
    const response = await call(server, {
      mode: "compact",
      shards: [`continuity:${LEDGER_MONTH}.jsonl`],
    });
    const view = response.result.structuredContent;
    expect(view.dry_run).toBe(true);
    expect(view.totals.folded).toBe(5);
    expect(digestVaultTree(vault)).toBe(before);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("a mismatched expect aborts the confirmed compact without writing", async () => {
    seedLedger();
    const server = new MCPServer({ vault }, { reach: TRANSPORT_REACH.local });
    await init(server);
    const before = readFileSync(join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`), "utf8");
    const response = await call(server, {
      mode: "compact",
      shards: [`continuity:${LEDGER_MONTH}.jsonl`],
      apply: true,
      expect: 4,
    });
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("--expect 4");
    expect(readFileSync(join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`), "utf8")).toBe(
      before,
    );
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test("a confirmed compact folds, appends one audit record, and reports the recovery point", async () => {
    seedLedger();
    const server = new MCPServer({ vault }, { reach: TRANSPORT_REACH.local });
    await init(server);
    const response = await call(server, {
      mode: "compact",
      shards: [`continuity:${LEDGER_MONTH}.jsonl`],
      apply: true,
      expect: 5,
    });
    const view = response.result.structuredContent;
    expect(view.dry_run).toBe(false);
    expect(view.totals.folded).toBe(5);
    expect(view.snapshot_run_id).toBeDefined();
    expect(view.audit_record_id).toBeDefined();
    expect(view.shards[0]!.bytes_after).toBeLessThan(view.shards[0]!.bytes_before);
    const audits = listContinuityRecords(vault, { kind: "receipt_compaction" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.id).toBe(view.audit_record_id);
    const after = readFileSync(join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`), "utf8");
    expect(after).toContain(RECEIPT_LEDGER_MONTH_AGGREGATE_MARKER);
  });

  test("compact below local reach is refused by name, never planned", async () => {
    // A server whose transport minted no reach resolves to the
    // narrowest, so the destructive mode answers the named refusal: no
    // shard plan, no byte totals, and the vault untouched.
    seedLedger();
    const server = new MCPServer({ vault });
    await init(server);
    const before = digestVaultTree(vault);
    const response = await call(server, {
      mode: "compact",
      shards: [`continuity:${LEDGER_MONTH}.jsonl`],
      apply: true,
    });
    const view = response.result.structuredContent;
    expect(view.measured).toBe(false);
    expect(view.reason).toBe(RECEIPT_COMPACT_REACH_REASON);
    expect(view.shards).toBeUndefined();
    expect(view.totals).toBeUndefined();
    expect(digestVaultTree(vault)).toBe(before);
    expect(listContinuityRecords(vault, { kind: "receipt_compaction" })).toHaveLength(0);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a shard the scan cannot read surfaces as unreadable, never as a filesystem error",
    async () => {
      // The scan view rides to remote callers verbatim, so the error rows
      // must carry the shard's name and the sanitized verdict only - the
      // raw Node text would hand over an absolute host path and a
      // missing-versus-denied oracle.
      seedLedger();
      const shard = join(continuityLogDir(vault), `${LEDGER_MONTH}.jsonl`);
      chmodSync(shard, 0o000);
      try {
        const server = new MCPServer({ vault });
        await init(server);
        const response = await call(server, {});
        const view = response.result.structuredContent;
        expect(view.errors).toHaveLength(1);
        expect(view.errors[0]!.shard).toBe(`continuity:${LEDGER_MONTH}.jsonl`);
        expect(view.errors[0]!.message).toBe(RECEIPT_SHARD_UNREADABLE);
        expect(JSON.stringify(view)).not.toContain(vault);
      } finally {
        chmodSync(shard, 0o644);
      }
    },
  );

  test("the surface vocabulary derives from the shared modes tuple", () => {
    const tool = RECEIPT_TOOLS[0]!;
    const schemaModes = (tool.inputSchema.properties as { mode: { enum: string[] } }).mode.enum;
    expect(schemaModes).toEqual([...RECEIPT_MODES]);
    expect(tool.description.toLowerCase()).toContain("receipt compaction");
  });
});
