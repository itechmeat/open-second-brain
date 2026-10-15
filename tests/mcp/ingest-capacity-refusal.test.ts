/**
 * `brain_ingest_source` capacity admission (storage lifecycle, Lane 2):
 * at the critical storage tier the ingest refuses BEFORE any write with
 * the `capacity_exhausted` envelope naming the remedy; an unbounded or
 * sub-critical vault ingests unchanged; and when no cap is configured
 * the check is skipped entirely - no measurement, no sample, no cost.
 *
 * The refusal sits at the tool's validate phase, ahead of `ingestSource`,
 * so the commit phase is never entered and never rolled back: the vault
 * is byte-identical after a refusal. Reads and the read-only batch plan
 * are never gated - reclamation must stay possible while producers are
 * refused.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { STORAGE_ERROR_CODES } from "../../src/core/brain/storage/capacity-error.ts";
import { STORAGE_USAGE_METRIC_SURFACE } from "../../src/core/brain/storage/forecast.ts";
import { isToolErrorCode } from "../../src/mcp/tool-error-codes.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { brainPageTexts } from "../helpers/brain-pages.ts";
import { readRpcErrorCode } from "../helpers/tool-error-envelope.ts";

const SUMMARY = "Release notes of the capacity widget.";

/**
 * A cap every real vault clears many times over: whatever the bootstrapped
 * fixture holds is far past 95 percent of this, and usage past 100 percent
 * of cap is still `critical` - the top measured tier.
 */
const CRITICAL_CAP_BYTES = 1000;
/** A cap no test fixture approaches, so the tier stays below the warn band. */
const ROOMY_CAP_BYTES = 1_000_000_000_000;
/** The metrics surface a usage sample rides; the admission check appends none. */
const STORAGE_USAGE_SURFACE = STORAGE_USAGE_METRIC_SURFACE;

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

function fixture(capBytes: number | undefined): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-ingest-cap-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "source.md"), "# Widget source\n\nBody text.\n");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  if (capBytes !== undefined) {
    appendFileSync(brainConfigPath(vault), `\nstorage:\n  cap_bytes: ${capBytes}\n`);
  }
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  return { vault, server };
}

interface RpcResponse {
  readonly error?: { code: number; message: string; data?: Record<string, unknown> };
  readonly result?: { structuredContent?: Record<string, unknown> };
}

async function ingest(f: Fixture): Promise<RpcResponse> {
  const raw = await f.server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 7,
    method: "tools/call",
    params: {
      name: "brain_ingest_source",
      arguments: {
        source_path: "notes/source.md",
        summary: SUMMARY,
        entities: [{ category: "concept", name: "Capacity widget" }],
      },
    },
  });
  return raw as RpcResponse;
}

/** The tool's result object, from structured content or the text block. */
function payload(res: RpcResponse): Record<string, unknown> {
  const structured = res.result?.structuredContent;
  if (structured !== undefined) return structured;
  return JSON.parse(
    (res.result?.content as ReadonlyArray<{ text?: string }> | undefined)?.[0]?.text ?? "{}",
  ) as Record<string, unknown>;
}

/** Total bytes of every file under `root`, recursively - a write changes this. */
function vaultBytes(root: string): number {
  let total = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

describe("brain_ingest_source capacity admission", () => {
  test("at the critical tier the ingest refuses by name and writes nothing", async () => {
    const f = fixture(CRITICAL_CAP_BYTES);
    const before = vaultBytes(f.vault);
    const res = await ingest(f);
    const message = res.error?.message ?? "";
    expect(readRpcErrorCode(res)).toBe("capacity_exhausted");
    expect(STORAGE_ERROR_CODES).toContain("capacity_exhausted");
    // Registered on the wire registry (Lane 1's exhaustiveMembers row),
    // so the refusal answers with a token a client can branch on.
    expect(isToolErrorCode("capacity_exhausted")).toBe(true);
    expect(message).toContain("critical");
    expect(message).toContain("brain_ingest_source");
    // The remedy path is named, not inferred: reclaim by compaction or
    // retirement, or raise the cap.
    expect(message).toContain("cap_bytes");

    // Zero writes: the refusal happened in the validate phase, so no page,
    // ledger or metric moved anywhere in the vault.
    expect(vaultBytes(f.vault)).toBe(before);
    expect(brainPageTexts(f.vault).some((text) => text.includes(SUMMARY))).toBe(false);
    expect(listMetrics(f.vault, { surface: STORAGE_USAGE_SURFACE })).toEqual([]);
  });

  test("an unbounded vault ingests unchanged", async () => {
    const f = fixture(undefined);
    const res = await ingest(f);
    expect(res.error).toBeUndefined();
    expect(String(payload(res)["summary_path"] ?? "").length).toBeGreaterThan(0);
    expect(brainPageTexts(f.vault).some((text) => text.includes(SUMMARY))).toBe(true);
  });

  test("a sub-critical vault ingests unchanged", async () => {
    const f = fixture(ROOMY_CAP_BYTES);
    const res = await ingest(f);
    expect(res.error).toBeUndefined();
    expect(brainPageTexts(f.vault).some((text) => text.includes(SUMMARY))).toBe(true);
  });

  test("no cap configured means no measurement cost", async () => {
    const f = fixture(undefined);
    await ingest(f);
    // The unbounded vault ingested (the contract above), and the admission
    // check left no usage sample behind: with no cap in force the check
    // never measured.
    expect(listMetrics(f.vault, { surface: STORAGE_USAGE_SURFACE })).toEqual([]);
  });
});
