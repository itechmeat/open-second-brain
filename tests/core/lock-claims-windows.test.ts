/**
 * The claim-file locks (the automatic upgrade's worker lock, the store
 * migration's worker lock, the search freshen claim) on Windows: an
 * exclusive create of a claim another process is releasing is refused
 * with EPERM rather than EEXIST. That is a claim someone holds, answered
 * the way an existing claim is, never a crash or an "unwritable" state.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimSelfHealUpgradeLock,
  ownsSelfHealUpgradeLock,
  selfHealUpgradeLockPath,
} from "../../src/core/maintenance/self-heal-upgrade-state.ts";
import {
  FRESHEN_CLAIM_FILE,
  FRESHEN_SKIP,
  tryClaimFreshen,
} from "../../src/core/search/freshen.ts";
import {
  autoMigrationLockPath,
  claimAutoMigrationLock,
} from "../../src/core/store-migration/auto-state.ts";
import { windowsRefusal } from "../helpers/windows-lock-refusal.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-lock-claims-"));
});
afterEach(() => {
  mock.restore();
  rmSync(vault, { recursive: true, force: true });
});

/**
 * Refuse every exclusive create of `path` the way Windows does while its
 * holder releases it. The claim is created by an exclusive `open`, so that
 * is the create the refusal stands for; every other open goes through.
 */
function refuseExclusiveCreate(path: string): () => number {
  const real = fs.openSync;
  let calls = 0;
  spyOn(fs, "openSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file) === path) {
      calls += 1;
      // The holder's file is still there, delete-pending.
      fs.writeFileSync(`${path}`, "", { flag: "w" });
      throw windowsRefusal(path, "EPERM", "open");
    }
    return (real as (...args: unknown[]) => number)(file, ...rest);
  }) as typeof fs.openSync);
  return () => calls;
}

describe("a claim another process is releasing on Windows", () => {
  test("the automatic upgrade's worker lock reads as held, not as a crash", () => {
    const calls = refuseExclusiveCreate(selfHealUpgradeLockPath(vault));
    expect(claimSelfHealUpgradeLock(vault, new Date())).toBeNull();
    expect(calls()).toBeGreaterThan(0);
  });

  test("the store migration's worker lock reads as held, not as a crash", () => {
    const calls = refuseExclusiveCreate(autoMigrationLockPath(vault));
    expect(claimAutoMigrationLock(vault, new Date())).toBeNull();
    expect(calls()).toBeGreaterThan(0);
  });

  test("the freshen claim reads as claimed, not as unwritable", () => {
    const dir = join(vault, "index");
    fs.mkdirSync(dir, { recursive: true });
    refuseExclusiveCreate(join(dir, FRESHEN_CLAIM_FILE));
    expect(tryClaimFreshen(dir, Date.now())).toEqual({
      skip: FRESHEN_SKIP.claimed,
    });
  });
});

describe("a claim that is gone by the time it is judged", () => {
  test("the automatic upgrade's worker lock races the create again and removes nothing", () => {
    const path = selfHealUpgradeLockPath(vault);
    const realOpen = fs.openSync;
    let refused = false;
    spyOn(fs, "openSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file) === path && !refused) {
        // A holder's claim met the create, and is released before the judge reads it.
        refused = true;
        throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
          code: "EEXIST",
          path,
        });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);
    const realUnlink = fs.unlinkSync;
    let rival: string | null = null;
    spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      if (String(file) === path && rival === null) {
        // Another worker claims the free name right before this unlink.
        rival = claimSelfHealUpgradeLock(vault, new Date());
      }
      return realUnlink(file);
    }) as typeof fs.unlinkSync);
    const token = claimSelfHealUpgradeLock(vault, new Date());
    expect(token).not.toBeNull();
    expect(rival).toBeNull();
    expect(ownsSelfHealUpgradeLock(vault, token!)).toBe(true);
  });
});
