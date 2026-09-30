/**
 * Every append-mode writer in `src/` names its file through the per-device
 * shard grammar, or is allowed by name with a reason (t_774dea61).
 *
 * Syncthing merges nothing: two devices appending to one file produce a
 * `*.sync-conflict-*` copy that no reader merges, and the rows in it are
 * lost to every reader until someone merges them by hand. The ledgers
 * stopped doing that by writing one file per device; this census keeps a
 * NEW append site from quietly reintroducing the shared file.
 *
 * ## The rule names files, not call sites
 *
 * Mirroring the hook-audit root guard (`tests/hooks/audit-root.test.ts`),
 * a module with an append-mode write passes when it calls a shard-naming
 * function anywhere in its code. It does not prove the append at line N
 * uses the name built at line M; it makes a new append site in a module
 * that never thought about devices fail until it adopts the grammar or is
 * allowed by name - a review gate, not a proof.
 *
 * A shard-naming function is one of {@link SHARD_NAMING_PRIMITIVES}, or an
 * exported function anywhere in `src/` whose body calls one (to a fixed
 * point). That is what lets `capture/telegram-capture.ts` pass through
 * `captureDecisionLogPath`, and the decision-receipt and truth stores pass
 * through their own device-id shard-path builders, without an allow-list
 * entry each.
 *
 * ## The append-mode forms
 *
 * `appendFileSync(` / `appendFile(`; `openSync(` / `open(` whose second
 * argument is an `"a"` or `"a+"` literal; and any `flag:` / `flags:`
 * property set to one (the `writeFileSync(..., { flag: "a" })` and
 * `createWriteStream` spellings). Read off the shared source lexer, so a
 * mention in a comment or a string is not a call. A mode passed through
 * a variable is not seen; that would be a new shape in this tree, and
 * {@link APPEND_SHAPES} below is where it gets added the day it appears.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The one root the census walks. */
const SWEPT_ROOT = "src";

/**
 * Functions whose result is a per-device shard name or the shard id
 * itself: the shared grammar's builders, and the device-id resolver the
 * older hand-rolled shard paths call directly.
 */
const SHARD_NAMING_PRIMITIVES: ReadonlyArray<string> = Object.freeze([
  "shardedFileName",
  "resolveAppendShardId",
  "resolveDeviceId",
]);

/** An allow-list reason has to be an argument, not a label. */
const MIN_REASON_LENGTH = 80;

/**
 * Append-mode writers that are not device-sharded, each with the reason a
 * single shared file is still correct.
 */
const APPEND_ALLOW_LIST: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/dream-workrun.ts":
    "each dream run appends to its own dream-runs/<run-id>.jsonl, a name unique to one run on one " +
    "device, so no second device ever appends to the same file",
  "src/core/brain/diagnostics.ts":
    "the doctor repair appends the terminal interrupted marker to a dangling per-run dream workrun " +
    "file, under a lock, and that file is unique to the run that created it",
  "src/core/doctor.ts":
    "the config-writeable probe opens the machine config file in append mode and writes zero bytes; " +
    "it lives outside the vault, is not a ledger, and removes the file it created",
});

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface AppendSite {
  readonly path: string;
  readonly line: number;
  readonly form: string;
}

/** A regex over the code view plus a predicate on the call's arguments. */
interface AppendShape {
  readonly form: string;
  readonly pattern: RegExp;
  /** Receives the comment-stripped arguments; true when this is an append. */
  readonly isAppend: (args: ReadonlyArray<string>) => boolean;
}

