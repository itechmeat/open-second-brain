/**
 * One lexer for every census that reads this repository's own source.
 *
 * ## Why a census lexes at all
 *
 * The first version of the progress census was a handful of regexes over
 * raw source, and four independent reviewers walked past it with a
 * positive control each. A required `safeguard` escaped because the file
 * filter was a literal string. A `type X = { … }` alias escaped because
 * only `interface` was enumerated. And a generic constraint containing a
 * brace did not merely hide a violation - it made the block matcher read
 * the wrong body, which is worse than a miss, because a mis-parse reports
 * a fact about a block that was never examined. A census that reports a
 * pass over a mis-parsed block is the failure these files exist to
 * prevent.
 *
 * This project has one runtime dependency and no TypeScript AST, so a
 * real parser is out. What is in reach is a lexer that is CORRECT about
 * the two things a census gets wrong - what is code, and where a block
 * ends - and that is what this is.
 *
 * ## Why it lives here rather than in four census files
 *
 * Four census files had grown their own copy. Two of them
 * (destructive-site and progress) were one implementation typed twice,
 * character-identical apart from the second view. The other two were
 * partial maskers with no regex rule, and one of those was WRONG on
 * shipped source: it read a backtick inside a regex literal as a template
 * opener, blanked 9,706 of the 31,608 bytes of `src/core/vault.ts`, and
 * hid the only frozen binding in the tree its census could not otherwise
 * see. A defect fixed in one copy of four is a defect still live in
 * three, which is why there is now one.
 *
 * ## The two views
 *
 * {@link lexSource} returns both, each the same LENGTH as the source -
 * measured in UTF-16 code units, the unit `String.length` and `text[i]`
 * both speak, and the unit {@link toCodeUnits} builds the views in - so
 * every offset still points at the same character and a rule that needs a
 * literal value reads it back out of the original text at the same index.
 *
 *   - {@link LexedSource.withoutComments} blanks comment bodies only. It
 *     keeps string, template and regex CONTENTS on purpose: an import's
 *     specifier IS a string, and a binding detector that cannot read
 *     `"node:fs"` finds no imports at all. Routing such a read through
 *     the other view is measured to drop the write-site census from 64
 *     rows to zero with an EMPTY failure list - the false-clean signature
 *     these censuses exist to prevent.
 *   - {@link LexedSource.code} blanks comment bodies AND the contents of
 *     every string, template and regex literal. Delimiters survive, so a
 *     literal is still recognisable as one; what does not survive is
 *     anything a literal could carry that a structural scan would read as
 *     syntax. A `rmSync(` inside a quoted example is not a call, and a
 *     comment naming a gate gates nothing.
 *
 * {@link lexCode} is `lexSource(text).code`, for the callers that need
 * one view.
 *
 * ## What the lexer cannot see, stated rather than implied
 *
 * The union of the limits its four callers used to state separately.
 * Each census's remaining blind spots are about its own rule and stay
 * with it; these are the ones that belong to the lexing:
 *
 *   - Code inside a `${…}` interpolation is read as CODE, which is what
 *     it is - but it is not attributed to the template that encloses it.
 *     A census that reports positions inside a template reports them as
 *     ordinary code.
 *   - A regex whose opening `/` sits in a position the heuristic reads as
 *     division is read as division. {@link REGEX_PRECEDING} and
 *     {@link REGEX_PRECEDING_KEYWORDS} are the whole of that heuristic.
 *   - Angle brackets are not brackets here. `<` is a comparison as often
 *     as it is a type argument, and a depth map that counted `i < n`
 *     would be wrong for the rest of the file. The two places generics
 *     matter - an interface header and a type alias's left side - are
 *     scanned locally by the census that needs them.
 *   - `withoutComments` carries literal contents by design, so a census
 *     that reads structure off it reads whatever a string is carrying
 *     too. That view answers "what did this module import", never "what
 *     does this module call".
 *
 * One more caller could use this next: `import-cycles.test.ts` anchors
 * its specifier match on `^[ \t]*`, so a specifier inside a docblock does
 * not match - but one written at column zero inside a template literal
 * would.
 */

/** Two views of one module, both the same LENGTH as the source. */
export interface LexedSource {
  /** Comments blanked; string, template and regex CONTENTS kept. */
  readonly withoutComments: string;
  /** Comments and all literal CONTENTS blanked; `${…}` code kept. */
  readonly code: string;
}

