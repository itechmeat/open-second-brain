/**
 * The durable raw-source archive store (answer trust, Task C2).
 *
 * Four invariants are pinned here because each one is a way the store could
 * silently stop being evidence: the address names the bytes on disk (dedup
 * is that address applied twice); a credential in a captured source never
 * reaches a second file (redaction runs BEFORE persist, and the digest is
 * the redacted bytes'); a past-ceiling input is refused whole, never stored
 * half; and a verification distinguishes "gone" from "disagrees".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_VERIFICATION,
  SOURCE_ARCHIVE_BYTES_KEY,
  SOURCE_ARCHIVE_HASH_KEY,
  discardSourceArchive,
  isArchiveVerification,
  putSourceArchive,
  readSourceArchiveEntry,
  sourceArchiveCitingPages,
  sourceArchivePath,
  sourceArchiveStats,
  sourceArchivesDir,
  verifySourceArchive,
} from "../../../../src/core/brain/provenance/source-archive.ts";
import { admitToIndex } from "../../../../src/core/vault-scope/index-admission.ts";
import { REDACTION_PLACEHOLDER, redactRawOutput } from "../../../../src/core/redactor.ts";
import { createHash } from "node:crypto";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-source-archive-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("putSourceArchive", () => {
  test("persists the bytes at their digest under Brain/.archives/<sha256>.txt", () => {
    const put = putSourceArchive(vault, "the source bytes\n");

    expect(put.hash).toBe(sha256("the source bytes\n"));
    expect(put.bytes).toBe(Buffer.byteLength("the source bytes\n", "utf8"));
    const entry = join(vault, "Brain", ".archives", `${put.hash}.txt`);
    expect(existsSync(entry)).toBe(true);
    expect(readFileSync(entry, "utf8")).toBe("the source bytes\n");
  });

  test("identical bytes persist once - the content address is the dedup", () => {
    const first = putSourceArchive(vault, "same bytes");
    const second = putSourceArchive(vault, "same bytes");

    expect(second.hash).toBe(first.hash);
    const store = join(vault, "Brain", ".archives");
    expect(readdirSync(store)).toEqual([`${first.hash}.txt`]);
  });

  test("a re-ingest of an intact entry leaves it untouched - no mtime churn", () => {
    const first = putSourceArchive(vault, "stable bytes");
    const entry = join(vault, "Brain", ".archives", `${first.hash}.txt`);
    const before = statSync(entry).mtimeMs;

    putSourceArchive(vault, "stable bytes");

    expect(statSync(entry).mtimeMs).toBe(before);
  });

  test("a re-ingest repairs an entry corrupted on disk", () => {
    // The natural repair of the `mismatched` state the hygiene scan
    // reports: the same source lands the same address, re-verifies the
    // entry it finds there, and rewrites it when the bytes disagree.
    const first = putSourceArchive(vault, "original");
    const entry = join(vault, "Brain", ".archives", `${first.hash}.txt`);
    writeFileSync(entry, "tampered after the stamp", "utf8");
    expect(verifySourceArchive(vault, first.hash).state).toBe(ARCHIVE_VERIFICATION.mismatched);

    const second = putSourceArchive(vault, "original");

    expect(second.hash).toBe(first.hash);
    expect(verifySourceArchive(vault, first.hash).state).toBe(ARCHIVE_VERIFICATION.verified);
    expect(readFileSync(entry, "utf8")).toBe("original");
  });

  test("a credential-shaped input never lands on disk unredacted", () => {
    // The redaction must run BEFORE persist, and the entry's address must
    // be the digest of the REDACTED bytes - an address over the raw input
    // would name a file that does not exist and break re-verification.
    const input = "deploy notes\napi_key: ZXhwb3J0ZWQta2V5LTEyMzQ1\ntrailing prose\n";
    const put = putSourceArchive(vault, input);
    const stored = readFileSync(join(vault, "Brain", ".archives", `${put.hash}.txt`), "utf8");

    expect(stored).not.toContain("ZXhwb3J0ZWQta2V5LTEyMzQ1");
    expect(stored).toContain(REDACTION_PLACEHOLDER);
    expect(put.hash).toBe(sha256(redactRawOutput(input)));
  });

  test("a past-ceiling input raises the named error and never a truncated write", () => {
    const oversized = "a".repeat(ARCHIVE_MAX_BYTES + 1);

    let thrown: unknown;
    try {
      putSourceArchive(vault, oversized);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error)?.name).toBe("SourceArchiveError");
    expect((thrown as Error).message).toContain(`${ARCHIVE_MAX_BYTES}-byte ceiling`);
    // Refuse-not-truncate: nothing was written at all, neither a truncated
    // entry nor a partial one.
    expect(existsSync(sourceArchivesDir(vault))).toBe(false);
  });

  test("an input exactly at the ceiling is archived whole", () => {
    const atCeiling = "b".repeat(ARCHIVE_MAX_BYTES);
    const put = putSourceArchive(vault, atCeiling);
    expect(put.bytes).toBe(ARCHIVE_MAX_BYTES);
    expect(verifySourceArchive(vault, put.hash).state).toBe(ARCHIVE_VERIFICATION.verified);
  });
});

describe("verifySourceArchive and readSourceArchiveEntry", () => {
  test("an intact entry verifies", () => {
    const put = putSourceArchive(vault, "intact");
    expect(verifySourceArchive(vault, put.hash)).toEqual({
      state: ARCHIVE_VERIFICATION.verified,
      hash: put.hash,
    });
  });

  test("a tampered entry re-hashes differently - mismatched, not missing", () => {
    const put = putSourceArchive(vault, "original");
    writeFileSync(join(vault, "Brain", ".archives", `${put.hash}.txt`), "tampered", "utf8");
    expect(verifySourceArchive(vault, put.hash).state).toBe(ARCHIVE_VERIFICATION.mismatched);
  });

  test("an absent entry is missing, and a malformed stamp is missing too", () => {
    putSourceArchive(vault, "present");
    expect(verifySourceArchive(vault, sha256("absent")).state).toBe(ARCHIVE_VERIFICATION.missing);
    // A stamp that is not a hash names no entry the store could hold.
    expect(verifySourceArchive(vault, "not-a-hash").state).toBe(ARCHIVE_VERIFICATION.missing);
  });

  test("reading an entry returns its text and byte count; absent is null", () => {
    const put = putSourceArchive(vault, "read me");
    expect(readSourceArchiveEntry(vault, put.hash)).toEqual({
      state: ARCHIVE_VERIFICATION.verified,
      hash: put.hash,
      bytes: Buffer.byteLength("read me", "utf8"),
      text: "read me",
    });
    expect(readSourceArchiveEntry(vault, sha256("nope"))).toBeNull();
  });

  test("a caller-supplied hash cannot traverse out of the store", () => {
    for (const hostile of ["../secrets.txt", "../../etc/passwd", "A".repeat(64), "ab".repeat(31)]) {
      let thrown: unknown;
      try {
        sourceArchivePath(vault, hostile);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error)?.name).toBe("SourceArchiveError");
    }
  });
});

describe("sourceArchiveStats", () => {
  test("a vault that never captured reports an empty store, not an error", () => {
    expect(sourceArchiveStats(vault)).toEqual({ entries: 0, totalBytes: 0 });
  });

  test("counts entries and their combined bytes, and nothing it does not recognize", () => {
    const a = putSourceArchive(vault, "alpha");
    const b = putSourceArchive(vault, "beta");
    // A stray file is not an entry: the store counts what its grammar names.
    writeFileSync(join(vault, "Brain", ".archives", "notes.txt"), "stray", "utf8");

    const stats = sourceArchiveStats(vault);
    expect(stats.entries).toBe(2);
    expect(stats.totalBytes).toBe(a.bytes + b.bytes);
  });
});

describe("discardSourceArchive", () => {
  test("removes the entry and says so; an absent entry was not removed", () => {
    const put = putSourceArchive(vault, "ephemeral");
    expect(discardSourceArchive(vault, put.hash)).toBe(true);
    expect(verifySourceArchive(vault, put.hash).state).toBe(ARCHIVE_VERIFICATION.missing);
    expect(discardSourceArchive(vault, put.hash)).toBe(false);
  });
});

describe("sourceArchiveCitingPages", () => {
  test("lists exactly the summary pages stamping the digest, sorted", () => {
    const put = putSourceArchive(vault, "cited bytes");
    const sources = join(vault, "Brain", "sources");
    mkdirSync(sources, { recursive: true });
    const stamped = (name: string, hash: string | null): void => {
      const hashLines =
        hash === null
          ? []
          : [`${SOURCE_ARCHIVE_HASH_KEY}: ${hash}`, `${SOURCE_ARCHIVE_BYTES_KEY}: 11`];
      writeFileSync(
        join(sources, name),
        ["---", "kind: brain-source", ...hashLines, "---", "", "body", ""].join("\n"),
        "utf8",
      );
    };
    stamped("b-second.md", put.hash);
    stamped("a-first.md", put.hash);
    stamped("c-other.md", sha256("another source"));
    stamped("d-unstamped.md", null);

    expect(sourceArchiveCitingPages(vault, put.hash)).toEqual([
      "Brain/sources/a-first.md",
      "Brain/sources/b-second.md",
    ]);
    expect(sourceArchiveCitingPages(vault, sha256("nothing cites this"))).toEqual([]);
  });
});

describe("the archive store is refused to the search index", () => {
  test("an entry path is excluded by name, a sibling lane is not", () => {
    expect(admitToIndex(`Brain/.archives/${"a".repeat(64)}.txt`)).toEqual({
      admit: false,
      reason: "source-archive-store",
    });
    expect(admitToIndex("Brain/archives-notes.md").admit).toBe(true);
  });
});

describe("the verification vocabulary", () => {
  test("the guard accepts exactly the three members", () => {
    expect(Object.values(ARCHIVE_VERIFICATION).toSorted()).toEqual([
      "mismatched",
      "missing",
      "verified",
    ]);
    for (const member of Object.values(ARCHIVE_VERIFICATION)) {
      expect(isArchiveVerification(member)).toBe(true);
    }
    expect(isArchiveVerification("intact")).toBe(false);
    expect(isArchiveVerification(42)).toBe(false);
  });
});
