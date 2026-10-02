/**
 * The compiled digest pages and remote search.
 *
 * `Brain/active.md` is an ordinary page to the indexer (the default skip
 * list names only `index.md` and `log.md`), and it carries no
 * `visibility:` of its own, yet it compiles the principles of preferences
 * that may reserve themselves against remote reads. `brain_context`, the
 * `osb://preferences/active` resource and `brain_pre_compress_pack` render
 * the digest per reader; every generic page reader (search, read,
 * backlinks and the rest) asks the shared reach predicate instead, which
 * withholds the compiled digest pages at remote reach.
 *
 * A/B over the same fixture: the local search finds the principle through
 * the digest page, the remote search finds neither the page nor the
 * principle, so the remote assertion is not vacuous.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActive } from "../../src/core/brain/active.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const MARKER = "zzderiveddigestprobezz";
const PRIVATE_PATH = "Brain/preferences/pref-withheld.md";
const ACTIVE_PATH = "Brain/active.md";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Fixture {
  readonly configPath: string;
  readonly vault: string;
}

async function fixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-derived-digest-search-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writePreference(vault, {
    slug: "withheld",
    topic: "withheld",
    principle: `Always mention ${MARKER} first.`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
  const abs = join(vault, PRIVATE_PATH);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
  regenerateActive(vault);
  await indexVault(resolveSearchConfig({ vault, configPath }), { force: true });
  return { configPath, vault };
}

async function search(f: Fixture, reach: TransportReach): Promise<string> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const server = new MCPServer({ vault: f.vault, configPath: f.configPath }, { reach });
  return JSON.stringify(await server.callTool("brain_search", { query: MARKER }));
}

describe("the indexed active digest and remote search", () => {
  test("a local search finds the principle through the digest page", async () => {
    const local = await search(await fixture(), TRANSPORT_REACH.local);
    expect(local).toContain(ACTIVE_PATH);
    expect(local).toContain(MARKER);
  });

  test("a remote search finds neither the digest page nor the reserved principle", async () => {
    const remote = await search(await fixture(), TRANSPORT_REACH.remote);
    expect(remote).not.toContain(PRIVATE_PATH);
    expect(remote).not.toContain(ACTIVE_PATH);
    expect(remote).not.toContain(MARKER);
  });
});
