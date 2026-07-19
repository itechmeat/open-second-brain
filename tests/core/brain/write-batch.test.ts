/**
 * Kernel 2 (atomic multi-operation write core) unit tests, note-op
 * vocabulary (W1, t_3ff3fe77).
 *
 * The core validates and projects an ordered operation list in memory
 * first, then commits to disk as a unit; the first invalid operation
 * aborts with a typed {@link WriteBatchError} naming the operation index
 * and no disk write happens. Note operations reuse the exact
 * create-note safety envelope (path traversal, Brain machinery root,
 * vault-scope exclusions) and atomic-write semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWriteBatch, WriteBatchError } from "../../../src/core/brain/write-batch.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-batch-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function seedNote(rel: string, body: string, frontmatter = ""): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const fm = frontmatter ? `---\n${frontmatter}\n---\n\n` : "";
  writeFileSync(abs, `${fm}${body}\n`, "utf8");
  return abs;
}

describe("applyWriteBatch note operations", () => {
  test("a single create_note op writes the file and reports applied:1", () => {
    const res = applyWriteBatch(vault, [
      {
        kind: "create_note",
        path: "Notes/New.md",
        frontmatter: { title: "New", tags: ["a", "b"] },
        content: "Hello body.",
      },
    ]);
    expect(res.applied).toBe(1);
    expect(res.done).toBe(true);
    const md = readFileSync(join(vault, "Notes/New.md"), "utf8");
    expect(md).toContain("title: New");
    expect(md).toContain("Hello body.");
    expect(res.results[0]).toMatchObject({ kind: "create_note", path: "Notes/New.md" });
  });

  test("update_note merges frontmatter keys and replaces the body", () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc\nstatus: draft");
    applyWriteBatch(vault, [
      {
        kind: "update_note",
        path: "Notes/Doc.md",
        frontmatter: { status: "final", owner: "me" },
        body: "new body",
      },
    ]);
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    // Merged: existing title preserved, status overridden, owner added.
    expect(md).toContain("title: Doc");
    expect(md).toContain("status: final");
    expect(md).toContain("owner: me");
    expect(md).toContain("new body");
    expect(md).not.toContain("old body");
  });

  test("update_note with only frontmatter keeps the existing body", () => {
    seedNote("Notes/Doc.md", "keep me", "title: Doc");
    applyWriteBatch(vault, [
      { kind: "update_note", path: "Notes/Doc.md", frontmatter: { status: "final" } },
    ]);
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("keep me");
    expect(md).toContain("status: final");
  });

  test("append_note appends to the existing body without touching frontmatter", () => {
    seedNote("Notes/Doc.md", "first line", "title: Doc");
    applyWriteBatch(vault, [{ kind: "append_note", path: "Notes/Doc.md", content: "second line" }]);
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("title: Doc");
    expect(md).toContain("first line");
    expect(md).toContain("second line");
    expect(md.indexOf("first line")).toBeLessThan(md.indexOf("second line"));
  });

  test("update_note on a missing target is a typed error and writes nothing", () => {
    let thrown: unknown;
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Ghost.md", body: "x" }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WriteBatchError);
    expect((thrown as WriteBatchError).code).toBe("target_missing");
    expect((thrown as WriteBatchError).index).toBe(0);
    expect(existsSync(join(vault, "Notes/Ghost.md"))).toBe(false);
  });

  test("append_note on a missing target is a typed error", () => {
    expect(() =>
      applyWriteBatch(vault, [{ kind: "append_note", path: "Notes/Ghost.md", content: "x" }]),
    ).toThrow(WriteBatchError);
  });

  test("update_note requires at least frontmatter or a body", () => {
    seedNote("Notes/Doc.md", "body", "title: Doc");
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("invalid_operation");
    }
  });

  test("create_note refuses to clobber an existing note", () => {
    seedNote("Notes/Dup.md", "original");
    try {
      applyWriteBatch(vault, [{ kind: "create_note", path: "Notes/Dup.md", content: "new" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("exists");
    }
    expect(readFileSync(join(vault, "Notes/Dup.md"), "utf8")).toContain("original");
  });

  test("path traversal is refused via the create-note safety envelope", () => {
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "../escape.md", body: "x" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("invalid_path");
    }
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });

  test("the Brain machinery root is refused", () => {
    try {
      applyWriteBatch(vault, [{ kind: "create_note", path: "Brain/sneaky.md", content: "x" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("excluded");
    }
  });

  test("an empty operations list is a typed error", () => {
    expect(() => applyWriteBatch(vault, [])).toThrow(WriteBatchError);
  });

  test("an unknown op kind aborts with the operation index", () => {
    seedNote("Notes/Doc.md", "body", "title: Doc");
    try {
      applyWriteBatch(vault, [
        { kind: "append_note", path: "Notes/Doc.md", content: "x" },
        // deliberately malformed op at index 1
        { kind: "frobnicate" } as never,
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("invalid_operation");
      expect((err as WriteBatchError).index).toBe(1);
    }
  });

  test("a later invalid op aborts the whole batch: earlier ops do not land", () => {
    const abs = seedNote("Notes/A.md", "unchanged", "title: A");
    const before = readFileSync(abs, "utf8");
    expect(() =>
      applyWriteBatch(vault, [
        // op 0: a valid update to an existing note.
        { kind: "update_note", path: "Notes/A.md", body: "would change" },
        // op 1: invalid - target does not exist. Must abort before commit.
        { kind: "update_note", path: "Notes/Missing.md", body: "y" },
      ]),
    ).toThrow(WriteBatchError);
    // Op 0 must NOT have landed because op 1 failed validation first.
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("two operations targeting the same note in one batch are refused", () => {
    seedNote("Notes/A.md", "body", "title: A");
    try {
      applyWriteBatch(vault, [
        { kind: "update_note", path: "Notes/A.md", body: "one" },
        { kind: "append_note", path: "Notes/A.md", content: "two" },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("duplicate_target");
      expect((err as WriteBatchError).index).toBe(1);
    }
  });

  test("a mid-write failure leaves the target byte-identical", () => {
    // Running as root bypasses filesystem permission bits, so the
    // read-only-directory injection cannot force a write failure there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = join(vault, "Notes");
    const abs = seedNote("Notes/Doc.md", "original body", "title: Doc");
    const before = readFileSync(abs, "utf8");
    chmodSync(dir, 0o500); // r-x: readable for the projection, not writable for the commit
    try {
      expect(() =>
        applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "new body" }]),
      ).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    // The atomic temp-file + rename pipeline never touched the target.
    expect(readFileSync(abs, "utf8")).toBe(before);
  });
});
