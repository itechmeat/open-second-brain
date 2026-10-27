/**
 * MCP surface for the note-file lifecycle: `brain_note_lifecycle` (B2).
 *
 * The defect this covers is the surface's, not the core's: for as long as
 * `brain_create_note` was the only note-file verb, an agent that
 * mis-named a note had no way to say so. This file exercises the tool's
 * own responsibilities - dispatching on `action`, refusing an action it
 * does not have rather than falling back to one it does, mapping the
 * typed core refusal onto a structured MCPError, and carrying the
 * evidence-freshness fields out to the caller.
 *
 * Deliberately NOT covered here: the relocation semantics themselves
 * (`tests/core/brain/notes/note-lifecycle.test.ts` owns those), and the
 * frozen tool-name set (`brain-tools-parity.test.ts` owns that).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { INDEX_EVIDENCE, INDEX_REFRESH } from "../../src/core/brain/notes/lifecycle.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { LIFECYCLE_FILE_TOOLS } from "../../src/mcp/brain/lifecycle-file-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = LIFECYCLE_FILE_TOOLS.find((t) => t.name === "brain_note_lifecycle")!;

/** The handler's declared return, so the assertions below index it. */
type ToolResult = Record<string, unknown>;

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return (await tool.handler(ctx, args)) as ToolResult;
}

function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("brain_note_lifecycle registration", () => {
  test("advertises a closed action enum and requires an action and a path", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["action", "path"]);
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties["action"]?.enum).toEqual([
      "rename",
      "move",
      "archive",
      "delete",
      "move-folder",
      "rename-folder",
    ]);
  });

  test("the description names the folder actions and where they run", () => {
    // The enum admits the folder actions, so the description must say the
    // same thing the refusal says: they address a whole folder and run in
    // the folder lifecycle - and the path argument covers a folder, which
    // carries no .md suffix.
    expect(tool.description).toContain("move-folder");
    expect(tool.description).toContain("rename-folder");
    expect(tool.description).toContain("folder lifecycle");
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties["path"]?.description).toContain("folder");
  });
});

describe("folder actions through the tool", () => {
  test("a folder action refuses confirm and delete_linked instead of dropping them", async () => {
    note("Projects/Old/a.md", "alpha\n");
    for (const extra of [{ confirm: true }, { delete_linked: true }]) {
      await expect(
        call({ action: "move-folder", path: "Projects/Old", to: "Archive", ...extra }),
      ).rejects.toThrow(/takes neither confirm nor delete_linked/);
    }
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive"))).toBe(false);
  });

  test("a folder holding a note the caller's reach denies refuses exactly as a missing one", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/quiet.md", "---\nvisibility: private\n---\nreserved\n");
    const remote = { ...ctx, reach: TRANSPORT_REACH.remote };

    for (const apply of [false, true]) {
      await expect(
        tool.handler(remote, { action: "move-folder", path: "Projects/Old", to: "Archive", apply }),
      ).rejects.toThrow(/no note folder/);
    }
    // Nothing was planned, moved or renamed on either run, and the
    // refusal never names the denied page.
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/quiet.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive"))).toBe(false);
  });

  test("move-folder relocates the folder and renders the move report", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Notes/Ref.md", "pathed [[Projects/Old/a]]\n");

    const res = await call({
      action: "move-folder",
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res).toMatchObject({
      action: "move-folder",
      applied: true,
      from: "Projects/Old",
      to: "Archive/Old",
    });
    // The moved list, per file, and the per-file failure list.
    expect(res["moved"]).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(res["move_failures"]).toEqual([]);
    // A relocation destroys nothing, so no snapshot rides the response.
    expect(res["snapshot"]).toBeNull();
    const references = res["references"] as Record<string, unknown>;
    expect(references["files_rewritten"]).toBe(1);
    expect(references["inbound_files"]).toEqual(["Notes/Ref.md"]);
    expect(readFileSync(join(vault, "Notes/Ref.md"), "utf8")).toContain("[[a]]");
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(false);
  });

  test("move-folder names non-Markdown residue and omits the field when clean", async () => {
    note("Projects/Old/a.md", "alpha\n");
    writeFileSync(join(vault, "Projects/Old/img.png"), "png\n");

    const res = await call({
      action: "move-folder",
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });
    expect(res["left_behind"]).toEqual(["img.png"]);
    expect(existsSync(join(vault, "Projects/Old/img.png"))).toBe(true);

    // Absent-when-empty: the rename-folder response of a move that
    // empties its folder carries no left_behind key at all.
    note("Other/Sub/b.md", "beta\n");
    const clean = await call({
      action: "move-folder",
      path: "Other/Sub",
      to: "Archive2",
      apply: true,
    });
    expect("left_behind" in clean).toBe(false);
  });

  test("move-folder names the relative embeds whose targets stayed behind (M17)", async () => {
    note("Projects/Old/a.md", "![pic](diagram.png)\n");
    writeFileSync(join(vault, "Projects/Old/diagram.png"), "png\n");

    const res = await call({
      action: "move-folder",
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });
    // The wikilink pass rewrites [[path]] spellings only; a relative
    // image depends on the note's directory, so the response names the
    // pair instead of letting files_rewritten: 0 read as "nothing broke".
    expect(res["dangling_relative_links"]).toEqual([
      { note: "Archive/Old/a.md", target: "diagram.png" },
    ]);
    expect(res["left_behind"]).toEqual(["diagram.png"]);

    // Absent-when-empty: a move whose relative targets move with the
    // folder carries no dangling_relative_links key at all.
    note("Whole/Sub/b.md", "[link](kept.md)\n");
    note("Whole/Sub/kept.md", "the target is a note; it moves too\n");
    const clean = await call({
      action: "move-folder",
      path: "Whole/Sub",
      to: "Archive3",
      apply: true,
    });
    expect("dangling_relative_links" in clean).toBe(false);
  });

  test("rename-folder renames within the parent through the same tool", async () => {
    note("Projects/Old/a.md", "alpha\n");
    const res = await call({
      action: "rename-folder",
      path: "Projects/Old",
      to: "New",
      apply: true,
    });
    expect(res).toMatchObject({ action: "rename-folder", applied: true, to: "Projects/New" });
    expect(res["moved"]).toEqual([{ from: "Projects/Old/a.md", to: "Projects/New/a.md" }]);
    expect(existsSync(join(vault, "Projects/New/a.md"))).toBe(true);
  });
});

