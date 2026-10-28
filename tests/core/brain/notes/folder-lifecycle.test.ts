/**
 * Folder-level note lifecycle: `move-folder` and `rename-folder`
 * (t_9571a47f).
 *
 * The note-file surface is defined per FILE; reorganizing a vault by
 * folder means moving notes one at a time by hand, which breaks inbound
 * path-spelled wikilinks. A folder move never changes a basename, so the
 * bare `[[Name]]` spellings keep resolving and only PATH-spelled links
 * break - which one `retargetWikilinks` pass over the successfully moved
 * set fixes completely. There is no second (bare-name repair) pass here,
 * and the tests pin that the single pass is genuinely complete.
 *
 * The operation is explicitly NOT atomic and the tests hold it to that
 * honesty: occupancy is eliminated by a pre-flight that refuses before
 * the first byte moves, and a mid-set I/O failure is NAMED in
 * `moveFailures` with the rewrite pairs computed from the successfully
 * moved set only - never rolled back, matching the settled partial-
 * failure doctrine of the file surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  BASENAME_REWRITE,
  isNoteLifecycleAction,
  NOTE_ARCHIVE_ROOT,
  NOTE_LIFECYCLE_ACTION,
  NOTE_LIFECYCLE_ACTIONS,
  noteLifecycle,
  NoteLifecycleError,
} from "../../../../src/core/brain/notes/lifecycle.ts";
import {
  folderLifecycle,
  isFolderLifecycleAction,
} from "../../../../src/core/brain/notes/folder-lifecycle.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

/**
 * Whether the filesystem hosting the test tmpdir folds case in names:
 * probed once, at load, because `test.skipIf` decides at declaration -
 * before any per-test vault exists - and the folding behavior belongs to
 * the volume, not to the process.
 */
const FOLDS_CASE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "o2b-case-probe-"));
  try {
    mkdirSync(join(probe, "Fold"));
    const plain = statSync(join(probe, "Fold"));
    const folded = statSync(join(probe, "fold"));
    return plain.dev === folded.dev && plain.ino === folded.ino;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-folder-lifecycle-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-folder-lifecycle-cfg-"));
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

function isDir(rel: string): boolean {
  try {
    return statSync(join(vault, rel)).isDirectory();
  } catch {
    return false;
  }
}

describe("the folder action vocabulary", () => {
  test("move-folder and rename-folder are members of the one lifecycle vocabulary", () => {
    expect(NOTE_LIFECYCLE_ACTION.moveFolder).toBe("move-folder");
    expect(NOTE_LIFECYCLE_ACTION.renameFolder).toBe("rename-folder");
    expect(NOTE_LIFECYCLE_ACTIONS).toContain("move-folder");
    expect(NOTE_LIFECYCLE_ACTIONS).toContain("rename-folder");
    // The guard reads the same constant, so the CLI check, MCP enum and
    // manifest stay in sync from one place.
    expect(isNoteLifecycleAction("move-folder")).toBe(true);
    expect(isNoteLifecycleAction("rename-folder")).toBe(true);
    expect(isNoteLifecycleAction("Move-Folder")).toBe(false);
  });

  test("the folder guard accepts exactly the two folder actions", () => {
    expect(isFolderLifecycleAction("move-folder")).toBe(true);
    expect(isFolderLifecycleAction("rename-folder")).toBe(true);
    for (const outsider of ["delete", "archive", "rename", "move", null, 42, {}, ""]) {
      expect(isFolderLifecycleAction(outsider)).toBe(false);
    }
  });
});

describe("the folder envelope", () => {
  test("a missing source is a typed source_missing refusal", async () => {
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Nope",
        to: "Archive-elsewhere",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/NotAFolder",
        to: "Elsewhere",
        apply: true,
      }),
    ).rejects.toThrow(/source_missing|no note folder/);
  });

  test("the vault root is refused as a source", async () => {
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.renameFolder,
        path: "",
        to: "Everything",
        apply: true,
      }),
    ).rejects.toThrow();
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.renameFolder,
        path: ".",
        to: "Everything",
        apply: true,
      }),
    ).rejects.toThrow();
  });

  test("the Brain machinery root is refused for source and destination alike", async () => {
    note("Projects/Old/a.md", "x\n");
    // Source under Brain/.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Brain/reports",
        to: "Projects",
        apply: true,
      }),
    ).rejects.toThrow(/Brain/);
    // Destination under Brain/.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Brain",
        apply: true,
      }),
    ).rejects.toThrow(/Brain/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("a vault-scope excluded path is refused, naming the entry", async () => {
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: ".obsidian/plugins",
        to: "Projects",
        apply: true,
      }),
    ).rejects.toThrow(/excluded by vault\.ignore_paths \(\.obsidian\)/);
  });

  test("traversal is refused for source and destination", async () => {
    note("Projects/Old.md", "x\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/../..",
        to: "Elsewhere",
        apply: true,
      }),
    ).rejects.toThrow();
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "../outside",
        apply: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
  });
});

