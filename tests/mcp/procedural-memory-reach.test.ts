/**
 * `brain_procedural_memory` answers for a procedure page the caller may
 * not read at its reach exactly as for an absent one.
 *
 * An entry names its page's vault-relative path, its title and its
 * frontmatter lists. `list` leaves such an entry out and counts what it
 * returns, `reconcile` reports counts over the pages the caller may read,
 * and `mark_used` and `mark_outcome` refuse its id as unknown before
 * anything is written. At local reach the entry is listed as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { proceduralEntryId } from "../../src/core/brain/procedural-memory.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_PATH = "Brain/procedures/secret-deploy.md";
const SECRET_BODY =
  "---\nvisibility: private\ntriggers: [deploy]\n---\n# Secret deploy\nUse the PIN 4711.\n";
const SECRET_ID = proceduralEntryId(PRIVATE_PATH);

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
  readonly local: MCPServer;
}

/**
 * One vault holding the private procedure, or one where it never existed.
 * `server` mints no reach (remote); `local` is the same vault at local
 * reach, used to seed the index the way an operator would.
 */
async function fixture(withSecret: boolean): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-pmem-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Brain/procedures"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, "Brain/procedures/open-release.md"), "# Open release\nTag it.\n");
  if (withSecret) writeFileSync(join(vault, PRIVATE_PATH), SECRET_BODY);
  const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  await local.callTool("brain_procedural_memory", { operation: "reconcile" });
  return { vault, server: new MCPServer({ vault, configPath }), local };
}

async function answer(server: MCPServer, args: Record<string, unknown>): Promise<string> {
  try {
    return `ok: ${JSON.stringify(await server.callTool("brain_procedural_memory", args))}`;
  } catch (err) {
    const e = err as Error & { code?: unknown; data?: unknown };
    return `error: ${e.message} ${JSON.stringify(e.code)} ${JSON.stringify(e.data)}`;
  }
}

describe("a procedure the caller cannot read answers as an absent one", () => {
  for (const args of [
    { operation: "list" },
    { operation: "list", ranked: true },
    { operation: "reconcile" },
    { operation: "mark_used", id: SECRET_ID },
    { operation: "mark_outcome", id: SECRET_ID, outcome: "success" },
  ]) {
    test(JSON.stringify(args), async () => {
      const hidden = await fixture(true);
      const absent = await fixture(false);
      expect(await answer(hidden.server, args)).toBe(await answer(absent.server, args));
    });
  }

  test("a refused mark writes nothing", async () => {
    const hidden = await fixture(true);
    await answer(hidden.server, { operation: "mark_used", id: SECRET_ID });
    const listed = await answer(hidden.local, { operation: "list" });
    expect(listed).toContain(PRIVATE_PATH);
    expect(listed).not.toContain('"usedCount":1');
  });
});

describe("at local reach the procedure is listed and marked", () => {
  test("list and mark_used", async () => {
    const { local } = await fixture(true);
    expect(await answer(local, { operation: "list" })).toContain(PRIVATE_PATH);
    expect(await answer(local, { operation: "mark_used", id: SECRET_ID })).toContain(
      '"usedCount":1',
    );
  });
});
