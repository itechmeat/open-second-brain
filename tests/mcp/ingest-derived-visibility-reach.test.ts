/**
 * A summary page that carries a derived section is at most as visible as
 * its source.
 *
 * The derived section copies source content (table rows, HTML headings)
 * onto `Brain/sources/src-*.md`. A local caller may ingest a source whose
 * own frontmatter reserves it; the summary page then inherits that
 * visibility, so a later caller at remote reach finds neither the copied
 * words through `brain_search` nor the page through the shared reach
 * predicate every generic page reader asks, while a local caller may still
 * read the page.
 *
 * The A/B control is the same source without its reserving block: the
 * remote search then finds the derived words on the summary page, so the
 * remote assertion is not vacuous. (A local `brain_search` is no control:
 * its default scope leaves reserved pages out at every reach, and the
 * reserved token cannot be requested as an argument.)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { isPathReadableAtReach } from "../../src/core/search/result-filters.ts";
import { MCPServer } from "../../src/mcp/server.ts";

/** A word only the source's data carries: a table row or an HTML heading. */
const ROW_WORD = "zzderivedrowprobezz";
const HEADING_WORD = "zzderivedheadingprobezz";
const RESERVE_BLOCK = "---\nvisibility: private\n---\n";

/** The byte-order mark a spreadsheet export may put before everything else. */
const BYTE_ORDER_MARK = "\ufeff";

interface Case {
  readonly label: string;
  readonly path: string;
  /** What precedes the reserving block, kept in the open control too. */
  readonly lead?: string;
  /** The source's data, after the reserving block. */
  readonly data: string;
  readonly word: string;
}

const CASES: readonly Case[] = Object.freeze([
  {
    label: "a reserved CSV",
    path: "Clips/reserved.csv",
    data: `name,code\n${ROW_WORD},4711\n`,
    word: ROW_WORD,
  },
  {
    label: "a reserved CSV behind a byte-order mark",
    path: "Clips/reserved-bom.csv",
    lead: BYTE_ORDER_MARK,
    data: `name,code\n${ROW_WORD},4711\n`,
    word: ROW_WORD,
  },
  {
    label: "a reserved HTML file",
    path: "Clips/reserved.html",
    data: `<h1>${HEADING_WORD}</h1><p>Body.</p>\n`,
    word: HEADING_WORD,
  },
]);

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
  readonly summaryPath: string;
}

/** A server at the reach given, or with no reach minted at all (remote). */
function serverAt(f: Pick<Fixture, "vault" | "configPath">, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  return new MCPServer(
    { vault: f.vault, configPath: f.configPath },
    reach !== undefined ? { reach } : undefined,
  );
}

/** A vault where a local caller ingested the source, then indexed. */
async function ingestedAtLocalReach(c: Case, reserved = true): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-derived-visibility-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Clips"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  const lead = c.lead ?? "";
  writeFileSync(join(vault, c.path), `${lead}${reserved ? RESERVE_BLOCK : ""}${c.data}`);
  const result = (await serverAt({ vault, configPath }, TRANSPORT_REACH.local).callTool(
    "brain_ingest_source",
    {
      source_path: c.path,
      summary: "A clipped source.",
      entities: [{ category: "concept", name: "Plan" }],
    },
  )) as Record<string, unknown>;
  const structured = (result["structuredContent"] ?? result) as Record<string, unknown>;
  await indexVault(resolveSearchConfig({ vault, configPath }), { force: true });
  return { vault, configPath, summaryPath: String(structured["summary_path"]) };
}

/** A search with no reach minted, which fails closed to remote. */
async function remoteSearch(f: Fixture, query: string): Promise<string> {
  return JSON.stringify(await serverAt(f).callTool("brain_search", { query }));
}

describe("a summary page derived from a reserved source", () => {
  for (const c of CASES) {
    test(`${c.label}: a remote search finds the derived words only when the source is open`, async () => {
      const open = await ingestedAtLocalReach(c, false);
      const control = await remoteSearch(open, c.word);
      expect(control).toContain(c.word);
      expect(control).toContain(open.summaryPath);

      const f = await ingestedAtLocalReach(c);
      const remote = await remoteSearch(f, c.word);
      expect(remote).not.toContain(c.word);
      expect(remote).not.toContain(f.summaryPath);
    });

    test(`${c.label}: the summary page is withheld from a remote read`, async () => {
      const f = await ingestedAtLocalReach(c);
      expect(isPathReadableAtReach(f.vault, f.summaryPath, TRANSPORT_REACH.local, new Map())).toBe(
        true,
      );
      expect(isPathReadableAtReach(f.vault, f.summaryPath, TRANSPORT_REACH.remote, new Map())).toBe(
        false,
      );
    });
  }
});