describe("the caller's reach over the folder", () => {
  test("a move set the caller may not read refuses exactly as a missing folder", async () => {
    note("Projects/Old/a.md", "alpha\n");
    for (const apply of [false, true]) {
      let caught: unknown;
      try {
        await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply,
          readable: () => false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NoteLifecycleError);
      expect((caught as NoteLifecycleError).code).toBe("source_missing");
    }
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive"))).toBe(false);
  });

  test("a folder holding one note the caller may not read refuses without naming it", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/quiet.md", "reserved\n");
    for (const apply of [false, true]) {
      let caught: unknown;
      try {
        await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply,
          readable: (rel) => !rel.endsWith("quiet.md"),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NoteLifecycleError);
      const refusal = caught as NoteLifecycleError;
      expect(refusal.code).toBe("source_missing");
      // The refusal reads exactly as a missing folder's: the denied
      // note's path names nothing the caller could otherwise learn.
      expect(refusal.message).not.toContain("quiet");
    }
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/quiet.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive"))).toBe(false);
  });

  test("a denied folder answers a destination mistake as a missing folder, never the destination's error", async () => {
    // The reach check runs BEFORE the destination is resolved: a folder
    // holding a note the caller may not read answers every later error
    // path as a missing folder too. A destination refusal would let a
    // deliberately bad `to` tell an existing-but-denied folder apart
    // from a missing one - an existence oracle.
    note("Projects/Old/quiet.md", "reserved\n");
    for (const apply of [false, true]) {
      let caught: unknown;
      try {
        await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Projects/Old/nested",
          apply,
          readable: () => false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NoteLifecycleError);
      expect((caught as NoteLifecycleError).code).toBe("source_missing");
    }
    expect(existsSync(join(vault, "Projects/Old/quiet.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/nested"))).toBe(false);
  });
});

