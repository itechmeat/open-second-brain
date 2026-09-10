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
 *
 * The nothing-writes-silently wave (unit B) adds two refusals to that
 * vocabulary, pinned below:
 *
 *   1. `target_unreadable` - a note that exists and cannot be read is no
 *      longer projected as an empty note, for update and for append. The
 *      refusal names the path and the reason, and the file is untouched.
 *   1b. `target_frontmatter_lossy` - the same refusal for the other thing
 *      the parser can report: a frontmatter line it could not express and
 *      dropped. The read-modify-write re-serialises the parsed map, so
 *      writing would delete that line and report success.
 *   2. `blank_overwrite_refused` - an update may not replace a body that
 *      carries text with a blank one unless `allowEmpty` says so.
 *      Whitespace-only is blank; a create of a genuinely new empty note
 *      is not an update and is unaffected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyWriteBatch, WriteBatchError } from "../../../src/core/brain/write-batch.ts";
import { listNoteWrites, type NoteWriteRecord } from "../../../src/core/brain/notes/write-log.ts";
import {
  NOTE_WRITE_NO_PRIOR,
  pruneWriteImages,
} from "../../../src/core/brain/notes/write-record.ts";
import { writeImagePath } from "../../../src/core/brain/paths.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";

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

  test("update_note refuses a blank body over a note that has one", () => {
    const abs = seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const before = readFileSync(abs, "utf8");
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("blank_overwrite_refused");
      expect((err as WriteBatchError).index).toBe(0);
      // The refusal names the note, not just the operation index.
      expect((err as WriteBatchError).message).toContain("Notes/Doc.md");
      expect((err as WriteBatchError).details).toMatchObject({ path: "Notes/Doc.md" });
    }
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("a whitespace-only body is a blank one: the parser would trim it away", () => {
    const abs = seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const before = readFileSync(abs, "utf8");
    expect(() =>
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "  \n\t\n" }]),
    ).toThrow(WriteBatchError);
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("allowEmpty clears the body deliberately, keeping the frontmatter", () => {
    const abs = seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    applyWriteBatch(vault, [
      { kind: "update_note", path: "Notes/Doc.md", body: "", allowEmpty: true },
    ]);
    const md = readFileSync(abs, "utf8");
    expect(md).toContain("title: Doc");
    expect(md).not.toContain("worth keeping");
  });

  test("a frontmatter-only update never trips the blank guard", () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    applyWriteBatch(vault, [
      { kind: "update_note", path: "Notes/Doc.md", frontmatter: { status: "final" } },
    ]);
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("worth keeping");
    expect(md).toContain("status: final");
  });

  test("creating a genuinely new empty note is untouched by the guard", () => {
    const res = applyWriteBatch(vault, [
      { kind: "create_note", path: "Notes/Empty.md", frontmatter: { title: "Empty" } },
    ]);
    expect(res.applied).toBe(1);
    const md = readFileSync(join(vault, "Notes/Empty.md"), "utf8");
    expect(md).toContain("title: Empty");
  });

  test("an update on a note that cannot be read is refused, and nothing is written", () => {
    // A directory standing where a note should be: `existsSync` says
    // yes and `readFileSync` raises EISDIR - an existing target the
    // process cannot read, without depending on permission bits.
    const abs = join(vault, "Notes/Doc.md");
    mkdirSync(abs, { recursive: true });
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "replacement" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("target_unreadable");
      expect((err as WriteBatchError).message).toContain("Notes/Doc.md");
      // The reason travels with the refusal; a bare "could not read"
      // would leave the operator guessing between a permission bit and
      // a missing mount.
      expect(String((err as WriteBatchError).details["reason"])).toContain("EISDIR");
    }
    expect(statSync(abs).isDirectory()).toBe(true);
  });

  test("an append onto a note that cannot be read is refused, and nothing is written", () => {
    const abs = join(vault, "Notes/Doc.md");
    mkdirSync(abs, { recursive: true });
    try {
      applyWriteBatch(vault, [{ kind: "append_note", path: "Notes/Doc.md", content: "more" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("target_unreadable");
    }
    expect(statSync(abs).isDirectory()).toBe(true);
  });

  test("an update on a note whose frontmatter the scanner cannot express is refused", () => {
    // The line scanner has no branch for a continuation line, so it drops
    // it and says so. A read-modify-write re-serialises the PARSED map, so
    // proceeding would delete that line from disk and answer updated: true.
    const abs = seedNote("Notes/Odd.md", "body", "title: Odd\n  continued indent line");
    const before = readFileSync(abs, "utf8");
    try {
      applyWriteBatch(vault, [
        { kind: "update_note", path: "Notes/Odd.md", frontmatter: { reviewed: "2026-08-23" } },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("target_frontmatter_lossy");
      expect((err as WriteBatchError).message).toContain("Notes/Odd.md");
      expect(String((err as WriteBatchError).details["reason"])).toContain("continued indent line");
    }
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("an append onto such a note is refused too - it rewrites the same frontmatter", () => {
    const abs = seedNote("Notes/Odd.md", "body", "title: Odd\n  continued indent line");
    const before = readFileSync(abs, "utf8");
    expect(() =>
      applyWriteBatch(vault, [{ kind: "append_note", path: "Notes/Odd.md", content: "more" }]),
    ).toThrow(WriteBatchError);
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("frontmatter the scanner does express is updated as before", () => {
    // The refusal is scoped to a line the parser reported dropping: a
    // comment and a block list are both consumed, not dropped.
    const abs = seedNote("Notes/Fine.md", "body", "# a comment\ntags:\n  - one\ntitle: Fine");
    applyWriteBatch(vault, [
      { kind: "update_note", path: "Notes/Fine.md", frontmatter: { status: "final" } },
    ]);
    const md = readFileSync(abs, "utf8");
    expect(md).toContain("status: final");
    expect(md).toContain("title: Fine");
  });

  test("an unreadable-by-permission note is refused rather than blanked", () => {
    // Running as root bypasses the permission bits this case needs.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const abs = seedNote("Notes/Secret.md", "the body that must survive", "title: Secret");
    const before = readFileSync(abs, "utf8");
    chmodSync(abs, 0o000);
    try {
      expect(() =>
        applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Secret.md", body: "new" }]),
      ).toThrow(WriteBatchError);
    } finally {
      chmodSync(abs, 0o600);
    }
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("an unreadable target at op 1 aborts the batch before op 0 lands", () => {
    const kept = seedNote("Notes/A.md", "unchanged", "title: A");
    const before = readFileSync(kept, "utf8");
    mkdirSync(join(vault, "Notes/B.md"), { recursive: true });
    expect(() =>
      applyWriteBatch(vault, [
        { kind: "update_note", path: "Notes/A.md", body: "would change" },
        { kind: "update_note", path: "Notes/B.md", body: "y" },
      ]),
    ).toThrow(WriteBatchError);
    expect(readFileSync(kept, "utf8")).toBe(before);
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

/**
 * Attributable note writes (who-wrote-what, Task A / t_662f4e82).
 *
 * The kernel is one of the two seams every note mutation funnels through,
 * so this is where "exactly one event per write" is pinned - along with
 * the before-image, which is what makes a recorded write undoable rather
 * than merely visible.
 */
describe("applyWriteBatch note-write attribution", () => {
  function noteWrites(): ReadonlyArray<NoteWriteRecord> {
    return listNoteWrites(vault).writes;
  }

  test("each of the three note operations appends exactly one event", () => {
    seedNote("Notes/Doc.md", "original body", "title: Doc");
    applyWriteBatch(vault, [{ kind: "create_note", path: "Notes/Fresh.md", content: "fresh" }]);
    applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "next body" }]);
    applyWriteBatch(vault, [{ kind: "append_note", path: "Notes/Doc.md", content: "more" }]);

    const writes = noteWrites();
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => `${w.op} ${w.target}`).toSorted()).toEqual([
      "append Notes/Doc.md",
      "create Notes/Fresh.md",
      "update Notes/Doc.md",
    ]);
  });

  test("every note result carries the id of the event that attributes it", () => {
    seedNote("Notes/Doc.md", "original body", "title: Doc");
    const res = applyWriteBatch(vault, [
      { kind: "create_note", path: "Notes/Fresh.md", content: "fresh" },
      { kind: "update_note", path: "Notes/Doc.md", body: "next body" },
    ]);
    const ids = res.results.map((r) => ("write_id" in r ? r.write_id : null));
    for (const id of ids) expect(id).toMatch(/^nw_\d{14}_[0-9a-f]{16}$/);
    expect(new Set(noteWrites().map((w) => w.write_id))).toEqual(new Set(ids as string[]));
    // The audit half is a pair: an id present means no reason is owed.
    for (const r of res.results) expect("audit_reason" in r).toBe(false);
  });

  test("an update records the bytes it replaced and the bytes it wrote", () => {
    const abs = seedNote("Notes/Doc.md", "original body", "title: Doc");
    const before = readFileSync(abs, "utf8");
    applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "next body" }]);
    const after = readFileSync(abs, "utf8");

    const write = noteWrites()[0]!;
    expect(write.hash_before).toBe(sha256Hex(before));
    expect(write.hash_after).toBe(sha256Hex(after));
    expect(write.bytes_before).toBe(Buffer.byteLength(before, "utf8"));
    expect(write.bytes_after).toBe(Buffer.byteLength(after, "utf8"));
    // The before-image holds the exact prior bytes, keyed by their hash.
    expect(readFileSync(writeImagePath(vault, write.hash_before), "utf8")).toBe(before);
  });

  test("a create records no prior content and stores no image", () => {
    applyWriteBatch(vault, [{ kind: "create_note", path: "Notes/Fresh.md", content: "fresh" }]);
    const write = noteWrites()[0]!;
    expect(write.hash_before).toBe(NOTE_WRITE_NO_PRIOR);
    expect(write.bytes_before).toBe(0);
    expect(pruneWriteImages(vault, { olderThanDays: 0, dryRun: true }).removed).toEqual([]);
  });

  test("returning a note to a former state re-uses the image already stored", () => {
    const abs = seedNote("Notes/Doc.md", "one", "title: Doc");
    const first = readFileSync(abs, "utf8");
    applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "two" }]);
    const second = readFileSync(abs, "utf8");
    applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "one" }]);
    applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Doc.md", body: "two" }]);

    // Three rewrites, two distinct prior contents, two image files.
    expect(noteWrites()).toHaveLength(3);
    const stored = pruneWriteImages(vault, { olderThanDays: 0, dryRun: true }).removed;
    expect(stored.toSorted()).toEqual([sha256Hex(first), sha256Hex(second)].toSorted());
  });

  test("a refused batch records nothing, because no bytes were written", () => {
    seedNote("Notes/Doc.md", "original body", "title: Doc");
    expect(() =>
      applyWriteBatch(vault, [
        { kind: "update_note", path: "Notes/Doc.md", body: "next body" },
        { kind: "update_note", path: "Notes/Missing.md", body: "never" },
      ]),
    ).toThrow(WriteBatchError);
    expect(noteWrites()).toEqual([]);
  });
});
