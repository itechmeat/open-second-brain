/**
 * The search-query schema artifact must SHIP (t_50c81d5c): the `o2b`
 * bin runs the packaged `src/`, and `SEARCH_QUERY_SCHEMA_PATH` resolves
 * module-relatively to `<package-root>/schemas/brain/search-query.schema.json`
 * - so `o2b search schema check` exits 2 ("missing or unreadable") and
 * `o2b search schema export` throws ENOENT in any installed copy where
 * the package `files` allowlist does not carry that path. This holds the
 * allowlist to the path the installed verb actually resolves, the exact
 * gap `npm pack` otherwise only shows at publish time.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SEARCH_QUERY_SCHEMA_PATH } from "../../src/cli/search/verbs/schema-export.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** npm `files` semantics: an entry is one file, or a directory shipped recursively. */
function ships(files: ReadonlyArray<string>, rel: string): boolean {
  return files.some((entry) => {
    const asDir = entry.endsWith("/") ? entry : `${entry}/`;
    return entry === rel || rel.startsWith(asDir);
  });
}

describe("the search-query schema artifact ships in the package", () => {
  test("the verb's committed-artifact path is the package-relative schemas path", () => {
    const rel = relative(ROOT, SEARCH_QUERY_SCHEMA_PATH);
    expect(rel).toBe(join("schemas", "brain", "search-query.schema.json"));
    // The allowlist cannot ship a file the repo does not carry.
    expect(existsSync(SEARCH_QUERY_SCHEMA_PATH)).toBe(true);
  });

  test("the package.json files allowlist covers that path", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    // Normalise to forward slashes: `relative` yields separators native to
    // the host (backslashes on Windows), while the `files` entries are posix.
    const rel = relative(ROOT, SEARCH_QUERY_SCHEMA_PATH).split(sep).join("/");
    const missing = ships(pkg.files ?? [], rel) ? [] : [rel];
    expect(missing).toEqual([]);
  });
});