describe("move-folder", () => {
  test("moves every file and rewrites path-spelled inbound links to the minimal spelling", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/b.md", "beta\n");
    note("Notes/Ref.md", "pathed [[Projects/Old/a]] and suffixed [[Projects/Old/a.md]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.from).toBe("Projects/Old");
    expect(res.to).toBe("Archive/Old");
    expect(res.moved.map((m) => m.to).toSorted()).toEqual(["Archive/Old/a.md", "Archive/Old/b.md"]);
    expect(res.moveFailures).toEqual([]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive/Old/b.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(false);
    // The minimal spelling of the moved note: the basename is unique, so
    // both path-spelled forms collapse onto it.
    expect(read("Notes/Ref.md")).toBe("pathed [[a]] and suffixed [[a]]\n");
    expect(res.references.filesRewritten).toBe(1);
    expect(res.references.basename).toBe(BASENAME_REWRITE.notNeeded);
  });

  test("leaves bare-basename links untouched and resolving", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Notes/Ref.md", "bare [[a]] and pathed [[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    // A folder move never changes a basename, so the bare spelling never
    // breaks; rewriting it is not this operation's business.
    expect(read("Notes/Ref.md")).toBe("bare [[a]] and pathed [[a]]\n");
    expect(res.references.rewrittenSpellings).toEqual([
      { from: "Projects/Old/a.md", to: "a" },
      { from: "Projects/Old/a", to: "a" },
    ]);
  });

  test("rewrites to the suffix-less path when the destination basename is contested", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Archive/Other/a.md", "another note that already owns the basename\n");
    note("Notes/Ref.md", "pathed [[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    // Bare `a` has two carriers after the move, so the minimal honest
    // spelling is the suffix-less path.
    expect(read("Notes/Ref.md")).toBe("pathed [[Archive/Old/a]]\n");
    expect(res.references.rewrittenSpellings).toEqual([
      { from: "Projects/Old/a.md", to: "Archive/Old/a" },
      { from: "Projects/Old/a", to: "Archive/Old/a" },
    ]);
  });

  test("rewrites sibling path-spelled links inside the moved folder itself", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/b.md", "see [[Projects/Old/a]]\n");

    await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(read("Archive/Old/b.md")).toBe("see [[a]]\n");
  });

  test("rewrites Brain artifact references and never rewrites the append-only log", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Brain/reports/weekly.md", "- ref [[Projects/Old/a]]\n");
    note("Brain/log/2026-10-26.md", "- saw [[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(read("Brain/reports/weekly.md")).toBe("- ref [[a]]\n");
    // Testimony is read and reported, never rewritten.
    expect(read("Brain/log/2026-10-26.md")).toBe("- saw [[Projects/Old/a]]\n");
    expect(res.references.inboundFiles).toContain("Brain/log/2026-10-26.md");
  });

  test("refuses a destination sharing the source's parent - that is rename-folder", async () => {
    note("Projects/Old/a.md", "x\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Projects/Elsewhere",
        apply: true,
      }),
    ).rejects.toThrow(/wrong_action|use rename-folder/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("a destination directory in another parent's subtree moves without complaint", async () => {
    note("Projects/Old/a.md", "alpha\n");
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive/2026",
      apply: true,
    });
    // `Archive/2026` sits in `Archive`, not in `Projects`, so the folder's
    // parent genuinely changes and the move is exactly what was asked for.
    expect(res.to).toBe("Archive/2026/Old");
    expect(existsSync(join(vault, "Archive/2026/Old/a.md"))).toBe(true);
  });

  test("moving to the vault root lands the folder at the top level", async () => {
    note("Projects/Old/a.md", "alpha\n");
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "",
      apply: true,
    });
    // The root is a legitimate DESTINATION directory (a folder may land
    // at the top level) while staying refused as a SUBJECT.
    expect(res.to).toBe("Old");
    expect(existsSync(join(vault, "Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
  });

  test("a destination inside the source subtree is refused - the folder would nest inside itself", async () => {
    note("Projects/Old/a.md", "alpha\n");
    mkdirSync(join(vault, "Projects/Sub"), { recursive: true });

    let caught: unknown;
    try {
      await folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects",
        to: "Projects/Sub",
        apply: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NoteLifecycleError);
    const refusal = caught as NoteLifecycleError;
    expect(refusal.code).toBe("destination_inside_source");
    // The refusal names both paths, so the caller can see the collision.
    expect(refusal.message).toContain("Projects/Sub");
    expect(refusal.message).toContain("Projects");
    // Deeper nesting is the same refusal.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects",
        to: "Projects/Sub/Deeper",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    // Nothing moved: the tree is exactly where it was.
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Sub/Projects"))).toBe(false);
  });

  test("a destination that collapses onto the source folder is refused as unchanged", async () => {
    note("Projects/Old/a.md", "x\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Projects",
        apply: true,
      }),
    ).rejects.toThrow(/destination is the source folder/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("a FILE occupying the destination folder path refuses with nothing moved", async () => {
    note("Projects/Old/a.md", "source\n");
    note("Archive/Old", "occupied by a stranger\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Archive",
        apply: true,
      }),
    ).rejects.toThrow(/nothing was moved/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(read("Archive/Old")).toBe("occupied by a stranger\n");
  });

  test("an occupied destination DIRECTORY refuses with nothing moved", async () => {
    note("Projects/Old/a.md", "source\n");
    note("Archive/Old/stranger.md", "occupied\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Archive",
        apply: true,
      }),
    ).rejects.toThrow(/nothing was moved/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(read("Archive/Old/stranger.md")).toBe("occupied\n");
  });

  test("an empty destination directory is not an occupancy: the files land in it", async () => {
    note("Projects/Old/a.md", "source\n");
    mkdirSync(join(vault, "Archive/Old"), { recursive: true });

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
  });

  test("an empty folder moves with an empty moved set and no residue", async () => {
    mkdirSync(join(vault, "Projects/Empty"), { recursive: true });

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Empty",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toEqual([]);
    expect(res.moveFailures).toEqual([]);
    expect(existsSync(join(vault, "Projects/Empty"))).toBe(false);
    expect(isDir("Archive/Empty")).toBe(true);
  });

  test("a spelling that matches nothing in the walk refuses instead of succeeding as a no-op", async () => {
    // The vault's real folder, as the walk spells it.
    note("Projects/Old/a.md", "alpha\n");
    // A second, differently-cased directory this host tells apart: the
    // caller's spelling stats as a real, non-empty folder while matching
    // none of the walked paths - the shape a case or normalization
    // mismatch takes on a case-insensitive host.
    mkdirSync(join(vault, "projects/old"), { recursive: true });
    writeFileSync(join(vault, "projects/old/img.png"), "png\n");

    let caught: unknown;
    try {
      await folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "projects/old",
        to: "Archive",
        apply: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NoteLifecycleError);
    const refusal = caught as NoteLifecycleError;
    expect(refusal.code).toBe("move_set_empty");
    expect(refusal.message).toContain("projects/old");
    expect(refusal.message).toMatch(/case|normaliz/i);
    // Nothing was touched: the real folder stands and no destination
    // skeleton appeared.
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive/old"))).toBe(false);

    // A plan-only run of the same spelling is the same refusal: a plan
    // of nothing over a non-empty folder is a preview of a lie.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "projects/old",
        to: "Archive",
      }),
    ).rejects.toThrow(/move_set_empty|not empty on disk/);
  });

  test("non-Markdown residue in the source folder is named, not silently clean", async () => {
    note("Projects/Old/a.md", "alpha\n");
    writeFileSync(join(vault, "Projects/Old/img.png"), "png\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    // The note relocated; the image is not a note and did not move - and
    // the result names what stayed in the source folder after the prune.
    expect(res.leftBehind).toEqual(["img.png"]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/img.png"))).toBe(true);

    // A move that genuinely empties its source folder names nothing.
    note("Other/Sub/b.md", "beta\n");
    const clean = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Other/Sub",
      to: "Archive",
      apply: true,
    });
    expect(clean.leftBehind).toEqual([]);
    expect(existsSync(join(vault, "Other/Sub"))).toBe(false);
  });

  test("dry run is the default: it reports the full plan and writes nothing", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Notes/Ref.md", "[[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
    });

    expect(res.applied).toBe(false);
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(res.references.inboundFiles).toEqual(["Notes/Ref.md"]);
    expect(res.references.filesRewritten).toBe(0);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive/Old"))).toBe(false);
    expect(read("Notes/Ref.md")).toBe("[[Projects/Old/a]]\n");
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a mid-set move failure is named, not rolled back, and the rewrite uses the moved set only",
    async () => {
      note("Projects/Old/a.md", "alpha\n");
      note("Projects/Old/sub/b.md", "beta\n");
      note("Notes/A.md", "moves [[Projects/Old/a]]\n");
      note("Notes/B.md", "moves [[Projects/Old/sub/b]]\n");
      // The nested directory becomes unmovable AFTER the plan and after
      // `a.md` has already relocated: the EACCES lands mid-set.
      chmodSync(join(vault, "Projects/Old/sub"), 0o500);

      let res;
      try {
        res = await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply: true,
        });
      } finally {
        chmodSync(join(vault, "Projects/Old/sub"), 0o700);
      }

      expect(res.applied).toBe(true);
      expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
      expect(res.moveFailures).toHaveLength(1);
      expect(res.moveFailures[0]!.path).toBe("Projects/Old/sub/b.md");
      // The prune could not empty the source, and the residue names what
      // is still sitting in it.
      expect(res.leftBehind).toEqual(["sub"]);
      // The residue is exactly where the report says: `a.md` is at its
      // new path, `b.md` stays at its old one.
      expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
      expect(existsSync(join(vault, "Projects/Old/sub/b.md"))).toBe(true);
      // Pairs were computed from the moved set ONLY: the link to the
      // moved note is rewritten, the link to the failed note still
      // resolves to where the bytes actually are.
      expect(read("Notes/A.md")).toBe("moves [[a]]\n");
      expect(read("Notes/B.md")).toBe("moves [[Projects/Old/sub/b]]\n");
      // The failed move leaves exactly one name for the file: the fault
      // struck after the destination name was linked, and that second
      // name was dropped - the report's "never moved" stays true.
      expect(existsSync(join(vault, "Archive/Old/sub/b.md"))).toBe(false);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a set where nothing moves leaves no invented destination folder behind",
    async () => {
      note("Projects/Old/a.md", "alpha\n");
      // Every relocation fails the same way: the destination name lands,
      // then dropping the source name is refused, so the set finishes
      // with nothing moved - and the destination folder the apply
      // created for the set must not stay behind as residue the report
      // contradicts.
      chmodSync(join(vault, "Projects/Old"), 0o500);
      let res;
      try {
        res = await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply: true,
        });
      } finally {
        chmodSync(join(vault, "Projects/Old"), 0o700);
      }

      expect(res.applied).toBe(true);
      expect(res.moved).toEqual([]);
      expect(res.moveFailures).toHaveLength(1);
      // Nothing was invented at the destination, and the source stands
      // exactly where the report says its bytes are.
      expect(existsSync(join(vault, "Archive"))).toBe(false);
      expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a fully-failed set cleans its invented subtree and spares a pre-existing destination parent",
    async () => {
      // Nested source: the per-file machinery creates Archive/Old/sub for
      // the failed move, and the cleanup takes the whole invented branch,
      // not just the destination folder itself. An EMPTY Archive that was
      // already here stays - a directory that existed before is not this
      // operation's to remove, and the move lands under it.
      note("Projects/Old/sub/a.md", "alpha\n");
      mkdirSync(join(vault, "Archive"), { recursive: true });
      chmodSync(join(vault, "Projects/Old/sub"), 0o500);
      let res;
      try {
        res = await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply: true,
        });
      } finally {
        chmodSync(join(vault, "Projects/Old/sub"), 0o700);
      }

      expect(res.applied).toBe(true);
      expect(res.moved).toEqual([]);
      expect(res.moveFailures).toHaveLength(1);
      // The invented branch is gone down to the destination folder; the
      // pre-existing parent stands, and the source is exactly where the
      // report says its bytes are.
      expect(existsSync(join(vault, "Archive/Old"))).toBe(false);
      expect(isDir("Archive")).toBe(true);
      expect(existsSync(join(vault, "Projects/Old/sub/a.md"))).toBe(true);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a partially-failed set still cleans the empty branch a failed move invented",
    async () => {
      // One note relocates; the nested one fails the source-name drop
      // after its branch was created for it. The set ends half-moved, and
      // the empty branch the failed move invented must not stand beside a
      // report that says it never moved - while the moved note's own
      // branch, holding real bytes, does.
      note("Projects/Old/a.md", "alpha\n");
      note("Projects/Old/sub/b.md", "beta\n");
      chmodSync(join(vault, "Projects/Old/sub"), 0o500);
      let res;
      try {
        res = await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Archive",
          apply: true,
        });
      } finally {
        chmodSync(join(vault, "Projects/Old/sub"), 0o700);
      }

      expect(res.applied).toBe(true);
      expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
      expect(res.moveFailures).toHaveLength(1);
      expect(res.moveFailures[0]!.path).toBe("Projects/Old/sub/b.md");
      // The moved note stands; the failed move's invented branch is gone.
      expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
      expect(existsSync(join(vault, "Archive/Old/sub"))).toBe(false);
      // The source keeps the failed file exactly where the report says.
      expect(existsSync(join(vault, "Projects/Old/sub/b.md"))).toBe(true);
      expect(existsSync(join(vault, "Projects/Old"))).toBe(true);
    },
  );

  test("a foreign file at a cleared destination name survives the move's fault", async () => {
    note("Projects/Old/a.md", "alpha\n");
    // The pre-flight cleared the destination name; a foreign file appears
    // there before the link - the race the occupied-name guard exists
    // for, produced through the relocation seam. The refusal is the move's
    // own, and the cleanup must not unlink bytes it did not write.
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
      relocate: (_fromAbs, toAbs, label) => {
        writeFileSync(toAbs, "foreign bytes\n");
        throw new NoteLifecycleError(
          "destination_occupied",
          `destination already exists: ${label}`,
        );
      },
    });

    expect(res.applied).toBe(true);
    expect(res.moved).toEqual([]);
    expect(res.moveFailures).toHaveLength(1);
    expect(res.moveFailures[0]!.path).toBe("Projects/Old/a.md");
    expect(res.moveFailures[0]!.reason).toContain("destination already exists");
    // The foreign file stands, and the invented branch around it stands
    // with it; the source still holds the note.
    expect(readFileSync(join(vault, "Archive/Old/a.md"), "utf8")).toBe("foreign bytes\n");
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("a top-level folder moves under a sibling top-level directory", async () => {
    note("Old/a.md", "alpha\n");
    mkdirSync(join(vault, "Archive"), { recursive: true });

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Old",
      to: "Archive",
      apply: true,
    });

    expect(res.from).toBe("Old");
    expect(res.to).toBe("Archive/Old");
    expect(res.moved).toEqual([{ from: "Old/a.md", to: "Archive/Old/a.md" }]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Old"))).toBe(false);
  });

  test("a clean nested move leaves no empty skeleton and names no residue", async () => {
    note("Projects/Old/sub/deep/b.md", "beta\n");
    note("Projects/Old/a.md", "alpha\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.moveFailures).toEqual([]);
    expect(res.leftBehind).toEqual([]);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
    expect(existsSync(join(vault, "Projects/Old/sub"))).toBe(false);
    expect(existsSync(join(vault, "Archive/Old/sub/deep/b.md"))).toBe(true);
  });

  test("directories the move never touched keep standing after a partial prune", async () => {
    // One note moves; a no-Markdown subtree and a pre-existing empty
    // sibling stay. The prune's candidates are the MOVED files' ancestor
    // chains, so the removal cannot walk the source's subtree and delete
    // directories this operation never touched - and the source folder
    // itself stands because the untouched residue still fills it.
    note("Projects/Old/a.md", "alpha\n");
    mkdirSync(join(vault, "Projects/Old/sub"), { recursive: true });
    writeFileSync(join(vault, "Projects/Old/sub/img.png"), "png\n");
    mkdirSync(join(vault, "Projects/Old/empty"), { recursive: true });

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(res.leftBehind).toEqual(["empty", "sub"]);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/sub/img.png"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/empty"))).toBe(true);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
  });

  test("the prune never follows a symlinked directory out of the source", async () => {
    // The candidates are derived from moved files' vault-relative
    // spellings, never from a filesystem walk of the source: a linked
    // directory under the source is neither descended into nor offered
    // to the removal, so nothing outside the source - here a real empty
    // directory the link resolves to - is this operation's to delete.
    note("Projects/Old/a.md", "alpha\n");
    mkdirSync(join(vault, "Outside/inner"), { recursive: true });
    symlinkSync(join(vault, "Outside"), join(vault, "Projects/Old/link"), "dir");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(existsSync(join(vault, "Outside/inner"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/link"))).toBe(true);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
  });

  test.skipIf(!FOLDS_CASE)(
    "a case-only folder rename is refused rather than half-reported",
    async () => {
      note("Projects/Old/a.md", "alpha\n");
      // The refusal exists for the host that folds case: there the two
      // spellings name one directory entry, which moving files cannot
      // re-case. A host that tells them apart reaches an ordinary rename
      // instead, so the test is SKIPPED there - reported as a skip, never
      // a silent early pass.
      await expect(
        folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.renameFolder,
          path: "Projects/Old",
          to: "old",
          apply: true,
        }),
      ).rejects.toThrow(/destination_unchanged|case-only/);
      expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    },
  );

  test("a folder holding only attachments moves an empty set and keeps its contents", async () => {
    mkdirSync(join(vault, "Assets/img"), { recursive: true });
    writeFileSync(join(vault, "Assets/img/logo.png"), "png\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Assets/img",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toEqual([]);
    expect(res.moveFailures).toEqual([]);
    expect(res.leftBehind).toEqual(["logo.png"]);
    expect(existsSync(join(vault, "Assets/img/logo.png"))).toBe(true);
    expect(existsSync(join(vault, "Archive/img/logo.png"))).toBe(false);
    // A folder that keeps its entries creates nothing at the destination:
    // an empty directory the move invented is residue in the vault.
    expect(existsSync(join(vault, "Archive/img"))).toBe(false);
  });

  test("a dry run reports the spellings the apply would write", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Notes/Ref.md", "pathed [[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Elsewhere",
    });

    expect(res.applied).toBe(false);
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Elsewhere/Old/a.md" }]);
    expect(res.references.rewrittenSpellings).toEqual([
      { from: "Projects/Old/a.md", to: "a" },
      { from: "Projects/Old/a", to: "a" },
    ]);
  });
});

