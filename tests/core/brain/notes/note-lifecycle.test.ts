/**
 * Note-file lifecycle: rename, move, delete, archive (B2).
 *
 * The defect. `brain_create_note`, `brain_update_note` and
 * `brain_append_note` are the whole of the note-file surface: a note can
 * be brought into existence and edited, and after that it is immovable
 * and undeletable through every surface this project ships. An agent that
 * mis-named a note had exactly one remedy - create the correct one and
 * leave the wrong one behind - which is how a vault accumulates the
 * duplicates the dedup pass then has to reason about.
 *
 * The second defect, and the harder one. A rename that reports success
 * without qualifying it is a lie: the Brain backlink index is a full scan
 * and Brain-scoped, the vault-wide `links` table is only as fresh as the
 * last `indexVault` pass, and no write hook updates either. So these
 * tests assert what the result SAYS as hard as they assert what it did -
 * that the bare-basename spelling is withheld when another note shares
 * the name, and that the search index's staleness travels back on the
 * result instead of being silently absorbed.
 *
 * Deliberately NOT covered here: the MCP argument coercion (its own file
 * under `tests/mcp/`), the CLI flag surface (`tests/cli/`), and whether a
 * snapshot archive can be extracted again - that is `snapshot.ts`'s own
 * suite, and duplicating it here would assert the tar pipeline twice.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  BASENAME_REWRITE,
  INDEX_EVIDENCE,
  isNoteLifecycleAction,
  NOTE_ARCHIVE_ROOT,
  NOTE_LIFECYCLE_ACTION,
  NOTE_LIFECYCLE_ACTIONS,
  noteLifecycle,
  NoteLifecycleError,
} from "../../../../src/core/brain/notes/lifecycle.ts";
import { RECOVERABILITY_STATE } from "../../../../src/core/brain/gates/recoverability.ts";
import { CountGuardError } from "../../../../src/core/brain/count-guard.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-note-lifecycle-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Write a note verbatim, creating its parents. */
function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function read(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

describe("the action vocabulary", () => {
  test("every declared action is a member and the guard refuses everything else", () => {
    expect([...NOTE_LIFECYCLE_ACTIONS].toSorted()).toEqual(
      Object.values(NOTE_LIFECYCLE_ACTION).toSorted(),
    );
    for (const action of NOTE_LIFECYCLE_ACTIONS) expect(isNoteLifecycleAction(action)).toBe(true);
    for (const outsider of [null, 42, {}, "", "Rename"]) {
      expect(isNoteLifecycleAction(outsider)).toBe(false);
    }
  });
});

describe("rename", () => {
  test("moves the bytes and rewrites path-spelled inbound wikilinks", async () => {
    note("Projects/Old.md", "---\ntitle: Old\n---\n\nbody\n");
    note(
      "Projects/Ref.md",
      "see [[Projects/Old]] and [[Projects/Old.md]] and [[Projects/Old|x]]\n",
    );

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.from).toBe("Projects/Old.md");
    expect(res.to).toBe("Projects/New.md");
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(false);
    expect(read("Projects/New.md")).toContain("body");

    const ref = read("Projects/Ref.md");
    expect(ref).toContain("[[Projects/New]]");
    expect(ref).toContain("[[Projects/New.md]]");
    expect(ref).toContain("[[Projects/New|x]]");
    expect(ref).not.toContain("Old");
    expect(res.references?.filesRewritten).toBe(1);
  });

  test("rewrites references that live inside Brain/, not only outside it", async () => {
    note("Projects/Old.md", "x\n");
    // A Brain artifact citing a note by path holds an ordinary
    // reference: it dangles exactly like a user note's would, so it is
    // in range. The append-only log is the one exception, and it has
    // its own test below.
    note("Brain/reports/weekly.md", "- ref [[Projects/Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(read("Brain/reports/weekly.md")).toContain("[[Projects/New]]");
    expect(res.references?.filesRewritten).toBe(1);
  });

  test("rewrites the bare-basename spelling when exactly one note carries it", async () => {
    note("Projects/Old.md", "x\n");
    note("Projects/Ref.md", "bare [[Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(res.references?.basename).toBe(BASENAME_REWRITE.applied);
    expect(read("Projects/Ref.md")).toContain("[[New]]");
  });

  test("withholds the bare-basename rewrite when another note shares the basename", async () => {
    note("Projects/Old.md", "x\n");
    note("Archive-elsewhere/Old.md", "a different note with the same basename\n");
    note("Projects/Ref.md", "bare [[Old]] and pathed [[Projects/Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });

    expect(res.references?.basename).toBe(BASENAME_REWRITE.ambiguous);
    const ref = read("Projects/Ref.md");
    // The unambiguous path spelling still moves; the bare one is left
    // exactly as it was, because it may name the other note.
    expect(ref).toContain("[[Projects/New]]");
    expect(ref).toContain("[[Old]]");
  });

  test("refuses a destination in another directory - that is a move", async () => {
    note("Projects/Old.md", "x\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Other/Old.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });

  test("refuses an occupied destination rather than clobbering it", async () => {
    note("Projects/Old.md", "old\n");
    note("Projects/New.md", "occupied\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/New.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(read("Projects/New.md")).toBe("occupied\n");
  });

  test("puts the DESTINATION through the same path envelope as the source", async () => {
    note("Projects/Old.md", "x\n");
    // The Brain machinery root is refused for a create; it must be
    // refused for a rename destination too, or the envelope has a hole.
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Brain/Sneaky.md",
        apply: true,
      }),
    ).rejects.toThrow();
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old.md",
        to: "Projects/../../escape.md",
        apply: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });

  test("a missing source is a typed refusal, never a silent no-op", async () => {
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Nope.md",
        to: "Projects/New.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
  });

  test("dry run is the default: it reports the blast radius and writes nothing", async () => {
    note("Projects/Old.md", "x\n");
    note("Projects/Ref.md", "[[Projects/Old]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
    });

    expect(res.applied).toBe(false);
    expect(res.references?.inboundFiles).toEqual(["Projects/Ref.md"]);
    expect(res.references?.filesRewritten).toBe(0);
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
    expect(read("Projects/Ref.md")).toContain("[[Projects/Old]]");
  });
});

describe("the freshness of the evidence a rename acted on", () => {
  test("names the search index as absent when the vault has never been indexed", async () => {
    note("Projects/Old.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });
    expect(res.references?.index.state).toBe(INDEX_EVIDENCE.absent);
    expect(res.references?.index.lastIndexedAt).toBeNull();
    // A next command, so the caller is never left with a bare verdict.
    expect(res.references?.index.nextCommand.length).toBeGreaterThan(0);
  });

  test("the live scan is reported as what it is: the files it actually read", async () => {
    note("Projects/Old.md", "x\n");
    note("Projects/Ref.md", "[[Projects/Old]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.rename,
      path: "Projects/Old.md",
      to: "Projects/New.md",
      apply: true,
    });
    expect(res.references?.filesScanned).toBeGreaterThanOrEqual(2);
  });
});

describe("move", () => {
  test("relocates across directories and rewrites the path spelling", async () => {
    note("Inbox/Note.md", "---\ntitle: Note\n---\n\nbody\n");
    note("Inbox/Ref.md", "[[Inbox/Note]]\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.move,
      path: "Inbox/Note.md",
      to: "Projects/Note.md",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(read("Projects/Note.md")).toContain("body");
    expect(existsSync(join(vault, "Inbox/Note.md"))).toBe(false);
    expect(read("Inbox/Ref.md")).toContain("[[Projects/Note]]");
    // The basename did not change, so there was no bare spelling to fix.
    expect(res.references?.basename).toBe(BASENAME_REWRITE.notNeeded);
  });

  test("refuses a destination in the same directory - that is a rename", async () => {
    note("Inbox/Note.md", "x\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.move,
        path: "Inbox/Note.md",
        to: "Inbox/Other.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
  });
});

describe("archive", () => {
  test("displaces the note under the archive root, mirroring its path", async () => {
    note("Projects/Done.md", "---\ntitle: Done\n---\n\nbody\n");

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.archive,
      path: "Projects/Done.md",
      apply: true,
    });

    expect(res.to).toBe(`${NOTE_ARCHIVE_ROOT}/Projects/Done.md`);
    expect(read(`${NOTE_ARCHIVE_ROOT}/Projects/Done.md`)).toContain("body");
    expect(existsSync(join(vault, "Projects/Done.md"))).toBe(false);
  });

  test("destroys nothing, and the verdict says exactly that", async () => {
    note("Projects/Done.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.archive,
      path: "Projects/Done.md",
      apply: true,
    });
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
    expect(res.recoverability.blockers).toEqual([]);
  });

  test("refuses an occupied archive destination instead of overwriting it", async () => {
    note("Projects/Done.md", "second\n");
    note(`${NOTE_ARCHIVE_ROOT}/Projects/Done.md`, "first\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.archive,
        path: "Projects/Done.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(read(`${NOTE_ARCHIVE_ROOT}/Projects/Done.md`)).toBe("first\n");
  });

  test("refuses to archive something already under the archive root", async () => {
    note(`${NOTE_ARCHIVE_ROOT}/Projects/Done.md`, "x\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.archive,
        path: `${NOTE_ARCHIVE_ROOT}/Projects/Done.md`,
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
  });
});

describe("delete", () => {
  test("refuses without an explicit confirm, and writes nothing", async () => {
    note("Projects/Gone.md", "x\n");
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: "Projects/Gone.md",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(true);
  });

  test("removes the file under an explicit confirm", async () => {
    note("Projects/Gone.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
    });
    expect(res.applied).toBe(true);
    expect(res.to).toBeNull();
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(false);
  });

  test("takes a recovery point AND says it does not cover the note", async () => {
    note("Projects/Gone.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
    });
    // The archive exists...
    expect(res.snapshot).not.toBeNull();
    expect(existsSync(res.snapshot!.path)).toBe(true);
    // ...and it holds Brain/, which a note never lives in. Reporting the
    // archive path with no verdict beside it is the misleading success
    // this release exists to remove.
    expect(res.recoverability.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(res.recoverability.blockers).toContain("outside_brain_root");
    expect(res.recoverability.coverage).toEqual([]);
  });

  test("honours --expect over the inbound references it will leave dangling", async () => {
    note("Projects/Gone.md", "x\n");
    note("Projects/A.md", "[[Projects/Gone]]\n");
    note("Projects/B.md", "[[Projects/Gone]]\n");

    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: "Projects/Gone.md",
        apply: true,
        confirm: true,
        expect: 1,
      }),
    ).rejects.toThrow(CountGuardError);
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(true);

    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
      expect: 2,
    });
    expect(res.applied).toBe(true);
  });

  test("counts the inbound references it will strand, and rewrites none of them", async () => {
    note("Projects/Gone.md", "x\n");
    note("Projects/A.md", "[[Projects/Gone]]\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      apply: true,
      confirm: true,
    });
    expect(res.references?.inboundFiles).toEqual(["Projects/A.md"]);
    expect(res.references?.filesRewritten).toBe(0);
    expect(read("Projects/A.md")).toContain("[[Projects/Gone]]");
  });

  test("a dry run reports the blast radius and leaves the file alone", async () => {
    note("Projects/Gone.md", "x\n");
    const res = await noteLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.delete,
      path: "Projects/Gone.md",
      confirm: true,
    });
    expect(res.applied).toBe(false);
    expect(res.snapshot).toBeNull();
    expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(true);
  });
});
