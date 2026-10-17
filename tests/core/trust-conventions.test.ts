/**
 * Fixture contract for Open Second Brain's guarded host writes
 * (t_b6bcd984 + t_f4555087).
 *
 * Three agreements are pinned here so the guarded write lanes (install
 * JSON-merge, protect, doctor repair) and the standalone PreToolUse
 * host-backup hook cannot drift apart:
 *
 * 1. the consent vocabulary every guarded lane records:
 *    `confirmed | refused | headless-refused`;
 * 2. the receipt-line schema: actor, pid, before-hash, summary plus a
 *    per-lane tail (consent verdict, backup path, ...);
 * 3. the timestamped backup layout: a sibling `.o2b-backups` root
 *    holding one folder per target file, each backup a stamp-named FILE
 *    inside it, stamp in UTC compact `YYYY-MM-DD-HHMMSS` form.
 *
 * The conventions live in src/core/trust.ts so the CLI lanes import
 * them directly. The hook wrapper imports no src/core behavior - only
 * the two directory-name constants from the path-constants leaf - and
 * re-states the receipt shape; its compliance is pinned by its own
 * fixture test (tests/hooks/pretool-host-backup.test.ts), not by an
 * import.
 */

import { describe, expect, test } from "bun:test";
import { sep } from "node:path";

import { compactRunStamp } from "../../src/core/brain/time.ts";
import {
  BACKUP_DIR_NAME,
  backupFolderStamp,
  backupRootFor,
  CONSENT_VERDICTS,
  type ConsentVerdict,
  formatTrustReceiptLine,
  type TrustReceipt,
} from "../../src/core/trust.ts";

const HEAD_FIELDS = ["actor", "pid", "before_hash", "summary"] as const;

describe("trust conventions", () => {
  test("consent vocabulary is exactly confirmed | refused | headless-refused", () => {
    expect([...CONSENT_VERDICTS]).toEqual(["confirmed", "refused", "headless-refused"]);
    // Every verdict is a valid ConsentVerdict and the type has no extras.
    const drawn: readonly ConsentVerdict[] = ["confirmed", "refused", "headless-refused"];
    for (const v of drawn) expect(CONSENT_VERDICTS).toContain(v);
  });

  test("receipt line carries actor, pid, before-hash, summary, then the lane tail", () => {
    const receipt: TrustReceipt = {
      actor: "hook:claudecode",
      pid: 4242,
      before_hash: `sha256:${"a".repeat(64)}`,
      summary: "backed up settings.json before a Write",
    };
    const parsed = JSON.parse(
      formatTrustReceiptLine(receipt, { consent: "confirmed", backup: "/b/2026-10-16-120000" }),
    );
    for (const field of HEAD_FIELDS) expect(parsed).toHaveProperty(field);
    // The head is FIRST, not merely present: the receipt head keys lead
    // the line and the lane tail follows.
    expect(Object.keys(parsed).slice(0, 4)).toEqual([...HEAD_FIELDS]);
    expect(parsed.actor).toBe("hook:claudecode");
    expect(parsed.pid).toBe(4242);
    expect(parsed.before_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.summary).toBe("backed up settings.json before a Write");
    expect(parsed.consent).toBe("confirmed");
    expect(parsed.backup).toBe("/b/2026-10-16-120000");
  });

  test("the lane tail cannot clobber the fixed receipt head", () => {
    const receipt: TrustReceipt = {
      actor: "cli",
      pid: 7,
      before_hash: `sha256:${"b".repeat(64)}`,
      summary: "s",
    };
    const parsed = JSON.parse(formatTrustReceiptLine(receipt, { actor: "spoofed" }));
    expect(parsed.actor).toBe("cli");
    // The clobbered tail key is gone, not merely overridden: the head
    // names its own fields and the tail carries only the rest.
    expect(Object.keys(parsed)).toEqual([...HEAD_FIELDS]);
  });

  test("backup layout: one folder per target under .o2b-backups, each backup a UTC-stamp file", () => {
    const stamp = backupFolderStamp(new Date("2026-10-16T12:34:56Z"));
    expect(stamp).toBe("2026-10-16-123456");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
    // Same minting rule as every other run stamp in the repo.
    expect(backupFolderStamp(new Date("2020-01-02T03:04:05Z"))).toBe(
      compactRunStamp(new Date("2020-01-02T03:04:05Z")),
    );
    expect(BACKUP_DIR_NAME).toBe(".o2b-backups");
    // backupRootFor joins with the platform separator, so the win32
    // spelling of the same layout is backslashes: compare after folding
    // separators, not with a POSIX literal.
    expect(backupRootFor("/home/u/.claude/settings.json").split(sep).join("/")).toBe(
      "/home/u/.claude/.o2b-backups/settings.json",
    );
    // The root sits beside the target, never inside the target file.
    expect(backupRootFor("/x/settings.local.json").split(sep).join("/")).toBe(
      "/x/.o2b-backups/settings.local.json",
    );
  });
});