describe("rename-folder", () => {
  test("renames in place and rewrites path-spelled links", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Notes/Ref.md", "pathed [[Projects/Old/a]]\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.renameFolder,
      path: "Projects/Old",
      to: "New",
      apply: true,
    });

    expect(res.from).toBe("Projects/Old");
    expect(res.to).toBe("Projects/New");
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Projects/New/a.md" }]);
    expect(existsSync(join(vault, "Projects/New/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
    expect(read("Notes/Ref.md")).toBe("pathed [[a]]\n");
  });

  test("a cross-parent destination is refused - that is move-folder", async () => {
    note("Projects/Old/a.md", "x\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.renameFolder,
        path: "Projects/Old",
        to: "Elsewhere/Old",
        apply: true,
      }),
    ).rejects.toThrow(/wrong_action|use move-folder/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("a multi-segment name is a cross-parent move and is refused by name", async () => {
    note("Projects/Old/a.md", "x\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.renameFolder,
        path: "Projects/Old",
        to: "Sub/New",
        apply: true,
      }),
    ).rejects.toThrow(/wrong_action|use move-folder/);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });

  test("delete and archive are note-file actions and refuse a folder subject", async () => {
    mkdirSync(join(vault, "Projects/Old"), { recursive: true });
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: "Projects/Old",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.archive,
        path: "Projects/Old",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(isDir("Projects/Old")).toBe(true);
  });

  test("the archive root is an ordinary destination for move-folder - no archive semantics here", async () => {
    note("Projects/Old/a.md", "x\n");
    // The folder surface has no archive action; a caller-chosen
    // destination that happens to be named like one is just a move, with
    // no confirm ladder beyond the surface's own.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: NOTE_ARCHIVE_ROOT,
        apply: true,
      }),
    ).resolves.toBeDefined();
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
  });
});

