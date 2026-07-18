/**
 * D2 (t_29a63073): symlink-escape doctor lint.
 *
 * A symlink INSIDE Brain/ whose realpath resolves OUTSIDE the vault
 * root is an exfiltration/clobber hazard: a reader following it leaves
 * the vault. The doctor reports it as an error-severity `symlink-escape`
 * issue. It is a lint only - never auto-fixed. A symlink that stays
 * inside the vault is legitimate and must NOT flag.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let outside: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-symlink-escape-"));
  vault = join(tmp, "vault");
  outside = join(tmp, "outside");
  mkdirSync(vault, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "exfiltrate me\n", "utf8");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("symlink-escape lint", () => {
  test("flags a Brain/ symlink whose realpath resolves outside the vault", () => {
    const link = join(brainDirs(vault).inbox, "escape");
    symlinkSync(outside, link);

    const result = runDoctor(vault);
    const escape = [...result.errors, ...result.warnings].find((i) => i.code === "symlink-escape");
    expect(escape).toBeDefined();
    expect(escape!.severity).toBe("error");
    expect(escape!.path).toBe("Brain/inbox/escape");
  });

  test("does NOT flag a Brain/ symlink that stays inside the vault", () => {
    // A link inside Brain/ pointing at another in-vault path is legitimate.
    const targetInside = join(brainDirs(vault).preferences);
    const link = join(brainDirs(vault).inbox, "internal");
    symlinkSync(targetInside, link);

    const result = runDoctor(vault);
    const escape = [...result.errors, ...result.warnings].find((i) => i.code === "symlink-escape");
    expect(escape).toBeUndefined();
  });

  test("a clean vault with no symlinks reports no symlink-escape", () => {
    const result = runDoctor(vault);
    const escape = [...result.errors, ...result.warnings].find((i) => i.code === "symlink-escape");
    expect(escape).toBeUndefined();
  });
});
