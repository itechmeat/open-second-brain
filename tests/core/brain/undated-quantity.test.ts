/**
 * Undated-quantity recognizer (write-honesty, F4, t_fb442a24).
 *
 * A count or amount written with no structural date becomes a claim that
 * answers as true at every instant, because an absent `valid_from` is
 * unbounded. This recognizer owns only the high-precision half: find the
 * lexemes a writer would have to date, and say where they are.
 *
 * The corpus is table-driven in both directions. The negative half is as
 * load-bearing as the positive one: a version string, an ISO date, a
 * table cell, a code span and the frontmatter block are all places a
 * number appears without being an undated claim about the vault.
 */

import { describe, expect, test } from "bun:test";

import {
  containsIsoDate,
  containsProseIsoDate,
  findUndatedQuantities,
} from "../../../src/core/brain/undated-quantity.ts";
import { LINEAR_CEILING_MS } from "../../helpers/linear-time.ts";

interface PositiveCase {
  readonly name: string;
  readonly body: string;
  /** Lexemes in ascending offset order, after overlap resolution. */
  readonly lexemes: ReadonlyArray<string>;
}

const POSITIVE: ReadonlyArray<PositiveCase> = [
  {
    name: "currency symbol with a magnitude suffix",
    body: "the migration cost $4.2M in total",
    lexemes: ["$4.2M"],
  },
  {
    name: "currency code after the amount",
    body: "the invoice totals 10 USD",
    lexemes: ["10 USD"],
  },
  {
    name: "percent",
    body: "35% of sessions were recalled",
    lexemes: ["35%"],
  },
  {
    name: "fractional percent",
    body: "2.5% growth against last quarter",
    lexemes: ["2.5%"],
  },
  {
    name: "thousands-separated count with a unit",
    body: "5,000 users signed up",
    lexemes: ["5,000 users"],
  },
  {
    name: "number with a time unit",
    body: "the pass took 359 ms",
    lexemes: ["359 ms"],
  },
  {
    name: "number with a count unit",
    body: "it served 1,200 requests per run",
    lexemes: ["1,200 requests"],
  },
  {
    name: "number with a data-size unit",
    body: "a 512 MB payload",
    lexemes: ["512 MB"],
  },
  {
    name: "bare thousands-separated count",
    body: "the counter reads 12,400 and stops",
    lexemes: ["12,400"],
  },
  {
    name: "several quantities keep ascending offsets",
    body: "35% of 5,000 users",
    lexemes: ["35%", "5,000 users"],
  },
  {
    name: "a thousands-separated count followed by a prose comma",
    body: "the counter reads 12,400, then stops",
    lexemes: ["12,400"],
  },
  {
    name: "a year-shaped number with a thousands separator is still a quantity",
    body: "2,024 users were migrated",
    lexemes: ["2,024 users"],
  },
  {
    name: "a single-letter unit after whitespace",
    body: "the job ran 3 d",
    lexemes: ["3 d"],
  },
];

const NEGATIVE: ReadonlyArray<PositiveCase> = [
  {
    name: "an ISO calendar date",
    body: "published 2026-10-22 by the team",
    lexemes: [],
  },
  {
    name: "an ISO instant",
    body: "the run ended at 2026-10-22T10:30:00Z",
    lexemes: [],
  },
  {
    name: "a version token with a v prefix",
    body: "upgraded to v1.73.0 today",
    lexemes: [],
  },
  {
    name: "a bare semantic version",
    body: "release 1.73.0 shipped",
    lexemes: [],
  },
  {
    name: "an IPv4 address",
    body: "bound to 192.168.1.1 here",
    lexemes: [],
  },
  {
    name: "ordered-list markers on their own",
    body: "1. first entry\n2. second entry",
    lexemes: [],
  },
  {
    name: "a table row",
    body: "| 5,000 users | 35% |",
    lexemes: [],
  },
  {
    name: "an inline code span",
    body: "the token `5,000 users` is quoted",
    lexemes: [],
  },
  {
    name: "a fenced code block",
    body: "```\n5,000 users\n35%\n```",
    lexemes: [],
  },
  {
    name: "a count in the frontmatter block",
    body: "---\ncount: 5,000\ntitle: X\n---\n\nplain prose",
    lexemes: [],
  },
  {
    name: "a count in a CRLF frontmatter block",
    body: "---\r\ncount: 5,000\r\n---\r\n\r\nplain prose",
    lexemes: [],
  },
  {
    name: "a decimal with no unit",
    body: "pi is 3.14159 here",
    lexemes: [],
  },
  {
    name: "a number followed by a word outside the unit set",
    body: "42 boxes arrived",
    lexemes: [],
  },
  {
    name: "a candidate span inside an ISO date with a later table row",
    body: "Date: 2026-10-22 days\n\n| table | column |\n",
    lexemes: [],
  },
  {
    name: "a version token overlapping a quantity trigger",
    body: "release 1.2.3 USD shipped",
    lexemes: [],
  },
  {
    name: "a four-digit year followed by a count unit is not a quantity",
    body: "In 2024 users doubled",
    lexemes: [],
  },
  {
    name: "a dimension letter glued to a number",
    body: "a 3D printer outputs 2D jigs",
    lexemes: [],
  },
  {
    name: "a plan letter glued to a number",
    body: "plan 2b covers the rollout",
    lexemes: [],
  },
  {
    name: "a count inside a wikilink target",
    body: "see [[Pricing 12,400 plan]] for details",
    lexemes: [],
  },
  {
    name: "numbers in a URL run",
    body: "fetched https://x.com/item/5000users?q=50% just now",
    lexemes: [],
  },
  {
    name: "a markdown link destination",
    body: "the rows live in [quarterly export](12,400-rows.csv) here",
    lexemes: [],
  },
];

