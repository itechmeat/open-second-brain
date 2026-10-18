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
  buildOkfSubsetBundle,
  collectOkfPages,
  importOkfBundle,
  readOkfBundle,
  writeOkfBundle,
  type OkfPage,
} from "../../../../src/core/brain/portability/okf.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import type { FrontmatterValue } from "../../../../src/core/types.ts";
import {
  installKnowledgePack,
  readKnowledgePack,
  sealKnowledgePack,
} from "../../../../src/core/brain/portability/knowledge-pack.ts";

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

  test("a per-device log shard is a log day, not an invisible file", () => {
    // `Brain/log/` writes `<date>.<deviceId>.md` on every default install
    // since the per-device shard layout landed, so a pattern that matched
    // only the legacy un-sharded name reported `0 log day(s)` and an empty
    // `log.md` for a vault with a full change log.
    note("Brain/log/2026-06-01.bb4363ed.md", "- sharded entry\n");
    note("Brain/log/2026-06-02.md", "- legacy entry\n");

    const bundle = buildOkfBundle(vault);
    const log = fileOf(bundle.files, "log.md");
    expect(log).toContain("## 2026-06-01");
    expect(log).toContain("sharded entry");
    expect(bundle.manifest.log_days).toBe(2);
  });

  test("two shards of one day fold into one dated section", () => {
    note("Brain/log/2026-06-01.aaaaaaaa.md", "- from device a\n");
    note("Brain/log/2026-06-01.bbbbbbbb.md", "- from device b\n");

    const bundle = buildOkfBundle(vault);
    const log = fileOf(bundle.files, "log.md");
    expect(log.match(/## 2026-06-01/g)?.length).toBe(1);
    expect(log).toContain("from device a");
    expect(log).toContain("from device b");
    expect(bundle.manifest.log_days).toBe(1);
  });

  test("a `private: true` page exports in full - the key is not a boundary", () => {
    // Retraction, asserted rather than assumed. Nothing under
    // `portability/` reads this frontmatter key, the export composers are
    // content composers rather than visibility filters, and the
    // `<private>` REGION marker is the product's only content-derived
    // privacy primitive. The test exists so the label cannot be re-read as
    // a boundary by a later reader.
    note(
      "Notes/Labelled.md",
      "---\ntitle: Labelled\nprivate: true\ntags: [private, confidential]\n---\nsalary discussion.\n",
    );

    const bundle = buildOkfBundle(vault);
    const page = fileOf(bundle.files, "concepts/Labelled.md");
    expect(page).toContain("private: true");
    expect(page).toContain("salary discussion.");
    expect(bundle.manifest.pages.map((p) => p.path)).toContain("Notes/Labelled.md");
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

  test("content is deterministic across two builds (one shared generated instant)", () => {
    note("Notes/B.md", "---\ntitle: B\n---\nsee [[A]].\n");
    note("Notes/A.md", "---\ntitle: A\n---\nleaf.\n");
    const first = buildOkfBundle(vault);
    const second = buildOkfBundle(vault);
    // Every nondeterministic byte in the bundle flows from ONE generated
    // instant: the manifest's `generated_at` and every page's
    // `generated.at` (the two normalized fields) share the single bundle
    // value. Substituting the first build's instant into the second must
    // therefore make the two builds byte-identical - a timestamp that did
    // not share would survive the substitution and fail the comparison.
    const instant = second.manifest.generated_at;
    const normalized = second.files.map((f) => ({
      path: f.path,
      contents: f.contents.split(instant).join(first.manifest.generated_at),
    }));
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(first.files));
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

/**
 * OKF v0.2 emission (t_ffdb4fac): the bundle-root index declares
 * `okf_version: "0.2"` (the only frontmatter an index file may carry),
 * every page frontmatter carries the spec's per-concept keys -
 * `sources:` translated from citations with a REQUIRED `resource`, and
 * `generated: {by, at}` sharing the one bundle instant - and the open
 * status vocabulary lands on the spec's closed draft|stable|deprecated
 * enum conservatively.
 */
describe("v0.2 emission", () => {
  test("the bundle-root index declares okf_version and the manifest keeps the dialect schema", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nbody.\n");
    const bundle = buildOkfBundle(vault);
    const index = fileOf(bundle.files, "index.md");
    expect(index.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    // The dialect manifest field is untouched: `schema` stays "1".
    expect(bundle.manifest.schema).toBe(OKF_SCHEMA_VERSION);
  });

  test("every page carries a generated block sharing the bundle instant", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nsee [[Beta]].\n");
    note("Notes/Beta.md", "---\ntitle: Beta\n---\nleaf.\n");
    const bundle = buildOkfBundle(vault);
    const ats = bundle.manifest.pages.map((p) => {
      const page = fileOf(bundle.files, p.bundle_path);
      const m = page.match(/generated: \{by: "open-second-brain\/[^"]+", at: "([^"]+)"\}/);
      expect(m).not.toBeNull();
      return m![1]!;
    });
    expect(ats.length).toBe(bundle.manifest.pages.length);
    expect(new Set(ats).size).toBe(1);
    expect(ats[0]).toBe(bundle.manifest.generated_at);
  });

  test("flow scalars render as JSON double-quoted YAML, safe for ids like 2024", () => {
    // A bare `id: 2024` is an integer to a strict YAML reader, and bare
    // true/null/~ are booleans or null: every emitted scalar is a
    // double-quoted JSON string, which is valid YAML of type string.
    note("Notes/2024.md", "---\ntitle: Year\n---\nleaf.\n");
    note("Notes/Citer.md", "---\ntitle: Citer\n---\nsee [[2024]].\n");
    const bundle = buildOkfBundle(vault);
    const citer = fileOf(bundle.files, "concepts/Citer.md");
    expect(citer).toContain('- {resource: "concepts/2024.md", id: "2024"}');
    expect(citer).not.toContain("id: 2024");
  });

  test("citations translate into sources with a required resource", () => {
    note("Notes/Alpha.md", "---\ntitle: Alpha\n---\nsee [[Beta]], [[Deep/Gamma]].\n");
    note("Notes/Beta.md", "---\ntitle: Beta\n---\nleaf.\n");
    note("Deep/Gamma.md", "---\ntitle: Gamma\n---\nleaf.\n");
    note("Notes/Url.md", "---\ntitle: Url\n---\ncited [[https://example.com/paper]].\n");
    const bundle = buildOkfBundle(vault);
    const alpha = fileOf(bundle.files, "concepts/Alpha.md");
    expect(alpha).toContain("sources:");
    expect(alpha).toContain('- {resource: "concepts/Beta.md", id: "Beta"}');
    expect(alpha).toContain('- {resource: "concepts/Gamma.md", id: "Gamma"}');
    // A URL target is carried as-is; the manifest mirrors the entries.
    const url = fileOf(bundle.files, "concepts/Url.md");
    expect(url).toContain('- {resource: "https://example.com/paper"}');
    const alphaEntry = bundle.manifest.pages.find((p) => p.path === "Notes/Alpha.md");
    expect(alphaEntry?.sources).toEqual([
      { resource: "concepts/Beta.md", id: "Beta" },
      { resource: "concepts/Gamma.md", id: "Gamma" },
    ]);
  });

  test("a dangling citation is dropped, not guessed", () => {
    note(
      "Notes/Lonely.md",
      "---\ntitle: Lonely\n---\nsee [[Ghost]] and [[https://example.com/real]].\n",
    );
    const bundle = buildOkfBundle(vault);
    const page = fileOf(bundle.files, "concepts/Lonely.md");
    // The URL source survives; the unresolvable wikilink never becomes a
    // source entry (the body keeps its verbatim link either way).
    expect(page).toContain('- {resource: "https://example.com/real"}');
    expect(page).not.toContain("{resource: Ghost");
    expect(page).not.toContain("id: Ghost");
  });

  test("an ambiguous basename citation is dropped rather than guessed", () => {
    note("A/Dup.md", "---\ntitle: one\n---\nx\n");
    note("B/Dup.md", "---\ntitle: two\n---\ny\n");
    note("Notes/Citer.md", "---\ntitle: Citer\n---\nsee [[Dup]].\n");
    const bundle = buildOkfBundle(vault);
    const citer = fileOf(bundle.files, "concepts/Citer.md");
    expect(citer).not.toContain("sources:");
    expect(citer).not.toContain("resource:");
  });

  test("a path citation into colliding stems emits the resource without an id", () => {
    // The path resolves the page (bundle_path names exactly one file), but
    // the stem does not name an id: A/Dup.md and B/Dup.md are both id
    // "Dup". The id field is documented as a stable key, so the entry
    // carries the resource only - same refuse-to-guess rule as the
    // basename branch.
    note("A/Dup.md", "---\ntitle: one\n---\nx\n");
    note("B/Dup.md", "---\ntitle: two\n---\ny\n");
    note("Notes/Citer.md", "---\ntitle: Citer\n---\nsee [[B/Dup]].\n");
    const bundle = buildOkfBundle(vault);
    const citer = fileOf(bundle.files, "concepts/Citer.md");
    expect(citer).toContain('- {resource: "concepts/Dup-2.md"}');
    expect(citer).not.toContain("id:");
    const entry = bundle.manifest.pages.find((p) => p.path === "Notes/Citer.md");
    expect(entry?.sources).toEqual([{ resource: "concepts/Dup-2.md" }]);
  });

  test("an extension-bearing basename citation resolves through the stem map", () => {
    // `[[Dup.md]]` names the same page `[[Dup]]` does: the citation keeps
    // its extension while the stem map keys on stems, so the resolver
    // falls back to stem(citation) instead of dropping a resolvable page.
    note("Notes/Dup.md", "---\ntitle: Dup\n---\nleaf.\n");
    note("Notes/Citer.md", "---\ntitle: Citer\n---\nsee [[Dup.md]].\n");
    const bundle = buildOkfBundle(vault);
    const citer = fileOf(bundle.files, "concepts/Citer.md");
    expect(citer).toContain('- {resource: "concepts/Dup.md", id: "Dup"}');
    const entry = bundle.manifest.pages.find((p) => p.path === "Notes/Citer.md");
    expect(entry?.sources).toEqual([{ resource: "concepts/Dup.md", id: "Dup" }]);
  });

  test("an extension-bearing ambiguous basename citation is still dropped", () => {
    note("A/Dup.md", "---\ntitle: one\n---\nx\n");
    note("B/Dup.md", "---\ntitle: two\n---\ny\n");
    note("Notes/Citer.md", "---\ntitle: Citer\n---\nsee [[Dup.md]].\n");
    const bundle = buildOkfBundle(vault);
    const citer = fileOf(bundle.files, "concepts/Citer.md");
    expect(citer).not.toContain("sources:");
    expect(citer).not.toContain("resource:");
  });

  test("lifecycle maps conservatively onto draft | stable | deprecated", () => {
    note("Notes/Done.md", "---\ntitle: Done\nstatus: done\n---\nx\n");
    note("Notes/Archived.md", "---\ntitle: Archived\nstatus: archived\n---\nx\n");
    note("Notes/Draft.md", "---\ntitle: Draft\nstatus: draft\n---\nx\n");
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nx\n");
    const bundle = buildOkfBundle(vault);
    const pageOf = (rel: string): string => fileOf(bundle.files, `concepts/${rel}.md`);
    // Completion is never mapped to deprecation.
    expect(pageOf("Done")).toContain("status: stable");
    expect(pageOf("Done")).not.toContain("status: done");
    expect(pageOf("Archived")).toContain("status: deprecated");
    expect(pageOf("Draft")).toContain("status: draft");
    expect(pageOf("Plain")).toContain("status: stable");
    const byPath = new Map(bundle.manifest.pages.map((p) => [p.path, p]));
    expect(byPath.get("Notes/Done.md")?.status).toBe("stable");
    expect(byPath.get("Notes/Archived.md")?.status).toBe("deprecated");
    expect(byPath.get("Notes/Draft.md")?.status).toBe("draft");
    expect(byPath.get("Notes/Plain.md")?.status).toBe("stable");
  });
});

/**
 * The OKF v0.2 spec's only ALWAYS-REQUIRED per-concept key is `type`
 * (non-empty). The export therefore emits a derived `type` on every page
 * - the preserved foreign type when the page came from a foreign
 * producer, else the page's own structural kind - and carries a native
 * frontmatter `type` through the producer namespace (`okf_type_raw`,
 * beside `okf_status_raw`) so an own-producer trusted import restores it
 * exactly instead of keeping the derived projection.
 */
describe("v0.2 type emission", () => {
  test("every exported page carries a non-empty derived type", () => {
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nbody.\n");
    note("Notes/Typed.md", "---\ntitle: Typed\nkind: book\n---\nbody.\n");
    note("Brain/sources/src-paper.md", "---\ntitle: Paper\nkind: brain-source\n---\ncited.\n");
    const bundle = buildOkfBundle(vault);
    expect(bundle.manifest.pages.length).toBe(3);
    for (const p of bundle.manifest.pages) {
      const page = fileOf(bundle.files, p.bundle_path);
      const m = /^type: "(.+)"$/m.exec(page);
      expect(m).not.toBeNull();
      expect(m![1]!.length).toBeGreaterThan(0);
    }
    // The derived type is the page's own kind, not its structural lane:
    // the sources-lane page keeps the kind its frontmatter declares.
    expect(fileOf(bundle.files, "concepts/Plain.md")).toContain('type: "note"');
    expect(fileOf(bundle.files, "concepts/Typed.md")).toContain('type: "book"');
    expect(fileOf(bundle.files, "references/src-paper.md")).toContain('type: "brain-source"');
  });

  test("a foreign page's preserved raw type is the derived type on re-export", () => {
    note("Imported/Foo.md", "---\ntitle: Foo\nokf_type: encyclopedia-entry\n---\nbody\n");
    const bundle = buildOkfBundle(vault);
    expect(fileOf(bundle.files, "concepts/Foo.md")).toContain('type: "encyclopedia-entry"');
  });

  test("a native type is carried raw and restored byte-exact through a trusted import", () => {
    // The derived emission is a projection (foreign type, else the
    // structural kind); a native `type` the operator wrote must not be
    // shadowed by it. The native value rides `okf_type_raw` beside the
    // derived block, and an own-producer trusted import restores it
    // exactly - the same contract as `okf_status_raw`.
    note("Notes/Beta.md", "---\ntitle: Beta\ntype: glossary-entry\n---\nbody.\n");
    const bundle = buildOkfBundle(vault);
    const beta = fileOf(bundle.files, "concepts/Beta.md");
    expect(beta).toContain("okf_type_raw: glossary-entry");
    // The derived emission names the kind; the native value rides raw.
    expect(beta).toContain('type: "note"');
    expect(beta).not.toContain("type: glossary-entry");

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-type-rt-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-type-rt-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Beta.md"), "utf8");
      expect(landed).toContain("type: glossary-entry");
      expect(landed).not.toContain('type: "note"');
      expect(landed).not.toContain("okf_type_raw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a plain page round-trips without the derived block, from the first export", () => {
    // A fresh export declares its full coverage - the derived type
    // included - so the trusted import strips the WHOLE derived block
    // from a page that never carried one natively. Under the bare-true
    // marker the type pair went undeclared, and the derived type
    // survived the import as a real native field: one step of drift,
    // locked in by every export after it. Absent okf_type_raw beside a
    // marker naming `type` means "the export derived this type" - never
    // "delete a native type": a page whose export rode a REAL native
    // type verbatim keeps it (the legacy marker below).
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nbody.\n");
    const bundle = buildOkfBundle(vault);
    const plain = fileOf(bundle.files, "concepts/Plain.md");
    expect(plain).toContain('type: "note"');
    // The marker names exactly the natives the exporter manages, inline.
    expect(plain).toContain("okf_raw: [status, sources, generated, type]");

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-type-plain-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-type-plain-dest-"));
    const dir2 = mkdtempSync(join(tmpdir(), "o2b-okf-type-plain-rt-"));
    const dest2 = mkdtempSync(join(tmpdir(), "o2b-okf-type-plain-rt-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const result = importOkfBundle(dest, readOkfBundle(dir), { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Plain.md"), "utf8");
      expect(landed).not.toContain("type:");
      expect(landed).not.toContain("okf_type_raw");
      expect(landed).not.toContain("status:");
      expect(landed).not.toContain("sources:");
      expect(landed).not.toContain("generated:");
      expect(landed).not.toContain("okf_raw");
      expect(landed).toContain("title: Plain");

      // The round-trip converges from the first export: the imported
      // page re-exports with the derived block beside a fresh full
      // marker, and the next import strips it again - the derived type
      // never accumulates into a native.
      const second = buildOkfBundle(dest);
      expect(fileOf(second.files, "concepts/Plain.md")).toContain(
        "okf_raw: [status, sources, generated, type]",
      );
      writeOkfBundle(dir2, second);
      const result2 = importOkfBundle(dest2, readOkfBundle(dir2), { trusted: true });
      expect(result2.errors).toEqual([]);
      const relanded = readFileSync(join(dest2, "Notes/Plain.md"), "utf8");
      expect(relanded).not.toContain("type:");
      expect(relanded).toContain("title: Plain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
      rmSync(dest2, { recursive: true, force: true });
    }
  });
});

/**
 * The `okf_raw` marker declares which native fields the export managed:
 * `true` (the shape every exporter stamped before the marker could
 * declare coverage) covers the old status/sources/generated set, a list
 * of native names covers exactly what it names, and the restore drops a
 * native ONLY when its pair was declared. Reading a bare `true` as
 * covering `type` too deleted real native types: exports produced before
 * the type pair existed carried a page's `type` verbatim beside the
 * marker with no `okf_type_raw`, and the restore read that absence as
 * "never had a value".
 */
describe("the raw-carry marker declares what it covers", () => {
  const entry = {
    id: "Topic",
    path: "Notes/Topic.md",
    class: "concept",
    bundle_path: "concepts/Topic.md",
    kind: "note",
    citations: [],
    status: "stable",
    sources: [],
    aliases: [],
    freshness: null,
    foreign_type: null,
    producer_meta: {},
  } as const;

  /** Hand-build an own-producer bundle whose single page is caller-written. */
  function ownBundle(dir: string, pageContents: string): void {
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const manifest = {
      schema: OKF_SCHEMA_VERSION,
      producer: OKF_PRODUCER,
      generated_at: "2026-06-01T00:00:00Z",
      vault_basename: "Declared",
      log_days: 0,
      pages: [entry],
    };
    writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(dir, "concepts/Topic.md"), pageContents, "utf8");
  }

  test("a legacy marker-bearing page keeps its native type through import", () => {
    // The pre-type-pair export shape: a native `type` rode the page
    // verbatim beside the bare `okf_raw: true` marker, and no
    // okf_type_raw existed. The restore covers only what the marker
    // declares (status / sources / generated), so the real type survives
    // - trusted round-trip and review staging alike.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-mark-type-"));
    const trustedDest = mkdtempSync(join(tmpdir(), "o2b-okf-mark-type-tr-"));
    const reviewDest = mkdtempSync(join(tmpdir(), "o2b-okf-mark-type-rv-"));
    try {
      ownBundle(
        dir,
        "---\ntitle: Topic\ntype: glossary-entry\nokf_status_raw: quarantine\nstatus: stable\nokf_raw: true\n---\nBody.\n",
      );
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);

      const trusted = importOkfBundle(trustedDest, parsed, { trusted: true });
      expect(trusted.errors).toEqual([]);
      const landed = readFileSync(join(trustedDest, "Notes/Topic.md"), "utf8");
      expect(landed).toContain("type: glossary-entry");
      expect(landed).toContain("status: quarantine");
      expect(landed).not.toContain("status: stable");
      expect(landed).not.toContain("okf_type_raw");
      expect(landed).not.toContain("okf_status_raw");
      expect(landed).not.toContain("okf_raw");
      expect(landed).toContain("Body.");

      const review = importOkfBundle(reviewDest, parsed, { now: new Date(0) });
      expect(review.errors).toEqual([]);
      const staged = readFileSync(join(reviewDest, OKF_REVIEW_REL, "Notes", "Topic.md"), "utf8");
      expect(staged).toContain("type: glossary-entry");
      expect(staged).toContain("okf_review: pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(trustedDest, { recursive: true, force: true });
      rmSync(reviewDest, { recursive: true, force: true });
    }
  });

  test("a declared-but-absent native still strips, and an undeclared one survives", () => {
    // A list marker covers exactly what it names: status and type are
    // declared and absent, so their derived values drop; generated was
    // never declared, so its derived value lands instead of being
    // dropped by a guess.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-mark-list-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-mark-list-dest-"));
    try {
      ownBundle(
        dir,
        '---\ntitle: Declared\nokf_raw: [status, type]\nstatus: stable\ntype: "note"\ngenerated: {by: "someone/1.0", at: "2026-06-01T00:00:00Z"}\n---\nBody.\n',
      );
      const parsed = readOkfBundle(dir);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Topic.md"), "utf8");
      expect(landed).not.toContain("status:");
      expect(landed).not.toContain("type:");
      expect(landed).toContain("generated:");
      expect(landed).not.toContain("okf_raw");
      expect(landed).toContain("Body.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

/**
 * Manifest-less, spec-shaped OKF v0.2 bundles: the spec defines a bundle
 * as a plain directory tree of markdown (reserving index.md and log.md)
 * and requires NO manifest, so a tree whose bundle-root index declares
 * `okf_version: "0.2"` must import even without okf.json. The page list
 * is built by walking the tree; every walked page routes through the
 * EXISTING foreign-producer path - staged for review, provenance
 * stamped, machinery keys stripped - never a silent restore. A bundle
 * WITH okf.json keeps the manifest path and its schema gate entirely,
 * and every refusal but the absent-manifest one is unchanged.
 */
describe("manifest-less spec-shaped v0.2 bundles", () => {
  /** Hand-built spec-shaped bundle: index.md + pages, no okf.json. */
  function specBundle(dir: string): void {
    mkdirSync(join(dir, "concepts"), { recursive: true });
    mkdirSync(join(dir, "queries"), { recursive: true });
    mkdirSync(join(dir, "references"), { recursive: true });
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n# Foreign\n', "utf8");
    writeFileSync(join(dir, "log.md"), "## 2026-06-01\n\n- old news\n", "utf8");
    writeFileSync(
      join(dir, "concepts/foo.md"),
      "---\ntitle: Foo\ntype: wiki-article\n_status: confirmed\nowner: someone\n---\nFoo body.\n",
      "utf8",
    );
    writeFileSync(join(dir, "queries/q.md"), "---\ntitle: Q\ntype: report\n---\nQ body.\n", "utf8");
    writeFileSync(
      join(dir, "references/r.md"),
      "---\ntitle: R\ntype: paper\n---\nR body.\n",
      "utf8",
    );
    writeFileSync(join(dir, "notes/n.md"), "---\ntitle: N\ntype: zettel\n---\nN body.\n", "utf8");
    writeFileSync(
      join(dir, "loose.md"),
      "---\ntitle: Loose\ntype: note\n---\nLoose body.\n",
      "utf8",
    );
  }

  test("a bundle with no okf.json and a v0.2 index is read by walking the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-spec-"));
    try {
      specBundle(dir);
      const parsed = readOkfBundle(dir);
      // Reserved files are never pages; everything else is.
      expect(parsed.pages.map((p) => p.entry.bundle_path).toSorted()).toEqual([
        "concepts/foo.md",
        "loose.md",
        "notes/n.md",
        "queries/q.md",
        "references/r.md",
      ]);
      // Class comes from the directory name when it names a class lane,
      // and defaults to concept everywhere else (foreign dirs, root).
      const byPath = new Map(parsed.pages.map((p) => [p.entry.bundle_path, p.entry]));
      expect(byPath.get("concepts/foo.md")?.class).toBe("concept");
      expect(byPath.get("queries/q.md")?.class).toBe("query");
      expect(byPath.get("references/r.md")?.class).toBe("reference");
      expect(byPath.get("notes/n.md")?.class).toBe("concept");
      expect(byPath.get("loose.md")?.class).toBe("concept");
      // Native frontmatter and body are intact.
      const foo = parsed.pages.find((p) => p.entry.bundle_path === "concepts/foo.md")!;
      expect(foo.frontmatter["title"]).toBe("Foo");
      expect(foo.frontmatter["type"]).toBe("wiki-article");
      expect(foo.body).toContain("Foo body.");
      // No manifest declared anything: the parsed manifest shows it.
      expect(parsed.manifest.schema).toBe("");
      expect(parsed.foreign).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("imported spec pages stage for review through the foreign-producer path", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-spec-imp-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-spec-imp-dest-"));
    try {
      specBundle(dir);
      const result = importOkfBundle(dest, readOkfBundle(dir), { now: new Date(0) });
      expect(result.mode).toBe("review");
      expect(result.errors).toEqual([]);
      const staged = readFileSync(join(dest, OKF_REVIEW_REL, "concepts/foo.md"), "utf8");
      // Native frontmatter intact.
      expect(staged).toContain("title: Foo");
      expect(staged).toContain("type: wiki-article");
      // Provenance stamped: the spec page's own type is the raw foreign
      // type the stamp preserves.
      expect(staged).toContain("okf_producer: unknown");
      expect(staged).toContain("okf_type: wiki-article");
      expect(staged).toContain('okf_imported_at: "1970-01-01T00:00:00Z"');
      expect(staged).toContain("okf_review: pending");
      // Machinery keys are stripped, never silently restored, and this
      // system's raw namespace cannot be planted through the walk either.
      expect(staged).not.toContain("_status:");
      expect(staged).not.toContain("owner:");
      expect(staged).not.toContain("okf_raw");
      expect(staged).toContain("Foo body.");
      // The reserved change log is not staged as a page.
      expect(existsSync(join(dest, OKF_REVIEW_REL, "log.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a nested index.md is a page; only the bundle-root index and log are reserved", () => {
    // The reserved-name check compared the BASENAME at any depth, so a
    // foreign bundle's real nested pages - a concepts/index.md, a
    // per-project log page - were silently dropped from the walk. The
    // spec's reservation is a bundle-ROOT one: index.md at the top is
    // the version declaration and log.md the change log; the same names
    // below the root are nobody's machinery.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-spec-nested-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-spec-nested-dest-"));
    try {
      mkdirSync(join(dir, "concepts"), { recursive: true });
      writeFileSync(join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n# Root\n', "utf8");
      writeFileSync(join(dir, "log.md"), "## 2026-06-01\n\n- old news\n", "utf8");
      mkdirSync(join(dir, "notes"), { recursive: true });
      writeFileSync(
        join(dir, "concepts", "index.md"),
        "---\ntitle: Index Page\ntype: zettel\n---\nNested body.\n",
        "utf8",
      );
      writeFileSync(
        join(dir, "notes", "log.md"),
        "---\ntitle: Project Log\ntype: zettel\n---\nLog body.\n",
        "utf8",
      );
      const parsed = readOkfBundle(dir);
      expect(parsed.pages.map((p) => p.entry.bundle_path).toSorted()).toEqual([
        "concepts/index.md",
        "notes/log.md",
      ]);
      const result = importOkfBundle(dest, parsed, { now: new Date(0) });
      expect(result.errors).toEqual([]);
      expect(result.written).toEqual([
        `${OKF_REVIEW_REL}/concepts/index.md`,
        `${OKF_REVIEW_REL}/notes/log.md`,
      ]);
      const staged = readFileSync(join(dest, OKF_REVIEW_REL, "concepts", "index.md"), "utf8");
      expect(staged).toContain("title: Index Page");
      expect(staged).toContain("Nested body.");
      // The root files stay reserved: never staged as pages.
      expect(existsSync(join(dest, OKF_REVIEW_REL, "index.md"))).toBe(false);
      expect(existsSync(join(dest, OKF_REVIEW_REL, "log.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a manifest-less tree without a v0.2 index declaration is still refused by name", () => {
    const noIndex = mkdtempSync(join(tmpdir(), "o2b-okf-spec-noindex-"));
    const unversioned = mkdtempSync(join(tmpdir(), "o2b-okf-spec-unvers-"));
    const wrongVersion = mkdtempSync(join(tmpdir(), "o2b-okf-spec-wrongvers-"));
    try {
      specBundle(noIndex);
      rmSync(join(noIndex, "index.md"));
      expect(() => readOkfBundle(noIndex)).toThrow("not an OKF bundle");

      specBundle(unversioned);
      writeFileSync(join(unversioned, "index.md"), "# No version declared\n", "utf8");
      expect(() => readOkfBundle(unversioned)).toThrow("not an OKF bundle");

      specBundle(wrongVersion);
      writeFileSync(
        join(wrongVersion, "index.md"),
        '---\nokf_version: "9.9"\n---\n# Future\n',
        "utf8",
      );
      expect(() => readOkfBundle(wrongVersion)).toThrow("not an OKF bundle");
    } finally {
      rmSync(noIndex, { recursive: true, force: true });
      rmSync(unversioned, { recursive: true, force: true });
      rmSync(wrongVersion, { recursive: true, force: true });
    }
  });

  test("a present okf.json with a wrong schema is still refused beside a v0.2 index", () => {
    // The manifest path and its schema gate are untouched by the
    // manifest-less acceptance: a PRESENT wrong schema never falls back
    // to the version declaration.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-spec-manifest-"));
    try {
      specBundle(dir);
      const manifest = {
        schema: "999",
        producer: "some-other-wiki",
        generated_at: "2026-06-01T00:00:00Z",
        vault_basename: "Foreign",
        log_days: 0,
        pages: [],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      expect(() => readOkfBundle(dir)).toThrow("unsupported OKF schema: expected 1, got 999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * OKF v0.2 import acceptance (t_ffdb4fac): the reader admits a bundle
 * whose manifest carries the Open Second Brain dialect `schema: "1"` OR
 * one that declares NO manifest schema while its bundle-root index
 * declares `okf_version: "0.2"`, preserves the on-disk schema value
 * instead of stamping its own constant, and still refuses everything
 * else by name. The index path is version-level only: the gate never
 * reads the producer. A PRESENT non-dialect schema is refused even
 * beside a v0.2 index - otherwise every future dialect bump would slip
 * through under v1 assumptions, because this export's own index always
 * declares okf_version.
 */
describe("v0.2 import acceptance", () => {
  /**
   * Hand-build a bundle in `dir` in the singlePageBundle pattern, with
   * caller-chosen manifest `schema` and index `okf_version` markers
   * (either may be null to omit the marker entirely). The producer is a
   * foreign one throughout: the gate is version-level, not producer-
   * keyed, so every acceptance test doubles as the wrong-producer pin.
   */
  function bundleWithMarkers(
    dir: string,
    schema: string | null,
    indexVersion: string | null,
  ): void {
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const manifest: Record<string, unknown> = {
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
          status: "stable",
          sources: [],
          aliases: [],
          freshness: null,
          foreign_type: null,
          producer_meta: {},
        },
      ],
    };
    if (schema !== null) manifest["schema"] = schema;
    writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
    const index =
      indexVersion === null
        ? "# Foreign\n"
        : `---\nokf_version: "${indexVersion}"\n---\n# Foreign\n`;
    writeFileSync(join(dir, "index.md"), index, "utf8");
    writeFileSync(join(dir, "concepts/Topic.md"), "---\ntitle: Topic\n---\nBody.\n", "utf8");
  }

  test("a schema-less bundle whose index declares okf_version 0.2 is accepted at the gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-v02-"));
    try {
      bundleWithMarkers(dir, null, "0.2");
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(true);
      expect(parsed.pages.length).toBe(1);
      // The parsed manifest reports the ON-DISK declaration, not a
      // hardcoded constant: no schema was declared, so the reader shows "".
      expect(parsed.manifest.schema).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a present non-dialect schema is refused even beside a v0.2 index", () => {
    // The index always declares okf_version on this export's own bundles,
    // so an OR that treats the declaration as sufficient would accept a
    // future dialect schema "2" under v1 assumptions.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-v02-refuse-"));
    try {
      bundleWithMarkers(dir, "2", "0.2");
      expect(() => readOkfBundle(dir)).toThrow("unsupported OKF schema: expected 1, got 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a schema-less bundle whose index declares no version is refused by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-v02-none-"));
    try {
      bundleWithMarkers(dir, null, null);
      expect(() => readOkfBundle(dir)).toThrow("unsupported OKF schema");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bundle with neither marker is refused by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-v02-refuse-"));
    try {
      bundleWithMarkers(dir, "999", "9.9");
      expect(() => readOkfBundle(dir)).toThrow("unsupported OKF schema: expected 1, got 999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Rewrite the bundle's manifest so `schema` is an EXPLICIT JSON null -
   * a writer that nulls the field declares no schema just as surely as
   * one that omits it, and the gate must not read null as a PRESENT
   * wrong schema.
   */
  function withExplicitNullSchema(dir: string): void {
    const manifestPath = join(dir, "okf.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["schema"] = null;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  }

  test("a null manifest schema beside a v0.2 index is treated as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-nullschema-"));
    try {
      bundleWithMarkers(dir, null, "0.2");
      withExplicitNullSchema(dir);
      const parsed = readOkfBundle(dir);
      expect(parsed.pages.length).toBe(1);
      // The on-disk declaration is still what the parsed manifest shows:
      // null is no string schema, so the reader reports "".
      expect(parsed.manifest.schema).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a null schema with no index declaration is refused naming the expectation", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-nullschema-none-"));
    try {
      bundleWithMarkers(dir, null, null);
      withExplicitNullSchema(dir);
      expect(() => readOkfBundle(dir)).toThrow(
        "unsupported OKF schema: no schema 1 in okf.json and no okf_version 0.2 declaration in index.md",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a trusted own-producer round-trip restores native frontmatter, not the derived block", () => {
    // The v0.2 derived keys are recomputed on every export, and the
    // closed status enum cannot name this system's own statuses. The
    // export therefore carries the native values under the producer
    // namespace (okf_status_raw / okf_sources_raw / okf_generated_raw)
    // beside the derived block, and a trusted own-producer import
    // restores them and drops the derived block: a page quarantined
    // before export is quarantined again instead of being silently
    // promoted to the enum's `stable` by its own round-trip.
    note("Notes/Q.md", "---\ntitle: Q\nstatus: quarantine\n---\nbody.\n");
    note("Notes/Done.md", "---\ntitle: Done\nstatus: done\n---\nbody.\n");
    note("Notes/G.md", "---\ntitle: G\ngenerated: hand-written\n---\nbody.\n");
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nsee [[Q]].\n");
    note("Notes/S.md", "---\ntitle: S\nsources: [https://example.com/orig]\n---\nsee [[Q]].\n");
    const bundle = buildOkfBundle(vault);
    // The export carries the raw values beside the derived block.
    const qPage = fileOf(bundle.files, "concepts/Q.md");
    expect(qPage).toContain("status: stable");
    expect(qPage).toContain("okf_status_raw: quarantine");
    // Every page of a fresh export declares raw-carrying, raw keys or
    // not, and names the natives the exporter manages.
    expect(qPage).toContain("okf_raw: [status, sources, generated, type]");

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-rt-bundle-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-rt-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      expect(result.written).toContain("Notes/Q.md");
      // Quarantine survives: the derived `stable` is dropped, the raw
      // status is restored, and no namespaced key is left behind.
      const landedQ = readFileSync(join(dest, "Notes/Q.md"), "utf8");
      expect(landedQ).toContain("status: quarantine");
      expect(landedQ).not.toContain("status: stable");
      expect(landedQ).not.toContain("okf_status_raw");
      expect(landedQ).not.toContain("generated:");
      expect(landedQ).toContain("body.");
      // Completion states come back too: `done` is `done`, not `stable`.
      const landedDone = readFileSync(join(dest, "Notes/Done.md"), "utf8");
      expect(landedDone).toContain("status: done");
      expect(landedDone).not.toContain("status: stable");
      // A native generated value is restored, not the derived block.
      const landedG = readFileSync(join(dest, "Notes/G.md"), "utf8");
      expect(landedG).toContain("generated: hand-written");
      expect(landedG).not.toContain("open-second-brain/");
      // A page whose source carried none of the three fields exports no
      // raw keys - but its bundle file carries the okf_raw marker, so
      // the import reads the absent raw keys as "the field never had a
      // value" and strips the derived block: the plain page comes back
      // plain, with no `status: stable` materialized out of nothing
      // that the next export would carry as a raw native.
      const landedPlain = readFileSync(join(dest, "Notes/Plain.md"), "utf8");
      expect(landedPlain).not.toContain("status:");
      expect(landedPlain).not.toContain("sources:");
      expect(landedPlain).not.toContain("generated:");
      expect(landedPlain).not.toContain("okf_raw");
      expect(landedPlain).toContain("see [[Q]].");
      // User-written sources come back; the derived flow map does not.
      // The writer quotes array items on re-render - the DATA is what is
      // pinned, in its deterministic written form.
      const landedS = readFileSync(join(dest, "Notes/S.md"), "utf8");
      expect(landedS).toContain('sources: ["https://example.com/orig"]');
      expect(landedS).not.toContain("{resource:");
      // Re-export is deterministic: the restored state re-exports as the
      // same raw + derived shape, byte-identical modulo the shared
      // generated instant. The marker declared the type pair, so the
      // first import stripped the derived type along with the rest of
      // the block - nothing materialized, nothing to carry raw, and the
      // round-trip converges from the first export instead of drifting
      // one step into a native type.
      const re = buildOkfBundle(dest);
      const reQ = fileOf(re.files, "concepts/Q.md");
      expect(reQ.split(re.manifest.generated_at).join(bundle.manifest.generated_at)).toBe(qPage);

      // From there the shape is stable: importing the re-export strips
      // the derived block again, and a third export is byte-identical to
      // the second.
      const dir2 = mkdtempSync(join(tmpdir(), "o2b-okf-rt-bundle2-"));
      const dest2 = mkdtempSync(join(tmpdir(), "o2b-okf-rt-dest2-"));
      try {
        writeOkfBundle(dir2, re);
        const result2 = importOkfBundle(dest2, readOkfBundle(dir2), { trusted: true });
        expect(result2.errors).toEqual([]);
        const landedQ2 = readFileSync(join(dest2, "Notes/Q.md"), "utf8");
        expect(landedQ2).toContain("status: quarantine");
        expect(landedQ2).not.toContain("type:");
        const re2 = buildOkfBundle(dest2);
        expect(
          fileOf(re2.files, "concepts/Q.md")
            .split(re2.manifest.generated_at)
            .join(re.manifest.generated_at),
        ).toBe(reQ);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
        rmSync(dest2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a legacy own-producer page (no raw-carry marker) keeps its natives on a trusted import", () => {
    // Bundles exported before the raw-carrying declaration existed
    // carried the page's native status / sources / generated in place,
    // with no okf_raw marker to say otherwise. The restore branch runs
    // only on a marked page, so a marker-less page imports untouched:
    // its frontmatter already IS the native state, and reading absent
    // raw keys as "the field never had a value" would delete exactly
    // those natives - a legacy bundle's trusted round-trip once lost
    // every page's status, quarantine included.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-legacy-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-legacy-dest-"));
    try {
      mkdirSync(join(dir, "concepts"), { recursive: true });
      const manifest = {
        schema: OKF_SCHEMA_VERSION,
        producer: OKF_PRODUCER,
        generated_at: "2026-06-01T00:00:00Z",
        vault_basename: "Legacy",
        log_days: 0,
        pages: [
          {
            id: "Topic",
            path: "Notes/Topic.md",
            class: "concept",
            bundle_path: "concepts/Topic.md",
            kind: "note",
            citations: [],
            status: "deprecated",
            sources: [],
            aliases: [],
            freshness: null,
            foreign_type: null,
            producer_meta: {},
          },
        ],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      writeFileSync(
        join(dir, "concepts/Topic.md"),
        "---\ntitle: Topic\nstatus: quarantine\nsources: [https://example.com/orig]\ngenerated: by-hand\n---\nBody.\n",
        "utf8",
      );
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Topic.md"), "utf8");
      expect(landed).toContain("status: quarantine");
      expect(landed).toContain('sources: ["https://example.com/orig"]');
      expect(landed).toContain("generated: by-hand");
      expect(landed).not.toContain("okf_status_raw");
      expect(landed).toContain("Body.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a marker-less page carrying raw keys still restores its natives", () => {
    // The raw keys and the okf_raw marker ship together, so no released
    // bundle can carry one without the other - but a page that keeps the
    // keys and loses the marker must not fall back to the legacy path:
    // the raw keys are themselves the declaration that this page's
    // natives ride beside the derived block. The legacy early-return
    // stranded them - the derived `stable` landed, the carrier rode
    // along beside it, and the next export carried the materialized
    // status as a raw native, permanent.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-rawnomark-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-rawnomark-dest-"));
    try {
      mkdirSync(join(dir, "concepts"), { recursive: true });
      const manifest = {
        schema: OKF_SCHEMA_VERSION,
        producer: OKF_PRODUCER,
        generated_at: "2026-06-01T00:00:00Z",
        vault_basename: "Markerless",
        log_days: 0,
        pages: [
          {
            id: "Topic",
            path: "Notes/Topic.md",
            class: "concept",
            bundle_path: "concepts/Topic.md",
            kind: "note",
            citations: [],
            status: "stable",
            sources: [],
            aliases: [],
            freshness: null,
            foreign_type: null,
            producer_meta: {},
          },
        ],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      writeFileSync(
        join(dir, "concepts/Topic.md"),
        "---\ntitle: Topic\nokf_status_raw: quarantine\nstatus: stable\n---\nBody.\n",
        "utf8",
      );
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Topic.md"), "utf8");
      // The raw status is restored and the derived block shed, exactly
      // as if the marker had been present beside the keys.
      expect(landed).toContain("status: quarantine");
      expect(landed).not.toContain("status: stable");
      expect(landed).not.toContain("okf_status_raw");
      expect(landed).not.toContain("sources:");
      expect(landed).not.toContain("generated:");
      expect(landed).toContain("Body.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a fresh-export plain page round-trips without gaining the derived block", () => {
    // A page whose source carried no status / sources / generated exports
    // no raw keys - but it is still a raw-carrying exporter's page, and
    // its bundle file says so with the okf_raw marker beside the derived
    // block. The import must read the absent raw keys as "the field
    // never had a value" and strip the derived block, so the plain page
    // comes back plain. Reading the zero-raw-key shape as a legacy page
    // instead materialized `status: stable` where none existed - and the
    // next export then carried the materialized status as a raw native,
    // permanent.
    note("Notes/Plain.md", "---\ntitle: Plain\n---\nsee [[Q]].\n");
    const bundle = buildOkfBundle(vault);
    // The marker declares raw-carrying on every page of a fresh export,
    // raw keys or not, naming the full coverage the exporter manages.
    const plainPage = fileOf(bundle.files, "concepts/Plain.md");
    expect(plainPage).toContain("okf_raw: [status, sources, generated, type]");
    expect(plainPage).toContain("status: stable");

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-plain-rt-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-plain-rt-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const parsed = readOkfBundle(dir);
      expect(parsed.foreign).toBe(false);
      const result = importOkfBundle(dest, parsed, { trusted: true });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Notes/Plain.md"), "utf8");
      // The derived block is stripped, not landed: no status the closed
      // enum materialized out of nothing, no generated stamp - and no
      // marker machinery left behind either.
      expect(landed).not.toContain("status:");
      expect(landed).not.toContain("generated:");
      expect(landed).not.toContain("okf_raw");
      expect(landed).toContain("title: Plain");
      expect(landed).toContain("see [[Q]].");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a non-string native status round-trips through the raw key", () => {
    // The raw status was carried through the string-only field reader: a
    // numeric or whitespace-only status was exported with no raw key at
    // all, and the trusted restore then deleted the field wholesale. The
    // raw key now carries whatever the frontmatter holds, and the
    // restore keys on presence, not shape - the same rule sources and
    // generated already follow. (A frontmatter map built in memory, as
    // the knowledge-pack subset path does, can hold non-string scalars
    // the file scanner would parse into strings.)
    const page = (id: string, status: FrontmatterValue): OkfPage => ({
      id,
      path: `Notes/${id}.md`,
      cls: "concept",
      bundle_path: `concepts/${id}.md`,
      kind: "note",
      citations: [],
      status: "stable",
      aliases: [],
      freshness: null,
      foreign_type: null,
      producer_meta: {},
      frontmatter: { title: id, status },
      body: "body.",
    });
    const bundle = buildOkfSubsetBundle(vault, [page("Num", 42), page("Ws", "  ")]);
    // The export carries both under the raw key, beside the derived block.
    expect(fileOf(bundle.files, "concepts/Num.md")).toContain("okf_status_raw: 42");
    expect(fileOf(bundle.files, "concepts/Ws.md")).toContain('okf_status_raw: "  "');

    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-rawshape-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-rawshape-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const result = importOkfBundle(dest, readOkfBundle(dir), { trusted: true });
      expect(result.errors).toEqual([]);
      const landedNum = readFileSync(join(dest, "Notes/Num.md"), "utf8");
      expect(landedNum).toContain("status: 42");
      expect(landedNum).not.toContain("status: stable");
      expect(landedNum).not.toContain("okf_status_raw");
      const [landedWsMeta] = parseFrontmatter(join(dest, "Notes/Ws.md"));
      expect(landedWsMeta["status"]).toBe("  ");
      expect(landedWsMeta["okf_status_raw"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a foreign bundle's derived keys ride a trusted import verbatim", () => {
    // Foreign bundles import as-is: the derived block is the bundle's
    // own data, never restored away and never re-stamped, and no raw
    // keys are read on a foreign producer's word.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-foreign-v02-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-foreign-v02-dest-"));
    try {
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
            status: "stable",
            sources: [],
            aliases: [],
            freshness: null,
            foreign_type: null,
            producer_meta: {},
          },
        ],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      writeFileSync(
        join(dir, "concepts/Topic.md"),
        '---\ntitle: Topic\nstatus: stable\nsources:\n  - {resource: "concepts/Other.md", id: "Other"}\ngenerated: {by: "some-other-wiki/9", at: "2026-06-01T00:00:00Z"}\n---\nBody.\n',
        "utf8",
      );
      const result = importOkfBundle(dest, readOkfBundle(dir), {
        trusted: true,
        now: new Date(0),
      });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Concepts/Topic.md"), "utf8");
      expect(landed).toContain("status: stable");
      expect(landed).toContain("concepts/Other.md");
      expect(landed).toContain("some-other-wiki/9");
      expect(landed).not.toContain("okf_status_raw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("an own-producer bundle staged untrusted keeps its real status and sheds the raw keys", () => {
    // The restore keys on the PRODUCER, not on the operator's vouch: a
    // staged page is already marked okf_review: pending, so restoring the
    // native status there cannot promote anything into the live vault -
    // while skipping the restore is the exact regression the raw keys
    // exist to fix (a quarantined page lands `stable` on review).
    note("Notes/Q.md", "---\ntitle: Q\nstatus: quarantine\n---\nbody.\n");
    const bundle = buildOkfBundle(vault);
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-review-rt-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-review-rt-dest-"));
    try {
      writeOkfBundle(dir, bundle);
      const result = importOkfBundle(dest, readOkfBundle(dir));
      expect(result.mode).toBe("review");
      expect(result.errors).toEqual([]);
      const staged = readFileSync(join(dest, OKF_REVIEW_REL, "Notes/Q.md"), "utf8");
      expect(staged).toContain("status: quarantine");
      expect(staged).not.toContain("status: stable");
      expect(staged).toContain("okf_review: pending");
      expect(staged).not.toContain("okf_status_raw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a foreign bundle cannot plant the raw machinery keys", () => {
    // okf_status_raw / okf_sources_raw / okf_generated_raw are this
    // system's restore machinery: a foreign producer's word neither
    // triggers the restore nor leaves the keys behind as stray machinery
    // in the vault - the page imports verbatim minus the namespace.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-foreign-raw-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-foreign-raw-dest-"));
    try {
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
            status: "stable",
            sources: [],
            aliases: [],
            freshness: null,
            foreign_type: null,
            producer_meta: {},
          },
        ],
      };
      writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
      writeFileSync(
        join(dir, "concepts/Topic.md"),
        "---\ntitle: Topic\nstatus: stable\nokf_status_raw: quarantine\nokf_sources_raw: [planted]\nokf_generated_raw: forged\n---\nBody.\n",
        "utf8",
      );
      const result = importOkfBundle(dest, readOkfBundle(dir), {
        trusted: true,
        now: new Date(0),
      });
      expect(result.errors).toEqual([]);
      const landed = readFileSync(join(dest, "Concepts/Topic.md"), "utf8");
      expect(landed).toContain("status: stable");
      expect(landed).not.toContain("okf_status_raw");
      expect(landed).not.toContain("okf_sources_raw");
      expect(landed).not.toContain("okf_generated_raw");
      expect(landed).not.toContain("planted");
      expect(landed).not.toContain("forged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("a sealed knowledge-pack half carrying a v0.2 okf.json installs", () => {
    const packDir = mkdtempSync(join(tmpdir(), "o2b-okf-pack-"));
    const dest = mkdtempSync(join(tmpdir(), "o2b-okf-pack-dest-"));
    try {
      const okfManifest = {
        schema: "",
        producer: OKF_PRODUCER,
        generated_at: "2026-06-01T00:00:00Z",
        vault_basename: "Packed",
        log_days: 0,
        pages: [
          {
            id: "runbook",
            path: "Notes/runbook.md",
            class: "concept" as const,
            bundle_path: "concepts/runbook.md",
            kind: "note",
            citations: [],
            status: "stable" as const,
            sources: [],
            aliases: [] as string[],
            freshness: null,
            foreign_type: null,
            producer_meta: {},
          },
        ],
      };
      const sealed = sealKnowledgePack({
        name: "v02-pack",
        version: "1.0.0",
        selection: ["tag:ops"],
        okfManifest,
        // The index carries the v0.2 declaration the manifest schema
        // does not; the seal hashes exactly these bytes.
        pageFiles: [
          { path: "index.md", contents: '---\nokf_version: "0.2"\n---\n# Packed\n' },
          { path: "concepts/runbook.md", contents: "---\ntitle: Runbook\n---\nRestart.\n" },
        ],
        preferences: [],
      });
      writeOkfBundle(packDir, { manifest: okfManifest, files: sealed.files });

      const pack = readKnowledgePack(packDir);
      expect(pack.integrity.verified).toBe(true);
      const result = installKnowledgePack(dest, pack);
      expect(result.pages.written).toEqual([`${OKF_REVIEW_REL}/Notes/runbook.md`]);
      expect(existsSync(join(dest, OKF_REVIEW_REL, "Notes", "runbook.md"))).toBe(true);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
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
      expect(result.skipped).toContain(`${OKF_REVIEW_REL}/Notes/Alpha.md`);
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

/**
 * Hand-built single-page bundles for the recorded-path trust walls
 * (t_sec_okf_lane): `..` can never escape the review lane, Brain
 * machinery is writable only by this producer's own trusted round-trip,
 * and foreign pages do not arrive speaking in this system's voice.
 */
describe("import path lanes (t_sec_okf_lane)", () => {
  function singlePageBundle(
    dir: string,
    producer: string,
    pagePath: string,
    pageFrontmatter: string,
  ): void {
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const manifest = {
      schema: OKF_SCHEMA_VERSION,
      producer,
      generated_at: "2026-06-01T00:00:00Z",
      vault_basename: "Lane",
      log_days: 0,
      pages: [
        {
          id: "Topic",
          path: pagePath,
          class: "concept",
          bundle_path: "concepts/Topic.md",
          kind: "note",
          citations: [],
          aliases: [],
          freshness: null,
          foreign_type: null,
          producer_meta: {},
        },
      ],
    };
    writeFileSync(join(dir, "okf.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(dir, "concepts/Topic.md"), `---\n${pageFrontmatter}---\nBody.\n`, "utf8");
  }

  test("review mode refuses a '..' recorded path instead of staging into Brain", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(dir, OKF_PRODUCER, "../Brain/standing-rules.md", "title: S\n");
      const result = importOkfBundle(vault, readOkfBundle(dir));
      expect(result.written).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("'..'");
      // Neither the live machinery file nor a staging-prefixed copy exists.
      expect(existsSync(join(vault, "Brain/standing-rules.md"))).toBe(false);
      expect(existsSync(join(vault, OKF_REVIEW_REL, "Brain/standing-rules.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted import of a foreign bundle refuses Brain machinery paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(dir, "some-other-wiki", "Brain/standing-rules.md", "title: S\n");
      const result = importOkfBundle(vault, readOkfBundle(dir), { trusted: true });
      expect(result.written).toEqual([]);
      expect(result.errors[0]?.message).toContain("Brain machinery");
      expect(existsSync(join(vault, "Brain/standing-rules.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted own-producer round-trip still writes the Brain sources lane", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(dir, OKF_PRODUCER, "Brain/sources/src-paper.md", "title: Paper\n");
      const result = importOkfBundle(vault, readOkfBundle(dir), { trusted: true });
      expect(result.errors).toEqual([]);
      expect(result.written).toEqual(["Brain/sources/src-paper.md"]);
      expect(existsSync(join(vault, "Brain/sources/src-paper.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted own-producer round-trip refuses Brain machinery outside the page lanes", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(dir, OKF_PRODUCER, "Brain/standing-rules.md", "title: S\n");
      const result = importOkfBundle(vault, readOkfBundle(dir), { trusted: true });
      expect(result.written).toEqual([]);
      expect(result.errors[0]?.message).toContain("Brain machinery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a foreign staged page arrives without machinery frontmatter keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(
        dir,
        "some-other-wiki",
        "Concepts/Topic.md",
        "title: Topic\n_status: confirmed\n_confidence: high\nowner: someone\norigin_channel: cli\n_revision: 99\n",
      );
      const result = importOkfBundle(vault, readOkfBundle(dir), {
        trusted: true,
        now: new Date(0),
      });
      expect(result.errors).toEqual([]);
      const written = readFileSync(join(vault, "Concepts/Topic.md"), "utf8");
      expect(written).not.toContain("_status:");
      expect(written).not.toContain("_confidence:");
      expect(written).not.toContain("owner:");
      expect(written).not.toContain("origin_channel:");
      expect(written).not.toContain("_revision:");
      expect(written).toContain("okf_producer: some-other-wiki");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("this producer's own round-trip stays lossless (machinery keys survive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(
        dir,
        OKF_PRODUCER,
        "Notes/Topic.md",
        "title: Topic\n_status: confirmed\nowner: someone\n",
      );
      const result = importOkfBundle(vault, readOkfBundle(dir), { trusted: true });
      expect(result.errors).toEqual([]);
      const written = readFileSync(join(vault, "Notes/Topic.md"), "utf8");
      expect(written).toContain("_status: confirmed");
      expect(written).toContain("owner: someone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a forged own-producer claim does not carry machinery keys into review", () => {
    // `producer` is bundle-supplied: any bundle can claim to be this
    // system. Without the operator's --trusted the claim buys nothing.
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(
        dir,
        OKF_PRODUCER,
        "Notes/Topic.md",
        "title: Topic\n_status: confirmed\n_force_confirmed_via: cli\nowner: someone\norigin_channel: cli\n",
      );
      const result = importOkfBundle(vault, readOkfBundle(dir));
      expect(result.errors).toEqual([]);
      const written = readFileSync(join(vault, OKF_REVIEW_REL, "Notes/Topic.md"), "utf8");
      expect(written).not.toContain("_status:");
      expect(written).not.toContain("_force_confirmed_via:");
      expect(written).not.toContain("owner:");
      expect(written).not.toContain("origin_channel:");
      expect(written).toContain("okf_review: pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a staged page keeps its visibility: stripping it could only widen reach", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(
        dir,
        OKF_PRODUCER,
        "Notes/Secret.md",
        "title: Secret\nvisibility: private\n",
      );
      importOkfBundle(vault, readOkfBundle(dir));
      const written = readFileSync(join(vault, OKF_REVIEW_REL, "Notes/Secret.md"), "utf8");
      expect(written).toContain("visibility: private");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trusted import compares the Brain segment case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      singlePageBundle(dir, OKF_PRODUCER, "brain/_brain.yaml", "title: S\n");
      const result = importOkfBundle(vault, readOkfBundle(dir), { trusted: true });
      expect(result.written).toEqual([]);
      expect(result.errors[0]?.message).toContain("Brain machinery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the Brain page lanes open on the operator's --trusted, not on the producer claim", () => {
    const own = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    const other = mkdtempSync(join(tmpdir(), "o2b-okf-lane-"));
    try {
      // Claiming this producer without --trusted: staged, lane untouched.
      singlePageBundle(own, OKF_PRODUCER, "Brain/sources/src-paper.md", "title: Paper\n");
      const review = importOkfBundle(vault, readOkfBundle(own));
      expect(review.written).toEqual([`${OKF_REVIEW_REL}/Brain/sources/src-paper.md`]);
      expect(existsSync(join(vault, "Brain/sources/src-paper.md"))).toBe(false);
      // Declaring a foreign producer with --trusted: the operator vouched,
      // so the lane opens - with machinery keys still stripped.
      singlePageBundle(
        other,
        "some-other-wiki",
        "Brain/reports/2026-06-01-r.md",
        "title: R\n_status: confirmed\n",
      );
      const trusted = importOkfBundle(vault, readOkfBundle(other), { trusted: true });
      expect(trusted.written).toEqual(["Brain/reports/2026-06-01-r.md"]);
      const written = readFileSync(join(vault, "Brain/reports/2026-06-01-r.md"), "utf8");
      expect(written).not.toContain("_status:");
    } finally {
      rmSync(own, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
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

  test("rejects bundle file paths that escape the output directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-okf-escape-write-"));
    const outside = mkdtempSync(join(tmpdir(), "o2b-okf-outside-"));
    try {
      const outsideName = outside.split("/").pop()!;
      const bundle = {
        manifest: {
          schema: OKF_SCHEMA_VERSION,
          producer: OKF_PRODUCER,
          generated_at: "2026-06-01T00:00:00Z",
          vault_basename: "Vault",
          pages: [],
          log_days: 0,
        },
        files: [{ path: `../${outsideName}/pwned.md`, contents: "nope\n" }],
      };

      expect(() => writeOkfBundle(dir, bundle)).toThrow(/path escapes vault/);
      expect(existsSync(join(outside, "pwned.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
