/**
 * A remote re-ingest of a summary page the caller may not read.
 *
 * A local caller ingests a source reserved by its own frontmatter, so the
 * summary page inherits the reservation. The summary path is deterministic,
 * so a later `brain_ingest_source` of the same source at remote reach (no
 * reach minted) must answer exactly as for the same vault without that
 * page, and must leave the page byte-identical: the answer is no oracle for
 * the page's existence, and the call is no way to overwrite it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const SOURCE_PATH = "Clips/reserved.csv";
const RESERVE_LINE = "visibility: private\n";
const PRIVATE_BODY = `---\n${RESERVE_LINE}---\nname,code\nzzreingestprobezz,4711\n`;
const INGEST_ARGS = Object.freeze({
  source_path: SOURCE_PATH,
  summary: "A clipped source.",
  entities: [{ category: "concept", name: "Plan" }],
});

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
}

/** A server at the reach given, or with no reach minted at all (remote). */
function serverAt(f: Fixture, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  return new MCPServer(
    { vault: f.vault, configPath: f.configPath },
    reach !== undefined ? { reach } : undefined,
  );
}

async function ingest(f: Fixture, reach?: TransportReach): Promise<Record<string, unknown>> {
  const result = (await serverAt(f, reach).callTool("brain_ingest_source", {
    ...INGEST_ARGS,
  })) as Record<string, unknown>;
  return (result["structuredContent"] ?? result) as Record<string, unknown>;
}

/**
 * A vault where a local caller ingested the reserved source; with
 * `withSummary` false its summary page is then removed (the control).
 */
async function ingestedReservedSource(
  withSummary: boolean,
): Promise<Fixture & { readonly summaryPath: string }> {
  const base = mkdtempSync(join(tmpdir(), "o2b-reserved-reingest-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, SOURCE_PATH), PRIVATE_BODY);
  const f = { vault, configPath };
  const summaryPath = String((await ingest(f, TRANSPORT_REACH.local))["summary_path"]);
  if (!withSummary) rmSync(join(vault, summaryPath));
  return { ...f, summaryPath };
}

describe("a remote re-ingest of a reserved summary page", () => {
  test("answers as for the vault without the page and leaves the page byte-identical", async () => {
    const reserved = await ingestedReservedSource(true);
    const control = await ingestedReservedSource(false);
    const summaryAbs = join(reserved.vault, reserved.summaryPath);
    const before = readFileSync(summaryAbs);

    const remote = await ingest(reserved);
    expect(remote).toEqual(await ingest(control));
    expect(remote["created"]).toBe(true);
    expect(readFileSync(summaryAbs).equals(before)).toBe(true);
  });

  test("a reserved summary page is left as it is once its source is open", async () => {
    const f = await ingestedReservedSource(true);
    writeFileSync(join(f.vault, SOURCE_PATH), PRIVATE_BODY.replace(RESERVE_LINE, ""));
    const summaryAbs = join(f.vault, f.summaryPath);
    const before = readFileSync(summaryAbs);

    expect((await ingest(f))["created"]).toBe(true);
    expect(readFileSync(summaryAbs).equals(before)).toBe(true);
  });

  test("a local re-ingest still reads and rewrites the page (positive control)", async () => {
    const reserved = await ingestedReservedSource(true);
    const local = await ingest(reserved, TRANSPORT_REACH.local);
    expect(local["created"]).toBe(false);
    expect(local["summary_path"]).toBe(reserved.summaryPath);
  });
});
