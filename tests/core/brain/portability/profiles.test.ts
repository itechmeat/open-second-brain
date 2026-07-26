/**
 * Named multi-vault profiles (Vault portability suite, Feature 4).
 *
 * A profile registry (name -> vault path) stored in a profiles.json
 * beside the config, with list / create / switch. Activation is a
 * pointer in that file (no symlinks). `resolveVault` consults the active
 * profile before the bare config `vault` key; with no profiles it is
 * unchanged (back-compat).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import {
  createProfile,
  listProfiles,
  switchProfile,
  resolveActiveProfileVault,
} from "../../../../src/core/brain/portability/profiles.ts";
import { resolveVault } from "../../../../src/core/config.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let home: string;
let configPath: string;
let previousVaultDir: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "o2b-profiles-"));
  configPath = join(home, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${join(home, "default-vault")}\n`);
  previousVaultDir = process.env["VAULT_DIR"];
  delete process.env["VAULT_DIR"];
});
afterEach(() => {
  if (previousVaultDir === undefined) delete process.env["VAULT_DIR"];
  else process.env["VAULT_DIR"] = previousVaultDir;
  rmSync(home, { recursive: true, force: true });
});

/** A real directory under the temp home, since create validates the target. */
function vaultDir(name: string): string {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("profile registry", () => {
  test("create + list", () => {
    createProfile(configPath, "work", vaultDir("work"));
    createProfile(configPath, "personal", vaultDir("personal"));
    const { profiles, active } = listProfiles(configPath);
    expect(profiles.map((p) => p.name).toSorted()).toEqual(["personal", "work"]);
    expect(active).toBeNull();
  });

  test("switch sets the active pointer", () => {
    const workVault = join(home, "work-vault");
    mkdirSync(workVault, { recursive: true });
    createProfile(configPath, "work", workVault);
    switchProfile(configPath, "work");
    expect(listProfiles(configPath).active).toBe("work");
    expect(resolveActiveProfileVault(configPath)).toBe(workVault);
  });

  test("switching to an unknown profile throws", () => {
    expect(() => switchProfile(configPath, "ghost")).toThrow();
  });

  test("switching to a profile whose vault stopped being a directory still fails at switch time", () => {
    // Unit J: activation used to succeed and fail in a LATER process,
    // where the first write would materialize the mis-resolved root. The
    // create-time check (Task 21) does not retire this one: a vault can be
    // removed or replaced between create and switch.
    const gone = vaultDir("removed-vault");
    createProfile(configPath, "ghost-vault", gone);
    rmSync(gone, { recursive: true, force: true });
    expect(() => switchProfile(configPath, "ghost-vault")).toThrow(/not a directory/);
    // The active pointer is unchanged, so nothing resolves to it.
    expect(listProfiles(configPath).active).toBeNull();

    const replaced = vaultDir("replaced-vault");
    createProfile(configPath, "file-vault", replaced);
    rmSync(replaced, { recursive: true, force: true });
    atomicWriteFileSync(replaced, "not a vault\n");
    expect(() => switchProfile(configPath, "file-vault")).toThrow(/not a directory/);
  });

  test("creating against a path that is not a directory is refused at create time", () => {
    // The same error shape switching already uses, one step earlier.
    expect(() => createProfile(configPath, "ghost", join(home, "does-not-exist"))).toThrow(
      /profile 'ghost' points at a path that is not a directory/,
    );
    const filePath = join(home, "a-file");
    atomicWriteFileSync(filePath, "not a vault\n");
    expect(() => createProfile(configPath, "file-vault", filePath)).toThrow(/not a directory/);
    // Neither attempt reached the registry.
    expect(listProfiles(configPath).profiles).toHaveLength(0);
  });

  test("creating over an existing name is refused and leaves the registry byte-identical", () => {
    createProfile(configPath, "work", vaultDir("work"));
    const registry = join(home, "profiles.json");
    const before = readFileSync(registry, "utf8");

    expect(() => createProfile(configPath, "work", vaultDir("other"))).toThrow(
      /profile 'work' already exists/,
    );
    // A trimmed name is the same name, and must not slip past the check.
    expect(() => createProfile(configPath, "  work  ", vaultDir("other"))).toThrow(
      /profile 'work' already exists/,
    );

    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(listProfiles(configPath).profiles.map((p) => p.vault)).toEqual([join(home, "work")]);
  });

  test("the mutation is serialized: a held registry lock refuses the create", () => {
    // Proves the lock is genuinely taken on the registry directory rather
    // than the read-modify-write being merely narrow.
    const release = lockfile.lockSync(dirname(configPath), { stale: 10_000, realpath: false });
    try {
      expect(() => createProfile(configPath, "work", vaultDir("work"))).toThrow(/ELOCKED|lock/i);
    } finally {
      release();
    }
    // Once released, the same create succeeds.
    createProfile(configPath, "work", vaultDir("work"));
    expect(listProfiles(configPath).profiles.map((p) => p.name)).toEqual(["work"]);
  });

  test("two concurrent creates both land", async () => {
    // Two OS processes, both started before either is awaited - no sleep,
    // no staggering. A lock-free read-modify-write loses one of them.
    const script = join(home, "create-profile.ts");
    const module = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "src",
      "core",
      "brain",
      "portability",
      "profiles.ts",
    );
    writeFileSync(
      script,
      [
        `import { createProfile } from ${JSON.stringify(module)};`,
        `createProfile(process.argv[2]!, process.argv[3]!, process.argv[4]!);`,
      ].join("\n") + "\n",
      "utf8",
    );

    const spawn = (name: string) =>
      Bun.spawn(["bun", "run", script, configPath, name, vaultDir(name)], {
        stdout: "pipe",
        stderr: "pipe",
      });
    const alpha = spawn("alpha");
    const beta = spawn("beta");
    const [alphaCode, betaCode] = await Promise.all([alpha.exited, beta.exited]);

    expect([alphaCode, betaCode]).toEqual([0, 0]);
    expect(listProfiles(configPath).profiles.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  test("resolveActiveProfileVault is null with no active profile", () => {
    expect(resolveActiveProfileVault(configPath)).toBeNull();
  });

  test("a malformed registry never clobbers stored profiles on a mutating call", () => {
    const registry = join(home, "profiles.json");
    atomicWriteFileSync(registry, "{ this is not valid json");
    // Read-only callers tolerate the malformed file (treat as empty)...
    expect(listProfiles(configPath).profiles).toHaveLength(0);
    expect(resolveActiveProfileVault(configPath)).toBeNull();
    // ...but a mutating call fails fast instead of saving over it.
    expect(() => createProfile(configPath, "work", vaultDir("work"))).toThrow(/malformed/);
    expect(() => switchProfile(configPath, "work")).toThrow(/malformed/);
    // The original bytes are left untouched.
    expect(readFileSync(registry, "utf8")).toBe("{ this is not valid json");
  });
});

describe("resolveVault integration", () => {
  test("returns the active profile's vault when one is active", () => {
    const workVault = join(home, "work-vault");
    mkdirSync(workVault, { recursive: true });
    createProfile(configPath, "work", workVault);
    switchProfile(configPath, "work");
    expect(resolveVault(configPath)).toBe(workVault);
  });

  test("falls back to the config vault when no profile is active (back-compat)", () => {
    expect(resolveVault(configPath)).toBe(join(home, "default-vault"));
  });
});
