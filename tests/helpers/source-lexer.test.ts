/**
 * The lexer four censuses run, tested directly rather than through them.
 *
 * Every census that reads this repository's source used to carry its own
 * copy of this scanner, and not one of the four had a test for the case
 * its own docblock argued about. That is exactly where the live defect
 * was: a backtick inside a regex literal opened a phantom template,
 * blanked 31 % of `src/core/vault.ts`, and hid a frozen binding the
 * vocabulary census was written to find. A mis-parse is worse than a miss
 * - it reports a fact about a block that was never examined - so the
 * shapes that produce one are pinned here, in the module that owns them.
 *
 * No helper under `tests/helpers/` had its own test before this file.
 * The convention it sets: a helper whose behaviour other tests draw
 * conclusions from is exercised on its own, so a regression fails by name
 * here instead of surfacing as a quietly smaller population somewhere
 * else.
 */

import { describe, expect, test } from "bun:test";

import { lexCode, lexSource } from "./source-lexer.ts";

/**
 * `src/core/vault.ts:88` verbatim: the line that made the vocabulary
 * census blind. The backtick inside the regex is the whole defect.
 */
const REGEX_WITH_BACKTICK = "const CODE_BLOCK_RE = /```[\\s\\S]*?```|`[^`]+`/g;\n";

/** The shape stated in the vocabulary census's own docblock. */
const REGEX_WITH_QUOTE = "const QUOTED = /[\"']/;\n";

/** Divisions that a naive regex-opener heuristic reads as literals. */
const DIVISIONS =
  "const q = total / count;\n" +
  "const r = (total) / count;\n" +
  "const s = items[0] / count;\n" +
  "const t = a > b / c;\n" +
  "const u = i++ / 2;\n";

/** A statement no rule may blank, appended after each hazard above. */
const TAIL = "export const AFTER_THE_HAZARD = 1;\n";

/**
 * An astral character in a docblock, which shipped source really carries
 * (`src/core/discipline/render.ts`).
 *
 * It is one code POINT and two UTF-16 code UNITS, and the scanner indexes
 * code units (`text[i]`, `text.length`). A view built out of code points
 * is therefore one slot SHORTER than the source for every astral
 * character before the current offset, so every blanking window past it
 * lands early and the offsets a census reads back out of the original
 * text point at the wrong character. The statement after the comment is
 * what makes that visible: it sits one slot early in the view, and a
 * census that took its position from the view and its text from the
 * source would read the character before it.
 */
const ASTRAL_IN_A_COMMENT = "/** \u{1D54F} astral. */\nconst after = 1;\n";

/** Every input below, so length and newline preservation is asserted once. */
const ALL_INPUTS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["a regex holding a backtick", REGEX_WITH_BACKTICK + TAIL],
  ["a regex holding a quote", REGEX_WITH_QUOTE + TAIL],
  ["divisions", DIVISIONS + TAIL],
  ["a brace in a string", 'const s = "closes nothing: }";\n' + TAIL],
  ["a brace in a comment", "// closes nothing: }\n/* nor this: } */\n" + TAIL],
  ["a nested interpolation", "const t = `a ${`b ${inner} c`} d`;\n" + TAIL],
  ["an interpolated string", 'const t = `x ${label("y")} z`;\n' + TAIL],
  ["an escaped backslash", 'const p = "ends with a backslash \\\\";\nconst q = 1;\n' + TAIL],
  ["an import specifier", 'import { writeFileSync } from "node:fs";\n' + TAIL],
  ["an unterminated template", "const t = `never closed\n" + TAIL],
  ["an astral character in a comment", ASTRAL_IN_A_COMMENT + TAIL],
  ["an astral character in a string", 'const s = "\u{1D54F}";\n' + TAIL],
]);