const APPEND_MODE_LITERAL = /^(["'`])a\+?\1$/;

const APPEND_SHAPES: ReadonlyArray<AppendShape> = Object.freeze<AppendShape[]>([
  { form: "appendFile", pattern: /\bappendFile(?:Sync)?\s*\(/g, isAppend: () => true },
  {
    form: 'open(..., "a")',
    pattern: /\bopen(?:Sync)?\s*\(/g,
    isAppend: (args) => APPEND_MODE_LITERAL.test((args[1] ?? "").trim()),
  },
]);

/** A `flag:` / `flags:` property whose value is an append-mode literal. */
const FLAG_PROPERTY = /\bflags?\s*:\s*/g;

function readSourceTree(): ReadonlyArray<SourceFile> {
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
 * The top-level arguments of the call whose `(` is at `open`, read off
 * `withoutComments` but split on the `code` view, where a comma or a
 * bracket inside a literal is blanked and cannot mis-split.
 */
function callArguments(code: string, withoutComments: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(withoutComments.slice(start, i));
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(withoutComments.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** Every append-mode write in one module. */
function appendSites(file: SourceFile): AppendSite[] {
  const { code, withoutComments } = lexSource(file.text);
  const sites: AppendSite[] = [];
  for (const shape of APPEND_SHAPES) {
    for (const match of code.matchAll(shape.pattern)) {
      const open = match.index + match[0].length - 1;
      if (shape.isAppend(callArguments(code, withoutComments, open))) {
        sites.push({ path: file.path, line: lineAt(file.text, match.index), form: shape.form });
      }
    }
  }
  for (const match of code.matchAll(FLAG_PROPERTY)) {
    const valueAt = match.index + match[0].length;
    const value = /^(["'`])a\+?\1/.exec(withoutComments.slice(valueAt));
    if (value !== null && code[valueAt] === value[1]) {
      sites.push({ path: file.path, line: lineAt(file.text, match.index), form: 'flag: "a"' });
    }
  }
  return sites.toSorted((a, b) => a.line - b.line);
}

function callsAny(code: string, names: ReadonlySet<string>): boolean {
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (names.has(match[1]!)) return true;
  }
  return false;
}

/**
 * The primitives plus every exported PATH BUILDER - an exported function
 * declared to return `string` - whose body calls a known shard-naming
 * function, iterated to a fixed point so a builder that wraps a builder
 * counts too. A module-private builder in the same file counts as a step
 * on that path (`paths.ts` routes every `Brain/log/` ledger through one),
 * but only within its own module: a private name is not a name another
 * module can call, and two modules may each have a private `ledgerPath`.
 * A body runs from its declaration to the next column-0 `}`, the shape
 * the formatter gives every top-level function in this tree.
 *
 * Two restrictions keep a writer from passing as a name: the return
 * type (a function that APPENDS through a sharded ledger, like
 * `appendLogEvent`, calls a primitive too, and calling it says nothing
 * about the file the caller then appends to itself), and a body with no
 * append site of its own (`appendAuditRecord` returns the path it wrote).
 */
function shardNamingFunctions(files: ReadonlyArray<SourceFile>): ReadonlySet<string> {
  const exported = new Set(SHARD_NAMING_PRIMITIVES);
  const privateByFile = new Map<string, Set<string>>();
  const builders: Array<{ file: string; name: string; isExported: boolean; body: string }> = [];
  for (const file of files) {
    const { code } = lexSource(file.text);
    privateByFile.set(file.path, new Set());
    for (const match of code.matchAll(PATH_BUILDER_DECLARATION)) {
      const start = match.index + match[0].length;
      const found = code.indexOf("\n}", match.index);
      const end = found === -1 ? code.length : found;
      // A builder that appends itself (`appendAuditRecord` returns the
      // path it wrote) is a writer, not a name a caller appends to.
      if (appendSites({ path: file.path, text: file.text.slice(start, end) }).length > 0) continue;
      builders.push({
        file: file.path,
        name: match[2]!,
        isExported: match[1] !== undefined,
        body: code.slice(start, end),
      });
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const builder of builders) {
      const own = privateByFile.get(builder.file)!;
      const known = builder.isExported ? exported : own;
      if (known.has(builder.name)) continue;
      if (callsAny(builder.body, exported) || callsAny(builder.body, own)) {
        known.add(builder.name);
        grew = true;
      }
    }
  }
  return exported;
}

/**
 * `[export ]function name(<params>): string {` at column 0 - one nesting
 * level of parens in the params. Group 1 is the `export` keyword.
 */
const PATH_BUILDER_DECLARATION =
  /^(export\s+)?function\s+([\w$]+)\s*\((?:[^()]|\([^()]*\))*\)\s*:\s*string\s*\{/gm;

interface CensusResult {
  /** Append sites in modules that neither shard nor sit on the allow-list. */
  readonly offenders: ReadonlyArray<string>;
  /** Every module with at least one append site. */
  readonly appendingFiles: ReadonlyArray<string>;
  /** Appending modules recognised as sharded. */
  readonly shardedFiles: ReadonlyArray<string>;
}

function appendCensus(
  files: ReadonlyArray<SourceFile>,
  allow: Readonly<Record<string, string>>,
): CensusResult {
  const naming = shardNamingFunctions(files);
  const offenders: string[] = [];
  const appendingFiles: string[] = [];
  const shardedFiles: string[] = [];
  for (const file of files) {
    const sites = appendSites(file);
    if (sites.length === 0) continue;
    appendingFiles.push(file.path);
    if (callsAny(lexSource(file.text).code, naming)) {
      shardedFiles.push(file.path);
      continue;
    }
    if (Object.hasOwn(allow, file.path)) continue;
    for (const site of sites) offenders.push(`${site.path}:${site.line} ${site.form}`);
  }
  return { offenders, appendingFiles, shardedFiles };
}

describe("every append-mode writer is device-sharded or allowed by name", () => {
  const files = readSourceTree();
  const census = appendCensus(files, APPEND_ALLOW_LIST);

  test("the census actually found the append sites", () => {
    // A census over an empty set passes for the wrong reason.
    expect(census.appendingFiles.length).toBeGreaterThan(15);
    expect(census.shardedFiles.length).toBeGreaterThan(10);
  });

  test("no append site writes a shared file outside the allow-list", () => {
    expect(census.offenders).toEqual([]);
  });

  test("every allow-list entry still appends and is not already sharded", () => {
    const stale = Object.keys(APPEND_ALLOW_LIST).filter(
      (path) => !census.appendingFiles.includes(path) || census.shardedFiles.includes(path),
    );
    expect(stale).toEqual([]);
  });

  test("every allow-list reason is an argument", () => {
    const thin = Object.entries(APPEND_ALLOW_LIST)
      .filter(([, reason]) => reason.length < MIN_REASON_LENGTH)
      .map(([path]) => path);
    expect(thin).toEqual([]);
  });
});

/** A synthetic module under the swept root, for the census's own fixtures. */
function src(path: string, text: string): SourceFile {
  return { path: `src/${path}`, text };
}

describe("the append census can fail", () => {
  test.each([
    ["appendFileSync", `appendFileSync(path, "x\\n", "utf8");`],
    ["fs namespace", `fs.appendFileSync(path, line);`],
    ["promises appendFile", `await appendFile(path, line);`],
    ["openSync append", `const fd = openSync(path, "a", 0o600);`],
    ["openSync append-read", `const fd = openSync(path, 'a+');`],
    ["writeFileSync flag", `writeFileSync(path, line, { encoding: "utf8", flag: "a" });`],
    ["createWriteStream flags", `createWriteStream(path, { flags: "a" });`],
  ])("a bare %s site is an offender", (_label, line) => {
    const result = appendCensus([src("new-ledger.ts", `${line}\n`)], {});
    expect(result.offenders).toEqual([expect.stringMatching(/^src\/new-ledger\.ts:1 /)]);
  });

  test.each([
    ["a read-mode open", `const fd = openSync(path, "r");`],
    ["a write-mode flag", `writeFileSync(path, line, { flag: "w" });`],
    ["a mention in a comment", `// appendFileSync(path, line) is forbidden here`],
    ["a mention in a string", `const hint = "appendFileSync(path, line)";`],
  ])("%s is not an append site", (_label, line) => {
    const result = appendCensus([src("reader.ts", `${line}\n`)], {});
    expect(result.appendingFiles).toEqual([]);
  });

  test("calling a shard primitive clears the module", () => {
    const text = `const path = join(dir, shardedFileName("x", resolveAppendShardId(), "jsonl"));
appendFileSync(path, line);
`;
    expect(appendCensus([src("ledger.ts", text)], {}).offenders).toEqual([]);
  });

  test("calling an exported shard-path builder from another module clears the module", () => {
    const builder = src(
      "paths.ts",
      `export function outerPath(vault: string): string {
  return innerPath(vault);
}

export function innerPath(vault: string): string {
  return join(vault, shardedFileName("x", resolveAppendShardId(), "jsonl"));
}
`,
    );
    const writer = src("writer.ts", `appendFileSync(outerPath(vault), line);\n`);
    expect(appendCensus([builder, writer], {}).offenders).toEqual([]);
  });

  test("calling an exported function that only appends through a sharded ledger does not clear the module", () => {
    const ledger = src(
      "log.ts",
      `export function appendEvent(vault: string, line: string): void {
  appendFileSync(join(vault, shardedFileName("log", resolveAppendShardId(), "jsonl")), line);
}
`,
    );
    const writer = src("writer.ts", `appendEvent(vault, line);\nappendFileSync(path, line);\n`);
    expect(appendCensus([ledger, writer], {}).offenders).toEqual(["src/writer.ts:2 appendFile"]);
  });

  test("calling an exported writer that returns the path it appended to does not clear the module", () => {
    const ledger = src(
      "audit.ts",
      `export function appendRecord(dir: string, line: string): string {
  const path = join(dir, shardedFileName("week", resolveAppendShardId(), "jsonl"));
  appendFileSync(path, line);
  return path;
}
`,
    );
    const writer = src("writer.ts", `appendRecord(dir, line);\nappendFileSync(other, line);\n`);
    expect(appendCensus([ledger, writer], {}).offenders).toEqual(["src/writer.ts:2 appendFile"]);
  });

  test("an exported builder that reaches the grammar through a private builder clears the module", () => {
    const builder = src(
      "paths.ts",
      `function ledgerPath(vault: string, stem: string): string {
  return join(vault, shardedFileName(stem, resolveAppendShardId(), "jsonl"));
}

export function demandPath(vault: string): string {
  return ledgerPath(vault, "demand");
}
`,
    );
    const writer = src("writer.ts", `appendFileSync(demandPath(vault), line);\n`);
    expect(appendCensus([builder, writer], {}).offenders).toEqual([]);
  });

  test("a private builder in one module does not clear a same-named call in another", () => {
    const builder = src(
      "paths.ts",
      `function ledgerPath(vault: string): string {
  return join(vault, shardedFileName("x", resolveAppendShardId(), "jsonl"));
}
`,
    );
    const writer = src("writer.ts", `appendFileSync(ledgerPath(vault), line);\n`);
    expect(appendCensus([builder, writer], {}).offenders).toEqual(["src/writer.ts:1 appendFile"]);
  });

  test("an unrelated exported function does not clear the module", () => {
    const helper = src(
      "helper.ts",
      `export function plainPath(vault: string): string {
  return join(vault, "ledger.jsonl");
}
`,
    );
    const writer = src("writer.ts", `appendFileSync(plainPath(vault), line);\n`);
    expect(appendCensus([helper, writer], {}).offenders).toEqual(["src/writer.ts:1 appendFile"]);
  });

  test("an allow-list entry clears only the module it names", () => {
    const files = [
      src("allowed.ts", `appendFileSync(path, line);\n`),
      src("other.ts", `appendFileSync(path, line);\n`),
    ];
    const result = appendCensus(files, { "src/allowed.ts": "reason" });
    expect(result.offenders).toEqual(["src/other.ts:1 appendFile"]);
  });
});