describe("the count guard over the folder move set", () => {
  test("--expect counts the files the apply will write, not the files moved", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/b.md", "beta\n");
    note("Notes/Ref.md", "[[Projects/Old/a]] and [[Projects/Old/b]]\n");

    // Two notes move; ONE file holds the inbound references the apply
    // will write. The plan names that file and `--expect` counts it.
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Archive",
        apply: true,
        expect: 7,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
      expect: 1,
    });
    expect(res.applied).toBe(true);
    expect(res.moved).toHaveLength(2);
    expect(res.references.inboundFiles).toEqual(["Notes/Ref.md"]);
  });

  test("a strict mutation without --expect is refused before anything moves", async () => {
    note("Projects/Old/a.md", "x\n");
    note("Notes/Ref.md", "[[Projects/Old/a]]\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Old",
        to: "Archive",
        apply: true,
        strict: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });
});

describe("the folder result's evidence tail", () => {
  test("an applied move claims the detached index refresh and reports the index evidence", async () => {
    note("Projects/Old/a.md", "alpha\n");
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });
    expect(res.references.index.state.length).toBeGreaterThan(0);
    expect(res.references.index.nextCommand.length).toBeGreaterThan(0);
    expect(res.references.refresh).toBeDefined();
    // A relocation destroys nothing, so no snapshot is taken - the field
    // is null for shape parity with the file surface, and the verdict
    // covers the REWRITE.
    expect(res.snapshot).toBeNull();
    expect(res.recoverability.state.length).toBeGreaterThan(0);
  });

  test("a plan-only run claims nothing and refused nothing", async () => {
    note("Projects/Old/a.md", "alpha\n");
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
    });
    expect(res.references.refresh).toBeDefined();
    expect(res.references.refreshReason).toBeNull();
  });
});

