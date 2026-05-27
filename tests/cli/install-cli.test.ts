import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installCli, uninstallCli } from "../../src/cli/install-cli.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-installcli-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("installCli", () => {
  test("creates symlinks for o2b, vault-log, and o2b-hook", () => {
    const result = installCli(tmp);
    expect(result.errors).toEqual([]);
    for (const name of ["o2b", "vault-log", "o2b-hook"]) {
      const link = join(tmp, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toContain(`scripts/${name}`);
    }
  });

  test("re-running is idempotent (exists message, no error)", () => {
    installCli(tmp);
    const result = installCli(tmp);
    expect(result.errors).toEqual([]);
    expect(result.outcomes.some(([_, msg]) => msg.startsWith("exists:"))).toBe(true);
  });

  test("does not overwrite an existing symlink to a different target", () => {
    const fake = join(tmp, "fake.sh");
    writeFileSync(fake, "#!/bin/sh\n");
    symlinkSync(fake, join(tmp, "o2b"));
    const result = installCli(tmp);
    // Conflicting symlink is now reported as an error so callers (CLI
    // wrapper, scripted installs) exit non-zero instead of silently
    // succeeding while the requested link is still pointing elsewhere.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.outcomes.some(([n, msg]) => n === "o2b" && msg.startsWith("error:"))).toBe(true);
    expect(readlinkSync(join(tmp, "o2b"))).toBe(fake);
  });
});

describe("uninstallCli", () => {
  test("removes only links pointing at this repo's scripts", () => {
    installCli(tmp);
    const result = uninstallCli(tmp);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(tmp, "o2b"))).toBe(false);
    expect(existsSync(join(tmp, "vault-log"))).toBe(false);
  });

  test("refuses to remove a symlink that points outside this repo", () => {
    const elsewhere = join(tmp, "elsewhere.sh");
    writeFileSync(elsewhere, "#!/bin/sh\n");
    symlinkSync(elsewhere, join(tmp, "o2b"));
    const result = uninstallCli(tmp);
    expect(result.errors).toEqual([]);
    expect(
      result.outcomes.some(([n, msg]) => n === "o2b" && msg.includes("outside this repo")),
    ).toBe(true);
    expect(existsSync(join(tmp, "o2b"))).toBe(true);
  });

  test("skips a link that doesn't exist", () => {
    const result = uninstallCli(tmp);
    expect(result.errors).toEqual([]);
    expect(result.outcomes.every(([_, msg]) => msg.startsWith("skipped:"))).toBe(true);
  });
});
