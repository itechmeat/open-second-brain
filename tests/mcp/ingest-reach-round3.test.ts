/**
 * An ingest of a source reserved by its own frontmatter records no digest
 * of the reserved bytes on a page a remote reader may read.
 *
 * The entity pages an ingest creates are not reserved: they inherit no
 * visibility from the source. Their `source_content_hash` was the sha256
 * of the whole source file, so a remote caller could confirm a guessed
 * content of a small reserved file by searching for its digest. Whoever
 * ingests the reserved source (a local caller, or a remote one that
 * cannot read it), every remotely readable page must carry the digest as
 * often as in the vault that never ingested it: never.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const SOURCE_PATH = "Clips/reserved.csv";
const RESERVE_LINE = "visibility: private\n";
const PRIVATE_BODY = `---\n${RESERVE_LINE}---\nname,code\nzzdigestprobezz,4711\n`;
const OPEN_BODY = PRIVATE_BODY.replace(RESERVE_LINE, "");
const INGEST_ARGS = Object.freeze({
  source_path: SOURCE_PATH,
  summary: "A clipped source.",
  entities: [{ category: "concept", name: "Plan" }],
});
const MARKDOWN_EXT = ".md";

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

/** A vault holding the source with `body`, never ingested. */
function vaultWithSource(body: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-ingest-reach-r3-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, SOURCE_PATH), body);
  return { vault, configPath };
}

/** Ingest the source through the server at `reach`, or with no reach minted (remote). */
async function ingest(f: Fixture, reach?: TransportReach): Promise<void> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const server = new MCPServer(
    { vault: f.vault, configPath: f.configPath },
    reach !== undefined ? { reach } : undefined,
  );
  await server.callTool("brain_ingest_source", { ...INGEST_ARGS });
}

function markdownPages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return markdownPages(abs);
    return entry.name.endsWith(MARKDOWN_EXT) ? [abs] : [];
  });
}

/** The pages a remote reader may read that carry `digest`, vault-relative and sorted. */
function remotePagesCarrying(f: Fixture, digest: string): ReadonlyArray<string> {
  const cache = new Map();
  return markdownPages(f.vault)
    .map((abs) => relative(f.vault, abs).replaceAll("\\", "/"))
    .filter((rel) => isPathReadableAtReach(f.vault, rel, TRANSPORT_REACH.remote, cache))
    .filter((rel) => readFileSync(join(f.vault, rel), "utf8").includes(digest))
    .toSorted();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("an ingest of a reserved source records no digest a remote reader can read", () => {
  for (const [label, reach] of [
    ["a local caller", TRANSPORT_REACH.local],
    ["a remote caller", undefined],
  ] as const) {
    test(`ingested by ${label}, as in the vault that never ingested it`, async () => {
      const digest = sha256(PRIVATE_BODY);
      const reserved = vaultWithSource(PRIVATE_BODY);
      const never = vaultWithSource(PRIVATE_BODY);
      await ingest(reserved, reach);
      expect(remotePagesCarrying(reserved, digest)).toEqual(remotePagesCarrying(never, digest));
      expect(remotePagesCarrying(reserved, digest)).toEqual([]);
    });
  }

  test("an open source still has its digest recorded on the entity page (positive control)", async () => {
    const open = vaultWithSource(OPEN_BODY);
    await ingest(open, TRANSPORT_REACH.local);
    const carrying = remotePagesCarrying(open, sha256(OPEN_BODY));
    expect(carrying.some((rel) => rel.startsWith("Brain/entities/"))).toBe(true);
  });
});
