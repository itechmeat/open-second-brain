import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../../src/core/vault.ts";
import { writeAsset } from "../../src/core/pay-memory/asset.ts";


let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-asset-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const base = {
  title: "Blog Header: OpenSecondBrain Pay Memory",
  service: "paysponge/fal",
  resultUrl: "https://fal-cdn.example/abc.png",
};

describe("writeAsset", () => {
  test("creates the note with derived slug and frontmatter", () => {
    const out = writeAsset(tmp, base);
    expect(out.relativePath.startsWith("Brain/payments/assets/")).toBe(true);
    expect(out.slug).toContain("blog-header");

    const [meta, body] = parseFrontmatter(out.path);
    expect(meta["type"]).toBe("generated-asset");
    expect(meta["title"]).toBe(base.title);
    expect(meta["source"]).toBe(base.service);
    expect(meta["result_url"]).toBe(base.resultUrl);
    expect(body).toContain(`# ${base.title}`);
    expect(body).toContain(base.resultUrl);
  });

  test("links to source receipt and used-in draft as wikilinks", () => {
    const out = writeAsset(tmp, {
      ...base,
      sourceReceipt: "Brain/payments/2026-05-10/fal-blog.md",
      usedIn: "Brain/payments/drafts/blog-post.md",
      prompt: "A recursive technical blog illustration\nNo logos\nNo text",
    });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain('source_receipt: "[[Brain/payments/2026-05-10/fal-blog]]"');
    expect(text).toContain('used_in: "[[Brain/payments/drafts/blog-post]]"');
    expect(text).toContain("> A recursive technical blog illustration");
    expect(text).toContain("> No logos");
  });

  test("refuses to overwrite without flag", () => {
    writeAsset(tmp, base);
    expect(() => writeAsset(tmp, base)).toThrow(/already exists/);
    expect(() => writeAsset(tmp, { ...base, overwrite: true })).not.toThrow();
  });

  test("rejects missing required fields", () => {
    expect(() => writeAsset(tmp, { ...base, title: "" })).toThrow();
    expect(() => writeAsset(tmp, { ...base, service: "" })).toThrow();
    expect(() => writeAsset(tmp, { ...base, resultUrl: "" })).toThrow();
  });

  test("respects explicit slug", () => {
    const out = writeAsset(tmp, { ...base, slug: "custom" });
    expect(out.slug).toBe("custom");
    expect(out.path.endsWith("custom.md")).toBe(true);
  });

  test("sanitizes brackets in source_receipt wikilink", () => {
    const out = writeAsset(tmp, {
      ...base,
      sourceReceipt: "Brain/payments/2026-05-10/fal[v2].md",
    });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain('source_receipt: "[[Brain/payments/2026-05-10/falv2]]"');
    expect(text).toContain("Receipt: [[Brain/payments/2026-05-10/falv2]]");
  });

  test("escapes backticks in service name", () => {
    const out = writeAsset(tmp, { ...base, service: "weird/`evil`-svc" });
    const text = readFileSync(out.path, "utf8");
    expect(text).toContain("`weird/ˋevilˋ-svc`");
    expect(text).not.toContain("`weird/`evil`-svc`");
  });
});