describe("the file surface keeps refusing folder subjects", () => {
  test("noteLifecycle refuses a folder path - it has no .md rung to pass", async () => {
    mkdirSync(join(vault, "Projects/Old"), { recursive: true });
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.rename,
        path: "Projects/Old",
        to: "Projects/New",
        apply: true,
      }),
    ).rejects.toThrow(/\.md/);
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.delete,
        path: "Projects/Old",
        apply: true,
        confirm: true,
      }),
    ).rejects.toThrow(/\.md/);
    expect(readdirSync(join(vault, "Projects"))).toContain("Old");
  });

  test("noteLifecycle refuses the folder actions by name - the machinery is two modules", async () => {
    note("Projects/a.md", "x\n");
    // One vocabulary, two machines: `move-folder` sent to the FILE surface
    // must not fall through to the file envelope and report a one-file
    // result for a many-file operation.
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/a.md",
        to: "Elsewhere",
        apply: true,
      }),
    ).rejects.toThrow(/wrong_action|folder action/);
    await expect(
      noteLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.renameFolder,
        path: "Projects/a.md",
        to: "Renamed",
        apply: true,
      }),
    ).rejects.toThrow(NoteLifecycleError);
    expect(existsSync(join(vault, "Projects/a.md"))).toBe(true);
  });
});

/**
 * The move set is judged by REAL LOCATION (H2, M18): the vault walk lists
 * a file under whichever alias of its directory won the walk, so both the
 * membership decision and the spelling every report and rewrite pair
 * carries are decided by where a file really lives - inside the source's
 * real path - never by the spelling the walk happened to reach it
 * through. The two alias orders below are written to hold regardless of
 * which spelling wins the walk on any host.
 */
