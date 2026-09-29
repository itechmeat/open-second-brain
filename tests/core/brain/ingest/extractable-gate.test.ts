/**
 * P3 (t_ed856388): honor the schema `extractable` allowlist during page
 * discovery. When the schema declares extractable tokens, pages whose
 * `schema_type` is not in the allowlist are skipped-with-reason before
 * extraction; pages with no declared type stay ungated; an empty allowlist
 * gates nothing (byte-identical to today).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractableAllowlist,
  isSkippedPageReason,
  partitionExtractable,
  SKIPPED_PAGE_REASON,
  SKIPPED_PAGE_REASONS,
} from "../../../../src/core/brain/ingest/extractable-gate.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-extractable-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Write a page with an optional `schema_type` frontmatter field. */
function page(rel: string, schemaType?: string): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const fm = schemaType === undefined ? "" : `schema_type: ${schemaType}\n`;
  writeFileSync(abs, `---\ntitle: ${rel}\n${fm}---\n\nbody\n`, "utf8");
  return rel;
}

describe("partitionExtractable", () => {
  test("skips pages whose schema_type is not in the allowlist", () => {
    const paths = [page("a.md", "paper"), page("b.md", "memo"), page("c.md", "paper")];
    const part = partitionExtractable(vault, paths, new Set(["paper"]));
    expect(part.extractable).toEqual(["a.md", "c.md"]);
    expect(part.skipped.map((s) => s.path)).toEqual(["b.md"]);
    expect(part.skipped[0]!.detail).toBe("memo");
  });

  test("a page with no declared type stays ungated (kept)", () => {
    const paths = [page("untyped.md"), page("typed.md", "memo")];
    const part = partitionExtractable(vault, paths, new Set(["paper"]));
    expect(part.extractable).toContain("untyped.md");
    expect(part.skipped.map((s) => s.path)).toEqual(["typed.md"]);
  });

  test("an empty allowlist keeps everything (no gating)", () => {
    const paths = [page("a.md", "paper"), page("b.md", "memo")];
    const part = partitionExtractable(vault, paths, new Set());
    expect(part.extractable).toEqual(["a.md", "b.md"]);
    expect(part.skipped).toEqual([]);
  });
});

describe("typed skip reasons (P4)", () => {
  test("a skipped page carries a typed reason token from the closed list, plus the schema_type as detail", () => {
    const paths = [page("a.md", "paper"), page("b.md", "memo")];
    const part = partitionExtractable(vault, paths, new Set(["paper"]));
    expect(part.skipped).toHaveLength(1);
    const skip = part.skipped[0]!;
    expect(SKIPPED_PAGE_REASONS).toContain(skip.reason);
    expect(skip.reason).toBe(SKIPPED_PAGE_REASON.notExtractable);
    expect(skip.detail).toBe("memo");
  });

  test("isSkippedPageReason accepts the token and the legacy sentence, rejects an unknown string", () => {
    expect(isSkippedPageReason(SKIPPED_PAGE_REASON.notExtractable)).toBe(true);
    expect(
      isSkippedPageReason('schema_type "memo" is not in the schema extractable allowlist'),
    ).toBe(true);
    expect(isSkippedPageReason("schema_type was rejected for some other reason")).toBe(false);
    expect(isSkippedPageReason("")).toBe(false);
    expect(isSkippedPageReason(42)).toBe(false);
    expect(isSkippedPageReason(null)).toBe(false);
  });
});

describe("extractableAllowlist", () => {
  test("is empty for a vault with no extractable schema declaration", () => {
    expect(extractableAllowlist(vault).size).toBe(0);
  });

  test("reflects the schema pack's extractable tokens", () => {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nschema:\n  page_types:\n    - paper\n  extractable:\n    - paper\n",
      "utf8",
    );
    const allow = extractableAllowlist(vault);
    expect(allow.has("paper")).toBe(true);
  });
});
