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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
      // The residue is exactly where the report says: `a.md` is at its
      // new path, `b.md` stays at its old one.
      expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
      expect(existsSync(join(vault, "Projects/Old/sub/b.md"))).toBe(true);
      // Pairs were computed from the moved set ONLY: the link to the
      // moved note is rewritten, the link to the failed note still
      // resolves to where the bytes actually are.
      expect(read("Notes/A.md")).toBe("moves [[a]]\n");
      expect(read("Notes/B.md")).toBe("moves [[Projects/Old/sub/b]]\n");
    },
  );
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
