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
 *
 * Reach honesty: the refusal itself is a write gate, so it fires at every
 * reach - but the whole-vault figures beside it are the same local-reach
 * facts the `brain_storage` report refuses to take below local reach.
 * A remote caller is told the wall exists and where the remedy lives,
 * never handed the census that describes the vault.
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
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { isToolErrorCode } from "../../src/mcp/tool-error-codes.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
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
  readonly configPath: string;
  readonly server: MCPServer;
}

function fixture(
  capBytes: number | undefined,
  reach: TransportReach = TRANSPORT_REACH.local,
  configAppend = "",
): Fixture {
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
  if (configAppend.length > 0) appendFileSync(brainConfigPath(vault), configAppend);
  const server = new MCPServer({ vault, configPath }, { reach });
  return { vault, configPath, server };
}

/** The ingest arguments every call in this suite sends. */
function ingestArgs(): Record<string, unknown> {
  return {
    source_path: "notes/source.md",
    summary: SUMMARY,
    entities: [{ category: "concept", name: "Capacity widget" }],
  };
}

/** The three data keys that carry whole-vault figures to a caller. */
const FIGURE_KEYS = ["measured_bytes", "cap_bytes", "percent_used"] as const;

interface RpcResponse {
  readonly error?: { code: number; message: string; data?: Record<string, unknown> };
  readonly result?: {
    structuredContent?: Record<string, unknown>;
    content?: ReadonlyArray<{ text?: string }>;
  };
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
  return JSON.parse(res.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
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

describe("the admission gate reads only the storage block (review M1)", () => {
  test("a typo in an unrelated block never breaks the ingest on a vault with no cap", async () => {
    // The review's probe: the maintenance block is invalid, and the
    // storage block the gate decides from is absent - no cap, the
    // documented default where nothing refuses. The whole-file validation
    // the old loader ran made this ingest an internal error naming a host
    // path; the block-scoped read answers the gate's actual question.
    const f = fixture(
      undefined,
      TRANSPORT_REACH.local,
      "\nmaintenance:\n  host_pressure_percent: banana\n",
    );
    const res = await ingest(f);
    expect(res.error).toBeUndefined();
    expect(brainPageTexts(f.vault).some((text) => text.includes(SUMMARY))).toBe(true);
  });

  test("a broken storage block refuses by name, free of host paths", async () => {
    // The gate cannot know whether a cap is in force, so a broken policy
    // is never silently read as "no cap": the refusal names the field and
    // carries the registered code - and never the config's host path,
    // which a remote caller has no business learning.
    const f = fixture(undefined, TRANSPORT_REACH.local, "\nstorage:\n  cap_bytes: banana\n");
    const res = await ingest(f);
    expect(readRpcErrorCode(res)).toBe("config_invalid");
    const message = res.error?.message ?? "";
    expect(message).toContain("brain_ingest_source");
    expect(message).toContain("storage.cap_bytes");
    expect(message).not.toContain(f.vault);
  });

  test("an unparseable config refuses by name, free of host paths", async () => {
    const f = fixture(
      undefined,
      TRANSPORT_REACH.local,
      "\nstorage:\n  cap_bytes: 5\n   warn_percent: 80\n",
    );
    const res = await ingest(f);
    expect(readRpcErrorCode(res)).toBe("config_invalid");
    const message = res.error?.message ?? "";
    expect(message).toContain("brain_ingest_source");
    expect(message).not.toContain(f.vault);
  });
});

describe("the admission refusal at the caller's reach", () => {
  test("a local refusal carries the measured reading beside the code", async () => {
    const f = fixture(CRITICAL_CAP_BYTES, TRANSPORT_REACH.local);
    const res = await ingest(f);
    expect(readRpcErrorCode(res)).toBe("capacity_exhausted");
    const data = res.error?.data ?? {};
    expect(data["tier"]).toBe("critical");
    expect(typeof data["measured_bytes"]).toBe("number");
    expect(data["cap_bytes"]).toBe(CRITICAL_CAP_BYTES);
    expect(typeof data["percent_used"]).toBe("number");
  });

  test("a remote refusal names the wall and carries no vault figures", async () => {
    const f = fixture(CRITICAL_CAP_BYTES, TRANSPORT_REACH.remote);
    const before = vaultBytes(f.vault);
    const res = await ingest(f);
    // The gate is a write gate, not a secret: the refusal itself fires at
    // every reach, by the same code.
    expect(readRpcErrorCode(res)).toBe("capacity_exhausted");
    const data = res.error?.data ?? {};
    expect(data["tier"]).toBe("critical");
    expect(data["remedy"]).toContain("cap_bytes");
    // The local remedy is still in hand: the registered next step for a
    // critical vault, not a figure a remote caller cannot act on.
    expect(data["next_command"]).toBe("o2b brain storage");
    // The census is a whole-vault figure (brain_storage's reach model):
    // below local reach none of it rides.
    for (const key of FIGURE_KEYS) {
      expect(Object.hasOwn(data, key)).toBe(false);
    }
    // Still a validate-phase refusal: the vault did not move.
    expect(vaultBytes(f.vault)).toBe(before);
    expect(listMetrics(f.vault, { surface: STORAGE_USAGE_SURFACE })).toEqual([]);
  });

  test("a context that established nothing is refused without figures", async () => {
    const f = fixture(CRITICAL_CAP_BYTES);
    // No `reach` field on a hand-built context: nobody established who was
    // asking, so the tool answers at the narrowest reach (fail closed).
    const ctx: ServerContext = {
      vault: f.vault,
      configPath: f.configPath,
      repoRoot: null,
    };
    const handler = INGEST_TOOLS.find((tool) => tool.name === "brain_ingest_source")!.handler;
    let refused: MCPError | undefined;
    try {
      await handler(ctx, ingestArgs());
    } catch (err) {
      refused = err instanceof MCPError ? err : undefined;
    }
    expect(refused).toBeDefined();
    expect(refused!.code).toBe(INVALID_PARAMS);
    expect(String(refused!.message)).toContain("capacity_exhausted");
    // The admission envelope is always built as a record (the refusal
    // mapper spreads the leaf's fields into one), so the keys below are
    // read off that record.
    const data = (refused!.data ?? {}) as Record<string, unknown>;
    expect(data["code"]).toBe("capacity_exhausted");
    for (const key of FIGURE_KEYS) {
      expect(Object.hasOwn(data, key)).toBe(false);
    }
    expect(listMetrics(f.vault, { surface: STORAGE_USAGE_SURFACE })).toEqual([]);
  });
});
