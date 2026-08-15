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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
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

  test("refuses a vault-scope excluded path, naming the key and the entry", () => {
    expect(() => createNote(vault, { path: ".obsidian/plugins/x.md", content: "x" })).toThrow(
      /excluded by vault\.ignore_paths \(\.obsidian\)/,
    );
    expect(() => createNote(vault, { path: ".obsidian/plugins/x.md", content: "x" })).toThrow(
      CreateNoteError,
    );
  });

  test("refuses a path outside vault.include_paths, naming THAT polarity", () => {
    // One policy, every consumer. The message has to say which of the two
    // keys refused, because "excluded by vault scope" sends an operator
    // to read the wrong list.
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nvault:\n  include_paths:\n    - Notes\n",
      "utf8",
    );
    expect(() => createNote(vault, { path: "Archive/x.md", content: "x" })).toThrow(
      /outside vault\.include_paths \(Notes\)/,
    );
    expect(existsSync(join(vault, "Archive/x.md"))).toBe(false);
    // Inside the allowlist the same write lands.
    expect(createNote(vault, { path: "Notes/x.md", content: "x" }).created).toBe(true);
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

describe("a caller-named path is read with this host's separator only", () => {
  // Defect 2 of the v1.43.0 security review, reproduced at the envelope.
  // On POSIX a backslash is an ordinary filename character, and three
  // layers disagreed about it: the write-binding matcher split on it, the
  // result renderer rewrote it to `/`, and the Brain-root and vault-scope
  // checks treated it as literal. The envelope refuses the path rather
  // than picking one reading.
  for (const [label, path] of [
    ["a backslash inside a segment", "Projects\\evil.md"],
    ["a backslash traversal", "Projects\\..\\..\\..\\etc\\x.md"],
    ["a backslash-hidden Brain root", "Brain\\x.md"],
  ] as const) {
    test(`${label} is refused, not reinterpreted`, () => {
      let caught: CreateNoteError | null = null;
      try {
        createNote(vault, { path, content: "x" });
      } catch (err) {
        caught = err as CreateNoteError;
      }
      expect(caught).toBeInstanceOf(CreateNoteError);
      expect(caught!.code).toBe("invalid_path");
      expect(readdirSync(vault)).toEqual([]);
    });
  }

  test("a POSIX path with the same segments is still created", () => {
    const res = createNote(vault, { path: "Projects/evil.md", content: "x" });
    expect(res.path).toBe("Projects/evil.md");
    expect(existsSync(join(vault, "Projects", "evil.md"))).toBe(true);
  });
});