describe("symlinked entries in the move set (judged by real location)", () => {
  test("a symlinked directory inside the source excludes the foreign notes it reaches (H2, order one)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Alpha/Deep/real.md", "real body\n");
    note("Index.md", "[[Projects/Old/a]] and [[Alpha/Deep/real]]\n");
    symlinkSync(join(vault, "Alpha/Deep"), join(vault, "Projects/Old/link"), "dir");

    // The plan already shows the truth: only the folder's OWN note moves.
    const plan = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
    });
    expect(plan.applied).toBe(false);
    expect(plan.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    // The foreign note keeps its real location under either walked
    // spelling, and no name for it appears at the destination.
    expect(existsSync(join(vault, "Alpha/Deep/real.md"))).toBe(true);
    expect(existsSync(join(vault, "Archive/Old/link/real.md"))).toBe(false);
    // The link itself is neither followed nor removed: it is the residue,
    // named like any other entry the move could not carry.
    expect(res.leftBehind).toEqual(["link"]);
    expect(existsSync(join(vault, "Projects/Old/link"))).toBe(true);
    // The foreign note's inbound link is untouched; the moved note's is
    // rewritten. Before the real-location judgment the foreign note was
    // relocated under the link spelling with NO rewrite pair, and
    // `[[Alpha/Deep/real]]` dangled.
    expect(read("Index.md")).toBe("[[a]] and [[Alpha/Deep/real]]\n");
  });

  test("an alias walked before the source is normalized to the real spelling, not a silent no-op (H2, order two)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Index.md", "[[Projects/Old/a]]\n");
    // `Zed` sorts after `Projects`, so the walk reaches the source THROUGH
    // the alias first and lists the note under the alias spelling only -
    // the order that used to leave `movingSet` empty and report
    // applied:true with nothing moved.
    mkdirSync(join(vault, "Zed"), { recursive: true });
    symlinkSync(join(vault, "Projects/Old"), join(vault, "Zed/alias"), "dir");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    // The move set carries the REAL spelling - the name the disk answers
    // to and the name inbound links are spelled with - so the rewrite
    // pair exists and `[[Projects/Old/a]]` does not dangle.
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(false);
    expect(read("Index.md")).toBe("[[a]]\n");
    // The source folder genuinely emptied and went; the operator's own
    // alias is the only thing left pointing at a former address.
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
    expect(res.leftBehind).toEqual([]);
  });

  test("a symlinked note is excluded and named, never hard-linked (M18)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Other/x.md", "elsewhere\n");
    // A RELATIVE target, the shape that dangles when the symlink itself is
    // hard-linked at a new depth.
    symlinkSync("../../Other/x.md", join(vault, "Projects/Old/l.md"));

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    expect(res.moved).toEqual([{ from: "Projects/Old/a.md", to: "Archive/Old/a.md" }]);
    // The symlinked note is named as what stayed...
    expect(res.leftBehind).toEqual(["l.md"]);
    expect(lstatSync(join(vault, "Projects/Old/l.md")).isSymbolicLink()).toBe(true);
    // ...and no name for it was created at the destination: linking the
    // symlink used to leave a dangling `Archive/Old/l.md` behind.
    expect(lstatSync(join(vault, "Archive/Old/l.md"), { throwIfNoEntry: false })).toBeUndefined();
    // The real target is untouched at its real location.
    expect(read("Other/x.md")).toBe("elsewhere\n");
  });

  test("a dangling name a mid-set fault created is dropped by the cleanup (M18)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    // The relocation seam leaves a SYMLINK at the destination name whose
    // target does not exist - the exact shape a hard-linked symlinked
    // note produced - and then reports the fault. `existsSync` follows
    // the link, sees nothing and skips the unlink; a name this call
    // created must be dropped even when it dangles.
    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
      relocate: (fromAbs, toAbs, label) => {
        symlinkSync(join(fromAbs, "../never-here.md"), toAbs);
        throw new Error(`noteLifecycle: write of ${label} reported success but the file is absent`);
      },
    });

    expect(res.applied).toBe(true);
    expect(res.moved).toEqual([]);
    expect(res.moveFailures).toHaveLength(1);
    expect(res.moveFailures[0]!.path).toBe("Projects/Old/a.md");
    expect(lstatSync(join(vault, "Archive/Old/a.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(vault, "Archive/Old"))).toBe(false);
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  });
});

/**
 * The destination is judged by real path on both sides (M15), and the
 * rename-intent heuristic only fires when the named destination directory
 * does not exist (M16).
 */
