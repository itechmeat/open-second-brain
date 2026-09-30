/**
 * Every test that drops permission bits to make an access FAIL is gated on
 * {@link CHMOD_CANNOT_DENY} from `tests/helpers/platform.ts`.
 *
 * `chmod` denies nothing on two hosts: root reads and writes through any
 * mode bits, and Windows maps `chmod` onto the single read-only attribute,
 * which never removes read access and leaves a directory accepting new
 * entries. A test that waits for the denial there fails for a reason that
 * says nothing about the product - which is how a Windows CI run broke on
 * an unguarded `chmodSync(path, 0o000)`. The helper names that fact once;
 * this census keeps a new denial fixture from forgetting it.
 *
 * ## The rule names files, not call sites
 *
 * A test module with a denial passes when its code references the guard
 * anywhere (`test.skipIf(CHMOD_CANNOT_DENY)`, `describe.skipIf(...)`, an
 * early `if (CHMOD_CANNOT_DENY) return`). It does not prove the guard sits
 * on the test that holds the chmod; it makes a new denial in a module that
 * never thought about the platform fail until it does - a review gate, not
 * a proof. Gating on `IS_WINDOWS` alone does not pass: it still asserts a
 * denial root never sees.
 *
 * ## What counts as a denial
 *
 * A `chmod(` / `chmodSync(` call (bare, `fs.`, `fs.promises.`) whose mode
 * argument is a numeric literal whose OWNER digit lacks the read or the
 * write bit: `0o000`, `0o444`, `0o555`, `0o500`, `0o400`, `0o300`,
 * `0o200`, `0o100`. A mode whose owner digit is 6 or 7 restores access
 * (the `finally` that undoes the fixture) and is not a denial. Read off
 * the shared source lexer, so a mention in a comment or a string is not a
 * call. A mode passed through a variable, or as a string, is not seen;
 * no test in this tree spells one that way, and {@link denialMode} is
 * where the form gets added the day one does. Python suites are out of
 * scope: this lexer reads TypeScript.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The one root the census walks. */
const SWEPT_ROOT = "tests";

/** The platform fact a denial fixture has to be gated on. */
const DENY_GUARDS: ReadonlyArray<string> = Object.freeze(["CHMOD_CANNOT_DENY"]);

