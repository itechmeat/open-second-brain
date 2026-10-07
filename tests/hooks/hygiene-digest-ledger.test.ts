/**
 * Unit tests for the hygiene digest hash ledger
 * (context-injection-pipeline, lane B, task B2).
 *
 * The ledger is one overwrite-only file,
 * `<vault>/.open-second-brain/hygiene-digest.hash`, holding the hash of
 * the digest state the Stop hook last emitted. Every read is fail-soft:
 * missing, unreadable, non-regular and corrupt files all read as
 * `null`, which compares as "changed" so the next eligible turn emits
 * again rather than staying silent forever.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HYGIENE_DIGEST_HASH_FILENAME,
  computeHygieneDigestHash,
  hygieneDigestHashMatches,
  hygieneDigestHashPath,
  readHygieneDigestHash,
  writeHygieneDigestHash,
} from "../../hooks/lib/hygiene-digest-state.ts";
import { sha256Hex } from "../../src/core/integrity/digest.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import type { HygieneFinding } from "../../src/core/brain/hygiene/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-ledger-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

let seq = 0;

function finding(detector: HygieneFinding["detector"], id: string): HygieneFinding {
  seq += 1;
  return {
    id,
    detector,
    severity: "warning",
    title: `fixture finding ${seq}`,
    targets: [`target-${seq}`],
    proposed_action: "review",
    evidence: {},
  };
}

const HASH_RE = /^[0-9a-f]{64}$/;

describe("readHygieneDigestHash", () => {
  test("a missing file reads as null", () => {
    expect(readHygieneDigestHash(vault)).toBeNull();
  });

  test("a corrupt file reads as null", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const path = hygieneDigestHashPath(vault);
    for (const body of ["", "not-a-hash", "0".repeat(63), "0".repeat(65), "Z".repeat(64)]) {
      writeFileSync(path, body, "utf8");
      expect(readHygieneDigestHash(vault)).toBeNull();
    }
  });

  test("a directory in the file's place reads as null", () => {
    mkdirSync(join(vault, ".open-second-brain", HYGIENE_DIGEST_HASH_FILENAME), {
      recursive: true,
    });
    expect(readHygieneDigestHash(vault)).toBeNull();
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an unreadable file reads as null", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const path = hygieneDigestHashPath(vault);
    writeFileSync(path, `${sha256Hex("state")}\n`, "utf8");
    chmodSync(path, 0o000);
    try {
      expect(readHygieneDigestHash(vault)).toBeNull();
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

describe("hygieneDigestHashMatches", () => {
  test("a written hash compares equal, a changed one unequal", () => {
    expect(writeHygieneDigestHash(vault, sha256Hex("state-a"))).toBe(true);
    expect(hygieneDigestHashMatches(vault, sha256Hex("state-a"))).toBe(true);
    expect(hygieneDigestHashMatches(vault, sha256Hex("state-b"))).toBe(false);
  });

  test("a missing or corrupt ledger compares unequal", () => {
    expect(hygieneDigestHashMatches(vault, sha256Hex("state-a"))).toBe(false);
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(hygieneDigestHashPath(vault), "garbage", "utf8");
    expect(hygieneDigestHashMatches(vault, sha256Hex("state-a"))).toBe(false);
  });
});

describe("writeHygieneDigestHash", () => {
  test("a write-then-read roundtrip returns the written hash", () => {
    const hash = sha256Hex("roundtrip");
    expect(writeHygieneDigestHash(vault, hash)).toBe(true);
    expect(readHygieneDigestHash(vault)).toBe(hash);
  });

  test("the write replaces the file in place: no growth, no siblings", () => {
    const dir = join(vault, ".open-second-brain");
    mkdirSync(dir, { recursive: true });
    const first = sha256Hex("first");
    const second = sha256Hex("second");
    expect(writeHygieneDigestHash(vault, first)).toBe(true);
    expect(writeHygieneDigestHash(vault, second)).toBe(true);
    expect(readHygieneDigestHash(vault)).toBe(second);
    const names = readdirSync(dir).toSorted();
    expect(names).toEqual([HYGIENE_DIGEST_HASH_FILENAME]);
  });
});

describe("computeHygieneDigestHash", () => {
  test("is deterministic and order-insensitive over the finding ids", () => {
    const findings = [
      finding("conflicts", "conflicts:aaa"),
      finding("dedup", "dedup:bbb"),
      finding("freshness", "freshness:ccc"),
    ];
    const shuffled = [findings[2]!, findings[0]!, findings[1]!];
    const a = computeHygieneDigestHash({ findings, danglingLinks: 3 });
    const b = computeHygieneDigestHash({ findings: shuffled, danglingLinks: 3 });
    expect(a).toBe(b);
    expect(a).toMatch(HASH_RE);
  });

  test("only findings that meet the severity bar enter the hash", () => {
    const eligible = finding("conflicts", "conflicts:aaa");
    const infoOnly = { ...eligible, severity: "info" as const };
    const withInfo = computeHygieneDigestHash({ findings: [eligible, infoOnly], danglingLinks: 0 });
    const withoutInfo = computeHygieneDigestHash({ findings: [eligible], danglingLinks: 0 });
    expect(withInfo).toBe(withoutInfo);
  });

  test("changed state compares unequal: ids and the dangling count both move it", () => {
    const base = computeHygieneDigestHash({
      findings: [finding("conflicts", "conflicts:aaa")],
      danglingLinks: null,
    });
    expect(
      computeHygieneDigestHash({
        findings: [finding("conflicts", "conflicts:aaa")],
        danglingLinks: 0,
      }),
    ).not.toBe(base);
    expect(
      computeHygieneDigestHash({
        findings: [finding("conflicts", "conflicts:aaa"), finding("dedup", "dedup:bbb")],
        danglingLinks: null,
      }),
    ).not.toBe(base);
    expect(base).toMatch(HASH_RE);
  });

  test("the empty state hashes stably over the canonical payload", () => {
    const empty = computeHygieneDigestHash({ findings: [], danglingLinks: null });
    expect(empty).toBe(sha256Hex(JSON.stringify({ dangling: null, ids: [] })));
  });
});
