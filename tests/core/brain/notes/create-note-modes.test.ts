/**
 * createNote authoring modes (provenance-at-the-boundary, Unit C):
 * `ifExists: "skip"`, `strict` pre-write validation, and template-mode
 * bodies.
 *
 * Three properties are load-bearing and each has its own test here:
 *
 *   - With none of the three options set, the primitive is
 *     byte-identical to the release before them. The sharp form of that
 *     is a document the strict validator would reject (no frontmatter at
 *     all) still being written when `strict` is unset.
 *   - A skip is DISCRIMINATED from a create. Returning the same shape
 *     for both would be the silent fallback this wave forbids, so the
 *     result carries an `outcome` a caller cannot misread, and a skipped
 *     call leaves the vault tree byte-for-byte unchanged.
 *   - The write-batch surface keeps refusing an existing target. Batches
 *     are all-or-nothing; a per-operation skip would make "applied"
 *     mean two different things in one result list.
 *
 * The pre-existing refusal behaviour is pinned by `create-note.test.ts`,
 * which stays untouched and green.
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
import { join, relative } from "node:path";

import {
  createNote,
  CreateNoteError,
  type CreateNoteResult,
} from "../../../../src/core/brain/notes/create-note.ts";
import { applyWriteBatch, WriteBatchError } from "../../../../src/core/brain/write-batch.ts";

/**
 * One raw C0 control character, built rather than typed so it is
 * visible in source and survives a formatter. `validateArtifact`
 * rejects any C0 byte except tab, newline and carriage return.
 */
const CONTROL_CHAR = String.fromCharCode(7);

/** The YAML fence `formatFrontmatter` opens and closes the block with. */
const FRONTMATTER_FENCE = "---";
/** What separates a frontmatter key from its value on one line. */
const FRONTMATTER_KEY_SEPARATOR = ":";

/**
 * One fixed create input, reused so the with-options and without-options
 * cases differ in exactly one thing: whether an option was supplied. It
 * carries three frontmatter keys in a deliberate, non-alphabetical order,
 * because a reordering is one of the two ways the bytes can move without
 * any assertion on `created`/`outcome` noticing.
 */
const BASELINE_INPUT = Object.freeze({
  path: "Notes/Golden.md",
  frontmatter: Object.freeze({ title: "Golden", type: "note", tags: Object.freeze(["a", "b"]) }),
  content: "Body line one.\n\nBody line two.",
});

/**
 * The exact bytes {@link BASELINE_INPUT} produced with none of the three
 * authoring options set, captured from the primitive as it stood before
 * they existed. Pinned as a literal rather than recomputed from the
 * implementation, because an expectation derived from the implementation
 * cannot notice the implementation moving: an unconditional spread adding
 * one frontmatter key, or a reordering of the block, changes this string
 * and nothing else in this file.
 */
const GOLDEN_BASELINE_NOTE =
  "---\ntitle: Golden\ntype: note\ntags: [a, b]\n---\n\nBody line one.\n\nBody line two.\n";

/** Frontmatter key order of the pre-feature note, top to bottom. */
const GOLDEN_BASELINE_FRONTMATTER_KEYS: ReadonlyArray<string> = Object.freeze([
  "title",
  "type",
  "tags",
]);

/** The pre-feature bytes for a note with no frontmatter map at all. */
const GOLDEN_BARE_NOTE = "---\n---\n\njust a body\n";

/** Result field order the MCP surface and the SDK both read. */
const GOLDEN_RESULT_KEYS: ReadonlyArray<string> = Object.freeze(["path", "outcome", "created"]);

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-create-note-modes-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

