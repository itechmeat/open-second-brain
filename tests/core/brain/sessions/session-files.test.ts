/**
 * `sessionFilesUnder`, the one answer to "which files under this path are
 * session transcripts".
 *
 * It was extracted so the directory import and the transcript dataset
 * export could not drift about what a session log is, and it shipped with
 * no test of its own. Two of the three things it promises were unheld: the
 * typed `IO` refusal covered the root `statSync` and the per-entry
 * `lstatSync` but not the recursive `readdirSync` between them, so one
 * unreadable subdirectory escaped as a raw errno through both callers -
 * where the sibling sweep in `discover.ts` reports the same condition and
 * carries on; and the recursion had no depth bound at all while the sweep
 * beside it walks a declared glob.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSessionFileName,
  sessionFilesUnder,
} from "../../../../src/core/brain/sessions/session-files.ts";
import {
  SESSION_FILE_EXTENSION,
  SessionImportError,
} from "../../../../src/core/brain/sessions/types.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "o2b-session-files-"));
}

function touch(path: string): void {
  writeFileSync(path, "{}\n", "utf8");
}

describe("sessionFilesUnder", () => {
  test("a directory yields its transcripts, sorted, and nothing else", () => {
    const dir = tempDir();
    try {
      touch(join(dir, "b.jsonl"));
      touch(join(dir, "a.jsonl"));
      touch(join(dir, "README.md"));
      mkdirSync(join(dir, "nested"));
      touch(join(dir, "nested", "c.jsonl"));
      expect(sessionFilesUnder(dir)).toEqual([
        join(dir, "a.jsonl"),
        join(dir, "b.jsonl"),
        join(dir, "nested", "c.jsonl"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a named FILE is returned whatever its extension", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "transcript.log");
      touch(path);
      expect(sessionFilesUnder(path)).toEqual([path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path that does not exist is a typed refusal, not an empty list", () => {
    const dir = tempDir();
    try {
      expect(() => sessionFilesUnder(join(dir, "absent"))).toThrow(SessionImportError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable SUBDIRECTORY is a typed refusal naming it, not a raw errno", () => {
    // The hole: the top-level `statSync` and the per-entry `lstatSync`
    // were both wrapped, and the recursion between them was not. One
    // mode-000 directory therefore took down the whole import and the
    // whole export with an `EACCES` nobody had translated.
    if (process.getuid?.() === 0) return; // root reads a 000 directory anyway
    const dir = tempDir();
    const locked = join(dir, "locked");
    try {
      touch(join(dir, "readable.jsonl"));
      mkdirSync(locked);
      touch(join(locked, "hidden.jsonl"));
      chmodSync(locked, 0o000);
      let caught: unknown = null;
      try {
        sessionFilesUnder(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionImportError);
      expect((caught as SessionImportError).code).toBe("IO");
      expect((caught as SessionImportError).message).toContain(locked);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tree deeper than the bound is refused rather than recursed into", () => {
    const dir = tempDir();
    try {
      let deep = dir;
      for (let i = 0; i < 40; i++) {
        deep = join(deep, `d${i}`);
        mkdirSync(deep);
      }
      touch(join(deep, "buried.jsonl"));
      expect(() => sessionFilesUnder(dir)).toThrow(/nests deeper than/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what a session log is, stated once", () => {
  test("the walk accepts exactly the declared extension", () => {
    expect(isSessionFileName(`x${SESSION_FILE_EXTENSION}`)).toBe(true);
    expect(isSessionFileName("x.json")).toBe(false);
  });

  test("the Codex discovery glob is built from the same constant", async () => {
    // Three definitions of "a session log" existed: this walk's `.jsonl`,
    // the Codex rows' `**/*.json*`, and the adapters, which parse only
    // line-delimited JSON. The middle one made `.json` rollouts
    // discoverable and importable while `import-session <dir>` and
    // `export --transcripts <dir>` skipped every one of them in silence.
    const { resolveSessionRootsFor } = await import("../../../../src/core/runtime/host-facts.ts");
    const roots = resolveSessionRootsFor("codex", { home: "/home/nobody", env: {} });
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root.glob).toBe(`**/*${SESSION_FILE_EXTENSION}`);
  });
});