describe("findUndatedQuantities - the trigger classes", () => {
  for (const entry of POSITIVE) {
    test(entry.name, () => {
      const found = findUndatedQuantities(entry.body);
      expect(found.map((f) => f.lexeme)).toEqual([...entry.lexemes]);
      for (const item of found) {
        // The offset addresses the lexeme in the caller's own string.
        expect(entry.body.slice(item.offset, item.offset + item.lexeme.length)).toBe(item.lexeme);
      }
    });
  }
});

describe("findUndatedQuantities - the exclusions", () => {
  for (const entry of NEGATIVE) {
    test(entry.name, () => {
      expect(findUndatedQuantities(entry.body)).toEqual([]);
    });
  }

  test("an ordered-list marker is excluded without hiding its content", () => {
    const found = findUndatedQuantities("1. 5,000 users");
    expect(found.map((f) => f.lexeme)).toEqual(["5,000 users"]);
    expect(found[0]!.offset).toBe(3);
  });

  test("a CRLF frontmatter block masks only itself", () => {
    const head = "---\r\ncount: 5,000\r\n---\r\n\r\n";
    expect(findUndatedQuantities(`${head}plain prose`)).toEqual([]);

    // The closing fence on CRLF must not swallow the promoted body: a
    // quantity after it is still authored prose.
    const found = findUndatedQuantities(`${head}5,000 users`);
    expect(found.map((f) => f.lexeme)).toEqual(["5,000 users"]);
    expect(found[0]!.offset).toBe(head.length);
  });

  test("overlapping trigger classes yield the one longest lexeme", () => {
    expect(findUndatedQuantities("5,000 users").map((f) => f.lexeme)).toEqual(["5,000 users"]);
  });

  test("a pure scan leaves the input untouched and is repeatable", () => {
    const body = "35% of 5,000 users";
    expect(findUndatedQuantities(body)).toEqual(findUndatedQuantities(body));
    expect(body).toBe("35% of 5,000 users");
  });
});

describe("containsIsoDate", () => {
  test("recognises a date-only run anywhere in prose", () => {
    expect(containsIsoDate("published 2026-10-22 by the team")).toBe(true);
  });

  test("recognises an ISO instant", () => {
    expect(containsIsoDate("ended at 2026-10-22T10:30:00Z")).toBe(true);
  });

  test("does not read a version token as a date", () => {
    expect(containsIsoDate("upgraded to v1.73.0")).toBe(false);
  });
});

describe("containsProseIsoDate - the escape hatch reads the masked view", () => {
  test("a prose date hatches", () => {
    expect(containsProseIsoDate("published 2026-10-22 by the team")).toBe(true);
  });

  test("an instant in prose hatches", () => {
    expect(containsProseIsoDate("ended 2026-10-22T10:30:00Z on the dot")).toBe(true);
  });

  test("a date inside a fenced block is not prose", () => {
    expect(containsProseIsoDate("```\n2026-10-22\n```\n\n5,000 users\n")).toBe(false);
  });

  test("a date inside an inline code span is not prose", () => {
    expect(containsProseIsoDate("the stamp `2026-10-22` is quoted")).toBe(false);
  });

  test("a date inside a table row is not prose", () => {
    expect(containsProseIsoDate("| 2026-10-22 | 35% |")).toBe(false);
  });

  test("a date inside a URL is not prose", () => {
    expect(containsProseIsoDate("see https://x.com/posts/2026-10-22 today")).toBe(false);
  });

  test("a date inside a wikilink target is not prose", () => {
    expect(containsProseIsoDate("see [[Report 2026-10-22]] today")).toBe(false);
  });

  test("text with no date anywhere does not hatch", () => {
    expect(containsProseIsoDate("no date in here at all")).toBe(false);
  });
});

/**
 * The run shapes admit no comma or dot before the first digit. Without
 * that guard, in a comma-joined digit run every position after a comma
 * was a legal match start, each running `[\d,]*` to the end and
 * backtracking through the tail: 45 s on 50,000 chars, in the
 * synchronous write receipt. A quadratic pass over a 256 KiB body takes
 * minutes, the fixed scan takes milliseconds, and the ceiling is the
 * shared guard sized for a loaded CI runner.
 */
describe("findUndatedQuantities - bounded scan time", () => {
  const QUARTER_MIB_CHARS = 256 * 1024;

  test("a comma-joined digit run the size of the artifact cap stays linear", () => {
    const body = "1,".repeat(QUARTER_MIB_CHARS / 2);
    const started = performance.now();
    expect(findUndatedQuantities(body)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(LINEAR_CEILING_MS);
  });

  test("a dotted version-like run the size of the artifact cap stays linear", () => {
    const body = "1.1.".repeat(QUARTER_MIB_CHARS / 4);
    const started = performance.now();
    expect(findUndatedQuantities(body)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(LINEAR_CEILING_MS);
  });
});
