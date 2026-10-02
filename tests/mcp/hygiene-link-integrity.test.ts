/**
 * `brain_hygiene` scan gains ONE additive top-level key
 * (`link_integrity`) from the broken-link ratchet
 * (context-integrity-gates, unit G).
 *
 * Additive means additive: the existing keys keep their names and
 * meanings, and the closed detector tuple - validated in three places,
 * including this tool's input-schema enum - is untouched. A fifth
 * detector would change the tool contract; a top-level key does not.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { HYGIENE_DETECTOR_IDS } from "../../src/core/brain/hygiene/types.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { DANGLING_LINK_DEFINITION } from "../../src/core/search/link-ratchet.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { HYGIENE_TOOLS, LINK_INTEGRITY_REACH_REASON } from "../../src/mcp/brain/hygiene-tools.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

const SCAN_KEYS_BEFORE = [
  "mode",
  "generated_at",
  "detectors_run",
  "counts",
  "findings",
  "errors",
] as const;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-links-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** A scan through a server minted at `reach`, or with no reach minted when `null`. */
async function scan(reach: TransportReach | null = TRANSPORT_REACH.local): Promise<any> {
  const server = new MCPServer({ vault }, reach !== null ? { reach } : {});
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
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_hygiene", arguments: { mode: "scan" } },
  })) as any;
  return r.result.structuredContent;
}

test("the detector tuple and its input-schema enum stay in lockstep", () => {
  expect(HYGIENE_DETECTOR_IDS).toEqual([
    "conflicts",
    "dedup",
    "freshness",
    "usefulness",
    "slug-collisions",
    "tags",
    "capture-scope",
  ]);
  const schema = HYGIENE_TOOLS[0]!.inputSchema as any;
  expect(schema.properties.detectors.items.enum).toEqual([...HYGIENE_DETECTOR_IDS]);
});

test("scan keeps every existing key and adds exactly one", async () => {
  const s = await scan();
  for (const key of SCAN_KEYS_BEFORE) expect(Object.keys(s)).toContain(key);
  expect(Object.keys(s).toSorted()).toEqual([...SCAN_KEYS_BEFORE, "link_integrity"].toSorted());
  expect(s.mode).toBe("scan");
});

test("an unindexed vault reports link integrity as unmeasurable, never as clean", async () => {
  const s = await scan();
  expect(s.link_integrity.measured).toBe(false);
  expect(s.link_integrity.reason).toBe("index-missing");
  expect(s.link_integrity.definition).toBe(DANGLING_LINK_DEFINITION);
  expect(s.link_integrity.dangling).toBeUndefined();
});

test("after a full index run the dangling count is reported with its definition", async () => {
  writeFileSync(join(vault, "Brain", "note-a.md"), "# A\n\n[[Brain/note-b.md]] and [[gone]]\n");
  writeFileSync(join(vault, "Brain", "note-b.md"), "# B\n");
  await indexVault(resolveSearchConfig({ vault }), { force: true });

  const s = await scan();
  expect(s.link_integrity.measured).toBe(true);
  expect(s.link_integrity.definition).toBe(DANGLING_LINK_DEFINITION);
  expect(s.link_integrity.dangling).toBeGreaterThanOrEqual(1);
  expect(typeof s.link_integrity.links).toBe("number");
});

test("at remote reach the count is not measured, so it cannot tell a withheld page from an absent one", async () => {
  writeFileSync(join(vault, "Brain", "note-a.md"), "# A\n\n[[Brain/secret.md]] and [[gone]]\n");
  writeFileSync(join(vault, "Brain", "secret.md"), "---\nvisibility: private\n---\n# S\n");
  await indexVault(resolveSearchConfig({ vault }), { force: true });
  const withheld = (await scan(null)).link_integrity;
  expect((await scan()).link_integrity.measured).toBe(true);

  rmSync(join(vault, "Brain", "secret.md"));
  await indexVault(resolveSearchConfig({ vault }), { force: true });
  const absent = (await scan(null)).link_integrity;

  expect(withheld).toEqual(absent);
  expect(withheld.measured).toBe(false);
  expect(withheld.reason).toBe(LINK_INTEGRITY_REACH_REASON);
  expect(withheld.dangling).toBeUndefined();
});