describe("the destination's real path and existence", () => {
  test("a destination that is a symlink alias of the source is refused as nesting (M15)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Index.md", "[[Projects/Old/a]]\n");
    mkdirSync(join(vault, "Aa/Deep"), { recursive: true });
    symlinkSync(join(vault, "Projects/Old"), join(vault, "Aa/Deep/Link"), "dir");

    for (const apply of [false, true]) {
      let caught: unknown;
      try {
        await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "Aa/Deep/Link",
          apply,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NoteLifecycleError);
      const refusal = caught as NoteLifecycleError;
      expect(refusal.code).toBe("destination_inside_source");
      expect(refusal.message).toContain("Projects/Old");
    }
    // Nothing was linked into the source: the alias spelled a path
    // outside the folder while naming the folder itself, and the spelled
    // guard used to let it fold `Old/` inside `Projects/Old`.
    expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/Old"))).toBe(false);
    expect(read("Index.md")).toBe("[[Projects/Old/a]]\n");
  });

  test.skipIf(!FOLDS_CASE)(
    "a case-folded destination inside the source is refused by real path (M15)",
    async () => {
      note("Projects/Old/a.md", "alpha\n");
      // On the folding host this IS `Projects/Old/sub/deeper` - inside the
      // source but not the source itself - although its spelling never
      // matches the spelled guard. (A destination folding onto the source
      // itself is the destination_unchanged refusal, covered elsewhere.)
      mkdirSync(join(vault, "projects/old/sub/deeper"), { recursive: true });
      let caught: unknown;
      try {
        await folderLifecycle(vault, {
          action: NOTE_LIFECYCLE_ACTION.moveFolder,
          path: "Projects/Old",
          to: "projects/old/sub/deeper",
          apply: true,
        });
      } catch (err) {
        caught = err;
      }
      // On a case-sensitive host the spelled rung refuses (the spelled
      // destination realpaths strictly inside the source); on a folding
      // host the platform realpath preserves the caller's casing, so the
      // refusal comes from the identity rung - the directory entry IS the
      // source. Either way the code is the same.
      expect(caught).toBeInstanceOf(NoteLifecycleError);
      expect((caught as NoteLifecycleError).code).toBe("destination_inside_source");
      expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
      expect(existsSync(join(vault, "Projects/Old/sub/Old"))).toBe(false);
    },
  );

  test("a move into an EXISTING sibling folder works in one call (M16)", async () => {
    note("Projects/Old/a.md", "alpha\n");
    note("Projects/Old/b.md", "beta\n");
    note("Index.md", "[[Projects/Old/a]]\n");
    mkdirSync(join(vault, "Projects/Archive"), { recursive: true });

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Projects/Archive",
      apply: true,
    });

    // An existing sibling directory is a real move target, not the
    // spelling of a rename intent - the refusal that pointed at
    // rename-folder (which points back here for a cross-parent move)
    // used to make this move impossible in one call.
    expect(res.applied).toBe(true);
    expect(res.to).toBe("Projects/Archive/Old");
    expect(res.moved.map((m) => m.to).toSorted()).toEqual([
      "Projects/Archive/Old/a.md",
      "Projects/Archive/Old/b.md",
    ]);
    expect(existsSync(join(vault, "Projects/Old"))).toBe(false);
    expect(read("Index.md")).toBe("[[a]]\n");
  });

  test("a NON-existent sibling destination is still the rename-intent refusal (M16)", async () => {
    note("Projects/Second/c.md", "c\n");
    await expect(
      folderLifecycle(vault, {
        action: NOTE_LIFECYCLE_ACTION.moveFolder,
        path: "Projects/Second",
        to: "Projects/Nowhere",
        apply: true,
      }),
    ).rejects.toThrow(/use rename-folder/);
    expect(existsSync(join(vault, "Projects/Second/c.md"))).toBe(true);
  });
});

/**
 * Only Markdown moves; the receipt says what that honestly costs (M17):
 * a moved note's RELATIVE Markdown links and images depend on the note's
 * directory, which the move changed, and when the target stayed behind
 * the receipt names the pair instead of letting `files_rewritten: 0`
 * read as "nothing broke".
 */
describe("relative links the move leaves dangling (M17)", () => {
  test("a moved note's relative embed whose target stayed behind is named; targets that moved are not", async () => {
    note(
      "Projects/Old/a.md",
      "![pic](diagram.png)\n" +
        "[nested](./sub/other.md)\n" +
        "![absolute](/abs.png)\n" +
        "[remote](https://example.com/x.png)\n" +
        "![already broken](was-never-here.png)\n",
    );
    note("Projects/Old/sub/other.md", "nested\n");
    writeFileSync(join(vault, "Projects/Old/diagram.png"), "png\n");

    // The plan previews the same judgment from the planned set.
    const plan = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
    });
    expect(plan.applied).toBe(false);
    expect(plan.danglingRelativeLinks).toEqual([
      { note: "Archive/Old/a.md", target: "diagram.png" },
    ]);

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.applied).toBe(true);
    // The embed whose target is not a note stayed behind - named per note
    // and target, exactly as the note spells it.
    expect(res.danglingRelativeLinks).toEqual([
      { note: "Archive/Old/a.md", target: "diagram.png" },
    ]);
    // The attachment itself is in the residue, the file surface's own
    // honest answer for what a Markdown-only move leaves.
    expect(res.leftBehind).toEqual(["diagram.png"]);
    expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
    expect(existsSync(join(vault, "Projects/Old/diagram.png"))).toBe(true);
    // A target that moved WITH the folder still resolves and is not
    // named; a vault-absolute or scheme spelling never depended on the
    // note's directory; a link that was already dangling is not this
    // operation's doing.
    expect(existsSync(join(vault, "Archive/Old/sub/other.md"))).toBe(true);
  });

  test("a move whose relative targets all move with it names no dangling links", async () => {
    note("Projects/Old/a.md", "![pic](./img/inside.png)\n");
    note("Projects/Old/img/keep.md", "the target set is Markdown, so this moves too\n");

    const res = await folderLifecycle(vault, {
      action: NOTE_LIFECYCLE_ACTION.moveFolder,
      path: "Projects/Old",
      to: "Archive",
      apply: true,
    });

    expect(res.moved).toHaveLength(2);
    expect(res.danglingRelativeLinks).toEqual([]);
  });
});
