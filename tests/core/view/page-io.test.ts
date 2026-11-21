/**
 * Page files of the human view: only the stamped shapes sync tools give a
 * conflict copy count as one (a user's own file that merely starts with
 * the page's name is left alone), and a replacement leaves no temp file
 * behind.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  capturePage,
  conflictCopies,
  moveCompanions,
  NotAPageFileError,
  readPage,
  replacePage,
} from "../../../src/core/view/page-io.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osb-page-io-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("conflictCopies", () => {
  test("matches the sync tools' stamped copies and nothing else", () => {
    for (const name of [
      "about-me.md",
      "about-me.sync-conflict-20261106-120000-ABCDEFG.md",
      "about-me (conflicted copy 2026-11-06).md",
      "about-me (Sergey's conflicted copy 2026-11-06).md",
      "about-me (conflict notes).md",
      "about-me-notes.md",
      // A stamp spelled in capitals is still a copy, as it always was here.
      "about-me.SYNC-CONFLICT-20261106-120001-ABCDEFG.md",
    ]) {
      writeFileSync(join(dir, name), "x");
    }
    expect(conflictCopies(join(dir, "about-me.md")).map((p) => basename(p))).toEqual([
      "about-me (Sergey's conflicted copy 2026-11-06).md",
      "about-me (conflicted copy 2026-11-06).md",
      "about-me.SYNC-CONFLICT-20261106-120001-ABCDEFG.md",
      "about-me.sync-conflict-20261106-120000-ABCDEFG.md",
    ]);
  });
});

describe("replacePage", () => {
  test("places the new text and leaves only the page once the old bytes are discarded", () => {
    const page = join(dir, "about-me.md");
    writeFileSync(page, "old\n");
    const outcome = replacePage(page, Buffer.from("new\n"), Buffer.from("old\n"));
    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.replaced?.toString()).toBe("old\n");
    outcome.discard();
    expect(readFileSync(page, "utf8")).toBe("new\n");
    expect(readdirSync(dir)).toEqual(["about-me.md"]);
  });

  test("without hard links, a failed write puts the old page back and leaves no partial page", () => {
    const page = join(dir, "about-me.md");
    writeFileSync(page, "old\n");
    const noLink = Object.assign(new Error("no hard links"), { code: "EPERM" });
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw noLink;
    });
    // The temp file's flush passes; the page's own write hits a full disk.
    let flushes = 0;
    const realFsync = fs.fsyncSync;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      flushes += 1;
      if (flushes === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      realFsync(fd);
    });
    try {
      expect(() => replacePage(page, Buffer.from("new\n"), Buffer.from("old\n"))).toThrow(
        "disk full",
      );
    } finally {
      link.mockRestore();
      fsync.mockRestore();
    }
    expect(readFileSync(page, "utf8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual(["about-me.md"]);
  });

  test("without hard links, the new page is placed by an exclusive write", () => {
    const page = join(dir, "about-me.md");
    writeFileSync(page, "old\n");
    const noLink = Object.assign(new Error("no hard links"), { code: "EPERM" });
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw noLink;
    });
    try {
      const outcome = replacePage(page, Buffer.from("new\n"), Buffer.from("old\n"));
      expect(outcome.status).toBe("placed");
      expect(readFileSync(page, "utf8")).toBe("new\n");
    } finally {
      link.mockRestore();
    }
  });
});

describe("readPage", () => {
  test.skipIf(process.platform === "win32")(
    "a link put under the page name after the check is never read through",
    () => {
      const secret = join(dir, "secret.txt");
      writeFileSync(secret, "secret\n");
      const page = join(dir, "about-me.md");
      fs.symlinkSync(secret, page);
      // The name was a regular file when it was checked; a link took it
      // before the open.
      const realLstat = fs.lstatSync;
      const lstat = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike) =>
        p === page ? realLstat(secret) : realLstat(p)) as typeof fs.lstatSync);
      try {
        expect(() => readPage(page)).toThrow(NotAPageFileError);
      } finally {
        lstat.mockRestore();
      }
    },
  );
});

function folders(): { from: string; to: string } {
  const from = join(dir, "old");
  const to = join(dir, "new");
  fs.mkdirSync(from);
  writeFileSync(join(from, "notes.md"), "mine\n");
  return { from, to };
}

/** Windows: EPERM for a file another program holds. */
function denied(): never {
  throw Object.assign(new Error("access denied"), { code: "EPERM" });
}

