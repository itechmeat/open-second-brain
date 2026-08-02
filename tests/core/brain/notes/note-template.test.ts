/**
 * Note-body template grammar (provenance-at-the-boundary, Unit C).
 *
 * The grammar is CLOSED at two constructs - typed variable substitution
 * and presence-driven sections / list iteration. These tests pin both
 * halves of that boundary: what the two constructs do, and that nothing
 * else is a construct. An unknown placeholder survives byte-intact (the
 * rule `renderTemplate` in `src/core/brain/templates.ts` already
 * documents, so a typo surfaces instead of vanishing); a malformed
 * section is a typed refusal, because it cannot be rendered at all.
 */

import { describe, expect, test } from "bun:test";

import {
  NoteTemplateError,
  renderNoteTemplate,
} from "../../../../src/core/brain/notes/note-template.ts";

describe("renderNoteTemplate - construct 1: typed variable substitution", () => {
  test("renders a string variable as-is", () => {
    expect(renderNoteTemplate("# {{title}}", { title: "Release notes" })).toBe("# Release notes");
  });

  test("renders a number canonically, including zero", () => {
    expect(renderNoteTemplate("{{count}} open", { count: 0 })).toBe("0 open");
    expect(renderNoteTemplate("{{count}} open", { count: 12 })).toBe("12 open");
  });

  test("renders a boolean as true/false", () => {
    expect(renderNoteTemplate("draft={{draft}}", { draft: true })).toBe("draft=true");
    expect(renderNoteTemplate("draft={{draft}}", { draft: false })).toBe("draft=false");
  });

  test("renders a list with the canonical separator", () => {
    expect(renderNoteTemplate("tags: {{tags}}", { tags: ["a", "b", "c"] })).toBe("tags: a, b, c");
  });

  test("tolerates whitespace inside the delimiters", () => {
    expect(renderNoteTemplate("{{  title  }}", { title: "T" })).toBe("T");
  });

  test("substitutes literally - a value containing $& is not a backreference", () => {
    expect(renderNoteTemplate("{{name}}", { name: "pay-$& and $1" })).toBe("pay-$& and $1");
  });

  test("replaces every occurrence of the same variable", () => {
    expect(renderNoteTemplate("{{a}}/{{a}}", { a: "x" })).toBe("x/x");
  });
});

describe("renderNoteTemplate - construct 2: presence sections and list iteration", () => {
  test("renders a section when its variable is present and non-empty", () => {
    expect(renderNoteTemplate("{{#draft}}WIP{{/draft}}", { draft: true })).toBe("WIP");
    expect(renderNoteTemplate("{{#note}}[{{note}}]{{/note}}", { note: "hi" })).toBe("[hi]");
  });

  test("omits a section whose variable is present but empty", () => {
    expect(renderNoteTemplate("a{{#draft}}WIP{{/draft}}b", { draft: false })).toBe("ab");
    expect(renderNoteTemplate("a{{#note}}x{{/note}}b", { note: "" })).toBe("ab");
    expect(renderNoteTemplate("a{{#tags}}x{{/tags}}b", { tags: [] })).toBe("ab");
  });

  test("presence is not JavaScript truthiness - a zero renders its section", () => {
    expect(renderNoteTemplate("{{#count}}n={{count}}{{/count}}", { count: 0 })).toBe("n=0");
  });

  test("iterates a list section once per item, binding the item to {{.}}", () => {
    expect(renderNoteTemplate("{{#tags}}- {{.}}\n{{/tags}}", { tags: ["a", "b"] })).toBe(
      "- a\n- b\n",
    );
  });

  test("an outer variable stays readable inside an iteration", () => {
    expect(
      renderNoteTemplate("{{#tags}}{{prefix}}{{.}} {{/tags}}", { prefix: "#", tags: ["x", "y"] }),
    ).toBe("#x #y ");
  });

  test("sections nest", () => {
    expect(
      renderNoteTemplate("{{#on}}{{#tags}}<{{.}}>{{/tags}}{{/on}}", { on: true, tags: ["a", "b"] }),
    ).toBe("<a><b>");
  });

  test("{{.}} outside an iteration is an unknown placeholder, left intact", () => {
    expect(renderNoteTemplate("x {{.}} y", {})).toBe("x {{.}} y");
  });
});

describe("renderNoteTemplate - unknown placeholders stay intact", () => {
  test("an unknown variable keeps its exact source text, spacing included", () => {
    expect(renderNoteTemplate("a {{ typo }} b", { title: "T" })).toBe("a {{ typo }} b");
  });

  test("an unknown section keeps the whole construct, body included", () => {
    expect(renderNoteTemplate("a{{#typo}}body{{/typo}}b", {})).toBe("a{{#typo}}body{{/typo}}b");
  });
});

describe("renderNoteTemplate - the grammar is closed", () => {
  test("there is no path/dotted lookup", () => {
    expect(renderNoteTemplate("{{a.b}}", { a: "x" })).toBe("{{a.b}}");
  });

  test("there is no expression language", () => {
    expect(renderNoteTemplate("{{a == b}}", { a: "x", b: "x" })).toBe("{{a == b}}");
    expect(renderNoteTemplate("{{a | upper}}", { a: "x" })).toBe("{{a | upper}}");
  });

  test("there is no inverted section", () => {
    expect(renderNoteTemplate("{{^a}}none{{/a}}", {})).toBe("{{^a}}none{{/a}}");
  });

  test("an unterminated delimiter is literal text", () => {
    expect(renderNoteTemplate("{{ oops", { oops: "x" })).toBe("{{ oops");
  });
});

describe("renderNoteTemplate - a malformed template is refused, not guessed", () => {
  test("an unclosed section throws a typed unbalanced_section", () => {
    try {
      renderNoteTemplate("{{#a}}body", { a: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoteTemplateError);
      expect((err as NoteTemplateError).code).toBe("unbalanced_section");
    }
  });

  test("a close with no open is not a construct, so it stays intact", () => {
    expect(renderNoteTemplate("body{{/a}}", { a: true })).toBe("body{{/a}}");
  });

  test("a mismatched close leaves the section open, which throws", () => {
    expect(() => renderNoteTemplate("{{#a}}x{{/b}}", { a: true, b: true })).toThrow(
      NoteTemplateError,
    );
  });

  test("nesting deeper than the cap throws a typed section_too_deep", () => {
    let template = "x";
    for (let i = 0; i < 40; i++) template = `{{#s${i}}}${template}{{/s${i}}}`;
    try {
      renderNoteTemplate(template, {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoteTemplateError);
      expect((err as NoteTemplateError).code).toBe("section_too_deep");
    }
  });
});
