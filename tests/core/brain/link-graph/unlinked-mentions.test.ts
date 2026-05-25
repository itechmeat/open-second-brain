/**
 * Unit tests for `findUnlinkedMentions`. The scanner finds raw-text
 * occurrences of a target's title (and any frontmatter alias)
 * outside of `[[...]]` brackets and outside fenced/inline code
 * spans. The matcher is language-agnostic - it uses Unicode
 * codepoint classes (`\p{L}`, `\p{N}`) for word boundaries, never a
 * vocabulary list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findUnlinkedMentions } from "../../../../src/core/brain/link-graph/unlinked-mentions.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-unlinked-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, frontmatter: Record<string, string>, body = ""): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

describe("findUnlinkedMentions - title matching", () => {
  test("plain title hit yields one mention", () => {
    writePref("pref-second-order", {
      kind: "preference",
      topic: "second-order",
      status: "confirmed",
      principle: "thinking ahead",
      title: "Second-Order Thinking",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "linker",
        status: "confirmed",
        principle: "example",
      },
      "I value Second-Order Thinking for decisions.",
    );
    const out = findUnlinkedMentions(vault, "pref-second-order");
    expect(out.length).toBe(1);
    expect(out[0]?.source).toBe("pref-linker");
    expect(out[0]?.term).toBe("Second-Order Thinking");
  });

  test("bracketed link does NOT produce a mention", () => {
    writePref("pref-second-order", {
      kind: "preference",
      topic: "second-order",
      status: "confirmed",
      principle: "thinking ahead",
      title: "Second-Order Thinking",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "linker",
        status: "confirmed",
        principle: "example",
      },
      "I use [[pref-second-order|Second-Order Thinking]] for decisions.",
    );
    const out = findUnlinkedMentions(vault, "pref-second-order");
    expect(out.length).toBe(0);
  });

  test("title falls back to id when frontmatter has no title", () => {
    writePref("pref-canonical-id-only", {
      kind: "preference",
      topic: "x",
      status: "confirmed",
      principle: "x",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "y",
      },
      "I rely on pref-canonical-id-only every day.",
    );
    const out = findUnlinkedMentions(vault, "pref-canonical-id-only");
    expect(out.length).toBe(1);
  });
});

describe("findUnlinkedMentions - alias expansion", () => {
  test("alias mention is detected via frontmatter aliases", () => {
    writePref("pref-second-order", {
      kind: "preference",
      topic: "second-order",
      status: "confirmed",
      principle: "x",
      title: "Second-Order Thinking",
      aliases: "[downstream, knock-on]",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "linker",
        status: "confirmed",
        principle: "x",
      },
      "Always consider downstream effects of a decision.",
    );
    const out = findUnlinkedMentions(vault, "pref-second-order");
    expect(out.length).toBe(1);
    expect(out[0]?.term).toBe("downstream");
  });
});

describe("findUnlinkedMentions - word-boundary discipline", () => {
  test("substring inside another word is NOT a mention", () => {
    // Target alias `cat`. Sibling note has `catastrophe`. Without
    // word boundaries this would false-positive.
    writePref("pref-cat", {
      kind: "preference",
      topic: "cat",
      status: "confirmed",
      principle: "x",
      title: "Catalog",
      aliases: "[cat]",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "linker",
        status: "confirmed",
        principle: "x",
      },
      "The catastrophe was avoided.",
    );
    const out = findUnlinkedMentions(vault, "pref-cat");
    expect(out.length).toBe(0);
  });

  test("non-ASCII title boundary is respected", () => {
    writePref("pref-ru", {
      kind: "preference",
      topic: "ru",
      status: "confirmed",
      principle: "x",
      title: "Раздел",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "x",
      },
      "В этом тексте есть Раздел вне ссылки.",
    );
    const out = findUnlinkedMentions(vault, "pref-ru");
    expect(out.length).toBe(1);
    expect(out[0]?.term).toBe("Раздел");
  });

  test("single-codepoint term is rejected (too noisy)", () => {
    writePref("pref-x", {
      kind: "preference",
      topic: "x",
      status: "confirmed",
      principle: "x",
      title: "X",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "y",
      },
      "X marks the spot. X is the variable. X is everywhere.",
    );
    const out = findUnlinkedMentions(vault, "pref-x");
    expect(out.length).toBe(0);
  });
});

describe("findUnlinkedMentions - code block exclusion", () => {
  test("fenced code block content does not register", () => {
    writePref("pref-foo", {
      kind: "preference",
      topic: "foo",
      status: "confirmed",
      principle: "x",
      title: "Token Bucket",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "y",
      },
      "Example:\n\n```\nfunction TokenBucket() {}\n```\n\nUse Token Bucket in real prose.",
    );
    const out = findUnlinkedMentions(vault, "pref-foo");
    expect(out.length).toBe(1); // only the prose mention, code block skipped
  });

  test("inline code span does not register", () => {
    writePref("pref-foo", {
      kind: "preference",
      topic: "foo",
      status: "confirmed",
      principle: "x",
      title: "Token Bucket",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "y",
      },
      "Use `Token Bucket` literally in code; otherwise Token Bucket in prose.",
    );
    const out = findUnlinkedMentions(vault, "pref-foo");
    expect(out.length).toBe(1);
  });
});

describe("findUnlinkedMentions - shape", () => {
  test("returns frozen array with line + context snippet", () => {
    writePref("pref-foo", {
      kind: "preference",
      topic: "foo",
      status: "confirmed",
      principle: "x",
      title: "Bar",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "y",
      },
      "First line.\nSecond line about Bar happens here.\nThird line.",
    );
    const out = findUnlinkedMentions(vault, "pref-foo");
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.length).toBe(1);
    expect(out[0]?.line).toBe(2);
    expect(out[0]?.contextSnippet).toContain("Bar");
  });

  test("ignores the target's own note", () => {
    writePref(
      "pref-self",
      {
        kind: "preference",
        topic: "s",
        status: "confirmed",
        principle: "p",
        title: "MyConcept",
      },
      "MyConcept self-reference here.",
    );
    const out = findUnlinkedMentions(vault, "pref-self");
    expect(out.length).toBe(0);
  });
});
