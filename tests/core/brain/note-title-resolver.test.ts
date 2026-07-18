/**
 * Tests for `note-title-resolver.ts` - the fail-closed marker-target
 * resolver used by the `set` write-back marker (Task 5, today-operator-
 * surface). Mirrors the config + `read_paths` fixture pattern used by
 * `tests/core/brain.inline-scan.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  NoteTitleResolutionError,
  resolveNoteTarget,
} from "../../../src/core/brain/notes/note-title-resolver.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-title-resolver-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
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

function writeMd(rel: string, content = "hello\n"): string {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

describe("resolveNoteTarget - path-target delegation", () => {
  beforeEach(() => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
  });

  test("existing vault-relative path resolves as-is", () => {
    writeMd("Daily/2026-07-17.md");
    expect(resolveNoteTarget(vault, "Daily/2026-07-17.md")).toBe("Daily/2026-07-17.md");
  });

  test("missing .md extension is appended before delegation", () => {
    writeMd("Daily/2026-07-17.md");
    expect(resolveNoteTarget(vault, "Daily/2026-07-17")).toBe("Daily/2026-07-17.md");
  });

  test("wikilink-wrapped path target resolves the same way", () => {
    writeMd("Daily/2026-07-17.md");
    expect(resolveNoteTarget(vault, "[[Daily/2026-07-17]]")).toBe("Daily/2026-07-17.md");
  });

  test("nonexistent path target throws a typed path_not_found error", () => {
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "Daily/does-not-exist.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("path_not_found");
  });

  test("path traversal outside the vault throws path_not_found, never escapes", () => {
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "../outside.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("path_not_found");
  });
});

describe("resolveNoteTarget - Obsidian-style title resolution", () => {
  beforeEach(() => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n    - Journal\n");
  });

  test("unique basename match across configured note paths resolves to its path", () => {
    writeMd("Daily/Project Kickoff.md");
    expect(resolveNoteTarget(vault, "Project Kickoff")).toBe("Daily/Project Kickoff.md");
  });

  test("bare target matches the same as a wikilink-wrapped target", () => {
    writeMd("Journal/Weekly Review.md");
    expect(resolveNoteTarget(vault, "[[Weekly Review]]")).toBe("Journal/Weekly Review.md");
  });

  test("wikilink alias and anchor decoration are stripped before matching", () => {
    writeMd("Daily/Weekly Review.md");
    expect(resolveNoteTarget(vault, "[[Weekly Review#Section|Display Text]]")).toBe(
      "Daily/Weekly Review.md",
    );
  });

  test("zero matches throws a typed not_found error", () => {
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "No Such Note");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("not_found");
  });

  test("ambiguous match throws a typed error listing sorted candidates, never a guess", () => {
    writeMd("Journal/Weekly Review.md");
    writeMd("Daily/Weekly Review.md");
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "Weekly Review");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    const error = caught as NoteTitleResolutionError;
    expect(error.code).toBe("ambiguous");
    expect(error.candidates).toEqual(["Daily/Weekly Review.md", "Journal/Weekly Review.md"]);
  });

  test("empty target throws a typed empty_target error", () => {
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "   ");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("empty_target");
  });

  test("empty bracket pair is not a recognised wikilink form - treated as literal text, not_found", () => {
    // Mirrors the rest of the codebase's wikilink grammar (see
    // `ANCHORED_WIKILINK_RE` / `parseWikilink`): an empty `[[]]` body
    // does not satisfy the non-empty-content wikilink pattern, so it
    // falls through as bare text rather than unwrapping to "".
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "[[]]");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("not_found");
  });

  test("ignore-path exclusion drops matches under an excluded subtree", () => {
    // Self-contained config (mirrors the note-walk test): DEFAULT_BRAIN_CONFIG_YAML
    // already defines a top-level `vault:` block, so appending a second one via
    // writeConfig would make this fixture parser-dependent. Write the whole
    // document once with the single `vault:` block we want under test.
    atomicWriteFileSync(
      join(brainDirs(vault).brain, "_brain.yaml"),
      "schema_version: 1\nnotes:\n  read_paths:\n    - Daily\nvault:\n  ignore_paths:\n    - Daily/Archive\n",
    );
    writeMd("Daily/Archive/Old Note.md");
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "Old Note");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("not_found");
  });

  test("a note outside every configured read path is not matched", () => {
    writeMd("Elsewhere/Stray Note.md");
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "Stray Note");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("not_found");
  });

  test("no configured read_paths at all yields a not_found error, never a crash", () => {
    writeConfig("");
    writeMd("Daily/Weekly Review.md");
    let caught: unknown;
    try {
      resolveNoteTarget(vault, "Weekly Review");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoteTitleResolutionError);
    expect((caught as NoteTitleResolutionError).code).toBe("not_found");
  });
});
