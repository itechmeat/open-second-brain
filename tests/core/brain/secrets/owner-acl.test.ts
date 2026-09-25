/**
 * The Windows stand-in for the secrets keyfile's 0600 / 0700 modes.
 *
 * The argv and principal are pure and pinned on every host; the ACL a
 * real `icacls` leaves behind is asserted on Windows only, by reading it
 * back with `icacls` itself.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentWindowsIdentity,
  ownerOnlyAclArgv,
  parseWhoamiUser,
  restrictToOwner,
  system32Tool,
} from "../../../../src/core/brain/secrets/owner-acl.ts";
import { loadOrCreateKey } from "../../../../src/core/brain/secrets/crypto.ts";
import { secretsDir, setSecret } from "../../../../src/core/brain/secrets/store.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

describe("ownerOnlyAclArgv", () => {
  test("a file: inheritance removed, one full-control grant, by SID", () => {
    expect(ownerOnlyAclArgv("C:\\v\\keyfile", SID, "file")).toEqual([
      "C:\\v\\keyfile",
      "/inheritance:r",
      "/grant:r",
      `*${SID}:F`,
    ]);
  });

  test("a directory: the grant is inheritable by what is created in it", () => {
    expect(ownerOnlyAclArgv("C:\\v\\secrets", SID, "directory")).toEqual([
      "C:\\v\\secrets",
      "/inheritance:r",
      "/grant:r",
      `*${SID}:(OI)(CI)F`,
    ]);
  });
});

describe("parseWhoamiUser", () => {
  test("reads the account name and SID from whoami's CSV line", () => {
    expect(parseWhoamiUser(`"host\\me","${SID}"\r\n`)).toEqual({ name: "host\\me", sid: SID });
    expect(parseWhoamiUser(`"azuread\\first last","S-1-12-1-1-2-3-4"\r\n`)).toEqual({
      name: "azuread\\first last",
      sid: "S-1-12-1-1-2-3-4",
    });
  });

  test("anything else is no identity, not a guess", () => {
    expect(parseWhoamiUser("")).toBeNull();
    expect(parseWhoamiUser("ERROR: Access is denied.\r\n")).toBeNull();
    expect(parseWhoamiUser(`"host\\me","not-a-sid"`)).toBeNull();
  });
});

describe("system32Tool", () => {
  test("an absolute System32 path, never a bare name cmd would look up in the cwd", () => {
    expect(system32Tool("icacls.exe", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\icacls.exe",
    );
    expect(system32Tool("icacls.exe", { windir: "E:\\W" })).toBe("E:\\W\\System32\\icacls.exe");
    expect(system32Tool("icacls.exe", { SystemRoot: "" })).toBe(
      "C:\\Windows\\System32\\icacls.exe",
    );
  });
});

describe("restrictToOwner off Windows", () => {
  test("is a no-op that reports success: the POSIX mode already did it", () => {
    expect(restrictToOwner("/nonexistent/keyfile", "file", "linux")).toBe(true);
  });
});

/**
 * The ACEs `icacls <path>` lists. The first line carries the path before
 * its first entry; the list ends at the first blank line, ahead of the
 * localised "Successfully processed" summary.
 */
function aclEntries(path: string): ReadonlyArray<string> {
  const proc = spawnSync(system32Tool("icacls.exe"), [path], {
    encoding: "utf8",
    windowsHide: true,
  });
  expect(proc.status).toBe(0);
  const entries: string[] = [];
  for (const [i, line] of proc.stdout.split(/\r?\n/).entries()) {
    if (line.trim() === "") break;
    entries.push((i === 0 ? line.slice(path.length) : line).trim());
  }
  return entries;
}

/** Account names compare case-insensitively on Windows. */
function lower(xs: ReadonlyArray<string>): ReadonlyArray<string> {
  return xs.map((x) => x.toLowerCase());
}