/** A chmod call in any of its spellings; the `(` ends the match. */
const CHMOD_CALL = /\bchmod(?:Sync)?\s*\(/g;

/** A numeric mode literal: octal, or plain decimal. */
const OCTAL_MODE = /^0o([0-7]{1,4})$/;
const DECIMAL_MODE = /^\d+$/;

/** The owner's read and write bits, shifted into the owner digit. */
const OWNER_READ_WRITE = 0o600;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readTestTree(): ReadonlyArray<SourceFile> {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(join(REPO_ROOT, SWEPT_ROOT));
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The top-level arguments of the call whose `(` is at `open`, read off the
 * `code` view, where a comma or a bracket inside a literal is blanked.
 */
function callArguments(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(code.slice(start, i));
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

/** The mode a literal argument spells, or null when it is not a literal. */
function denialMode(arg: string): number | null {
  const literal = arg.trim();
  const octal = OCTAL_MODE.exec(literal);
  if (octal !== null) return Number.parseInt(octal[1]!, 8);
  if (DECIMAL_MODE.test(literal)) return Number.parseInt(literal, 10);
  return null;
}

function isDenial(mode: number): boolean {
  return (mode & OWNER_READ_WRITE) !== OWNER_READ_WRITE;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** `path:line 0o…` for every denial chmod in one module. */
function denialSites(file: SourceFile): string[] {
  const { code } = lexSource(file.text);
  const sites: string[] = [];
  for (const match of code.matchAll(CHMOD_CALL)) {
    const open = match.index + match[0].length - 1;
    const mode = denialMode(callArguments(code, open)[1] ?? "");
    if (mode !== null && isDenial(mode)) {
      sites.push(
        `${file.path}:${lineAt(file.text, match.index)} 0o${mode.toString(8).padStart(3, "0")}`,
      );
    }
  }
  return sites;
}

function referencesGuard(code: string): boolean {
  return DENY_GUARDS.some((name) => new RegExp(`\\b${name}\\b`).test(code));
}

interface CensusResult {
  /** Denial sites in modules that never reference the guard. */
  readonly offenders: ReadonlyArray<string>;
  /** Every module with at least one denial site. */
  readonly denyingFiles: ReadonlyArray<string>;
}

function chmodDenyCensus(files: ReadonlyArray<SourceFile>): CensusResult {
  const offenders: string[] = [];
  const denyingFiles: string[] = [];
  for (const file of files) {
    const sites = denialSites(file);
    if (sites.length === 0) continue;
    denyingFiles.push(file.path);
    if (!referencesGuard(lexSource(file.text).code)) offenders.push(...sites);
  }
  return { offenders, denyingFiles };
}

describe("every chmod-denial test is gated where chmod cannot deny", () => {
  const census = chmodDenyCensus(readTestTree());

  test("the census actually found the denial fixtures", () => {
    // A census over an empty set passes for the wrong reason.
    expect(census.denyingFiles.length).toBeGreaterThan(40);
  });

  test("no denial fixture sits in a module that never references the guard", () => {
    expect(census.offenders).toEqual([]);
  });
});

/** A synthetic module under the swept root, for the census's own fixtures. */
function testFile(path: string, text: string): SourceFile {
  return { path: `tests/${path}`, text };
}

describe("the chmod-denial census can fail", () => {
  test.each([
    ["chmodSync 0o000", `chmodSync(path, 0o000);`],
    ["chmodSync read-only file", `chmodSync(path, 0o444);`],
    ["chmodSync read-only directory", `chmodSync(dir, 0o555); // r-x`],
    ["chmodSync owner r-x", `chmodSync(dir, 0o500);`],
    ["chmodSync write-execute", `chmodSync(dir, 0o300);`],
    ["fs.promises.chmod", `await fs.promises.chmod(path, 0o400);`],
    ["bare chmod", `await chmod(path, 0o200);`],
    ["decimal mode", `chmodSync(path, 0);`],
  ])("an unguarded %s is an offender", (_label, line) => {
    const result = chmodDenyCensus([testFile("new.test.ts", `${line}\n`)]);
    expect(result.offenders).toEqual([expect.stringMatching(/^tests\/new\.test\.ts:1 0o/)]);
  });

  test.each([
    ["a restoring 0o700", `chmodSync(dir, 0o700);`],
    ["a restoring 0o755", `chmodSync(dir, 0o755);`],
    ["a restoring 0o600", `chmodSync(path, 0o600);`],
    ["a group-writable 0o646", `chmodSync(path, 0o646);`],
    ["a mode passed through a variable", `chmodSync(path, mode);`],
    ["a mention in a comment", `// chmodSync(path, 0o000) would deny`],
    ["a mention in a string", `const hint = "chmodSync(path, 0o000)";`],
  ])("%s is not a denial site", (_label, line) => {
    expect(chmodDenyCensus([testFile("other.test.ts", `${line}\n`)]).denyingFiles).toEqual([]);
  });

  test("a module that gates on the guard is cleared", () => {
    const text = `import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
test.skipIf(CHMOD_CANNOT_DENY)("unreadable", () => {
  chmodSync(path, 0o000);
});
`;
    expect(chmodDenyCensus([testFile("gated.test.ts", text)]).offenders).toEqual([]);
  });

  test("gating on IS_WINDOWS alone does not clear the module", () => {
    const text = `import { IS_WINDOWS } from "../helpers/platform.ts";
test.skipIf(IS_WINDOWS)("unreadable", () => {
  chmodSync(path, 0o000);
});
`;
    expect(chmodDenyCensus([testFile("half.test.ts", text)]).offenders).toEqual([
      "tests/half.test.ts:3 0o000",
    ]);
  });

  test("the guard named only in a comment does not clear the module", () => {
    const text = `// gated on CHMOD_CANNOT_DENY elsewhere
chmodSync(path, 0o000);
`;
    expect(chmodDenyCensus([testFile("claimed.test.ts", text)]).offenders).toEqual([
      "tests/claimed.test.ts:2 0o000",
    ]);
  });
});