describe("dispatch", () => {
  test("renames, and reports what it rewrote plus how stale the index is", async () => {
    note("Projects/Old.md", "x\n");
    note("Projects/Ref.md", "[[Projects/Old]]\n");

    const res = await call({
      action: "rename",
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(res).toMatchObject({ action: "rename", applied: true, to: "Projects/New.md" });
    const references = res["references"] as Record<string, unknown>;
    expect(references["files_rewritten"]).toBe(1);
    expect(references["inbound_files"]).toEqual(["Projects/Ref.md"]);
    // The spellings the rewrite carried out, minimal forms included.
    expect(references["rewritten_spellings"]).toEqual([
      { from: "Projects/Old.md", to: "New" },
      { from: "Projects/Old", to: "New" },
      { from: "Old", to: "New" },
    ]);
    // Freshening is off suite-wide, so the write claimed nothing - and
    // the refusal says why on the same response, so a caller reading
    // `not_claimed` is not left to distinguish a deliberate off from a
    // broken freshen path.
    expect(references["refresh"]).toBe(INDEX_REFRESH.notClaimed);
    expect(references["refresh_reason"]).toBe("no_index");
    const index = references["index"] as Record<string, unknown>;
    expect(index["state"]).toBe(INDEX_EVIDENCE.absent);
    expect(typeof index["next_command"]).toBe("string");
    expect(readFileSync(join(vault, "Projects/Ref.md"), "utf8")).toContain("[[New]]");
  });

  test("dry run is the default: nothing moves without an explicit apply", async () => {
    note("Projects/Old.md", "x\n");
    const res = await call({
      action: "rename",
      path: "Projects/Old.md",
      to: "Projects/New.md",
    });
    expect(res["applied"]).toBe(false);
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });

  test("a delete carries the recoverability verdict, not just a snapshot path", async () => {
    note("Projects/Gone.md", "x\n");
    const res = await call({
      action: "delete",
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
    });
    const verdict = res["recoverability"] as Record<string, unknown>;
    expect(verdict["state"]).toBe("unproven");
    expect(verdict["blockers"]).toContain("outside_brain_root");
    expect(res["snapshot"]).not.toBeNull();
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(false);
  });

  test("an unconfirmed delete is a structured refusal that writes nothing", async () => {
    note("Projects/Gone.md", "x\n");
    let caught: unknown;
    try {
      await tool.handler(ctx, { action: "delete", path: "Projects/Gone.md", apply: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).data).toMatchObject({ code: "not_confirmed" });
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(true);
  });

  test("an unknown action is refused rather than falling back to one that exists", async () => {
    note("Projects/Old.md", "x\n");
    await expect(
      tool.handler(ctx, { action: "obliterate", path: "Projects/Old.md", apply: true }),
    ).rejects.toBeInstanceOf(MCPError);
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });

  test("a count-guard mismatch aborts before any write and names the count", async () => {
    note("Projects/Old.md", "x\n");
    note("Projects/A.md", "[[Projects/Old]]\n");
    let caught: unknown;
    try {
      await tool.handler(ctx, {
        action: "rename",
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        expect: 5,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).data).toMatchObject({ code: "count_guard", matched: 1 });
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });
});

/**
 * `delete_linked` on the tool surface (unit 3a / t_5e338af1). The fold and
 * the ladder are the core's; what belongs here is that the boolean reaches
 * it, that the two lists and the scanned scope are rendered, and that a
 * response without the flag says `null` rather than an empty cascade.
 */
describe("delete_linked", () => {
  test("renders the deletion set, the reported set and the scanned scope", async () => {
    note("Imports/Bench.md", "rows\n");
    note("Projects/Reader.md", "[[Imports/Bench]]\n");
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "inbox", "sig-derived.md"),
      '---\nid: sig-derived\nkind: brain-signal\nsource:\n  - "[[Imports/Bench]]"\n---\n\nbody\n',
    );

    const res = await call({ action: "delete", path: "Imports/Bench.md", delete_linked: true });
    const cascade = res["cascade"] as {
      deletion_set: string[];
      reported_files: string[];
      scanned_scope: string;
    };
    expect(cascade.deletion_set).toEqual(["Imports/Bench.md", "Brain/inbox/sig-derived.md"]);
    expect(cascade.reported_files).toContain("Projects/Reader.md");
    expect(cascade.scanned_scope).toBe("Brain/");
    // A dry run: nothing went.
    expect(existsSync(join(vault, "Brain", "inbox", "sig-derived.md"))).toBe(true);
  });

  test("a response without the flag carries cascade: null, not an empty one", async () => {
    note("Projects/Gone.md", "x\n");
    const res = await call({ action: "delete", path: "Projects/Gone.md" });
    expect(res["cascade"]).toBeNull();
  });

  test("the flag is refused on an action that removes nothing", async () => {
    note("Projects/Old.md", "x\n");
    let caught: unknown;
    try {
      await call({
        action: "rename",
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
        delete_linked: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).data).toMatchObject({ code: "cascade_forbidden" });
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });
});
