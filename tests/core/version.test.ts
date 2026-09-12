/**
 * The single source of the Open Second Brain version, and the census
 * that keeps it single.
 *
 * ## The defect
 *
 * `CLAUDE.md` states that `package.json` `version` is the one source of
 * truth, and `scripts/sync-version.ts` enforces that for the manifests
 * it mirrors into. Inside `src/` nothing enforced it: three modules
 * imported `package.json` and read `version` off it independently -
 * `src/cli/brain/verbs/continuity.ts` as `CLI_VERSION`,
 * `src/mcp/protocol.ts` as `SERVER_VERSION`, and
 * `src/core/install/opencode-plugin-asset.ts` inline in the plugin
 * header. Three copies of one fact do not disagree today, and that is
 * the whole risk: they cannot be seen to disagree either, because
 * nothing names them as copies. Adding a fourth read to serve
 * `o2b version` would have written the defect into the change meant to
 * answer the question.
 *
 * ## The population, defined structurally
 *
 * Every `.ts` module under {@link SRC_ROOT} is read, lexed by the shared
 * {@link lexCode} view (comments blanked, literal DELIMITERS kept so an
 * import specifier is still recognisable), and every static `import`
 * whose specifier ends in `package.json` is collected. The disposition
 * is an equality, not a floor: exactly one module may hold that import,
 * and it is {@link VERSION_MODULE}.
 *
 * ## What this census cannot see, stated rather than implied
 *
 *   - A dynamic `await import("../package.json")` is not a static import
 *     declaration and is invisible here. Nothing in the tree does that,
 *     and the equality below would not notice if something started.
 *   - A module that reads `package.json` off the filesystem at runtime
 *     is deliberately out of population: `src/core/doctor.ts` and
 *     `src/core/brain/architect/scan.ts` both do, and both are reading
 *     SOME project's manifest discovered at a runtime root, not this
 *     install's own version. Folding them in would make the census
 *     answer a different question than the one it is named for.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { lexCode } from "../helpers/source-lexer.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../../src/core/version.ts";
import packageJson from "../../package.json" with { type: "json" };

/** The shipped source tree this census scans. */
const SRC_ROOT = resolve(import.meta.dir, "..", "..", "src");

/** Repository root, for reporting paths a reader can open. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The one module permitted to import the manifest. */
const VERSION_MODULE = "src/core/version.ts";

/** The manifest specifier suffix a version read comes through. */
const MANIFEST_SPECIFIER = "package.json";

/** Every `.ts` module under `dir`, recursively, in stable order. */
function modules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modules(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Static import declarations in `text` whose specifier is the manifest. */
function manifestImports(text: string): number {
  const code = lexCode(text);
  const probe = /\bimport\b[^;]*?\bfrom\s*(["'])([^"']*)\1/g;
  let count = 0;
  for (const match of code.matchAll(probe)) {
    // The code view blanks literal CONTENTS, so read the specifier back
    // out of the original text at the same offset - the views share
    // every offset by construction.
    const at = match.index + match[0].length - match[2]!.length - 1;
    const specifier = text.slice(at, at + match[2]!.length);
    if (specifier.endsWith(MANIFEST_SPECIFIER)) count++;
  }
  return count;
}

describe("the Open Second Brain version constant", () => {
  test("carries the version package.json declares", () => {
    expect(OPEN_SECOND_BRAIN_VERSION).toBe(packageJson.version);
  });

  test("is a non-empty dotted version, not an empty string a bad read would leave", () => {
    expect(OPEN_SECOND_BRAIN_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe("manifest import census", () => {
  test("exactly one module under src/ imports package.json", () => {
    const holders: string[] = [];
    for (const file of modules(SRC_ROOT)) {
      const count = manifestImports(readFileSync(file, "utf8"));
      for (let i = 0; i < count; i++) holders.push(relative(REPO_ROOT, file));
    }
    expect(holders).toEqual([VERSION_MODULE]);
  });

  test("the scan sees an import, and only where it is really one", () => {
    // Positive control first: a census that cannot fail proves nothing.
    expect(manifestImports('import pkg from "../package.json";\n')).toBe(1);
    expect(manifestImports('import pkg from "../package.json" with { type: "json" };\n')).toBe(1);
    // A different specifier is not this import.
    expect(manifestImports('import { x } from "./config.ts";\n')).toBe(0);
    // The specifier quoted in a comment or a string is not an import.
    expect(manifestImports('// import pkg from "../package.json"\n')).toBe(0);
    expect(manifestImports('const doc = `import pkg from "../package.json"`;\n')).toBe(0);
  });
});
