/**
 * The content class at the knowledge-pack seam (F5, tasks E4 + E5).
 *
 * A knowledge pack is a subset EXPORT built to be handed to someone else,
 * and it is the one export that filters by LABEL before it composes: the
 * selection step blocks private entries and names them instead of writing
 * them. The reserved `content_class: prompt-derived` stamp joins that
 * block list beside `visibility` and `owner` - agent-produced material is
 * default-excluded from a pack the same as it is from every other shared
 * export, and the exclusion is named per entry.
 *
 * The no-backfill era boundary lives here too: pages written before the
 * class shipped carry no key, nothing rewrites them, and absence reads as
 * unmarked - a pre-stamp page exports exactly as it did before this
 * release.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTENT_CLASS,
  CONTENT_CLASS_FIELD,
  stampPromptDerivedLine,
} from "../../src/core/brain/provenance/content-class.ts";
import { selectKnowledgePack } from "../../src/core/brain/portability/knowledge-pack.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";

let src: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "o2b-kpack-class-"));
  mkdirSync(brainDirs(src).preferences, { recursive: true });
  mkdirSync(brainDirs(src).log, { recursive: true });
});

afterEach(() => rmSync(src, { recursive: true, force: true }));

function page(rel: string, frontmatter: ReadonlyArray<string>, body: string): void {
  const abs = join(src, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const lines = frontmatter.length > 0 ? ["---", ...frontmatter, "---", ""] : [];
  writeFileSync(abs, `${lines.join("\n")}\n${body}`, "utf8");
}

describe("the knowledge-pack block list", () => {
  test("a prompt-derived page is blocked and named, beside visibility and owner", () => {
    page(
      "Notes/agent-draft.md",
      ["tags: [ops]", `${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}`],
      "Synthesised from a prompt.\n",
    );
    page("Notes/handbook.md", ["tags: [ops]"], "Written by the operator.\n");

    const selected = selectKnowledgePack(src, ["tag:ops"]);
    expect(selected.blocked).toEqual([
      { kind: "page", id: "Notes/agent-draft.md", reason: "prompt-derived" },
    ]);
    // The bundle renders an index beside each carried page; the marked
    // page's file is absent entirely.
    expect(selected.pageFiles.some((f) => f.path.endsWith("agent-draft.md"))).toBe(false);
    expect(selected.pageFiles.some((f) => f.path.endsWith("handbook.md"))).toBe(true);
  });

  test("the block reason survives the guard's narrowing shape", () => {
    // The class a hand editor wrote that this build does not know reads as
    // unmarked - a typo must not silently hide pages from every shared
    // export - so only the reserved member blocks.
    page(
      "Notes/future-class.md",
      ["tags: [ops]", `${CONTENT_CLASS_FIELD}: agent-summary`],
      "A spelling this build does not know.\n",
    );
    page("Notes/handbook.md", ["tags: [ops]"], "Written by the operator.\n");

    const selected = selectKnowledgePack(src, ["tag:ops"]);
    expect(selected.blocked).toEqual([]);
    expect(selected.pageFiles.some((f) => f.path.endsWith("future-class.md"))).toBe(true);
    expect(selected.pageFiles.some((f) => f.path.endsWith("handbook.md"))).toBe(true);
  });

  test("a visibility-scoped page keeps its own reason, not the class one", () => {
    // First match wins, and the operator-set scope is the older, more
    // specific decision; the class check never displaces it.
    page(
      "Notes/scoped.md",
      [
        "tags: [ops]",
        "visibility: private",
        `${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}`,
      ],
      "Scoped AND agent-produced.\n",
    );
    page("Notes/handbook.md", ["tags: [ops]"], "Written by the operator.\n");

    const selected = selectKnowledgePack(src, ["tag:ops"]);
    expect(selected.blocked).toEqual([
      { kind: "page", id: "Notes/scoped.md", reason: "visibility" },
    ]);
  });
});

describe("the no-backfill era boundary", () => {
  test("a pre-stamp page exports unchanged; absence of the mark is the documented era", () => {
    page("Notes/runbook.md", ["tags: [ops]"], "Written before the class shipped.\n");

    const selected = selectKnowledgePack(src, ["tag:ops"]);
    expect(selected.blocked).toEqual([]);
    // The carried page file (the bundle also renders an index.md for it).
    const packed = selected.pageFiles.find((f) => f.path.endsWith("runbook.md"))!;
    expect(packed).toBeDefined();
    // The packed page carries no content_class key: the export path adds
    // nothing, and the pre-stamp era is documented rather than migrated.
    expect(packed.contents).toContain("Written before the class shipped.");
    expect(packed.contents).not.toContain(CONTENT_CLASS_FIELD);
  });

  test("no surface of the stamp rewrites an existing unmarked page", () => {
    // The stamp is creation-time only. Reading the class back, resolving
    // it and stripping a caller-named one are all pure or read-only; the
    // one writer among them (the line stamp) refuses a file without
    // frontmatter rather than inventing one. There is no backfill entry
    // point: nothing here takes a vault and adds the key to what it finds.
    const abs = join(src, "Notes/runbook.md");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "no frontmatter at all\n", "utf8");
    expect(() => stampPromptDerivedLine(abs)).toThrow(/no frontmatter block to stamp/);
    expect(readFileSync(abs, "utf8")).toBe("no frontmatter at all\n");
  });
});
