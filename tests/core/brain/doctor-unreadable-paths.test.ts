/**
 * A path the doctor could not read is uncertainty, never silence.
 *
 * The three sweeps that walk the store by hand - the symlink-escape
 * walk under `Brain/`, the removed-tool scan over Markdown, and the
 * basename sweep the orphan-evidence lint resolves references against -
 * each swallowed a failed read in a bare `catch` and returned. No
 * finding came out, and no finding is what every surface renders as a
 * clean bill of health: the operator was told the vault was fine
 * precisely where the doctor had been unable to look.
 *
 * The distinction these tests pin is the one that makes the fix safe. An
 * ABSENT directory was never a subtree to sweep - the common case, and
 * it must stay as quiet as it always was. A directory that exists and
 * cannot be listed, or a file standing where a directory was expected,
 * is a subtree that was skipped, and the doctor says so rather than
 * dying on it: every case below still returns a complete report.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { DoctorUncertainEntry } from "../../../src/core/brain/doctor/report.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";

const SKIPPED = DEGRADATION_CODE.vaultWalkEntrySkipped;

let tmp: string;
let vault: string;
let outside: string;
/** Paths chmod-ed unreadable by a test, restored before the tree is removed. */
let locked: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-unreadable-"));
  vault = join(tmp, "vault");
  outside = join(tmp, "outside");
  mkdirSync(vault, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  locked = [];
});

afterEach(() => {
  for (const path of locked) chmodSync(path, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Make `path` unreadable and register it for restoration. Fails loudly
 * rather than skipping when the mode does not actually deny the read -
 * a test that passes because the runner can read anything proves
 * nothing about the code under test.
 */
function makeUnreadable(path: string): string {
  chmodSync(path, 0o000);
  locked.push(path);
  return path;
}

function uncertain(): ReadonlyArray<DoctorUncertainEntry> {
  return runDoctor(vault).uncertain ?? [];
}

function skipsFor(path: string): ReadonlyArray<DoctorUncertainEntry> {
  return uncertain().filter((u) => u.code === SKIPPED && u.path === path);
}

describe("the environment can actually deny a read", () => {
  test("a 0o000 directory is unreadable to this runner", () => {
    const dir = join(tmp, "probe");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);
    // A runner that can read anything regardless of mode (root, or a
    // filesystem ignoring the bits) would make every assertion below
    // pass vacuously. Fail here instead, loudly.
    expect(() => readdirSync(dir)).toThrow();
  });
});

describe("the symlink-escape walk", () => {
  test("an unreadable directory under Brain/ is named, with the reason", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    const entry = skipsFor(dir).find((u) => u.message.includes("symlink"));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("EACCES");
  });

  test("it still reports the escaping symlinks it COULD see", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);
    symlinkSync(outside, join(brainDirs(vault).preferences, "escape"));

    const result = runDoctor(vault);
    expect(result.errors.map((e) => e.code)).toContain("symlink-escape");
  });

  test("a directory that is merely ABSENT stays quiet", () => {
    // The freshly bootstrapped vault has no unreadable path anywhere,
    // and several of the directories the checks look for do not exist.
    expect(uncertain().filter((u) => u.code === SKIPPED)).toEqual([]);
  });
});

describe("the removed-tool scan", () => {
  test("a file standing where the skills directory was expected is named", () => {
    const skills = join(vault, ".claude", "skills");
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(skills, "not a directory\n", "utf8");

    const entry = skipsFor(skills).find((u) => u.message.includes("removed"));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("ENOTDIR");
  });

  test("an unreadable skills subdirectory is named", () => {
    const dir = join(vault, ".claude", "skills", "private");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    const entry = skipsFor(dir).find((u) => u.message.includes("removed"));
    expect(entry).toBeDefined();
  });

  test("a Markdown file it cannot open is named rather than skipped", () => {
    const file = join(brainDirs(vault).brain, "notes.md");
    writeFileSync(file, "brain_digest\n", "utf8");
    makeUnreadable(file);

    const entry = uncertain().find((u) => u.path === file && u.message.includes("removed"));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("EACCES");
  });
});

describe("the orphan-evidence basename sweep", () => {
  test("an unreadable directory makes the basename universe incomplete, and says so", () => {
    const dir = join(vault, "notes");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    const entry = skipsFor(dir).find((u) => u.message.includes("basename"));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("EACCES");
  });

  test("the lint still runs over what it could read", () => {
    const dir = join(vault, "notes");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);
    writeFileSync(
      join(brainDirs(vault).log, "2026-05-14.md"),
      `---
kind: brain-log
date: 2026-05-14
tags: [brain, brain/log]
---

# Brain Log — 2026-05-14

## 10:00:00Z — apply-evidence

- preference: [[pref-foo]]
- artifact: [[missing-vault-page]]
- agent: claude
- result: applied
`,
      "utf8",
    );

    const result = runDoctor(vault);
    expect(result.warnings.map((w) => w.code)).toContain("orphan-evidence");
  });
});

describe("the doctor never dies on an odd path", () => {
  test("every unreadable shape above still yields a complete report", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);
    const skills = join(vault, ".claude", "skills");
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(skills, "not a directory\n", "utf8");

    expect(() => runDoctor(vault)).not.toThrow();
    expect(runDoctor(vault).trust_verdict).toBeDefined();
  });
});
