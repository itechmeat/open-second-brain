/**
 * createNote primitive (Brain Portability & Interop suite, Unit D).
 *
 * The shared write primitive behind the `brain_create_note` MCP tool and
 * the SDK `createNote` method. Writes a Markdown note atomically under
 * `ensureInsideVault`, honouring vault-scope ignore rules and refusing
 * the Brain machinery root, path traversal, and clobbering an existing
 * file - every refusal is a typed `CreateNoteError`, never a silent skip.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNote, CreateNoteError } from "../../../../src/core/brain/notes/create-note.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-create-note-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("createNote", () => {
  test("writes a note with frontmatter and body, returns the vault-relative path", () => {
    const res = createNote(vault, {
      path: "Notes/New.md",
      frontmatter: { title: "New", tags: ["a", "b"] },
      content: "Hello body.",
    });
    expect(res.created).toBe(true);
    expect(res.path).toBe("Notes/New.md");
    const written = readFileSync(join(vault, "Notes/New.md"), "utf8");
    expect(written).toContain("title: New");
    expect(written).toContain("Hello body.");
  });

  test("creates intermediate directories", () => {
    createNote(vault, { path: "A/B/C/Deep.md", content: "x" });
    expect(existsSync(join(vault, "A/B/C/Deep.md"))).toBe(true);
  });

  test("allows a note with no frontmatter and no content", () => {
    const res = createNote(vault, { path: "Notes/Empty.md" });
    expect(res.created).toBe(true);
    expect(existsSync(join(vault, "Notes/Empty.md"))).toBe(true);
  });

  test("rejects a non-.md path with a typed error", () => {
    expect(() => createNote(vault, { path: "Notes/data.json", content: "x" })).toThrow(
      CreateNoteError,
    );
  });

  test("rejects path traversal with a typed error", () => {
    expect(() => createNote(vault, { path: "../escape.md", content: "x" })).toThrow(
      CreateNoteError,
    );
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });

  test("rejects an absolute path with a typed error", () => {
    expect(() => createNote(vault, { path: "/etc/evil.md", content: "x" })).toThrow(
      CreateNoteError,
    );
  });

  test("refuses to write into the Brain machinery root", () => {
    expect(() => createNote(vault, { path: "Brain/sneaky.md", content: "x" })).toThrow(
      CreateNoteError,
    );
    expect(existsSync(join(vault, "Brain/sneaky.md"))).toBe(false);
  });

  test("refuses a vault-scope excluded path", () => {
    expect(() => createNote(vault, { path: ".obsidian/plugins/x.md", content: "x" })).toThrow(
      CreateNoteError,
    );
  });

  test("refuses to clobber an existing note (no overwrite)", () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes/Dup.md"), "original", "utf8");
    expect(() => createNote(vault, { path: "Notes/Dup.md", content: "new" })).toThrow(
      CreateNoteError,
    );
    // The original content is untouched.
    expect(readFileSync(join(vault, "Notes/Dup.md"), "utf8")).toBe("original");
  });

  test("the typed error carries a machine-readable code", () => {
    try {
      createNote(vault, { path: "../escape.md", content: "x" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNoteError);
      expect((err as CreateNoteError).code).toBe("invalid_path");
    }
  });
});
