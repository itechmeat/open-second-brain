/**
 * `brain_delete_by_source` answers for an original the caller may not read
 * at its reach exactly as for an absent one.
 *
 * The original named by `source_file` is a vault file outside `Brain/`.
 * A page that reserved itself is not confirmed by the plan (`originals`,
 * `blast_radius`, `matched`), and a confirmed run with
 * `include_originals` leaves it on disk, because a caller that cannot
 * read the page cannot learn that it exists by asking to delete it, and
 * cannot remove it either. The same call at local reach plans and
 * deletes it as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_PATH = "Notes/secret.md";
const SECRET_BODY = "---\nvisibility: private\n---\n# Secret plan\nThe PIN is 4711.\n";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly base: string;
  readonly server: MCPServer;
}

/**
 * One vault holding the private page, or one where it never existed. With
 * no `reach`, the server mints none, which fails closed to remote.
 */
function fixture(withSecret: boolean, reach?: typeof TRANSPORT_REACH.local): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-dbs-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, "Notes/open.md"), "# Open\n");
  if (withSecret) writeFileSync(join(vault, PRIVATE_PATH), SECRET_BODY);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, base, server };
}

/** The structured answer with the per-vault parts (paths, run ids, timestamps) normalised. */
async function answer(f: Fixture, args: Record<string, unknown>): Promise<string> {
  let raw: string;
  try {
    raw = JSON.stringify(await f.server.callTool("brain_delete_by_source", args));
  } catch (err) {
    raw = `error: ${(err as Error).message}`;
  }
  return raw
    .split(f.vault)
    .join("<vault>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
    .replace(/"(snapshot_run_id|audit_record_id)":"[^"]*"/g, '"$1":"<id>"');
}

describe("an original the caller cannot read answers as an absent one", () => {
  test("the dry run does not confirm it", async () => {
    const hidden = fixture(true);
    const absent = fixture(false);
    const args = { source_file: PRIVATE_PATH };
    expect(await answer(hidden, args)).toBe(await answer(absent, args));
  });

  test("a confirmed run with include_originals leaves it on disk", async () => {
    const hidden = fixture(true);
    const absent = fixture(false);
    const args = { source_file: PRIVATE_PATH, confirm: true, include_originals: true };
    expect(await answer(hidden, args)).toBe(await answer(absent, args));
    expect(existsSync(join(hidden.vault, PRIVATE_PATH))).toBe(true);
  });
});

describe("at local reach the original is planned and deleted", () => {
  test("dry run and confirmed run", async () => {
    const local = fixture(true, TRANSPORT_REACH.local);
    const plan = await local.server.callTool("brain_delete_by_source", {
      source_file: PRIVATE_PATH,
    });
    expect(JSON.stringify(plan)).toContain(`"originals":["${PRIVATE_PATH}"]`);
    await local.server.callTool("brain_delete_by_source", {
      source_file: PRIVATE_PATH,
      confirm: true,
      include_originals: true,
    });
    expect(existsSync(join(local.vault, PRIVATE_PATH))).toBe(false);
  });
});
