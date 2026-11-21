/**
 * A snapshot keeps every file whatever the script of its name: create,
 * list, extract and restore, on every platform.
 *
 * Decision, topic and preference slugs keep the letters of any script, so
 * `Brain/` holds names in Cyrillic, CJK and with combining marks. On
 * Windows the snapshot used to hand those names to `tar.exe` (bsdtar) in a
 * `-T` list, which it reads in the ANSI code page: the names decoded to
 * paths that do not exist ("tar: : Couldn't visit directory") and the
 * snapshot failed, the dream pass and every other gated write with it.
 * Its extraction turned the UTF-8 names of the archive into that code page
 * too and refused every name it lacks ("Archive entry has empty or
 * unreadable filename"), so a restore failed; macOS bsdtar renamed every
 * NFC name to NFD. The archive is now read in process, so every name
 * comes back byte for byte everywhere, and no `tar` is needed to restore.
 * Two members that one extraction folder cannot keep apart (an NFC name
 * and its NFD twin on APFS, two cases on a case-insensitive volume) are
 * refused before anything is extracted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs, snapshotPath } from "../../../src/core/brain/paths.ts";
import {
  createSnapshot,
  extractSnapshotToTemp,
  listSnapshots,
  restoreSnapshot,
} from "../../../src/core/brain/snapshot.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { tarOf } from "./fixtures/tar-fixture.ts";

const DREAM = { reason: BRAIN_SNAPSHOT_REASON.dream };

/** One directory and its files, each name in another script or form, no two equal after normalization. */
const DIR = "темы-主题";
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["decision-формат-заметок-релиза.md", "Cyrillic\n"],
  ["decision-发布说明格式.md", "CJK\n"],
  ["pref-cafe\u0301-plan.md", "a combining mark (NFD)\n"],
  ["pref-résumé-notes.md", "a precomposed accent (NFC)\n"],
  ["plain.md", "ASCII\n"],
];

let root: string;
let vault: string;
let brain: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-snap-unicode-"));
  vault = join(root, "vault");
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  brain = brainDirs(vault).brain;
  mkdirSync(join(brain, DIR));
  for (const [name, body] of FILES) writeFileSync(join(brain, DIR, name), body);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The names in `dir`, as bytes (hex), sorted. */
function names(dir: string): string[] {
  return readdirSync(dir)
    .map((n) => Buffer.from(n).toString("hex"))
    .toSorted();
}

/** `files`' names as {@link names} gives them. */
function hexNames(files: ReadonlyArray<readonly [string, string]>): string[] {
  return files.map(([n]) => Buffer.from(n).toString("hex")).toSorted();
}

/** How a fresh folder here treats two forms and two cases of one name. */
function folding(): { forms: boolean; cases: boolean } {
  const dir = mkdtempSync(join(root, "probe-"));
  writeFileSync(join(dir, "x-\u00e9"), "");
  return {
    forms: existsSync(join(dir, "x-e\u0301")),
    cases: existsSync(join(dir, "X-\u00e9")),
  };
}

/**
 * A snapshot archive holding `files` under `Brain/`, published as `runId`.
 * Each member is written from a folder of its own (`tarOf`), so twins keep
 * their own bodies even where the host filesystem would merge them.
 */
function craftedSnapshot(runId: string, files: ReadonlyArray<readonly [string, string]>): void {
  const tar = tarOf(root, [
    ["Brain", null],
    ...files.map(([n, body]) => [`Brain/${n}`, body] as const),
  ]);
  mkdirSync(brainDirs(vault).snapshots, { recursive: true });
  writeFileSync(snapshotPath(vault, runId), gzipSync(tar));
}

describe("a snapshot of names in any script", () => {
  test("is created and listed", () => {
    const snap = createSnapshot(vault, "dream-unicode-list", DREAM);
    expect(listSnapshots(vault).snapshots.map((s) => s.run_id)).toContain("dream-unicode-list");
    expect(existsSync(snap.path)).toBe(true);
  });

  test("extracts every file under its own name, with its bytes", () => {
    createSnapshot(vault, "dream-unicode-extract", DREAM);
    const extracted = extractSnapshotToTemp(vault, "dream-unicode-extract");
    try {
      const dir = join(extracted.brainRoot, DIR);
      expect(names(dir)).toEqual(names(join(brain, DIR)));
      for (const [name, body] of FILES) {
        expect(readFileSync(join(dir, name), "utf8")).toBe(body);
      }
    } finally {
      extracted.cleanup();
    }
  });

  test("is restored over a tree that lost and changed them", () => {
    createSnapshot(vault, "dream-unicode-restore", DREAM);
    rmSync(join(brain, DIR, FILES[0]![0]));
    writeFileSync(join(brain, DIR, FILES[1]![0]), "changed\n");
    restoreSnapshot(vault, "dream-unicode-restore");
    expect(names(join(brain, DIR))).toEqual(hexNames(FILES));
    for (const [name, body] of FILES) {
      expect(readFileSync(join(brain, DIR, name), "utf8")).toBe(body);
    }
  });
});

describe("a restore without tar", () => {
  test("extracts and restores with no tar on PATH", () => {
    // gzip, which is inflated in process: zstd is a tool of its own.
    craftedSnapshot(
      "dream-unicode-no-tar",
      FILES.map(([n, body]) => [`${DIR}/${n}`, body] as const),
    );
    rmSync(join(brain, DIR, FILES[2]![0]));
    const saved = process.env["PATH"];
    process.env["PATH"] = join(root, "no-tools-here");
    try {
      const extracted = extractSnapshotToTemp(vault, "dream-unicode-no-tar");
      try {
        expect(names(join(extracted.brainRoot, DIR))).toEqual(hexNames(FILES));
      } finally {
        extracted.cleanup();
      }
      restoreSnapshot(vault, "dream-unicode-no-tar");
    } finally {
      process.env["PATH"] = saved;
    }
    expect(readFileSync(join(brain, DIR, FILES[2]![0]), "utf8")).toBe(FILES[2]![1]);
  });
});

describe("two members one folder cannot keep apart", () => {
  for (const [what, twins, kind] of [
    ["an NFC name and its NFD twin", ["café-plan.md", "cafe\u0301-plan.md"], "forms"],
    ["two cases of one name", ["Note.md", "note.md"], "cases"],
    ["case aliases with normalized path components", ["Note.md", "./note.md"], "cases"],
  ] as const) {
    test(`${what}: both come back where the folder keeps them apart, else nothing is extracted`, () => {
      const runId = `dream-twins-${kind}`;
      craftedSnapshot(runId, [
        [twins[0], "first\n"],
        [twins[1], "second\n"],
      ]);
      const collapses = folding()[kind];
      if (collapses) {
        expect(() => extractSnapshotToTemp(vault, runId)).toThrow("cannot keep apart");
        const before = readdirSync(brain).toSorted();
        expect(() => restoreSnapshot(vault, runId)).toThrow("cannot keep apart");
        expect(readdirSync(brain).toSorted()).toEqual(before);
      } else {
        const extracted = extractSnapshotToTemp(vault, runId);
        try {
          expect(readFileSync(join(extracted.brainRoot, twins[0]), "utf8")).toBe("first\n");
          expect(readFileSync(join(extracted.brainRoot, twins[1]), "utf8")).toBe("second\n");
        } finally {
          extracted.cleanup();
        }
      }
    });
  }
});
