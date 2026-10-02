/**
 * The source-cleanup tools answer at the caller's reach.
 *
 * A summary page derived from a reserved source inherits the source's
 * visibility. `brain_search_by_source` and `brain_delete_by_source` find
 * pages by the source they trace to, so at remote reach (no reach minted)
 * they must answer exactly as for the same vault without that page: no
 * entry, no count, no manifest entry for the reserved source, and a
 * confirmed delete that leaves the reserved page byte-identical. A local
 * caller is the positive control: it finds the page and may delete it.
 *
 * The entity page the same ingest writes is remote-readable and traces to
 * the source in both vaults; it is written before the source's visibility
 * is read, so it is not part of what this rule withholds.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManifest } from "../../src/core/brain/ingest/content-manifest.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const SOURCE_PATH = "Clips/reserved.csv";
const PRIVATE_BODY = "---\nvisibility: private\n---\nname,code\nzzcleanupprobezz,4711\n";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Fixture {
  readonly vault: string;
  readonly configPath: string;
  /** The summary page a local ingest wrote, or null when none ran. */
  readonly summaryPath: string | null;
}

/** A server at the reach given, or with no reach minted at all (remote). */
function serverAt(f: Fixture, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  return new MCPServer(
    { vault: f.vault, configPath: f.configPath },
    reach !== undefined ? { reach } : undefined,
  );
}

/** The structured payload of one tool call. */
async function call(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<Record<string, unknown>> {
  const result = (await serverAt(f, reach).callTool(tool, args)) as Record<string, unknown>;
  return (result["structuredContent"] ?? result) as Record<string, unknown>;
}

/**
 * A vault where a local caller ingested the reserved source. With
 * `withSummary` false the reserved summary page is then removed: the
 * control, identical but for the page a remote caller may not read.
 */
async function ingestedReservedSource(withSummary: boolean): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-cleanup-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, SOURCE_PATH), PRIVATE_BODY);
  const bare: Fixture = { vault, configPath, summaryPath: null };
  const ingest = await call(
    bare,
    "brain_ingest_source",
    {
      source_path: SOURCE_PATH,
      summary: "A clipped source.",
      entities: [{ category: "concept", name: "Plan" }],
    },
    TRANSPORT_REACH.local,
  );
  const summaryPath = String(ingest["summary_path"]);
  if (withSummary) return { ...bare, summaryPath };
  rmSync(join(vault, summaryPath));
  return bare;
}

/** Fields minted per run (record and snapshot ids), named rather than compared. */
const PER_RUN_FIELDS = Object.freeze(["audit_record_id", "snapshot_run_id"]);

function normalised(result: Record<string, unknown>): Record<string, unknown> {
  const out = { ...result };
  for (const field of PER_RUN_FIELDS) if (out[field] !== null) out[field] = `<${field}>`;
  return out;
}

describe("source-cleanup tools at the caller's reach", () => {
  test("brain_search_by_source answers a remote caller as if the reserved page were absent", async () => {
    const reserved = await ingestedReservedSource(true);
    const control = await ingestedReservedSource(false);
    const args = { source_file: SOURCE_PATH };

    const local = await call(reserved, "brain_search_by_source", args, TRANSPORT_REACH.local);
    expect(JSON.stringify(local)).toContain(String(reserved.summaryPath));

    expect(await call(reserved, "brain_search_by_source", args)).toEqual(
      await call(control, "brain_search_by_source", args),
    );
  });

  test("a remote dry run of brain_delete_by_source plans nothing it may not read", async () => {
    const reserved = await ingestedReservedSource(true);
    const control = await ingestedReservedSource(false);
    const args = { source_file: SOURCE_PATH };

    const local = await call(reserved, "brain_delete_by_source", args, TRANSPORT_REACH.local);
    expect(JSON.stringify(local)).toContain(String(reserved.summaryPath));
    expect(local["manifest_entry"]).toBe(SOURCE_PATH);

    const remote = await call(reserved, "brain_delete_by_source", args);
    expect(remote["manifest_entry"]).toBeNull();
    expect(remote).toEqual(await call(control, "brain_delete_by_source", args));
  });

  test("a remote confirmed delete leaves the reserved summary page byte-identical", async () => {
    const reserved = await ingestedReservedSource(true);
    const control = await ingestedReservedSource(false);
    const args = { source_file: SOURCE_PATH, confirm: true };
    const summaryAbs = join(reserved.vault, String(reserved.summaryPath));
    const before = readFileSync(summaryAbs);

    expect(normalised(await call(reserved, "brain_delete_by_source", args))).toEqual(
      normalised(await call(control, "brain_delete_by_source", args)),
    );
    expect(readFileSync(summaryAbs).equals(before)).toBe(true);
    expect(readManifest(reserved.vault).entries[SOURCE_PATH]).toBeDefined();

    const local = await call(reserved, "brain_delete_by_source", args, TRANSPORT_REACH.local);
    expect(local["deleted"]).toContain(reserved.summaryPath);
    expect(existsSync(summaryAbs)).toBe(false);
  });
});