/**
 * The machine's own administrative principals. `restrictToOwner` resets
 * the ACL before restricting it, but on GitHub's Windows runners, where
 * the suite runs as an elevated administrator, SYSTEM and Administrators
 * entries have been seen on the key directory. Both can read the key
 * whatever its ACL says (the threat model in `crypto.ts` already counts
 * them), so the assertions below allow them and nobody else.
 */
const MACHINE_ADMINS: ReadonlySet<string> = new Set([
  "nt authority\\system",
  "builtin\\administrators",
]);

/** The entries left once the machine's administrative principals are set aside. */
function withoutMachineAdmins(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  return lower(entries).filter((e) => !MACHINE_ADMINS.has(e.slice(0, e.indexOf(":"))));
}

describe.skipIf(!IS_WINDOWS)("the secrets keyfile ACL on Windows", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-secrets-acl-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("the keyfile, its directory and the store grant the current user alone", () => {
    setSecret(vault, {
      name: "embed-key",
      value: "sk-super-secret-value",
      agent: "tester",
      now: new Date("2026-06-05T10:00:00Z"),
    });
    const identity = currentWindowsIdentity();
    expect(identity).not.toBeNull();
    const principal = identity!.name.toLowerCase();
    const dir = secretsDir(vault);

    // Explicit, not inherited: no `(I)` and, beyond the machine's own
    // administrators, nothing but the one grant.
    const keyfile = aclEntries(join(dir, "keyfile"));
    const directory = aclEntries(dir);
    expect(lower([...keyfile, ...directory]).filter((e) => e.includes("(i)"))).toEqual([]);
    expect(withoutMachineAdmins(keyfile)).toEqual([`${principal}:(f)`]);
    expect(withoutMachineAdmins(directory)).toEqual([`${principal}:(oi)(ci)(f)`]);
    // The store is not touched directly; it inherits the directory's entries.
    const store = aclEntries(join(dir, "secrets.json"));
    expect(lower(store).filter((e) => !e.includes("(i)"))).toEqual([]);
    expect(withoutMachineAdmins(store)).toEqual([`${principal}:(i)(f)`]);
  });

  test("a secrets directory that arrived with a copied vault is restricted on load", () => {
    // Made by hand, the way a restore or a copy leaves it: an ACL of its
    // own that also lets Everyone (S-1-1-0) read the key and the store.
    // (Granted explicitly: on an elevated runner a new file inherits
    // nothing, so "inherited entries" is not a portable fixture.)
    const dir = secretsDir(vault);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keyfile"), Buffer.alloc(32, 7));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ version: 1, secrets: {} }));
    const icacls = system32Tool("icacls.exe");
    for (const [p, rights] of [
      [dir, "(OI)(CI)R"],
      [join(dir, "keyfile"), "R"],
      [join(dir, "secrets.json"), "R"],
    ] as const) {
      expect(spawnSync(icacls, [p, "/grant", `*S-1-1-0:${rights}`]).status).toBe(0);
    }
    const principal = currentWindowsIdentity()!.name.toLowerCase();
    const others = (p: string) =>
      withoutMachineAdmins(aclEntries(p)).filter((e) => !e.startsWith(`${principal}:`));
    expect(others(join(dir, "keyfile")).length).toBeGreaterThan(0);

    loadOrCreateKey(join(dir, "keyfile"));
    setSecret(vault, {
      name: "later",
      value: "v",
      agent: "tester",
      now: new Date("2026-06-05T10:00:00Z"),
    });

    expect(withoutMachineAdmins(aclEntries(join(dir, "keyfile")))).toEqual([`${principal}:(f)`]);
    expect(withoutMachineAdmins(aclEntries(dir))).toEqual([`${principal}:(oi)(ci)(f)`]);
    expect(others(join(dir, "secrets.json"))).toEqual([]);
  });

  test("a failed icacls warns and leaves the caller running", () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(restrictToOwner(join(vault, "missing", "keyfile"), "file")).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("warning: could not restrict secrets file");
  });
});
