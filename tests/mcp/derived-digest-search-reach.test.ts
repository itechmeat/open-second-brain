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
 * principle, so the remote assertion is not vacuous; an ordinary page is
 * still found remotely, so the remote search is not simply empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const MARKER = "zzderiveddigestprobezz";
const PRIVATE_PATH = "Brain/preferences/pref-withheld.md";
const ACTIVE_PATH = "Brain/active.md";
/** An ordinary page every reach may read: the remote half's positive control. */
const OPEN_MARKER = "zzopenprobezz";
const OPEN_PATH = "Notes/open.md";
/** A query nothing in the fixture matches, so the answer is the corpus statement. */
const ABSENT_QUERY = "zzabsentprobezz";
/** How the corpus statement names its document count. */
const COUNT_WORDING = "document(s)";
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

async function fixture(reserved = true): Promise<Fixture> {
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
  if (reserved) {
    const abs = join(vault, PRIVATE_PATH);
    const text = readFileSync(abs, "utf8");
    const close = text.indexOf("\n---\n", "---\n".length);
    writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
  }
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, OPEN_PATH), `# Open\n\nThis page mentions ${OPEN_MARKER}.\n`);
  regenerateActive(vault);
  await indexVault(resolveSearchConfig({ vault, configPath }), { force: true });
  return { configPath, vault };
}

async function search(f: Fixture, reach: TransportReach, query = MARKER): Promise<string> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const server = new MCPServer({ vault: f.vault, configPath: f.configPath }, { reach });
  return JSON.stringify(await server.callTool("brain_search", { query }));
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

  test("a remote search still finds an ordinary page", async () => {
    const remote = await search(await fixture(), TRANSPORT_REACH.remote, OPEN_MARKER);
    expect(remote).toContain(OPEN_PATH);
  });

  test("a remote search with no match states no index counts", async () => {
    // The counts cover every indexed page, the reserved one included, so a
    // remote caller is told only that nothing matched and when the index
    // was built; the local half proves the counts are there to leave out.
    const f = await fixture();
    expect(await search(f, TRANSPORT_REACH.local, ABSENT_QUERY)).toContain(COUNT_WORDING);
    const remote = await search(f, TRANSPORT_REACH.remote, ABSENT_QUERY);
    expect(remote).toContain("no match in the index as of");
    expect(remote).not.toContain(COUNT_WORDING);
  });

  test("the digest page is withheld at remote reach even when nothing is reserved", async () => {
    // The compiled digest pages are withheld below local reach whatever
    // they compile, so a vault with no reserved preference answers the
    // same way; the local half proves the page is indexed.
    const f = await fixture(false);
    expect(await search(f, TRANSPORT_REACH.local)).toContain(ACTIVE_PATH);
    expect(await search(f, TRANSPORT_REACH.remote)).not.toContain(ACTIVE_PATH);
  });
});

describe("the compiled digest pages in any spelling the filesystem resolves to them", () => {
  // The leading-slash row is re-rooted inside the vault by a join on every
  // OS; the case and trailing-dot rows name the same file on a
  // case-insensitive filesystem.
  for (const spelling of [
    "/Brain/active.md",
    "brain/active.md",
    "BRAIN/Lessons.md",
    "Brain/active.md.",
  ]) {
    test(`${spelling} is withheld at remote reach and readable at local reach`, async () => {
      const f = await fixture(false);
      expect(isPathReadableAtReach(f.vault, spelling, TRANSPORT_REACH.remote, new Map())).toBe(
        false,
      );
      expect(isPathReadableAtReach(f.vault, spelling, TRANSPORT_REACH.local, new Map())).toBe(true);
    });
  }
});
