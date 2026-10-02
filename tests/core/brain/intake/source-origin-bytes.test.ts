/**
 * One read of a source feeds both its digest and the bytes a check runs on.
 *
 * `classifySourceOrigin` hashed the source and discarded the bytes, so a
 * caller that needed the text had to read the file a second time - and could
 * check bytes that differ from the ones whose digest it records.
 * `readSourceOrigin` returns the bytes the digest was computed over.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashBytes, hashFile } from "../../../../src/core/brain/ingest/content-manifest.ts";
import {
  classifySourceOrigin,
  readSourceOrigin,
  SOURCE_HASH_MAX_BYTES,
  SourceTrustError,
} from "../../../../src/core/brain/intake/source-trust.ts";
import { INTAKE_TRUST } from "../../../../src/core/brain/trust/untrusted-provenance.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("readSourceOrigin", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "source-origin-bytes-"));
    writeFileSync(join(vault, "note.md"), "# Note\n\nBody ^p1\n");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("a vault file returns the trusted verdict, its digest and the hashed bytes", () => {
    const origin = readSourceOrigin(vault, "note.md");
    expect(origin.trust).toBe(INTAKE_TRUST.trusted);
    expect(origin.contentHash).toBe(hashFile(join(vault, "note.md")));
    expect(origin.bytes).toBeDefined();
    expect(sha256(origin.bytes ?? new Uint8Array())).toBe(origin.contentHash ?? "");
    expect(new TextDecoder().decode(origin.bytes)).toBe("# Note\n\nBody ^p1\n");
  });

  test("agrees with classifySourceOrigin on the verdict and the digest", () => {
    const origin = readSourceOrigin(vault, "note.md");
    expect(classifySourceOrigin(vault, "note.md")).toEqual({
      trust: origin.trust,
      contentHash: origin.contentHash,
    });
  });

  test("a URL and a missing file are untrusted with neither digest nor bytes", () => {
    for (const identity of ["https://x.test/a", "missing.md"]) {
      const origin = readSourceOrigin(vault, identity);
      expect(origin).toEqual({ trust: INTAKE_TRUST.untrusted });
      expect("bytes" in origin).toBe(false);
      expect("contentHash" in origin).toBe(false);
    }
  });

  test("a file past the ceiling is refused, as classifySourceOrigin refuses it", () => {
    const big = join(vault, "big.md");
    writeFileSync(big, "");
    truncateSync(big, SOURCE_HASH_MAX_BYTES + 1);
    expect(() => readSourceOrigin(vault, "big.md")).toThrow(SourceTrustError);
    expect(() => classifySourceOrigin(vault, "big.md")).toThrow(SourceTrustError);
  });
});

describe("readSourceOrigin - the one descriptor read", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "source-origin-fd-"));
    mkdirSync(join(vault, "Notes"));
    writeFileSync(join(vault, "Notes", "real.md"), "# Real\n\nBody.\n");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test.skipIf(IS_WINDOWS)("a symlink to a note inside the vault reads that note's bytes", () => {
    symlinkSync(join(vault, "Notes", "real.md"), join(vault, "Notes", "link.md"));
    const origin = readSourceOrigin(vault, "Notes/link.md");
    expect(origin.trust).toBe(INTAKE_TRUST.trusted);
    expect(origin.contentHash).toBe(hashFile(join(vault, "Notes", "real.md")));
  });

  test("an empty file is read as zero bytes with the digest of nothing", () => {
    writeFileSync(join(vault, "Notes", "empty.md"), "");
    const origin = readSourceOrigin(vault, "Notes/empty.md");
    expect(origin.trust).toBe(INTAKE_TRUST.trusted);
    expect(origin.bytes?.byteLength).toBe(0);
    expect(origin.contentHash).toBe(sha256(new Uint8Array()));
  });
});

describe("hashBytes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hash-bytes-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("equals hashFile for a file with a BOM and invalid UTF-8", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);
    const path = join(dir, "odd.md");
    writeFileSync(path, bytes);
    expect(hashBytes(bytes)).toBe(hashFile(path));
    expect(hashBytes(bytes)).toBe(sha256(bytes));
  });
});
