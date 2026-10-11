/**
 * Source-archive stamp census (answer trust, security F5).
 *
 * The delete-by-source citation probe (`sourceArchiveCitingPages`) sees
 * only `Brain/sources/` and `Brain/pending/` - the two directories the
 * ingest lane stamps. A frontmatter-bearing COPY of a stamped page
 * anywhere else would cite an entry the probe misses, and a confirmed
 * deletion would then remove an entry another page still names. The cheap
 * honest guard is this census: the `source_archive_hash` frontmatter key
 * has exactly ONE writer - the ingest lane's stamp site, which composes
 * the key from the store's own constant - so the two-directory walk is
 * exhaustive by construction, and any second writer of the key fails
 * here, by file name, before it can silence a cleanup.
 *
 * Like its sibling censuses, this one reads a LEXED view of each module
 * (`tests/helpers/source-lexer.ts`), so the key discussed in a docblock
 * is not a reference and a page-write named in a string literal is not a
 * site.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** The frontmatter key, in both of its spellings. */
const STAMP_KEY_IDENTIFIER = "SOURCE_ARCHIVE_HASH_KEY";
const STAMP_KEY_LITERAL = "source_archive_hash";

/**
 * The closed set of modules allowed to reference the stamp key at all:
 * the store that defines the constant and answers the citation probe, the
 * ingest lane that is the ONE writer, the hygiene detector that verifies
 * stamps, and the two MCP surfaces that read stamps for cleanup and name
 * the key in the archive_get schema.
 */
const STAMP_KEY_FILES: ReadonlyArray<string> = Object.freeze([
  posix.join("core", "brain", "hygiene", "detectors", "capture-scope.ts"),
  posix.join("core", "brain", "ingest", "ingest.ts"),
  posix.join("core", "brain", "provenance", "source-archive.ts"),
  posix.join("mcp", "brain", "hygiene-tools.ts"),
  posix.join("mcp", "brain", "ingest-tools.ts"),
]);

/** The one writer among them - the ingest lane's stamp site. */
const STAMP_WRITER = posix.join("core", "brain", "ingest", "ingest.ts");

/** The constant's definition site - the only home of the literal spelling. */
const STAMP_CONSTANT_HOME = posix.join("core", "brain", "provenance", "source-archive.ts");

/**
 * The page-write primitives. Binding one beside the stamp key is what
 * makes a module a WRITER of the stamp; a reader (detector, cleanup,
 * schema prose) binds none of them.
 */
const PAGE_WRITE_PRIMITIVES: ReadonlyArray<string> = Object.freeze([
  "writeFrontmatterAtomic",
  "formatFrontmatter",
]);

/** Every .ts file under src, as POSIX paths relative to it, sorted. */
function srcModulePaths(): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".ts")) out.push(posix.relative(SRC_ROOT, abs));
    }
  };
  walk(SRC_ROOT);
  return out;
}

/** Does this module reference the stamp key - identifier or literal? */
function referencesStampKey(path: string): boolean {
  const views = lexSource(readFileSync(join(SRC_ROOT, path), "utf8"));
  // `code` keeps identifiers and blanks string contents; `withoutComments`
  // keeps string contents - so the identifier is read off the code view,
  // the literal spelling off the view that carries strings.
  return (
    views.code.includes(STAMP_KEY_IDENTIFIER) || views.withoutComments.includes(STAMP_KEY_LITERAL)
  );
}

describe("source-archive stamp census", () => {
  test("the sweep sees the vault-facing src tree", () => {
    // A census over an empty sweep is a claim about a census; pin the
    // population's scale and the two load-bearing members' presence.
    const paths = srcModulePaths();
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain(STAMP_WRITER);
    expect(paths).toContain(STAMP_CONSTANT_HOME);
  });

  test("the key is referenced only by the closed set around the store", () => {
    // Any spelling - the store's identifier or the bare literal - outside
    // this set means a module composes or parses the stamp itself: a new
    // writer the citation probe would miss, named here before it can
    // silence a delete-by-source cleanup.
    const referencing = srcModulePaths().filter((path) => referencesStampKey(path));
    expect(referencing.toSorted()).toEqual(STAMP_KEY_FILES.toSorted());
  });

  test("the only key reference that writes a page is the ingest stamp site", () => {
    // This is the one-writer assumption the citation probe rests on,
    // stated as architecture: among the modules that reference the key,
    // exactly one binds a page-write primitive, and it takes the key from
    // the store's constant, never a second literal.
    const writers = srcModulePaths().filter((path) => {
      if (!referencesStampKey(path)) return false;
      const code = lexSource(readFileSync(join(SRC_ROOT, path), "utf8")).code;
      return PAGE_WRITE_PRIMITIVES.some((primitive) => code.includes(primitive));
    });
    expect(writers).toEqual([STAMP_WRITER]);
    const writerCode = lexSource(readFileSync(join(SRC_ROOT, STAMP_WRITER), "utf8")).code;
    expect(writerCode.includes(STAMP_KEY_IDENTIFIER)).toBe(true);
  });
});
