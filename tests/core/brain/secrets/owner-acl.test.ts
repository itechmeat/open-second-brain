/**
 * The Windows stand-in for the secrets keyfile's 0600 / 0700 modes.
 *
 * The argv and principal are pure and pinned on every host; the ACL a
 * real `icacls` leaves behind is asserted on Windows only, by reading it
 * back with `icacls` itself.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ownerOnlyAclArgv,
  restrictToOwner,
  windowsAclPrincipal,
} from "../../../../src/core/brain/secrets/owner-acl.ts";
import { secretsDir, setSecret } from "../../../../src/core/brain/secrets/store.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

describe("ownerOnlyAclArgv", () => {
  test("a file: inheritance removed, one full-control grant", () => {
    expect(ownerOnlyAclArgv("C:\\v\\keyfile", "HOST\\me", "file")).toEqual([
      "C:\\v\\keyfile",
      "/inheritance:r",
      "/grant:r",
      "HOST\\me:F",
    ]);
  });

  test("a directory: the grant is inheritable by what is created in it", () => {
    expect(ownerOnlyAclArgv("C:\\v\\secrets", "HOST\\me", "directory")).toEqual([
      "C:\\v\\secrets",
      "/inheritance:r",
      "/grant:r",
      "HOST\\me:(OI)(CI)F",
    ]);
  });
});

describe("windowsAclPrincipal", () => {
  test("qualifies the user with the logon domain when one is set", () => {
    expect(windowsAclPrincipal({ USERDOMAIN: "HOST" }, "me")).toBe("HOST\\me");
  });

  test("falls back to the bare user name without a domain", () => {
    expect(windowsAclPrincipal({}, "me")).toBe("me");
    expect(windowsAclPrincipal({ USERDOMAIN: "  " }, "me")).toBe("me");
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
  const proc = spawnSync("icacls.exe", [path], { encoding: "utf8", windowsHide: true });
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
    const principal = windowsAclPrincipal().toLowerCase();
    const dir = secretsDir(vault);

    // Explicit, not inherited: no `(I)` and nothing but the one grant.
    expect(lower(aclEntries(join(dir, "keyfile")))).toEqual([`${principal}:(f)`]);
    expect(lower(aclEntries(dir))).toEqual([`${principal}:(oi)(ci)(f)`]);
    // The store is not touched directly; it inherits the directory's entry.
    expect(lower(aclEntries(join(dir, "secrets.json")))).toEqual([`${principal}:(i)(f)`]);
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
