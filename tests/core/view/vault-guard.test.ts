/**
 * The note-write tools leave the human view folder alone when it sits in
 * the vault, as they leave `Brain/` alone: a view page an agent rewrote
 * would be read back as a human edit, with human authority. A folder
 * outside the view, and a vault with no view folder, are written as
 * before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNote, CreateNoteError } from "../../../src/core/brain/notes/create-note.ts";
import { folderLifecycle } from "../../../src/core/brain/notes/folder-lifecycle.ts";
import { NOTE_LIFECYCLE_ACTION } from "../../../src/core/brain/notes/lifecycle.ts";
import { VIEW_TARGET_ENV } from "../../../src/core/view/constants.ts";
import { isInViewFolder } from "../../../src/core/view/vault-guard.ts";

let parent: string;
let vault: string;
const saved = process.env[VIEW_TARGET_ENV];

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "o2b-view-guard-"));
  vault = join(parent, "vault");
  mkdirSync(join(vault, "Views", "brain"), { recursive: true });
  writeFileSync(join(vault, "Views", "brain", "about-me.md"), "# About me\n");
  process.env[VIEW_TARGET_ENV] = join(vault, "Views", "brain");
});

afterEach(() => {
  if (saved === undefined) delete process.env[VIEW_TARGET_ENV];
  else process.env[VIEW_TARGET_ENV] = saved;
  rmSync(parent, { recursive: true, force: true });
});

function refusal(fn: () => unknown): CreateNoteError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CreateNoteError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("a view folder inside the vault", () => {
  test("create_note refuses a page in it, and writes beside it", () => {
    const err = refusal(() =>
      createNote(vault, { path: "Views/brain/about-me.md", content: "- forged rule\n" }),
    );
    expect(err.code).toBe("excluded");
    expect(err.message).toContain("human view folder");
    expect(refusal(() => createNote(vault, { path: "Views/brain/history/2026-W01.md" })).code).toBe(
      "excluded",
    );
    expect(createNote(vault, { path: "Views/other.md", content: "x" }).created).toBe(true);
  });

  test("the folder lifecycle refuses the view folder and a folder that holds it", async () => {
    for (const path of ["Views/brain", "Views"]) {
      await expect(
        folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.renameFolder,
          path,
          to: "Moved",
          apply: true,
        }),
      ).rejects.toThrow(/human view folder/);
    }
    expect(existsSync(join(vault, "Views", "brain", "about-me.md"))).toBe(true);
    // Into the view folder: refused; beside it, into the folder that holds it: moved.
    mkdirSync(join(vault, "Projects", "A"), { recursive: true });
    writeFileSync(join(vault, "Projects", "A", "a.md"), "a\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/A",
        to: "Views/brain",
        apply: true,
      }),
    ).rejects.toThrow(/human view folder/);
    await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/A",
      to: "Views",
      apply: true,
    });
    expect(existsSync(join(vault, "Views", "A", "a.md"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "a vault reached through a link guards a view folder that does not exist yet",
    () => {
      const link = join(parent, "vault-link");
      symlinkSync(vault, link);
      // Configured through the link, and not rendered yet.
      process.env[VIEW_TARGET_ENV] = join(link, "Later", "view");
      const err = refusal(() =>
        createNote(vault, { path: "Later/view/about-me.md", content: "- forged rule\n" }),
      );
      expect(err.message).toContain("human view folder");
    },
  );

  test("with no view folder configured the same page is an ordinary note", () => {
    delete process.env[VIEW_TARGET_ENV];
    expect(createNote(vault, { path: "Views/brain/decisions.md", content: "x" }).created).toBe(
      true,
    );
  });
});

describe("isInViewFolder", () => {
  test("a view at the vault root owns only its own names", () => {
    expect(isInViewFolder("", "about-me.md")).toBe(true);
    expect(isInViewFolder("", "about-me (conflicted copy 2026-01-02).md")).toBe(true);
    expect(isInViewFolder("", "decisions.sync-conflict-20260102-101010-ABCDEFG.md")).toBe(true);
    expect(isInViewFolder("", "history/2026-W01.md")).toBe(true);
    expect(isInViewFolder("", ".o2b-view-x-new.md")).toBe(true);
    expect(isInViewFolder("", "Notes/about-me.md")).toBe(false);
    expect(isInViewFolder("", "about-me-notes.md")).toBe(false);
  });

  test("a view in a subfolder owns the folder; a container counts only when asked", () => {
    expect(isInViewFolder("Views/brain", "Views/brain")).toBe(true);
    expect(isInViewFolder("Views/brain", "Views/brain/x.md")).toBe(true);
    expect(isInViewFolder("Views/brain", "Views/brainy/x.md")).toBe(false);
    expect(isInViewFolder("Views/brain", "Views")).toBe(false);
    expect(isInViewFolder("Views/brain", "Views", { container: true })).toBe(true);
  });
});
