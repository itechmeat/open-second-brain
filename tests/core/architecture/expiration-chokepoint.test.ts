/**
 * One door onto `expiration_date`, measured rather than described.
 *
 * `expiration.ts` states the bargain in its own header: the READ side
 * fails open on a value it cannot parse, so a hand-corrupted date
 * surfaces rather than silently hiding a memory. That tolerance is only
 * safe while every WRITE is validated. A second writer stamping the field
 * without {@link normalizeExpirationDate} would turn a documented
 * fail-open into a memory that never expires and nobody notices - and it
 * would do so silently, which is exactly the shape a census exists for.
 *
 * The population is syntactic and the rule is one line: a module under
 * `src/` that STAMPS the expiration field into a frontmatter map must
 * also name the validator. Two narrowings are stated rather than hidden.
 * First, this does not prove the two are on the same code path - nothing
 * syntactic can - so what it guarantees is that a new writer cannot land
 * without the validator being in front of the author's eyes. Second, a
 * bare `expiration_date:` object key counts only in a module that also
 * composes a page: on its own that spelling is how a READ surface
 * projects a value it parsed, and how a caller builds the writer input
 * the writer then validates, so counting it everywhere would report those
 * as bypasses.
 *
 * Claims pinned here:
 *
 *  1. Every module assigning `expiration_date` imports and calls
 *     `normalizeExpirationDate`.
 *  2. The census is not vacuous: the writers it knows about are actually
 *     found by the detector.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { EXPIRATION_DATE_FIELD } from "../../../src/core/brain/expiration.ts";
import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** The one validator every write must pass through. */
const CHOKEPOINT = "normalizeExpirationDate";

/** Every TypeScript module extension the runtime will load and run. */
const MODULE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".ts", ".mts", ".cts", ".tsx"]);

/**
 * The writers this census expects to find, so a detector that stopped
 * matching fails loudly instead of sweeping an empty set clean.
 */
const KNOWN_WRITERS: ReadonlyArray<string> = Object.freeze([
  "src/core/brain/signal.ts",
  "src/core/brain/preference.ts",
  "src/core/brain/expiration-set.ts",
]);

interface Module {
  readonly path: string;
  /** Comments and string bodies blanked, offsets preserved. */
  readonly code: string;
}

function readSrcTree(): Module[] {
  const files: Module[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          code: lexSource(readFileSync(abs, "utf8")).code,
        });
      }
    }
  };
  walk(SRC_ROOT);
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Stamping the field INTO a frontmatter map: the computed-member form,
 * through the exported constant or through the literal key. This is the
 * shape all three shipped writers use, and it is deliberately narrower
 * than "mentions the field".
 */
const STAMP_RE = new RegExp(
  String.raw`\[\s*(?:EXPIRATION_DATE_FIELD|["']${EXPIRATION_DATE_FIELD}["'])\s*\]\s*=[^=]`,
);

/**
 * The object-literal spelling, `{ expiration_date: value }`.
 *
 * On its own this is ambiguous and mostly innocent: it is how a READ
 * surface projects a value it just parsed (`query-tools.ts` does exactly
 * that), and how a caller builds the writer INPUT that the writer then
 * validates. It counts as a write only in a module that also composes a
 * page - which is the case this census is about, and stating the
 * narrowing is the difference between a measurement and a claim.
 */
const LITERAL_KEY_RE = new RegExp(String.raw`\b${EXPIRATION_DATE_FIELD}\s*:`);

/** The writers that put a frontmatter map on disk. */
const PAGE_WRITERS: ReadonlyArray<string> = Object.freeze([
  "writeFrontmatterAtomic",
  "writeFrontmatter",
  "formatFrontmatter",
]);

const MODULES = readSrcTree();
const WRITERS = MODULES.filter(
  (m) =>
    STAMP_RE.test(m.code) ||
    (LITERAL_KEY_RE.test(m.code) && PAGE_WRITERS.some((call) => m.code.includes(`${call}(`))),
);

describe("the expiration chokepoint", () => {
  test("every module that assigns expiration_date names the validator", () => {
    const bypassing = WRITERS.filter((m) => !m.code.includes(CHOKEPOINT)).map((m) => m.path);
    // Named, not counted: the failure has to say which file.
    expect(bypassing).toEqual([]);
  });

  test("the census is not vacuous", () => {
    const found = new Set(WRITERS.map((m) => m.path));
    const missing = KNOWN_WRITERS.filter((path) => !found.has(path));
    expect(missing).toEqual([]);
    expect(MODULES.length).toBeGreaterThan(200);
  });
});
