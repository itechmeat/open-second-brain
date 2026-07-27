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
 *
 * Three properties the first shipping of that fix did not have, and this
 * file now pins:
 *
 *   - the code an operator reads on the `[UNSURE]` line RESOLVES to an
 *     exit, so the line is not itself a dead end;
 *   - one unread path produces ONE entry however many sweeps walked it,
 *     and the stream is bounded;
 *   - the absent/failed split is asked on every path the doctor reads,
 *     including the ones an `existsSync` gate used to answer for it - a
 *     gate that returns false for a permission denial as readily as for
 *     an absence, and so reported a populated vault as an empty one.
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
import {
  readSweptDir,
  SWEEP_ORIGIN,
  type SweptPath,
} from "../../../src/core/brain/doctor/unreadable-path.ts";
import { UNCERTAIN_MAX_PER_CODE } from "../../../src/core/brain/doctor/uncertain-stream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { resolveNextStep } from "../../../src/core/brain/next-step.ts";
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

describe("the code an [UNSURE] line carries is not itself a dead end", () => {
  test("the skipped-entry code resolves to a next command", () => {
    // The CLI folds `uncertain` into the codes it resolves exits for. A
    // code in neither table prints the finding and nothing after it -
    // which is the dead end the exit census exists to make impossible.
    const step = resolveNextStep(SKIPPED);
    expect(step).not.toBeNull();
    expect(step!.nextCommand.startsWith("o2b ")).toBe(true);
  });

  test("the doctor emits exactly that code on an unreadable subtree", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    expect(uncertain().map((u) => u.code)).toContain(SKIPPED);
  });
});

describe("one unread path is one entry", () => {
  test("four sweeps over the same directory report it once", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    // The symlink walk, the removed-tool scan, the basename sweep and
    // the frontmatter probe all descend through Brain/inbox.
    expect(skipsFor(dir).length).toBe(1);
  });

  test("the surviving entry keeps the most informative consequence", () => {
    const dir = join(brainDirs(vault).inbox, "vaulted");
    mkdirSync(dir, { recursive: true });
    makeUnreadable(dir);

    // Of the four clauses written for this path, the basename sweep's is
    // the one that states most about what went unanswered; first-wins
    // would have kept whichever check the registry happens to run first.
    expect(skipsFor(dir)[0]!.message).toContain("basename universe");
    expect(skipsFor(dir)[0]!.message).toContain("EACCES");
  });

  test("the stream is capped, so a synced tree cannot flood the payload", () => {
    const parent = brainDirs(vault).inbox;
    for (let i = 0; i < UNCERTAIN_MAX_PER_CODE + 10; i += 1) {
      const dir = join(parent, `locked-${i}`);
      mkdirSync(dir, { recursive: true });
      makeUnreadable(dir);
    }

    expect(uncertain().filter((u) => u.code === SKIPPED).length).toBe(UNCERTAIN_MAX_PER_CODE);
  });
});

describe("a failure on a parent path component", () => {
  test("an unreadable .claude/ does not read as an absent skills directory", () => {
    const claude = join(vault, ".claude");
    const skills = join(claude, "skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "old.md"), "brain_digest\n", "utf8");
    makeUnreadable(claude);

    // Before: `existsSync(skills)` was false because the PARENT denied
    // the stat, so the scan returned as if the vault had no skills at
    // all - and the migration this scan exists to surface vanished.
    const entry = skipsFor(skills)[0];
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("EACCES");
  });

  test("a self-referential skills symlink is named rather than silently skipped", () => {
    const skills = join(vault, ".claude", "skills");
    mkdirSync(join(vault, ".claude"), { recursive: true });
    symlinkSync(skills, skills);

    const entry = skipsFor(skills)[0];
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("ELOOP");
  });

  test("an unreadable vault root is not reported as an un-initialized one", () => {
    makeUnreadable(vault);

    const result = runDoctor(vault);
    // `brain-root-absent` resolves to `o2b brain init`, which would
    // write a Brain layer into a store this pass never managed to look
    // at. Absence and denial are different answers.
    expect(result.warnings.map((w) => w.code)).not.toContain("brain-root-absent");
    expect((result.uncertain ?? []).map((u) => u.code)).not.toContain("brain-root-absent");
    const entry = (result.uncertain ?? []).find((u) => u.code === SKIPPED);
    expect(entry).toBeDefined();
    expect(entry!.path).toBe(brainDirs(vault).brain);
  });

  test("a root that is genuinely absent still reports absent, unchanged", () => {
    const empty = join(tmp, "no-vault-here");
    mkdirSync(empty, { recursive: true });

    const result = runDoctor(empty);
    expect(result.warnings.map((w) => w.code)).toEqual(["brain-root-absent"]);
    expect((result.uncertain ?? []).map((u) => u.code)).toEqual(["brain-root-absent"]);
  });
});

describe("ENOENT means absent only where absence was possible", () => {
  test("a sweep's own root that is missing stays quiet", () => {
    const entries: DoctorUncertainEntry[] = [];
    const swept: SweptPath = { site: "test", consequence: "nothing was swept", uncertain: entries };

    expect(readSweptDir(join(tmp, "never-created"), swept, SWEEP_ORIGIN.root)).toBeNull();
    expect(entries).toEqual([]);
  });

  test("a path the walk itself listed is a race, not an absence", () => {
    const entries: DoctorUncertainEntry[] = [];
    const swept: SweptPath = {
      site: "test",
      consequence: "the subtree was skipped",
      uncertain: entries,
    };

    // The parent listed this name a moment ago, so it existed. ENOENT
    // here means it vanished under the walk - a subtree that was skipped
    // like any other, not an optional directory nobody created.
    expect(readSweptDir(join(tmp, "never-created"), swept, SWEEP_ORIGIN.discovered)).toBeNull();
    expect(entries.map((e) => e.code)).toEqual([SKIPPED]);
    expect(entries[0]!.message).toContain("ENOENT");
  });
});

describe("an entry that is neither a file nor a directory", () => {
  test("a symlinked Markdown file under Brain/ is named, not dropped", () => {
    // `Dirent.isFile()` and `isDirectory()` are both false for a
    // symlink, so this file was skipped with no error, no warning and no
    // uncertainty - and its target is outside Brain/, so no other pass
    // reads it either.
    const target = join(vault, "notes", "tool-note.md");
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(target, "brain_digest\n", "utf8");
    const alias = join(brainDirs(vault).inbox, "alias.md");
    symlinkSync(target, alias);

    const entry = skipsFor(alias)[0];
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("symbolic link");
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

  test("an unreadable Brain/ still produces findings rather than a throw", () => {
    makeUnreadable(brainDirs(vault).brain);

    expect(() => runDoctor(vault)).not.toThrow();
    const result = runDoctor(vault);
    expect(
      result.errors.length + result.warnings.length + (result.uncertain ?? []).length,
    ).toBeGreaterThan(0);
    expect((result.uncertain ?? []).some((u) => u.code === SKIPPED)).toBe(true);
  });

  test("an unreadable Brain/preferences still produces findings rather than a throw", () => {
    const prefs = brainDirs(vault).preferences;
    makeUnreadable(prefs);

    expect(() => runDoctor(vault)).not.toThrow();
    expect(skipsFor(prefs).length).toBe(1);
  });

  test("a regular file standing where Brain/log belongs is reported, not fatal", () => {
    const log = brainDirs(vault).log;
    rmSync(log, { recursive: true, force: true });
    writeFileSync(log, "not a directory\n", "utf8");

    expect(() => runDoctor(vault)).not.toThrow();
    const entry = skipsFor(log)[0];
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("ENOTDIR");
  });
});