describe("source lexer", () => {
  test("a regex literal holding a backtick does not open a template", () => {
    // The regression test for the defect this helper was extracted to
    // close. Read as a template opener, the backtick blanks everything to
    // the next backtick anywhere in the file - here, the whole tail.
    const code = lexCode(REGEX_WITH_BACKTICK + TAIL);
    expect(code).toContain("export const AFTER_THE_HAZARD = 1;");
    expect(code).toContain("const CODE_BLOCK_RE = /");
    expect(code).not.toContain("[^`]");
  });

  test("a regex literal holding a quote does not open a string", () => {
    const code = lexCode(REGEX_WITH_QUOTE + TAIL);
    expect(code).toContain("export const AFTER_THE_HAZARD = 1;");
    expect(code).not.toContain('["');
  });

  test("division is not read as a regex opener", () => {
    // No literal appears in this input at all, so a correct lexer changes
    // nothing. A `/` misread as an opener swallows the rest of its line.
    expect(lexCode(DIVISIONS)).toBe(DIVISIONS);
  });

  test("a brace inside a string cannot close a block", () => {
    const code = lexCode('const s = "closes nothing: }";\n' + TAIL);
    expect(code).not.toContain("}");
    expect(code).toContain('const s = "');
    expect(code).toContain("export const AFTER_THE_HAZARD = 1;");
  });

  test("a brace inside a comment cannot close a block either", () => {
    const source = "// closes nothing: }\n/* nor this: } */\n" + TAIL;
    const views = lexSource(source);
    expect(views.code).not.toContain("}");
    expect(views.withoutComments).not.toContain("}");
    expect(views.code).toContain("export const AFTER_THE_HAZARD = 1;");
  });

  test("a nested interpolation is read as code, its template text is not", () => {
    // Pinned as an exact string: the interpolated identifier survives at
    // its own offset, every character of template TEXT becomes a space,
    // and the two `${` boundaries are still where they were.
    const code = lexCode("const t = `a ${`b ${inner} c`} d`;\n" + TAIL);
    expect(code).toBe("const t = `  ${`  ${inner}  `}  `;\n" + TAIL);
  });

  test("a string inside an interpolation keeps its call and loses its value", () => {
    const code = lexCode('const t = `x ${label("y")} z`;\n' + TAIL);
    expect(code).toContain("label(");
    expect(code).not.toContain('"y"');
    expect(code).toContain("export const AFTER_THE_HAZARD = 1;");
  });

  test("an escaped backslash does not swallow the closing quote", () => {
    const code = lexCode('const p = "ends with a backslash \\\\";\nconst q = 1;\n' + TAIL);
    expect(code).toContain("const q = 1;");
    expect(code).toContain("export const AFTER_THE_HAZARD = 1;");
  });

  test("withoutComments keeps an import specifier that code blanks", () => {
    // The invariant the write-site and destructive-site censuses depend
    // on: an import's specifier IS a string, so a binding detector has to
    // read it. Routing that read through `code` instead drops the
    // write-site census from 64 rows to zero with an EMPTY failure list,
    // which is the false-clean signature these censuses exist to prevent.
    const source = 'import { writeFileSync } from "node:fs";\n' + TAIL;
    const views = lexSource(source);
    expect(views.withoutComments).toContain('from "node:fs"');
    expect(views.code).not.toContain("node:fs");
    expect(views.code).toContain('from "');
  });

  test("withoutComments blanks a comment while keeping the string beside it", () => {
    const source = '/** Mentions progressCounter( in prose. */\nconst tail = "x";\n';
    const views = lexSource(source);
    expect(views.withoutComments).not.toContain("progressCounter(");
    expect(views.withoutComments).toContain('const tail = "x";');
    expect(views.code).not.toContain("progressCounter(");
    expect(views.code).not.toContain('"x"');
  });

  test("a comment behind a regex holding a quote is still blanked", () => {
    // The latent defect in the fourth copy: with no regex rule, the `"`
    // inside `/["]/` opened a string that ran to the next quote, so the
    // docblock after it was never blanked and `progressCounter(` in prose
    // counted as an emitter.
    const source =
      REGEX_WITH_QUOTE + '/** Mentions progressCounter( in prose. */\nconst t = "x";\n';
    expect(lexCode(source)).not.toContain("progressCounter(");
  });

  test("both views preserve length and every newline offset", () => {
    for (const [label, source] of ALL_INPUTS) {
      const views = lexSource(source);
      const report = (view: string, name: string): string =>
        `${label} (${name}): ${view.length} chars, newlines at ${newlineOffsets(view).join(",")}`;
      const expected = `${label} (x): ${source.length} chars, newlines at ${newlineOffsets(source).join(",")}`;
      expect(report(views.withoutComments, "x")).toBe(expected);
      expect(report(views.code, "x")).toBe(expected);
    }
  });

  test("an astral character does not shift every offset after it", () => {
    // The offset invariant, asserted where it can actually fail. Both
    // views are indexed by UTF-16 code unit because the scanner is; a
    // view built out of code points is one slot short per astral
    // character, and every offset after it addresses the character
    // before the one it names.
    const views = lexSource(ASTRAL_IN_A_COMMENT);
    expect(views.code).toBe(" ".repeat(17) + "\nconst after = 1;\n");
    expect(views.withoutComments).toBe(views.code);
    // The character at every offset past the astral one is unchanged, so
    // a rule that reads a literal back out of the source at an offset the
    // view gave it reads the character the view was describing.
    const source = ASTRAL_IN_A_COMMENT + TAIL;
    const code = lexCode(source);
    for (let i = 0; i < source.length; i += 1) {
      if (code[i] !== " ") expect(code[i]).toBe(source[i]!);
    }
    expect(code.length).toBe(source.length);
  });

  test("lexCode is the code view of lexSource", () => {
    for (const [, source] of ALL_INPUTS) {
      expect(lexCode(source)).toBe(lexSource(source).code);
    }
  });
});

function newlineOffsets(text: string): ReadonlyArray<number> {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") out.push(i);
  return out;
}
