/**
 * `brain_delete_by_source` carries the core `failed` list on the wire
 * (storage lifecycle, PR #257 review M8). The MCP serializer emitted
 * `deleted` and `changed` but never `failed`, so a confirmed removal
 * that could not delete a file answered as a clean run with a smaller
 * count. A blocked removal now names the path and the fs error in the
 * tool answer, the same list the CLI verb prints and exits 1 on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { ingestSource } from "../../src/core/brain/ingest/ingest.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const SOURCE = "imports/benchmark.md";
const NOW = new Date("2026-06-01T00:00:00Z");

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-dbs-failed-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "imports"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, SOURCE), "benchmark rows\n", "utf8");
  ingestSource(
    vault,
    {
      sourcePath: SOURCE,
      summary: "Benchmark import summary.",
      extraction: { entities: [{ category: "concept", name: "BenchWidget" }] },
    },
    { agent: "tester", now: NOW },
  );
  return { vault, server: new MCPServer({ vault, configPath }) };
}

/** The tool's structured answer, unwrapped from the MCP envelope. */
async function call(f: Fixture, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await f.server.callTool("brain_delete_by_source", args);
  return result["structuredContent"] as Record<string, unknown>;
}

describe("brain_delete_by_source names what did not delete", () => {
  test("a confirmed run with a blocked removal carries failed on the wire", async () => {
    if (CHMOD_CANNOT_DENY) return;
    const f = fixture();
    const preview = (await call(f, { source_file: SOURCE })) as {
      derived: Array<{ path: string; kind: string }>;
    };
    const blockedPath = preview.derived.find((e) => e.kind === "summary")!.path;
    const blockedDir = join(f.vault, dirname(blockedPath));
    chmodSync(blockedDir, 0o555);
    try {
      const answer = (await call(f, { source_file: SOURCE, confirm: true })) as {
        changed: number;
        failed: ReadonlyArray<{ path: string; message: string }>;
      };
      expect(answer.failed.length).toBe(1);
      expect(answer.failed[0]!.path).toBe(blockedPath);
      expect(answer.failed[0]!.message.length).toBeGreaterThan(0);
      // The rest of the run still landed, and the answer says both sides.
      expect(answer.changed).toBeGreaterThan(0);
      expect(existsSync(join(f.vault, blockedPath))).toBe(true);
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });

  test("a clean confirmed run carries no failure", async () => {
    const f = fixture();
    const answer = (await call(f, { source_file: SOURCE, confirm: true })) as {
      failed?: unknown;
    };
    expect(answer.failed).toEqual([]);
  });
});
