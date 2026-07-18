/**
 * Tests for `detectTensionsInVault` - the production entry point that
 * scans the configured note corpus (`notes.read_paths`) and persists
 * detected contradictions as tensions (Belief lifecycle suite, S2,
 * t_0e3f2bee). Before this wiring the detector had no production caller.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  detectTensionsInVault,
  listTensions,
  TENSION_STATUS,
} from "../../../src/core/brain/tensions.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-tension-detect-"));
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

function writeMd(rel: string, content: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** A high-overlap, opposite-stance pair the note detector flags. */
function seedContradictoryCorpus(): void {
  writeConfig("\nnotes:\n  read_paths:\n    - Notes\n");
  writeMd(
    "Notes/tabs.md",
    "---\nid: note-tabs\n---\nAlways use tabs for indentation in source files.\n",
  );
  writeMd(
    "Notes/spaces.md",
    "---\nid: note-spaces\n---\nNever use tabs for indentation in source files.\n",
  );
}

describe("detectTensionsInVault", () => {
  test("scans the configured note corpus and persists a tension", () => {
    seedContradictoryCorpus();
    const res = detectTensionsInVault(vault, { agent: "tester" });
    expect(res.scannedFiles).toBe(2);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.records.length).toBe(1);

    const persisted = listTensions(vault);
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.status).toBe(TENSION_STATUS.open);
    // Subjects are the note ids, sorted.
    expect([persisted[0]!.subjectA, persisted[0]!.subjectB].toSorted()).toEqual([
      "note-spaces",
      "note-tabs",
    ]);
  });

  test("re-detection refreshes the existing tension instead of duplicating", () => {
    seedContradictoryCorpus();
    detectTensionsInVault(vault, { agent: "tester" });
    const second = detectTensionsInVault(vault, { agent: "tester" });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(listTensions(vault).length).toBe(1);
    expect(listTensions(vault)[0]!.detectedCount).toBe(2);
  });

  test("an unconfigured vault (no read_paths) scans nothing and creates nothing", () => {
    // No notes block at all: default read_paths is empty.
    writeConfig("");
    writeMd("Notes/tabs.md", "Always use tabs.\n");
    writeMd("Notes/spaces.md", "Never use tabs.\n");
    const res = detectTensionsInVault(vault, { agent: "tester" });
    expect(res.scannedFiles).toBe(0);
    expect(res.created).toBe(0);
    expect(listTensions(vault).length).toBe(0);
  });

  test("agreeing notes produce no tension", () => {
    writeConfig("\nnotes:\n  read_paths:\n    - Notes\n");
    writeMd("Notes/a.md", "---\nid: note-a\n---\nAlways use tabs for indentation here.\n");
    writeMd("Notes/b.md", "---\nid: note-b\n---\nAlways use tabs for indentation here too.\n");
    const res = detectTensionsInVault(vault, { agent: "tester" });
    expect(res.scannedFiles).toBe(2);
    expect(res.created).toBe(0);
    expect(listTensions(vault).length).toBe(0);
  });

  test("the Brain machinery root is never scanned as note content", () => {
    // read_paths points at the vault root; the walker still hard-skips Brain/.
    writeConfig("\nnotes:\n  read_paths:\n    - Notes\n");
    writeMd("Notes/tabs.md", "---\nid: note-tabs\n---\nAlways use tabs for indentation.\n");
    // A decoy under Brain/ that would contradict if it were scanned.
    writeMd(
      "Brain/preferences/pref-spaces.md",
      "---\nid: pref-spaces\n---\nNever use tabs for indentation.\n",
    );
    const res = detectTensionsInVault(vault, { agent: "tester" });
    expect(res.scannedFiles).toBe(1);
    expect(res.created).toBe(0);
  });
});
