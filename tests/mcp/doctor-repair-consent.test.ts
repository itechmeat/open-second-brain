/**
 * `brain_doctor` repair+apply stays machine consent (t_b6bcd984).
 *
 * The tool's input schema is unchanged - `apply: true` remains the one
 * explicit machine confirmation, with no new required argument that
 * would break agents mid-flight - and the `doctor-repair` events the
 * apply path logs record the provenance value `caller-apply`, so the
 * timeline still distinguishes an agent-driven write from an operator's
 * `--yes` (CLI) or interactive confirmation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { listLogDates, readLogDay } from "../../src/core/brain/log-jsonl.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function fixtureWithWalGap(): { server: MCPServer; vault: string } {
  const base = mkdtempSync(join(tmpdir(), "o2b-doctor-consent-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "source.md"), "# Widget source\n\nBody text.\n");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: agent\n`);
  bootstrapBrain(vault, { configPath });
  // A dangling dream workrun: the wal-gap fixer's one mechanical fix.
  const runs = join(vault, "Brain", "log", "dream-runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(
    join(runs, "run-mcp.jsonl"),
    JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-mcp" }) + "\n",
    "utf8",
  );
  // Local reach: the operator's own surface, which may read the Brain
  // log the wal-gap fixer targets (a remote caller cannot, and the
  // reach view would plan no fix - by design).
  return {
    server: new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local }),
    vault,
  };
}

interface RpcResponse {
  readonly error?: { code: number; message: string };
  readonly result?: {
    structuredContent?: Record<string, unknown>;
    content?: ReadonlyArray<{ text?: string }>;
  };
}

function repairEventBodies(vault: string): Array<Record<string, string>> {
  const bodies: Array<Record<string, string>> = [];
  for (const date of listLogDates(vault)) {
    for (const e of readLogDay(vault, date).entries) {
      if (e.eventType === "doctor-repair") bodies.push(e.body as Record<string, string>);
    }
  }
  return bodies;
}

describe("brain_doctor repair consent provenance", () => {
  test("apply: true records caller-apply in the doctor-repair event body", async () => {
    const { server, vault } = fixtureWithWalGap();
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 7,
      method: "tools/call",
      params: { name: "brain_doctor", arguments: { repair: true, apply: true } },
    })) as RpcResponse;
    expect(res.error).toBeUndefined();
    const s = res.result?.structuredContent ?? {};
    const repair = s["repair"] as { dryRun?: boolean; applied?: ReadonlyArray<unknown> };
    expect(repair.dryRun).toBe(false);
    expect((repair.applied ?? []).length).toBe(1);
    const bodies = repairEventBodies(vault);
    expect(bodies.length).toBe(1);
    expect(bodies[0]!["consent"]).toBe("caller-apply");
  });

  test("the input schema is unchanged: no consent argument exists", async () => {
    const { server } = fixtureWithWalGap();
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 8,
      method: "tools/list",
      params: {},
    })) as RpcResponse;
    expect(res.error).toBeUndefined();
    const tools =
      (res.result as { tools?: Array<{ name: string; inputSchema: Record<string, unknown> }> })
        ?.tools ?? [];
    const doctor = tools.find((t) => t.name === "brain_doctor");
    expect(doctor).toBeDefined();
    const schema = doctor!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: ReadonlyArray<string>;
    };
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
      "apply",
      "format",
      "repair",
      "strict",
    ]);
    // No NEW required argument: the machine-consent contract is the
    // existing `apply` flag, exactly as agents already call it.
    expect(schema.required ?? []).toEqual([]);
  });
});
