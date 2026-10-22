/**
 * The content class stamp (F5, write-time honesty and egress consent).
 *
 * `content_class` is the sibling of `origin_channel` on a different axis:
 * not which process wrote the page, but what kind of material the page
 * carries. The vocabulary is closed with ONE member, `prompt-derived` -
 * text an agent produced from a prompt - and one member is enough because
 * the stamp exists for exactly one decision: shared exports leave such
 * pages out by default, and an operator override names them back in.
 *
 * The rules pinned here mirror the origin channel's, because they are the
 * same rules about a second axis:
 *  - the value is server-derived at creation; a caller naming one is
 *    ignored, never honored,
 *  - the key is reserved against caller updates (forge and strip both),
 *  - absence of the key is a meaning - "written before the stamp
 *    existed" - and reads as unmarked, never as a guessed default,
 *  - unknown values refuse at the stamp and read as unmarked on disk,
 *    where a closed vocabulary met a hand editor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTENT_CLASSES,
  CONTENT_CLASS_FIELD,
  CONTENT_CLASS,
  contentClassCreationStamp,
  ContentClassValueError,
  isContentClass,
  omittedPageReferenceMatcher,
  readContentClass,
  resolveContentClass,
} from "../../../../src/core/brain/provenance/content-class.ts";
import { applyWriteBatch, WriteBatchError } from "../../../../src/core/brain/write-batch.ts";
import { createNote } from "../../../../src/core/brain/notes/create-note.ts";
import {
  clearOriginChannel,
  ORIGIN_CHANNEL,
  setOriginChannel,
} from "../../../../src/core/origin-channel.ts";
let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-content-class-"));
});
afterEach(() => {
  clearOriginChannel();
  rmSync(vault, { recursive: true, force: true });
});

describe("the content class vocabulary", () => {
  test("is closed, with prompt-derived as its one member", () => {
    expect(CONTENT_CLASSES).toEqual([CONTENT_CLASS.promptDerived]);
    expect(CONTENT_CLASS.promptDerived).toBe("prompt-derived");
    expect(isContentClass("prompt-derived")).toBe(true);
    expect(isContentClass("operator")).toBe(false);
    expect(isContentClass("prompt")).toBe(false);
    expect(isContentClass(undefined)).toBe(false);
  });

  test("the on-disk key avoids every origin-channel census spelling", () => {
    // The origin-channel census bans four spellings as caller-facing
    // property names; the new key must not collide with any of them, so
    // the two server-derived stamps never become one grep hit.
    for (const banned of ["origin_channel", "originChannel", "origin-channel", "channel"]) {
      expect(CONTENT_CLASS_FIELD.includes(banned)).toBe(false);
    }
    expect(CONTENT_CLASS_FIELD).toBe("content_class");
  });

  test("resolveContentClass refuses unknown values with a named error", () => {
    expect(resolveContentClass("prompt-derived")).toBe("prompt-derived");
    try {
      resolveContentClass("confidential");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ContentClassValueError);
      expect((err as ContentClassValueError).message).toContain("confidential");
      expect((err as ContentClassValueError).message).toContain("prompt-derived");
    }
  });
});

describe("the creation stamp", () => {
  test("an mcp-tool process stamps prompt-derived", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    expect(contentClassCreationStamp(ORIGIN_CHANNEL.mcpTool)).toBe("prompt-derived");
  });

  test("a cli process, an import process, and an unclaimed process stay unmarked", () => {
    expect(contentClassCreationStamp(ORIGIN_CHANNEL.cli)).toBeNull();
    expect(contentClassCreationStamp(ORIGIN_CHANNEL.import)).toBeNull();
    expect(contentClassCreationStamp("unset")).toBeNull();
  });
});

describe("createNote merges the class server-side", () => {
  test("an mcp-tool write stamps the class and a caller-named class loses", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const res = createNote(vault, {
      path: "Notes/FromAgent.md",
      frontmatter: { title: "FromAgent", [CONTENT_CLASS_FIELD]: "operator" },
      content: "body",
    });
    expect(res.created).toBe(true);
    const written = readFileSync(join(vault, "Notes/FromAgent.md"), "utf8");
    expect(written).toContain(`${CONTENT_CLASS_FIELD}: prompt-derived`);
    expect(written).not.toContain("operator");
  });

  test("a cli write stays byte-honest: unmarked, even when the caller names a class", () => {
    const res = createNote(vault, {
      path: "Notes/ByOperator.md",
      frontmatter: { title: "ByOperator", [CONTENT_CLASS_FIELD]: "prompt-derived" },
      content: "body",
    });
    expect(res.created).toBe(true);
    const written = readFileSync(join(vault, "Notes/ByOperator.md"), "utf8");
    expect(written).not.toContain(CONTENT_CLASS_FIELD);
  });
});

describe("an unmarked page reads as unmarked", () => {
  test("absence of the key is the pre-stamp era, not a guess", () => {
    expect(readContentClass({})).toBeNull();
    expect(readContentClass({ title: "Old page" })).toBeNull();
  });

  test("the reserved member reads back; an unknown hand-written value does not mark", () => {
    expect(readContentClass({ [CONTENT_CLASS_FIELD]: "prompt-derived" })).toBe("prompt-derived");
    expect(readContentClass({ [CONTENT_CLASS_FIELD]: "hand-written" })).toBeNull();
  });
});

describe("an update cannot forge or strip the class", () => {
  function seed(rel: string, body: string, frontmatter: string): void {
    const abs = join(vault, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  }

  test("the write batch refuses a caller-named class and names the key", () => {
    seed("Notes/Marked.md", "body", "title: Marked\ncontent_class: prompt-derived");
    try {
      applyWriteBatch(vault, [
        {
          kind: "update_note",
          path: "Notes/Marked.md",
          frontmatter: { [CONTENT_CLASS_FIELD]: "operator" },
        },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("reserved_frontmatter_key");
      expect((err as WriteBatchError).details).toMatchObject({ key: CONTENT_CLASS_FIELD });
    }
    expect(readFileSync(join(vault, "Notes/Marked.md"), "utf8")).toContain(
      `${CONTENT_CLASS_FIELD}: prompt-derived`,
    );
  });

  test("an update that touches other keys preserves the stamp in place", () => {
    seed("Notes/Marked2.md", "body", "title: Marked2\ncontent_class: prompt-derived");
    applyWriteBatch(vault, [
      { kind: "update_note", path: "Notes/Marked2.md", frontmatter: { status: "final" } },
    ]);
    const written = readFileSync(join(vault, "Notes/Marked2.md"), "utf8");
    expect(written).toContain("status: final");
    expect(written).toContain(`${CONTENT_CLASS_FIELD}: prompt-derived`);
  });
});

describe("the omitted-page reference matcher", () => {
  const namesOmitted = omittedPageReferenceMatcher(["Agent Page.md", "Notes/Nested Plan.md"]);

  test("a bare target names an omitted page with or without the .md suffix", () => {
    expect(namesOmitted("Agent Page")).toBe(true);
    expect(namesOmitted("Agent Page.md")).toBe(true);
  });

  test("a path-shaped target matches the exact path, suffix optional", () => {
    expect(namesOmitted("Notes/Nested Plan")).toBe(true);
    expect(namesOmitted("Notes/Nested Plan.md")).toBe(true);
    // A different folder holding the same basename is a different page.
    expect(namesOmitted("Other/Agent Page.md")).toBe(false);
  });

  test("an absolute resource names no vault page", () => {
    expect(namesOmitted("https://example.org/Agent Page")).toBe(false);
  });

  test("anything else names a kept page and stays", () => {
    expect(namesOmitted("Operator Page")).toBe(false);
    expect(namesOmitted("")).toBe(false);
  });
});
