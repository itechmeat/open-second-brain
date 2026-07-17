/**
 * Tests for `notes/note-walk.ts` - the shared note-space walker that
 * `scanInline`, the open-loops scanner, and the note-title resolver all
 * delegate to. These pin the extracted API directly; the fuller
 * behaviour is also exercised indirectly through
 * `tests/core/brain.inline-scan.test.ts` and
 * `tests/core/brain/note-title-resolver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  buildNoteWalkRules,
  normalisePrefix,
  resolveNoteRoots,
  walkMarkdownFiles,
} from "../../../src/core/brain/notes/note-walk.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-walk-"));
  mkdirSync(brainDirs(vault).brain, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfig(extra: string): void {
  atomicWriteFileSync(
    join(brainDirs(vault).brain, "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}${extra}`,
  );
}

function writeMd(rel: string, content = "hello\n"): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function relPaths(vaultRoot: string, roots: ReadonlyArray<string>): string[] {
  const rules = buildNoteWalkRules(vaultRoot);
  return [...walkMarkdownFiles(vaultRoot, roots, rules)].map((f) => f.relPath).toSorted();
}

describe("normalisePrefix", () => {
  test("strips leading and trailing slashes", () => {
    expect(normalisePrefix("/Daily/")).toBe("Daily");
    expect(normalisePrefix("Daily")).toBe("Daily");
  });
});

describe("resolveNoteRoots", () => {
  test("explicit paths override notes.read_paths", () => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
    expect(resolveNoteRoots(vault, ["Journal"])).toEqual(["Journal"]);
  });

  test("falls back to notes.read_paths when no explicit paths", () => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n    - Journal\n");
    expect(resolveNoteRoots(vault)).toEqual(["Daily", "Journal"]);
  });

  test("blank explicit entries are dropped so config still wins", () => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
    expect(resolveNoteRoots(vault, ["  "])).toEqual(["Daily"]);
  });

  test("no configured read paths yields an empty root list", () => {
    writeConfig("");
    expect(resolveNoteRoots(vault)).toEqual([]);
  });
});

describe("walkMarkdownFiles", () => {
  beforeEach(() => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
  });

  test("yields .md files under a root and skips non-md and out-of-root files", () => {
    writeMd("Daily/a.md");
    writeMd("Daily/b.txt");
    writeMd("Elsewhere/c.md");
    expect(relPaths(vault, ["Daily"])).toEqual(["Daily/a.md"]);
  });

  test("hard-skips the Brain/ machinery root", () => {
    writeMd("Brain/note.md");
    writeMd("Daily/keep.md");
    expect(relPaths(vault, ["Brain", "Daily"])).toEqual(["Daily/keep.md"]);
  });

  test("honours vault.ignore_paths exclusion", () => {
    // A single `vault:` block: DEFAULT_BRAIN_CONFIG_YAML already carries
    // one, so this test writes a self-contained config rather than
    // appending a second (duplicate) top-level key.
    atomicWriteFileSync(
      join(brainDirs(vault).brain, "_brain.yaml"),
      "schema_version: 1\nnotes:\n  read_paths:\n    - Daily\nvault:\n  ignore_paths:\n    - Daily/Archive\n",
    );
    writeMd("Daily/live.md");
    writeMd("Daily/Archive/old.md");
    expect(relPaths(vault, ["Daily"])).toEqual(["Daily/live.md"]);
  });

  test("size cap reports and skips oversize files, leaving smaller ones", () => {
    writeMd("Daily/small.md", "tiny\n");
    writeMd("Daily/big.md", "x".repeat(2048));
    const rules = buildNoteWalkRules(vault);
    const oversize: string[] = [];
    const yielded = [
      ...walkMarkdownFiles(vault, ["Daily"], rules, {
        maxFileSizeBytes: 1024,
        onOversize: (file, size) => oversize.push(`${file.relPath}:${size}`),
      }),
    ].map((f) => f.relPath);
    expect(yielded).toEqual(["Daily/small.md"]);
    expect(oversize).toEqual(["Daily/big.md:2048"]);
  });

  test("provides absolute and vault-relative paths for each file", () => {
    writeMd("Daily/a.md");
    const rules = buildNoteWalkRules(vault);
    const [file] = [...walkMarkdownFiles(vault, ["Daily"], rules)];
    expect(file?.relPath).toBe("Daily/a.md");
    expect(file?.absPath).toBe(join(vault, "Daily", "a.md"));
  });
});
