/**
 * Where {@link stampPromptDerivedLine} puts the stamp line.
 *
 * The stamp is a text insert: one `content_class: prompt-derived` line
 * added inside a page's frontmatter block, every other byte preserved.
 * The only question is WHERE the block ends, and the answer must be the
 * parser's answer - the same boundary `parseFrontmatterText` closes at -
 * because a stamp placed anywhere else is a page that reads unmarked no
 * matter what the bytes say. The cases here are the ones where a raw
 * `"\n---\n"` search disagrees with that boundary: a close fence that
 * carries trailing whitespace, with a bare `---` line further down that
 * the raw search then finds instead, and a close at end-of-file with no
 * trailing newline at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_CLASS_FIELD,
  CONTENT_CLASS,
  readContentClass,
  stampPromptDerivedLine,
} from "../../../../src/core/brain/provenance/content-class.ts";
import { parseFrontmatterText } from "../../../../src/core/vault.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o2b-stamp-boundary-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stamp(raw: string): string {
  const abs = join(dir, "page.md");
  writeFileSync(abs, raw, "utf8");
  stampPromptDerivedLine(abs);
  return readFileSync(abs, "utf8");
}

describe("stampPromptDerivedLine places the stamp at the parser's boundary", () => {
  test("a close the raw search misses stamps inside the block, not after a bare --- line", () => {
    // The close fence carries a trailing space, so the parser closes
    // there (`\n---` plus whitespace) while a raw `"\n---\n"` search
    // cannot see it and runs on to the bare `---` line below. A stamp
    // dropped at THAT line lands outside the parsed block: the page
    // reads unmarked, and the value region the author wrote is where
    // the marker went instead.
    const raw = [
      "---",
      "title: Checkpoint",
      "summary: a value the author continued past a rule",
      "--- ",
      "prose that names a rule:",
      "---",
      "",
      "body text",
      "",
    ].join("\n");
    const stamped = stamp(raw);

    // The page reads marked.
    expect(readContentClass(parseFrontmatterText(stamped)[0])).toBe(CONTENT_CLASS.promptDerived);
    // And the stamp is a frontmatter line, not body content: the body
    // the parser reads is unchanged.
    expect(parseFrontmatterText(stamped)[1]).toBe(parseFrontmatterText(raw)[1]);
    expect(stamped).toContain(
      `summary: a value the author continued past a rule\n` +
        `${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n`,
    );
  });

  test("a close at end-of-file without a trailing newline still stamps", () => {
    // The parser accepts this page (`\n---` at end-of-string closes the
    // block); the raw search found no `"\n---\n"` and refused it as
    // unterminated, leaving a written page unstampable.
    const stamped = stamp("---\ntitle: Final\ndeleted: no\n---");
    expect(readContentClass(parseFrontmatterText(stamped)[0])).toBe(CONTENT_CLASS.promptDerived);
    expect(stamped).toBe(
      `---\ntitle: Final\ndeleted: no\n${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n---`,
    );
  });

  test("a plain page stamps in place and a second stamp is a byte-level no-op", () => {
    const raw = "---\ntitle: Plain\nkind: note\n---\n\nbody\n";
    const once = stamp(raw);
    expect(once).toBe(
      `---\ntitle: Plain\nkind: note\n${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n---\n\nbody\n`,
    );
    const abs = join(dir, "page.md");
    stampPromptDerivedLine(abs);
    expect(readFileSync(abs, "utf8")).toBe(once);
  });

  test("a page already carrying an out-of-vocabulary class is refused, not double-stamped", () => {
    // The read side maps an unknown class value to unmarked, but the
    // STAMP must not read that as "no key": planting a second
    // `content_class:` line gives the frontmatter a duplicate key, which
    // strict YAML consumers reject outright.
    const abs = join(dir, "page.md");
    writeFileSync(
      abs,
      "---\ntitle: Hand\ntype: note\ncontent_class: agent-session-v2\n---\n\nbody\n",
      "utf8",
    );
    expect(() => stampPromptDerivedLine(abs)).toThrow(/content_class/);
    // The refusal never writes: the bytes are untouched.
    expect(readFileSync(abs, "utf8")).toBe(
      "---\ntitle: Hand\ntype: note\ncontent_class: agent-session-v2\n---\n\nbody\n",
    );
  });
});