describe("capturePage", () => {
  test("a folder at the name is refused and put back under its name, its files kept", () => {
    const folder = join(dir, "p.sync-conflict-20260101-120000-abcdefg.md");
    fs.mkdirSync(folder);
    writeFileSync(join(folder, "mine.txt"), "mine\n");
    expect(() => capturePage(folder)).toThrow(NotAPageFileError);
    expect(readFileSync(join(folder, "mine.txt"), "utf8")).toBe("mine\n");
    expect(readdirSync(dir)).toEqual([basename(folder)]);
  });

  test.skipIf(process.platform === "win32")(
    "a symbolic link at the name is refused and made again as the same link, never followed",
    () => {
      const target = join(dir, "target.md");
      writeFileSync(target, "secret\n");
      const link = join(dir, "p.md");
      fs.symlinkSync(target, link);
      expect(() => capturePage(link)).toThrow(NotAPageFileError);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(target);
      expect(readdirSync(dir).toSorted()).toEqual(["p.md", "target.md"]);
    },
  );
});

describe("moveCompanions", () => {
  test("a copy whose source cannot be removed is taken back: the file stays in one folder", () => {
    const { from, to } = folders();
    // Both calls fail with EPERM, as on Windows: the link, and taking the
    // source out of its name (Windows refuses to rename a held file too).
    const link = spyOn(fs, "linkSync").mockImplementation(denied);
    const realRename = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation(((p: fs.PathLike, q: fs.PathLike) => {
      if (String(p) === join(from, "notes.md")) denied();
      realRename(p, q);
    }) as typeof fs.renameSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
      rename.mockRestore();
    }
    expect(readdirSync(from)).toEqual(["notes.md"]);
    expect(readdirSync(to)).toEqual([]);
  });

  test("a source a sync tool replaced after the link is kept, and the stale link is taken back", () => {
    const { from, to } = folders();
    const realLink = fs.linkSync;
    const link = spyOn(fs, "linkSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      realLink(a, b);
      // The sync tool delivers a newer version under the old name.
      fs.renameSync(join(dir, "newer.tmp"), join(from, "notes.md"));
    }) as typeof fs.linkSync);
    writeFileSync(join(dir, "newer.tmp"), "newer\n");
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
    }
    expect(readFileSync(join(from, "notes.md"), "utf8")).toBe("newer\n");
    expect(readdirSync(to)).toEqual([]);
  });

  test("a destination a sync tool replaced while the move is taken back is kept", () => {
    const { from, to } = folders();
    const realLink = fs.linkSync;
    writeFileSync(join(dir, "newer.tmp"), "newer\n");
    writeFileSync(join(dir, "theirs.tmp"), "theirs\n");
    const link = spyOn(fs, "linkSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      realLink(a, b);
      link.mockRestore();
      // The sync tool delivers newer versions under both names.
      fs.renameSync(join(dir, "newer.tmp"), join(from, "notes.md"));
      fs.renameSync(join(dir, "theirs.tmp"), join(to, "notes.md"));
    }) as typeof fs.linkSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
    }
    expect(readFileSync(join(from, "notes.md"), "utf8")).toBe("newer\n");
    expect(readFileSync(join(to, "notes.md"), "utf8")).toBe("theirs\n");
  });

  test("a source a sync tool replaced after the last check is kept, never removed", () => {
    const { from, to } = folders();
    const source = join(from, "notes.md");
    const realLstat = fs.lstatSync;
    writeFileSync(join(dir, "newer.tmp"), "newer\n");
    let seen = 0;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      p: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      // The options travel on: the move reads `bigint` stats.
      const stat = realLstat(p, options);
      // The second look at the source is the last check before it goes.
      if (String(p) === source && ++seen === 2) {
        lstat.mockRestore();
        fs.renameSync(join(dir, "newer.tmp"), source);
      }
      return stat;
    }) as typeof fs.lstatSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      lstat.mockRestore();
    }
    expect(seen).toBe(2);
    expect(readFileSync(source, "utf8")).toBe("newer\n");
    expect(readdirSync(to)).toEqual([]);
  });

  test("without hard links, an edit of the copy in place before the source goes is kept", () => {
    // The copy is edited at the same size with its mtime put back (what a
    // clock that did not move reports) after it was placed. The source is
    // unchanged, so the move completes: the source goes, the edit stays.
    // Removing the copy because its stat still matched would lose it.
    const { from, to } = folders();
    const source = join(from, "notes.md");
    const dest = join(to, "notes.md");
    const link = spyOn(fs, "linkSync").mockImplementation(denied);
    const realLstat = fs.lstatSync;
    let looks = 0;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((
      p: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      // The second look at the source is the check after the copy.
      if (String(p) === source && ++looks === 2) {
        const mtime = Math.floor(realLstat(dest).mtimeMs / 1000);
        fs.utimesSync(dest, mtime, mtime);
        const text = readFileSync(dest, "utf8");
        writeFileSync(dest, "x".repeat(text.length - 1) + "\n");
        fs.utimesSync(dest, mtime, mtime);
      }
      return realLstat(p, options);
    }) as typeof fs.lstatSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
      lstat.mockRestore();
    }
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(readdirSync(from)).toEqual([]);
    expect(readFileSync(dest, "utf8")).toMatch(/^x+\n$/);
  });

  test("without hard links, a copy edited in place while the move is taken back is kept", () => {
    // Both changed: the source was edited (so the move is taken back) and
    // so was the copy, each at the same size with its mtime put back. The
    // source goes back under its name and the copy is not removed: its
    // bytes are no longer the ones the move wrote.
    const { from, to } = folders();
    const source = join(from, "notes.md");
    const dest = join(to, "notes.md");
    const mtime = Math.floor(Date.now() / 1000) - 3600;
    fs.utimesSync(source, mtime, mtime);
    const link = spyOn(fs, "linkSync").mockImplementation(denied);
    const realCopy = fs.copyFileSync;
    const copy = spyOn(fs, "copyFileSync").mockImplementation(((
      a: fs.PathLike,
      b: fs.PathLike,
      mode?: number,
    ) => {
      realCopy(a, b, mode);
      copy.mockRestore();
      // A whole second, so `utimes` can put the copy's mtime back exactly.
      fs.utimesSync(b, mtime, mtime);
      writeFileSync(source, "edit\n");
      fs.utimesSync(source, mtime, mtime);
    }) as typeof fs.copyFileSync);
    const realRename = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation(((p: fs.PathLike, q: fs.PathLike) => {
      // Taking the copy out of its name to remove it: it was edited first.
      if (String(p) === dest) {
        writeFileSync(dest, "ours\n");
        fs.utimesSync(dest, mtime, mtime);
      }
      realRename(p, q);
    }) as typeof fs.renameSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
      copy.mockRestore();
      rename.mockRestore();
    }
    expect(readFileSync(source, "utf8")).toBe("edit\n");
    expect(readFileSync(dest, "utf8")).toBe("ours\n");
  });

  test("without hard links, an edit in place during the copy is kept, never lost", () => {
    // FAT and exFAT have no hard links, so the move copies. An editor that
    // saves in place at the same size inside one tick of the volume's
    // clock (2 s on FAT) leaves inode, size and mtime as the move first
    // saw them; only the bytes tell the copy is of an older version.
    const { from, to } = folders();
    const source = join(from, "notes.md");
    const mtime = Math.floor(Date.now() / 1000) - 3600;
    fs.utimesSync(source, mtime, mtime);
    const link = spyOn(fs, "linkSync").mockImplementation(denied);
    const realCopy = fs.copyFileSync;
    const copy = spyOn(fs, "copyFileSync").mockImplementation(((
      a: fs.PathLike,
      b: fs.PathLike,
      mode?: number,
    ) => {
      realCopy(a, b, mode);
      writeFileSync(source, "edit\n");
      fs.utimesSync(source, mtime, mtime);
    }) as typeof fs.copyFileSync);
    try {
      moveCompanions(from, to, new Set());
    } finally {
      link.mockRestore();
      copy.mockRestore();
    }
    expect(readFileSync(source, "utf8")).toBe("edit\n");
    expect(readdirSync(to)).toEqual([]);
  });
});
