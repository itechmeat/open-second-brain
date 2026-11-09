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

import { conflictCopies, replacePage } from "../../../src/core/view/page-io.ts";

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
    ]) {
      writeFileSync(join(dir, name), "x");
    }
    expect(conflictCopies(join(dir, "about-me.md")).map((p) => basename(p))).toEqual([
      "about-me (Sergey's conflicted copy 2026-11-06).md",
      "about-me (conflicted copy 2026-11-06).md",
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
