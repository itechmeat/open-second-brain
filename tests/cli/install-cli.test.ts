import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healCliSymlinks, installCli, uninstallCli } from "../../src/cli/install-cli.ts";

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

function fakeOsbScript(root: string, name: string): string {
  const dir = join(root, "scripts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n");
  return file;
}

describe("installCli (idempotent reclaim, no manual rm)", () => {
  test("reclaims a dangling symlink", () => {
    symlinkSync(join(tmp, "gone", "scripts", "o2b"), join(tmp, "o2b"));
    const result = installCli(tmp);
    expect(result.errors).toEqual([]);
    expect(result.outcomes.some(([n, m]) => n === "o2b" && m.startsWith("repointed:"))).toBe(true);
    expect(existsSync(realpathSync(join(tmp, "o2b")))).toBe(true);
    expect(readlinkSync(join(tmp, "o2b"))).toContain(`scripts${"/"}o2b`);
  });

  test("reclaims a stale symlink pointing at another OSB checkout", () => {
    const stale = fakeOsbScript(join(tmp, "old-version"), "o2b");
    symlinkSync(stale, join(tmp, "o2b"));
    const result = installCli(tmp);
    expect(result.errors).toEqual([]);
    expect(result.outcomes.some(([n, m]) => n === "o2b" && m.startsWith("repointed:"))).toBe(true);
    expect(readlinkSync(join(tmp, "o2b"))).not.toBe(stale);
  });
});

describe("healCliSymlinks", () => {
  test("heals a dangling symlink that points into a plugin cache", () => {
    const cacheTarget = join(
      tmp,
      "home",
      ".claude",
      "plugins",
      "cache",
      "open-second-brain",
      "open-second-brain",
      "0.0.9",
      "scripts",
      "o2b",
    );
    symlinkSync(cacheTarget, join(tmp, "o2b")); // target does not exist (dangling)
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.some(([n, m]) => n === "o2b" && m.startsWith("healed:"))).toBe(true);
    expect(existsSync(realpathSync(join(tmp, "o2b")))).toBe(true);
  });

  test("leaves a dangling symlink that is not under a plugin cache alone", () => {
    // Could be a broken stable-dir install; automatic repair must not hijack it.
    symlinkSync(join(tmp, "gone", "scripts", "o2b"), join(tmp, "o2b"));
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.length).toBe(0);
    expect(lstatSync(join(tmp, "o2b")).isSymbolicLink()).toBe(true);
  });

  test("heals an OSB symlink that lives inside a plugin cache", () => {
    const cacheRoot = join(
      tmp,
      "home",
      ".claude",
      "plugins",
      "cache",
      "open-second-brain",
      "open-second-brain",
      "0.1.0",
    );
    const stale = fakeOsbScript(cacheRoot, "o2b");
    symlinkSync(stale, join(tmp, "o2b"));
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.some(([n, m]) => n === "o2b" && m.startsWith("healed:"))).toBe(true);
    expect(readlinkSync(join(tmp, "o2b"))).not.toBe(stale);
  });

  test("leaves a stable-directory install alone (not under a plugin cache)", () => {
    const stableTarget = fakeOsbScript(join(tmp, "srv", "open-second-brain"), "o2b");
    symlinkSync(stableTarget, join(tmp, "o2b"));
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.length).toBe(0);
    expect(readlinkSync(join(tmp, "o2b"))).toBe(stableTarget);
  });

  test("leaves a foreign symlink alone", () => {
    const foreign = join(tmp, "foreign.sh");
    writeFileSync(foreign, "#!/bin/sh\n");
    symlinkSync(foreign, join(tmp, "o2b"));
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.length).toBe(0);
    expect(readlinkSync(join(tmp, "o2b"))).toBe(foreign);
  });

  test("never touches a real (non-symlink) file", () => {
    const real = join(tmp, "o2b");
    writeFileSync(real, "i am not a symlink\n");
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.length).toBe(0);
    expect(lstatSync(real).isSymbolicLink()).toBe(false);
  });

  test("is a no-op when links are already current", () => {
    installCli(tmp);
    const r = healCliSymlinks(tmp);
    expect(r.outcomes.length).toBe(0);
  });
});
