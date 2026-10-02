/**
 * `brain_idea_discovery` ranks a vault the caller may read at its reach
 * as a vault without the pages it may not read.
 *
 * An orphan-research idea names a Brain page's path, its basename and its
 * age. A page that reserved itself is neither a candidate nor a source of
 * inbound links (its links would otherwise decide which visible pages
 * count as orphans), and it is left out before the ranking and the cap.
 * At local reach the page is ranked as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_PATH = "Brain/research/secret-plan.md";
const SECRET_BODY = "---\nvisibility: private\n---\n# Secret plan\nBuilds on [[open-study]].\n";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

/**
 * One vault holding the private research page, or one where it never
 * existed. With no `reach`, the server mints none, which fails closed to
 * remote.
 */
function fixture(withSecret: boolean, reach?: typeof TRANSPORT_REACH.local): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-ideas-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Brain/research"), { recursive: true });
  writeFileSync(join(vault, "Brain/research/open-study.md"), "# Open study\n");
  if (withSecret) writeFileSync(join(vault, PRIVATE_PATH), SECRET_BODY);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

/** The ranked ideas, with the age phrases (wall-clock dependent) normalised. */
async function ideas(f: Fixture): Promise<string> {
  const out = await f.server.callTool("brain_idea_discovery", { cap: 50 });
  return JSON.stringify(out).replace(/\d+d old/g, "<age>");
}

describe("a page the caller cannot read is ranked as an absent one", () => {
  test("neither a candidate nor an inbound link", async () => {
    const hidden = fixture(true);
    const absent = fixture(false);
    const answer = await ideas(hidden);
    expect(answer).toBe(await ideas(absent));
    expect(answer).toContain("Brain/research/open-study.md");
  });
});

describe("at local reach the page is ranked", () => {
  test("it is a candidate and its link counts", async () => {
    const answer = await ideas(fixture(true, TRANSPORT_REACH.local));
    expect(answer).toContain(PRIVATE_PATH);
    expect(answer).not.toContain("Brain/research/open-study.md");
  });
});