/** Characters after which a `/` opens a regex rather than divides. */
const REGEX_PRECEDING: ReadonlySet<string> = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
]);

/** Keywords after which a `/` opens a regex, e.g. `return /x/.test(s)`. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "void",
  "delete",
  "new",
]);

/**
 * Postfix operators whose last character is also a prefix operator.
 *
 * `prev` is a single character, so `i++ / 2` and `"x" + /a/` both present
 * a `+`, and {@link REGEX_PRECEDING} answers both the same way: regex.
 * That reads the division as an opener and blanks the rest of the line -
 * a mis-parse of exactly the class this helper exists to close, found by
 * this module's own tests rather than by a census going quiet. A postfix
 * increment yields a value, so what follows it divides.
 */
const POSTFIX_OPERATORS: ReadonlyArray<string> = Object.freeze(["++", "--"]);

/** The mode a template literal pushes; anything else is read as code. */
const TEMPLATE_MODE = "template";

/** The mode the scanner starts in, and the one a `${` pushes back on. */
const CODE_MODE = "code";

function regexCanStart(text: string, at: number, prev: string): boolean {
  const before = text.slice(0, at).trimEnd();
  if (POSTFIX_OPERATORS.some((operator) => before.endsWith(operator))) return false;
  if (REGEX_PRECEDING.has(prev)) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(before);
  return word !== null && REGEX_PRECEDING_KEYWORDS.has(word[0]);
}

/**
 * Split into UTF-16 code UNITS, the unit the scanner indexes in.
 *
 * `[...text]` and `Array.from(text)` iterate code POINTS, so an astral
 * character (one point, two units) makes the array one slot shorter than
 * the string it came from - and every offset the scanner computed with
 * `text[i]` / `text.length` then addresses the wrong slot. Shipped source
 * really carries one: `src/core/discipline/render.ts`, where the two
 * views measured 4359 against a 4360-character file and every blanking
 * window past the astral character landed a slot early. `split("")`
 * yields code units, and joining surrogate halves back in order rebuilds
 * the same string.
 */
function toCodeUnits(text: string): string[] {
  return text.split("");
}

/** Both views of `text`, with every offset and every newline preserved. */
export function lexSource(text: string): LexedSource {
  const n = text.length;
  const withoutComments = toCodeUnits(text);
  const code = toCodeUnits(text);
  const blank = (arr: string[], from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < Math.min(to, n); k++) {
      if (arr[k] !== "\n") arr[k] = " ";
    }
  };
  // Top of the stack is the current mode. A template literal pushes
  // `template`; a `${` inside one pushes `code` back on, with its own
  // brace counter, so an interpolated expression is read as code.
  const modes: string[] = [CODE_MODE];
  const braces: number[] = [0];
  let prev = "";
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (modes[modes.length - 1] === TEMPLATE_MODE) {
      if (c === "\\") {
        blank(code, i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        modes.pop();
        prev = "`";
        i += 1;
        continue;
      }
      if (c === "$" && text[i + 1] === "{") {
        modes.push(CODE_MODE);
        braces.push(0);
        prev = "{";
        i += 2;
        continue;
      }
      blank(code, i, i + 1);
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      let end = text.indexOf("\n", i);
      if (end === -1) end = n;
      blank(withoutComments, i, end);
      blank(code, i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(withoutComments, i, end);
      blank(code, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      blank(code, i + 1, j);
      prev = c;
      i = j + 1;
      continue;
    }
    if (c === "`") {
      modes.push(TEMPLATE_MODE);
      i += 1;
      continue;
    }
    if (c === "/" && regexCanStart(text, i, prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const e = text[j]!;
        if (e === "\\") {
          j += 2;
          continue;
        }
        if (e === "\n") break;
        if (e === "[") inClass = true;
        else if (e === "]") inClass = false;
        else if (e === "/" && !inClass) break;
        j += 1;
      }
      blank(code, i + 1, j);
      prev = "/";
      i = j + 1;
      continue;
    }
    if (c === "{") {
      braces[braces.length - 1]! += 1;
    } else if (c === "}") {
      if (braces[braces.length - 1] === 0 && modes.length > 1) {
        modes.pop();
        braces.pop();
        prev = "}";
        i += 1;
        continue;
      }
      braces[braces.length - 1]! -= 1;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { withoutComments: withoutComments.join(""), code: code.join("") };
}

/** {@link lexSource}'s `code` view, for the callers that need one view. */
export function lexCode(text: string): string {
  return lexSource(text).code;
}
