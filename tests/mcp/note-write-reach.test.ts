/**
 * The note write and lifecycle tools answer for a page the caller may not
 * read at its reach exactly as for an absent one.
 *
 * `brain_note_lifecycle`, `brain_append_note`, `brain_update_note` and the
 * update and append operations of `brain_write_batch` name an EXISTING
 * page. A page that reserved itself raises the same refusal a missing
 * path raises, before any plan is built or any byte is written, so a
 * caller that cannot read the page can neither learn that it exists nor
 * change it. `brain_create_note` keeps its occupied-target refusal: it
 * cannot answer "created" without overwriting the page or reporting a
 * write that did not happen, so it refuses and leaves the page alone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  readonly server: MCPServer;
}

/**
 * One vault holding the private page, or one where it never existed. With
 * no `reach`, the server mints none, which fails closed to remote.
 */
function fixture(withSecret: boolean, reach?: typeof TRANSPORT_REACH.local): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-note-write-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, "Notes/open.md"), "# Open\nSee [[secret]].\n");
  writeFileSync(join(vault, "Notes/other.md"), "# Other\nSee [[Notes/secret]].\n");
  if (withSecret) writeFileSync(join(vault, PRIVATE_PATH), SECRET_BODY);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

/** The answer (or the refusal) with the vault path normalised. */
async function answer(f: Fixture, tool: string, args: Record<string, unknown>): Promise<string> {
  let raw: string;
  try {
    raw = `ok: ${JSON.stringify(await f.server.callTool(tool, args))}`;
  } catch (err) {
    const e = err as Error & { code?: unknown; data?: unknown };
    raw = `error: ${e.message} ${JSON.stringify(e.code)} ${JSON.stringify(e.data)}`;
  }
  return raw.split(f.vault).join("<vault>");
}

const CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["brain_note_lifecycle", { action: "delete", path: PRIVATE_PATH }],
  ["brain_note_lifecycle", { action: "delete", path: PRIVATE_PATH, apply: true, confirm: true }],
  ["brain_note_lifecycle", { action: "move", path: PRIVATE_PATH, to: "Other/secret.md" }],
  ["brain_note_lifecycle", { action: "rename", path: PRIVATE_PATH, to: "Notes/renamed.md" }],
  ["brain_note_lifecycle", { action: "archive", path: PRIVATE_PATH, apply: true }],
  ["brain_append_note", { path: PRIVATE_PATH, content: "appended" }],
  ["brain_update_note", { path: PRIVATE_PATH, frontmatter: { visibility: "public" } }],
  ["brain_update_note", { path: PRIVATE_PATH, content: "replaced" }],
  ["brain_write_batch", { operations: [{ op: "append_note", path: PRIVATE_PATH, content: "x" }] }],
  [
    "brain_write_batch",
    {
      operations: [
        { op: "update_note", path: PRIVATE_PATH, frontmatter: { visibility: "public" } },
      ],
    },
  ],
];

describe("a page the caller cannot read answers as an absent one", () => {
  for (const [tool, args] of CALLS) {
    test(`${tool} ${JSON.stringify(args)}`, async () => {
      const hidden = fixture(true);
      const absent = fixture(false);
      expect(await answer(hidden, tool, args)).toBe(await answer(absent, tool, args));
      expect(readFileSync(join(hidden.vault, PRIVATE_PATH), "utf8")).toBe(SECRET_BODY);
    });
  }

  test("a create onto it is refused and leaves the page as it was", async () => {
    const hidden = fixture(true);
    const out = await answer(hidden, "brain_create_note", { path: PRIVATE_PATH, content: "mine" });
    expect(out).toContain("note already exists");
    expect(readFileSync(join(hidden.vault, PRIVATE_PATH), "utf8")).toBe(SECRET_BODY);
  });
});

describe("at local reach the page is planned and written", () => {
  test("lifecycle plan and append", async () => {
    const local = fixture(true, TRANSPORT_REACH.local);
    const plan = await local.server.callTool("brain_note_lifecycle", {
      action: "delete",
      path: PRIVATE_PATH,
    });
    expect(JSON.stringify(plan)).toContain('"from":"Notes/secret.md"');
    await local.server.callTool("brain_append_note", { path: PRIVATE_PATH, content: "appended" });
    expect(readFileSync(join(local.vault, PRIVATE_PATH), "utf8")).toContain("appended");
  });
});
