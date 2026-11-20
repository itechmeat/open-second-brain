/**
 * File identity as `bigint` (`src/core/fs-identity.ts`). NTFS file ids are
 * 64-bit and routinely exceed 2^53, where a JavaScript number no longer
 * holds every integer: two ids that differ only in their low bits read as
 * one number. The helpers compare the exact values, so two such files are
 * never judged the same. Constructed stats: no NTFS volume is needed.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  identityOfStats,
  pathIdentity,
  sameDevIno,
  sameIdentity,
} from "../../src/core/fs-identity.ts";

/** Two NTFS-like ids one apart: sequence number 43 above a 48-bit record number. */
const BASE = (0x2bn << 48n) | 0x1_2345_6788n;
const A = { dev: 3_088_675_331n, ino: BASE };
const B = { dev: 3_088_675_331n, ino: BASE + 1n };

describe("ids above 2^53", () => {
  test("read as one number, and as two identities", () => {
    expect(BASE > 2n ** 53n).toBe(true);
    // The defect: the default Stats numbers of two different files compare equal.
    expect(Number(A.ino) === Number(B.ino)).toBe(true);

    expect(sameIdentity(identityOfStats(A), identityOfStats(B))).toBe(false);
    expect(sameDevIno(A, B)).toBe(false);
    expect(sameIdentity(identityOfStats(A), identityOfStats({ ...A }))).toBe(true);
    expect(sameDevIno(A, { ...A })).toBe(true);
  });

  test("the same inode on another device is another file", () => {
    expect(sameIdentity(identityOfStats(A), identityOfStats({ ...A, dev: A.dev + 1n }))).toBe(
      false,
    );
  });
});

describe("a filesystem that reports no inode", () => {
  test("has no identity, and two such files are never the same", () => {
    const none = { dev: 1n, ino: 0n };
    expect(identityOfStats(none)).toBeNull();
    expect(sameIdentity(identityOfStats(none), identityOfStats({ ...none }))).toBe(false);
    // A version check still matches a file against its own stats.
    expect(sameDevIno(none, { ...none })).toBe(true);
  });
});

describe("pathIdentity on this host", () => {
  test("names a file, follows or not, and answers null for a missing one", () => {
    const root = mkdtempSync(join(tmpdir(), "o2b-fs-identity-"));
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      writeFileSync(a, "a");
      mkdirSync(b);
      expect(sameIdentity(pathIdentity(a), pathIdentity(a))).toBe(true);
      expect(sameIdentity(pathIdentity(a), pathIdentity(b))).toBe(false);
      expect(sameIdentity(pathIdentity(a, { follow: false }), pathIdentity(a))).toBe(true);
      expect(pathIdentity(join(root, "missing"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
