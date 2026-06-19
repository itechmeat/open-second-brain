/**
 * Open Knowledge Format (OKF) export / import round-trip
 * (Brain Portability & Interop suite, Unit C).
 *
 * `buildOkfBundle` projects the vault into a portable markdown bundle
 * (concepts / queries / references + date-grouped log + okf.json
 * manifest); `readOkfBundle` + `importOkfBundle` reconstruct it, staging
 * pages as review candidates by default and writing directly under
 * `--trusted`. Foreign provenance (raw type + producer-specific
 * frontmatter) survives a re-export.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OKF_PRODUCER,
  OKF_REVIEW_REL,
  OKF_SCHEMA_VERSION,
  OkfError,
  buildOkfBundle,
  collectOkfPages,
  importOkfBundle,
  readOkfBundle,
  writeOkfBundle,
} from "../../../../src/core/brain/portability/okf.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-okf-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function note(rel: string, content: string): void {
  const p = join(vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

function fileOf(files: ReadonlyArray<{ path: string; contents: string }>, path: string): string {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`bundle has no file ${path}`);
  return f.contents;
}

describe("buildOkfBundle", () => {
  test("classifies pages into concepts / queries / references by kind", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nlinks to [[Beta]].\n");
    note("Brain/sources/src-paper.md", "---\ntitle: Paper\nkind: brain-source\n---\ncited.\n");
    note("Brain/reports/2026-06-01-q.md", "---\ntitle: Q\nkind: brain-report\n---\nfindings.\n");

    const bundle = buildOkfBundle(vault);
    expect(bundle.manifest.schema).toBe(OKF_SCHEMA_VERSION);
    expect(bundle.manifest.producer).toBe(OKF_PRODUCER);

    const byPath = new Map(bundle.manifest.pages.map((p) => [p.path, p]));
    expect(byPath.get("Notes/Alpha.md")?.class).toBe("concept");
    expect(byPath.get("Brain/sources/src-paper.md")?.class).toBe("reference");
    expect(byPath.get("Brain/reports/2026-06-01-q.md")?.class).toBe("query");

    // Concept citation derived structurally from the body wikilink.
    expect(byPath.get("Notes/Alpha.md")?.citations).toEqual(["Beta"]);
  });

  test("emits okf.json, index.md, log.md, and one file per page", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nbody.\n");
    note("Brain/log/2026-06-01.md", "- did a thing\n");
    note("Brain/log/2026-06-02.md", "- did another\n");

    const bundle = buildOkfBundle(vault);
    const paths = bundle.files.map((f) => f.path);
    expect(paths).toContain("okf.json");
    expect(paths).toContain("index.md");
    expect(paths).toContain("log.md");
    expect(paths).toContain("concepts/Alpha.md");

    // Log is date-grouped under H2 headings, sorted ascending.
    const log = fileOf(bundle.files, "log.md");
    expect(log.indexOf("## 2026-06-01")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("## 2026-06-01")).toBeLessThan(log.indexOf("## 2026-06-02"));
    expect(bundle.manifest.log_days).toBe(2);

    // Page file carries frontmatter + body verbatim.
    const page = fileOf(bundle.files, "concepts/Alpha.md");
    expect(page).toContain("title: Alpha");
    expect(page).toContain("body.");
  });

  test("excludes Brain machinery (preferences, inbox) from pages", () => {
    note("Notes/Real.md", "---\ntitle: Real\n---\nx\n");
    note("Brain/preferences/pref-foo.md", "---\nid: pref-foo\n---\nrule\n");
    note("Brain/inbox/sig-2026-06-01-foo.md", "---\ntopic: foo\n---\nsig\n");
    const bundle = buildOkfBundle(vault);
    const paths = bundle.manifest.pages.map((p) => p.path);
    expect(paths).toContain("Notes/Real.md");
    expect(paths.some((p) => p.startsWith("Brain/preferences"))).toBe(false);
    expect(paths.some((p) => p.startsWith("Brain/inbox"))).toBe(false);
  });

  test("content is deterministic across two builds (only generated_at varies)", () => {
    note("Notes/B.md", "---\ntitle: B\n---\nsee [[A]].\n");
    note("Notes/A.md", "---\ntitle: A\n---\nleaf.\n");
    const first = buildOkfBundle(vault);
    const second = buildOkfBundle(vault);
    expect(JSON.stringify(first.files)).toBe(JSON.stringify(second.files));
    expect(JSON.stringify(first.manifest.pages)).toBe(JSON.stringify(second.manifest.pages));
  });

  test("de-duplicates colliding basenames within a class subdir", () => {
    note("A/Dup.md", "---\ntitle: one\n---\nx\n");
    note("B/Dup.md", "---\ntitle: two\n---\ny\n");
    const bundle = buildOkfBundle(vault);
    const bundlePaths = bundle.manifest.pages.map((p) => p.bundle_path).toSorted();
    expect(bundlePaths).toEqual(["concepts/Dup-2.md", "concepts/Dup.md"]);
  });
});

describe("collectOkfPages", () => {
  test("surfaces a preserved foreign type from okf_type frontmatter", () => {
    note(
      "Imported/Foo.md",
      "---\ntitle: Foo\nkind: note\nokf_type: encyclopedia-entry\nx-source-db: wikidata\n---\nbody\n",
    );
    const pages = collectOkfPages(vault);
    const foo = pages.find((p) => p.path === "Imported/Foo.md");
    expect(foo?.foreign_type).toBe("encyclopedia-entry");
    expect(foo?.producer_meta).toEqual({ "x-source-db": "wikidata" });
  });
});

describe("round-trip", () => {
  test("trusted import restores pages at their recorded paths", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nlinks [[Beta]].\n");
    note("Brain/sources/src-paper.md", "---\ntitle: Paper\nkind: brain-source\n---\ncited.\n");
    const bundle = buildOkfBundle(vault);

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-bundle-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);

      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.mode).toBe("trusted");
      expect(result.written).toContain("Notes/Alpha.md");
      expect(result.written).toContain("Brain/sources/src-paper.md");
      expect(existsSync(join(dest, "Notes/Alpha.md"))).toBe(true);
      expect(readFileSync(join(dest, "Notes/Alpha.md"), "utf8")).toContain("links [[Beta]].");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("default import stages pages under OKF Review/ as candidates", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nx\n");
    const bundle = buildOkfBundle(vault);
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-bundle-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const result = importOkfBundle(dest, readOkfBundle(dir));
      expect(result.mode).toBe("review");
      const staged = join(dest, OKF_REVIEW_REL, "Notes/Alpha.md");
      expect(existsSync(staged)).toBe(true);
      expect(readFileSync(staged, "utf8")).toContain("okf_review: pending");
      // The live target was never created.
      expect(existsSync(join(dest, "Notes/Alpha.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("review mode skips an existing staged target rather than clobbering", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nx\n");
    const bundle = buildOkfBundle(vault);
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-bundle-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const staged = join(dest, OKF_REVIEW_REL, "Notes/Alpha.md");
      mkdirSync(join(staged, ".."), { recursive: true });
      writeFileSync(staged, "PREEXISTING\n", "utf8");
      const result = importOkfBundle(dest, readOkfBundle(dir));
      expect(result.skipped).toContain(join(OKF_REVIEW_REL, "Notes/Alpha.md"));
      expect(readFileSync(staged, "utf8")).toBe("PREEXISTING\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("foreign provenance", () => {
  function foreignBundleDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-foreign-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const manifest = {
      schema: OKF_SCHEMA_VERSION,
      producer: "some-other-wiki",
      generated_at: "2026-06-01T00:00:00Z",
      vault_basename: "Foreign",
      log_days: 0,
      pages: [
        {
          id: "Topic",
          path: "Concepts/Topic.md",
          class: "concept",
          bundle_path: "concepts/Topic.md",
          kind: "note",
          citations: [],
          aliases: [],
          freshness: null,
          foreign_type: "wiki-article",
          producer_meta: { "x-wiki-id": "42" },
        },
      ],
    };
    writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(
      join(dir, "concepts/Topic.md"),
      "---\ntitle: Topic\nkind: note\nokf_type: wiki-article\nx-wiki-id: 42\n---\nForeign body.\n",
      "utf8",
    );
    return dir;
  }

  test("import stamps producer + raw foreign type, preserves x-* keys", () => {
    const dir = foreignBundleDir();
    try {
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(true);
      const result = importOkfBundle(vault, parsed, { trusted: true, now: new Date(0) });
      expect(result.foreign).toBe(true);
      const written = readFileSync(join(vault, "Concepts/Topic.md"), "utf8");
      expect(written).toContain("okf_producer: some-other-wiki");
      expect(written).toContain("okf_type: wiki-article");
      expect(written).toContain("x-wiki-id: 42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-export preserves raw foreign type while deriving standard fields", () => {
    const dir = foreignBundleDir();
    try {
      importOkfBundle(vault, readOkfBundle(dir), { trusted: true, now: new Date(0) });
      // The page now lives in OUR vault; re-export must keep foreign type
      // but derive standard kind from current state.
      const re = buildOkfBundle(vault);
      const page = re.manifest.pages.find((p) => p.path === "Concepts/Topic.md");
      expect(page?.foreign_type).toBe("wiki-article");
      expect(page?.producer_meta).toEqual({ "x-wiki-id": "42" });
      expect(page?.kind).toBe("note"); // standard field derived from current frontmatter
      // The re-exported page file still carries the foreign frontmatter.
      const body = fileOf(re.files, page!.bundle_path);
      expect(body).toContain("okf_type: wiki-article");
      expect(body).toContain("x-wiki-id: 42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readOkfBundle validation", () => {
  test("rejects a missing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-empty-"));
    try {
      expect(() => readOkfBundle(dir)).toThrow(OkfError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported schema loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-badschema-"));
    try {
      writeFileSync(join(dir, "okf.json"), JSON.stringify({ schema: "999", pages: [] }), "utf8");
      expect(() => readOkfBundle(dir)).toThrow(OkfError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page whose recorded bundle_path escapes the bundle is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-escape-"));
    try {
      const manifest = {
        schema: OKF_SCHEMA_VERSION,
        producer: "x",
        pages: [{ id: "evil", path: "a.md", class: "concept", bundle_path: "../../etc/passwd" }],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      const parsed = readOkfBundle(dir);
      expect(parsed.pages.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeOkfBundle", () => {
  test("refuses a non-empty directory without force", () => {
    note("Notes/A.md", "---\ntitle: A\n---\nx\n");
    const bundle = buildOkfBundle(vault);
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-nonempty-"));
    try {
      writeFileSync(join(dir, "stuff.txt"), "x", "utf8");
      expect(() => writeOkfBundle(dir, bundle)).toThrow(OkfError);
      // force overwrites.
      writeOkfBundle(dir, bundle, { force: true });
      expect(existsSync(join(dir, "okf.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
