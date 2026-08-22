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
import { INDEX_EVIDENCE } from "../../src/core/brain/notes/lifecycle.ts";
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
    expect(properties["action"]?.enum).toEqual(["rename", "move", "archive", "delete"]);
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
    const index = references["index"] as Record<string, unknown>;
    expect(index["state"]).toBe(INDEX_EVIDENCE.absent);
    expect(typeof index["next_command"]).toBe("string");
    expect(readFileSync(join(vault, "Projects/Ref.md"), "utf8")).toContain("[[Projects/New]]");
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
