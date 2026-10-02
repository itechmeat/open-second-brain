/**
 * Capture scope on distillation pages: how much of the source the vault
 * actually holds. A local source adds nothing (byte-identical page); a URL
 * adds `capture_scope: url-only`; a URL plus a caller-supplied verbatim
 * excerpt is `bounded-local`, and its quotes are checked against the excerpt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  distillSource,
  type DistillClaim,
  type DistillSourceResult,
} from "../../../../src/core/brain/distill/distill-source.ts";
import { QUOTE_CHECK_OUTCOME } from "../../../../src/core/brain/distill/quote-verdict.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../../../src/core/brain/paths.ts";
import {
  CAPTURE_EXCERPT_MAX_BYTES,
  CAPTURE_SCOPE,
  CAPTURE_SCOPE_KEY,
  CaptureExcerptError,
  EXCERPT_HASH_KEY,
  excerptDigest,
  readExcerptSection,
} from "../../../../src/core/brain/provenance/capture-scope.ts";
import { hasUntrustedSourceMarker } from "../../../../src/core/brain/trust/untrusted-provenance.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";

let vault: string;
const NOW = new Date("2026-07-10T08:00:00Z");
const LATER = new Date("2026-07-11T09:00:00Z");
const LOCAL = "Articles/restaking.md";
const URL_SOURCE = "https://example.test/restaking";
const EXCERPT = "Restaking reuses staked capital to secure more services. ^abc\n\nIt adds risk.\n";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-capture-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, LOCAL), "# Restaking\n\nBody text.\n", "utf8");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function distill(
  sourcePath: string,
  claims: ReadonlyArray<DistillClaim>,
  extra: { excerpt?: string; now?: Date } = {},
): DistillSourceResult {
  return distillSource(
    vault,
    {
      sourcePath,
      claims,
      ...(extra.excerpt !== undefined ? { excerpt: extra.excerpt } : {}),
    },
    { agent: "claude", now: extra.now ?? NOW },
  );
}

function page(res: DistillSourceResult): string {
  return readFileSync(join(vault, res.distillationPath), "utf8");
}

function meta(res: DistillSourceResult): Record<string, unknown> {
  return parseFrontmatter(join(vault, res.distillationPath))[0];
}

/** Distillation pages on disk. An absent directory is zero pages, not a throw. */
function distillationPages(): string[] {
  const dir = join(vault, BRAIN_DISTILLATIONS_REL);
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("distillSource - capture scope", () => {
  test("a local source is full-local and adds no capture key", () => {
    const res = distill(LOCAL, [{ text: "Plain claim.", block: "abc" }]);
    expect(res.captureScope).toBe(CAPTURE_SCOPE.fullLocal);
    expect(meta(res)[CAPTURE_SCOPE_KEY]).toBeUndefined();
    expect(meta(res)[EXCERPT_HASH_KEY]).toBeUndefined();
    expect(page(res)).not.toContain("## Excerpt");
  });

  test("a URL source is url-only beside the untrusted marker, and its quotes are unquoted", () => {
    const res = distill(URL_SOURCE, [{ text: "It “reuses staked capital”." }]);
    expect(res.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    expect(meta(res)[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.urlOnly);
    expect(hasUntrustedSourceMarker(meta(res))).toBe(true);
    expect(page(res)).toContain("- It reuses staked capital.");
    expect(res.quotes?.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.urlOnly, span: "reuses staked capital" },
    ]);
  });

  test("a URL source with an excerpt is bounded-local, stores the excerpt verbatim and checks against it", () => {
    const res = distill(
      URL_SOURCE,
      [{ text: "It “reuses staked capital”.", block: "abc" }, { text: "Also “It adds risk.”" }],
      { excerpt: EXCERPT },
    );
    expect(res.captureScope).toBe(CAPTURE_SCOPE.boundedLocal);
    expect(meta(res)[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.boundedLocal);
    expect(meta(res)[EXCERPT_HASH_KEY]).toBe(excerptDigest(EXCERPT));
    expect(hasUntrustedSourceMarker(meta(res))).toBe(true);
    expect(readExcerptSection(page(res))).toBe(EXCERPT);
    expect(res.quotes?.verified_in_block).toBe(1);
    expect(res.quotes?.verified_in_source).toBe(1);
    expect(res.quotes?.unquoted).toBe(0);
    expect(page(res)).toContain("- It “reuses staked capital”.");
  });

  test("an excerpt for a local source is refused by name and writes nothing", () => {
    expect(() => distill(LOCAL, [{ text: "Plain claim." }], { excerpt: EXCERPT })).toThrow(
      CaptureExcerptError,
    );
    expect(distillationPages()).toEqual([]);
  });

  test("an excerpt over the byte cap is refused and writes nothing", () => {
    const over = "é".repeat(CAPTURE_EXCERPT_MAX_BYTES / 2 + 1);
    expect(() => distill(URL_SOURCE, [{ text: "Plain claim." }], { excerpt: over })).toThrow(
      CaptureExcerptError,
    );
    expect(distillationPages()).toEqual([]);
  });

  test("re-running with the same excerpt is inert", () => {
    const claims = [{ text: "It “reuses staked capital”.", block: "abc" }];
    const first = distill(URL_SOURCE, claims, { excerpt: EXCERPT });
    const before = page(first);
    expect(readExcerptSection(before)).toBe(EXCERPT);
    const second = distill(URL_SOURCE, claims, { excerpt: EXCERPT, now: LATER });
    expect(second.created).toBe(false);
    expect(second.captureScope).toBe(CAPTURE_SCOPE.boundedLocal);
    expect(page(second)).toBe(before);
  });

  test("a CRLF excerpt holding a `---` line is stored verbatim and its digest still matches", () => {
    const excerpt = "---\r\ntitle: not frontmatter\r\n---\r\nQuoted line here. ^q\r\n";
    const res = distill(URL_SOURCE, [{ text: "It says “Quoted line here.”", block: "q" }], {
      excerpt,
    });
    expect(res.quotes?.verified_in_block).toBe(1);
    expect(meta(res)["title"]).toBeUndefined();
    expect(readExcerptSection(page(res))).toBe(excerpt);
    expect(meta(res)[EXCERPT_HASH_KEY]).toBe(excerptDigest(excerpt));
  });
});