/** Every path under `root`, with file bytes, so "changed nothing" is checkable. */
function snapshotTree(root: string): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).toSorted()) {
      const abs = join(dir, entry);
      const rel = relative(root, abs);
      if (statSync(abs).isDirectory()) {
        out.push(`dir  ${rel}`);
        walk(abs);
      } else {
        out.push(`file ${rel} ${readFileSync(abs, "utf8")}`);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Frontmatter keys of a written note, in the order they appear on disk.
 * Order is half of what byte-identity means here: the same set of keys
 * emitted in a different sequence is a different file, and a test that
 * compared sets would not see it. A note with no frontmatter block is a
 * caller error rather than an empty list - absence and "could not parse"
 * must not collapse into one answer.
 */
function frontmatterKeys(markdown: string): ReadonlyArray<string> {
  const lines = markdown.split("\n");
  const end = lines[0] === FRONTMATTER_FENCE ? lines.indexOf(FRONTMATTER_FENCE, 1) : -1;
  if (end < 0) {
    throw new Error(`note carries no frontmatter block: ${JSON.stringify(markdown)}`);
  }
  return lines.slice(1, end).map((line) => {
    const colon = line.indexOf(FRONTMATTER_KEY_SEPARATOR);
    if (colon < 0) throw new Error(`frontmatter line carries no key: ${JSON.stringify(line)}`);
    return line.slice(0, colon);
  });
}

/** Read one written note back as raw text, so disk is checked, not memory. */
function writtenNote(path: string): string {
  return readFileSync(join(vault, path), "utf8");
}

describe("createNote - the new options are byte-identical when absent", () => {
  test("with none of the options set the written bytes are the pre-feature golden", () => {
    const res = createNote(vault, { ...BASELINE_INPUT });
    expect(res.outcome).toBe("created");
    // Byte for byte on disk...
    expect(writtenNote(BASELINE_INPUT.path)).toBe(GOLDEN_BASELINE_NOTE);
    // ...frontmatter key order included.
    expect(frontmatterKeys(writtenNote(BASELINE_INPUT.path))).toEqual([
      ...GOLDEN_BASELINE_FRONTMATTER_KEYS,
    ]);
  });

  test("options spread in as undefined write the same bytes as options omitted", () => {
    // That is the shape every conditional spread in this codebase
    // produces when its condition is false, so an option threaded as an
    // explicit `undefined` must not become a different document.
    createNote(vault, {
      ...BASELINE_INPUT,
      ifExists: undefined,
      strict: undefined,
      template: undefined,
      templateVariables: undefined,
    });
    expect(writtenNote(BASELINE_INPUT.path)).toBe(GOLDEN_BASELINE_NOTE);
  });

  test("a document the strict validator would reject is still written when strict is unset", () => {
    // No frontmatter at all: `validateArtifact` reports frontmatter-missing.
    const res = createNote(vault, { path: "Notes/Bare.md", content: "just a body" });
    expect(res.created).toBe(true);
    // The whole file, not a substring: an empty frontmatter block is part
    // of the pre-feature shape and a body-only file is not the same note.
    expect(writtenNote("Notes/Bare.md")).toBe(GOLDEN_BARE_NOTE);
  });

  test("with ifExists unset an existing target is still refused with the exists code", () => {
    createNote(vault, { path: "Notes/Once.md", content: "first" });
    try {
      createNote(vault, { path: "Notes/Once.md", content: "second" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNoteError);
      expect((err as CreateNoteError).code).toBe("exists");
    }
    expect(readFileSync(join(vault, "Notes/Once.md"), "utf8")).toContain("first");
  });

  test("a create reports the created outcome alongside the frozen created flag", () => {
    const res = createNote(vault, { path: "Notes/New.md", content: "x" });
    expect(res.outcome).toBe("created");
    expect(res.created).toBe(true);
    // The result envelope is the one addition this unit makes, and it is
    // pinned in full so a fourth field cannot arrive unannounced.
    expect(Object.keys(res)).toEqual([...GOLDEN_RESULT_KEYS]);
  });
});

describe('createNote - ifExists: "skip"', () => {
  test("an existing target returns a skipped outcome a caller cannot read as a create", () => {
    createNote(vault, { path: "Notes/Dup.md", content: "original" });
    const res: CreateNoteResult = createNote(vault, {
      path: "Notes/Dup.md",
      content: "replacement",
      ifExists: "skip",
    });
    expect(res.outcome).toBe("skipped");
    expect(res.created).toBe(false);
    expect(res.path).toBe("Notes/Dup.md");
    expect(readFileSync(join(vault, "Notes/Dup.md"), "utf8")).toContain("original");
  });

  test("a skip leaves the vault tree byte-for-byte unchanged, directories included", () => {
    createNote(vault, { path: "A/B/C/Deep.md", content: "original" });
    const before = snapshotTree(vault);
    const res = createNote(vault, {
      path: "A/B/C/Deep.md",
      content: "replacement",
      ifExists: "skip",
    });
    expect(res.outcome).toBe("skipped");
    expect(snapshotTree(vault)).toEqual([...before]);
  });

  test("a free target under skip is created normally", () => {
    const res = createNote(vault, { path: "Notes/Fresh.md", content: "x", ifExists: "skip" });
    expect(res.outcome).toBe("created");
    expect(res.created).toBe(true);
    expect(existsSync(join(vault, "Notes/Fresh.md"))).toBe(true);
  });

  test("an explicit refuse behaves exactly like the default", () => {
    createNote(vault, { path: "Notes/R.md", content: "first" });
    expect(() =>
      createNote(vault, { path: "Notes/R.md", content: "second", ifExists: "refuse" }),
    ).toThrow(CreateNoteError);
  });

  test("skip does not relax any other refusal - traversal is still typed", () => {
    expect(() => createNote(vault, { path: "../escape.md", ifExists: "skip" })).toThrow(
      CreateNoteError,
    );
  });
});

describe("createNote - strict pre-write validation", () => {
  test("a valid document passes and is written", () => {
    const res = createNote(vault, {
      path: "Notes/Good.md",
      frontmatter: { title: "Good", type: "note" },
      content: "Body.",
      strict: true,
    });
    expect(res.outcome).toBe("created");
  });

  test("a document with no frontmatter is refused with the validator's coded violation", () => {
    try {
      createNote(vault, { path: "Notes/Bad.md", content: "body only", strict: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNoteError);
      const e = err as CreateNoteError;
      expect(e.code).toBe("invalid_document");
      expect(e.violations.map((v) => v.code)).toContain("frontmatter-missing");
    }
    expect(existsSync(join(vault, "Notes/Bad.md"))).toBe(false);
  });

  test("a body carrying raw control characters is refused", () => {
    try {
      createNote(vault, {
        path: "Notes/Ctrl.md",
        frontmatter: { title: "C" },
        content: `a${CONTROL_CHAR}b`,
        strict: true,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CreateNoteError).violations.map((v) => v.code)).toContain(
        "artifact-control-chars",
      );
    }
    expect(existsSync(join(vault, "Notes/Ctrl.md"))).toBe(false);
  });

  test("a declared type outside the vault's page_types vocabulary is refused", () => {
    try {
      createNote(vault, {
        path: "Notes/Typed.md",
        frontmatter: { title: "T", type: "not-a-declared-page-type" },
        content: "body",
        strict: true,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CreateNoteError).violations.map((v) => v.code)).toContain(
        "schema-type-unknown",
      );
    }
  });

  test("strict validates the rendered template body, not the raw template", () => {
    // The template text itself is clean; only the RENDERED body carries
    // the control character, so a strict refusal proves the validator
    // ran after rendering rather than before it.
    try {
      createNote(vault, {
        path: "Notes/Tpl.md",
        template: "start {{body}} end",
        templateVariables: { body: CONTROL_CHAR },
        strict: true,
        frontmatter: { title: "T" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CreateNoteError).violations.map((v) => v.code)).toContain(
        "artifact-control-chars",
      );
    }
    expect(existsSync(join(vault, "Notes/Tpl.md"))).toBe(false);
  });
});

describe("createNote - template mode", () => {
  test("renders typed variables, a presence section and a list iteration into the body", () => {
    const res = createNote(vault, {
      path: "Notes/Rendered.md",
      frontmatter: { title: "R" },
      template: "# {{title}}\n{{#draft}}(draft){{/draft}}\n{{#tags}}- {{.}}\n{{/tags}}{{ typo }}",
      templateVariables: { title: "R", draft: true, tags: ["a", "b"] },
    });
    expect(res.outcome).toBe("created");
    const md = readFileSync(join(vault, "Notes/Rendered.md"), "utf8");
    expect(md).toContain("# R");
    expect(md).toContain("(draft)");
    expect(md).toContain("- a\n- b\n");
    // The unknown placeholder survives so the typo surfaces in the note.
    expect(md).toContain("{{ typo }}");
  });

  test("a template with no variables renders its literal text", () => {
    createNote(vault, { path: "Notes/Lit.md", template: "plain body" });
    expect(readFileSync(join(vault, "Notes/Lit.md"), "utf8")).toContain("plain body");
  });

  test("content and template together are refused rather than one silently winning", () => {
    try {
      createNote(vault, { path: "Notes/Both.md", content: "a", template: "b" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNoteError);
      expect((err as CreateNoteError).code).toBe("invalid_template");
    }
    expect(existsSync(join(vault, "Notes/Both.md"))).toBe(false);
  });

  test("template variables without a template are refused", () => {
    expect(() =>
      createNote(vault, { path: "Notes/Orphan.md", templateVariables: { a: "b" } }),
    ).toThrow(CreateNoteError);
    expect(existsSync(join(vault, "Notes/Orphan.md"))).toBe(false);
  });

  test("a malformed template is refused and writes nothing", () => {
    try {
      createNote(vault, { path: "Notes/Broken.md", template: "{{#a}}x", templateVariables: {} });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CreateNoteError).code).toBe("invalid_template");
    }
    expect(existsSync(join(vault, "Notes/Broken.md"))).toBe(false);
  });
});

describe("write_batch keeps refusing an existing target", () => {
  test("a create_note operation on an occupied path aborts the whole batch", () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes/Taken.md"), "original", "utf8");
    try {
      applyWriteBatch(vault, [
        { kind: "create_note", path: "Notes/Fresh.md", content: "x" },
        { kind: "create_note", path: "Notes/Taken.md", content: "y" },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteBatchError);
      expect((err as WriteBatchError).code).toBe("exists");
    }
    // All-or-nothing: the first, valid operation did not land either.
    expect(readFileSync(join(vault, "Notes/Taken.md"), "utf8")).toBe("original");
    expect(existsSync(join(vault, "Notes/Fresh.md"))).toBe(false);
  });

  test("the batch create_note operation exposes no skip policy to opt into", () => {
    const withSkip = {
      kind: "create_note",
      path: "Notes/Taken.md",
      content: "y",
      if_exists: "skip",
    };
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes/Taken.md"), "original", "utf8");
    expect(() =>
      applyWriteBatch(vault, [
        withSkip as unknown as Parameters<typeof applyWriteBatch>[1][number],
      ]),
    ).toThrow(WriteBatchError);
    expect(readFileSync(join(vault, "Notes/Taken.md"), "utf8")).toBe("original");
  });
});
