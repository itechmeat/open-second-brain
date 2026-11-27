/**
 * The census of durable writes reachable from the MCP tool handlers
 * (change `lane-private-partition-reach`, the write rule), computed from
 * the source text so the checked-in table can be re-derived and kept
 * true by `lane-private-partition-reach-census.test.ts`.
 *
 * The search, as code:
 *
 *  1. The modules reachable from `src/mcp/` by their relative imports
 *     (every file under `src/mcp/` and what it imports, transitively).
 *  2. In those modules under `src/core/` and `src/mcp/`, every call of a
 *     durable write primitive ({@link WRITE_PRIMITIVES}): a lane write, a
 *     store append, a file write, delete or rename (machine state, device
 *     state, journals, markers, cursors, watermarks and ledgers all land
 *     through these). A primitive is found under its own name, under a
 *     name an import binds to it (`import { writeLaneText as put }`,
 *     followed through the relative re-exports of the imported module), as
 *     `<namespace>.<name>` of a namespace import, and passed as a value
 *     (`paths.forEach(unlinkSync)`), which counts as a call.
 *  3. A call graph of the functions of those modules, across files: a
 *     call resolves to a function of the same file, or through the file's
 *     relative imports (named, renamed, namespace) and the re-exports of
 *     the imported module to the function that defines the name.
 *  4. The readers of the caller's fold, to a fixed point over that graph:
 *     a function that calls a lane read ({@link LANE_READS}, narrowed
 *     below local reach), or calls a reader, in any file.
 *  5. For each write call, the decision reads: the lane reads of its own
 *     function, `via:<fn>` for a reader it calls (`via:<fn>@<file>` across
 *     files), and `caller:<fn>` for every function above it on a call
 *     chain, in any file and at any depth (the ancestors, to a fixed
 *     point), that reads directly or calls a reader off the chain (a
 *     read a frame of the call stack makes beside the write).
 *
 * The graph is resolved by name: a method called on an object resolves to
 * a function of that name in the file (or its imports) when there is one,
 * and a function passed as a value (an argument, a property value, an
 * assigned value) whose name is a statically known function is an edge to
 * it, as if called there. The census reads more decisions than there are
 * (a read after the write, or one deciding another entry, is listed too);
 * every listed read is judged by hand in the table's class and note.
 *
 * A row is keyed `<file>::<function>::<primitive>`; one key may stand for
 * several calls, counted (`CensusSite.lines`), and the table records the
 * count each row was reviewed at.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Where the search runs: the repository and its `src/` folder. */
export interface CensusRoots {
  readonly repo: string;
  readonly src: string;
}

const REPO = resolve(import.meta.dir, "..", "..");
const ROOTS: CensusRoots = { repo: REPO, src: join(REPO, "src") };

/** The durable write primitives the census searches for. */
export const WRITE_PRIMITIVES = [
  "writeLaneText",
  "writeLanePage",
  "removeLanePage",
  "removeLaneTree",
  "moveLanePage",
  "moveLaneTree",
  "storeWrite",
  "appendStoreRecords",
  "appendRecord",
  "atomicWriteFileSync",
  "atomicWriteText",
  "atomicCreateFileSyncExclusive",
  "writeFileSync",
  "appendFileSync",
  "unlinkSync",
  "rmSync",
  "renameSync",
] as const;

/**
 * The lane reads of the caller's fold: below local reach each answers as
 * a machine that holds only `shared` would.
 */
export const LANE_READS = [
  "lanePageExists",
  "readLanePage",
  "parseLanePage",
  "readLaneFile",
  "laneFileBytes",
  "readLaneText",
  "readLaneEntrySnapshot",
  "listLaneFiles",
  "laneStems",
  "listLaneTree",
  "listLaneDirs",
  "laneStoreStamp",
  "storeEntries",
  "storeEntry",
  "laneEntryClockMs",
  "laneStoreFold",
] as const;

/**
 * The lane write primitives themselves read the fold to place and check a
 * write (judged by the fold of every partition there): a call of one is
 * not a decision read of its caller.
 */
const LANE_WRITERS = new Set([
  "writeLaneText",
  "writeLanePage",
  "removeLanePage",
  "removeLaneTree",
  "moveLanePage",
  "moveLaneTree",
]);

/** Every `.ts` file under `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const text = new Map<string, string>();
function source(path: string): string {
  let t = text.get(path);
  if (t === undefined) {
    t = readFileSync(path, "utf8");
    text.set(path, t);
  }
  return t;
}

/** The source file a relative module specifier of `from` names, or null. */
function moduleFile(from: string, spec: string): string | null {
  const target = resolve(dirname(from), spec);
  const path = target.endsWith(".ts") ? target : `${target}.ts`;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    // A type-only or generated import that is not a source file.
    return null;
  }
}

/** The modules reachable from `src/mcp/` by relative imports. */
export function reachableModules(roots: CensusRoots = ROOTS): string[] {
  const seen = new Set<string>();
  const queue = tsFiles(join(roots.src, "mcp"));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of source(file).matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const path = moduleFile(file, m[1]!);
      if (path !== null && !seen.has(path)) queue.push(path);
    }
  }
  return [...seen].filter((f) => !f.endsWith(".d.ts")).toSorted();
}

interface Fn {
  readonly name: string;
  readonly start: number;
  /** The next function's start: calls up to it are this function's (a trailing table's inline handlers too). */
  readonly end: number;
  /** The line after its closing brace: a value is read only inside the function's own body. */
  readonly bodyEnd: number;
}

const FN_START =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z0-9_$]+\s*=>)|^\s{2}(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;

/** The top-level functions (and class methods) of a file, by line range. */
function functionsOf(lines: ReadonlyArray<string>): Fn[] {
  const starts: Array<{ name: string; start: number }> = [];
  lines.forEach((line, i) => {
    const m = FN_START.exec(line);
    if (m === null) return;
    const name = m[1] ?? m[2] ?? m[3];
    if (name === undefined || ["if", "for", "while", "switch", "catch"].includes(name)) return;
    starts.push({ name, start: i });
  });
  return starts.map((s, i) => {
    const cap = i + 1 < starts.length ? starts[i + 1]!.start : lines.length;
    return { name: s.name, start: s.start, end: cap, bodyEnd: closingLine(lines, s.start, cap) };
  });
}

/**
 * The line after the end of the function starting at `start`: its closing
 * brace at the indentation it starts at, or the start line itself when it
 * ends there (`=> expr;`, an overload signature); at most `cap`, the next
 * function's start. So a value in the code after the function (a
 * module's tool registration table after its last handler, `handler:
 * toolBrainEntity`) is not read as passed by it.
 */
function closingLine(lines: ReadonlyArray<string>, start: number, cap: number): number {
  const first = lines[start]!;
  if (/;\s*$/.test(codeOf(first))) return start + 1;
  const indent = /^\s*/.exec(first)![0];
  for (let i = start + 1; i < cap; i++) {
    // A bare `}` or `};`: a line like `}): T {` closes a parameter type.
    const line = lines[i]!;
    if (line.startsWith(`${indent}}`) && /^\s*\};?\s*$/.test(line)) return i + 1;
  }
  return cap;
}

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);
const codeOf = (line: string): string =>
  line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The spellings of `names` in one file: each name itself, and the other
 * spellings (`alias`) that stand for one of them there.
 */
interface Spellings {
  readonly names: ReadonlyArray<string>;
  /** An alias or `<namespace>.<name>` to the name it stands for. */
  readonly alias: ReadonlyMap<string, string>;
}

/** A name followed by a call (`name(`, `name<T>(`). */
const CALL_TAIL = "\\s*(?:<[^>]*>)?\\(";
/** A value position before a name: an argument, a property value, an assigned value. */
const VALUE_HEAD = "(?:[(,:?]|(?<![=!<>])=)\\s*";
/** A name used as a value: nothing follows it but the end of the value. */
const VALUE_TAIL = "\\s*(?=[,)}\\];]|$)";

/**
 * The calls of the names `spelled` on the code lines `[start, end)` of
 * `lines`: a call under the name itself (a member call `fs.name(` too), a
 * call under an alias (not as a member of another object), and the name or
 * an alias passed as a value before `valueEnd`, which counts as a call.
 */
function callsIn(
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
  spelled: Spellings,
  valueEnd: number,
): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  if (spelled.names.length === 0) return out;
  const own = spelled.names.map(escapeRe).join("|");
  const aliases = [...spelled.alias.keys()].toSorted((a, b) => b.length - a.length).map(escapeRe);
  const either =
    aliases.length === 0
      ? `(?<![A-Za-z0-9_$])(${own})`
      : `(?:(?<![A-Za-z0-9_$])(${own})|(?<![A-Za-z0-9_$.])(${aliases.join("|")}))`;
  const call = new RegExp(`${either}${CALL_TAIL}`, "g");
  const value = new RegExp(`${VALUE_HEAD}${either}${VALUE_TAIL}`, "g");
  const named = (m: RegExpMatchArray): string =>
    m[1] ?? spelled.alias.get(m[2]!) ?? (m[2] as string);
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (isComment(line)) continue;
    const code = codeOf(line);
    for (const m of code.matchAll(call)) {
      // A declaration of the primitive itself is not a call of it.
      if (/function\s*$/.test(code.slice(0, m.index))) continue;
      out.push({ name: named(m), line: i + 1 });
    }
    if (i >= valueEnd) continue;
    for (const m of code.matchAll(value)) out.push({ name: named(m), line: i + 1 });
  }
  return out.toSorted((a, b) => a.line - b.line);
}

/** The import and re-export lists of a module: `{ list } from "spec"`, value bindings only. */
function bindingLists(
  src: string,
  keyword: "import" | "export",
): Array<{ list: string; spec: string }> {
  const out: Array<{ list: string; spec: string }> = [];
  const re = new RegExp(`${keyword}\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']`, "g");
  for (const m of src.matchAll(re)) if (m[1] === undefined) out.push({ list: m[2]!, spec: m[3]! });
  return out;
}

/** The `orig as alias` pairs of one binding list (`type` members left out). */
function pairsOf(list: string): Array<{ orig: string; local: string }> {
  const out: Array<{ orig: string; local: string }> = [];
  for (const raw of list.split(",")) {
    if (/^\s*type\s/.test(raw)) continue;
    const [orig, alias] = raw
      .trim()
      .split(/\s+as\s+/)
      .map((p) => p.trim());
    if (orig === undefined || orig === "") continue;
    out.push({ orig, local: alias ?? orig });
  }
  return out;
}

/**
 * The name of `names` that `name`, imported from `spec` by `from`, stands
 * for: the name itself, or followed through the relative re-exports of
 * the imported module (`export { writeLaneText as put } from …`); null when
 * it stands for none.
 */
function nameExportedAs(
  from: string,
  spec: string,
  name: string,
  names: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): string | null {
  const target = spec.startsWith(".") ? moduleFile(from, spec) : null;
  if (target !== null && !seen.has(`${target}\u0000${name}`)) {
    seen.add(`${target}\u0000${name}`);
    for (const { list, spec: next } of bindingLists(source(target), "export")) {
      for (const { orig, local } of pairsOf(list)) {
        if (local === name) return nameExportedAs(target, next, orig, names, seen);
      }
    }
  }
  return names.has(name) ? name : null;
}

/**
 * The spellings of `names` in `file`: an import that binds one under
 * another name, and `<namespace>.<alias>` for an alias a namespace-imported
 * relative module re-exports one under.
 */
function spellingsIn(file: string, names: ReadonlyArray<string>): Spellings {
  const set = new Set(names);
  const alias = new Map<string, string>();
  const src = source(file);
  for (const { list, spec } of bindingLists(src, "import")) {
    for (const { orig, local } of pairsOf(list)) {
      if (local === orig && set.has(orig)) continue;
      const name = nameExportedAs(file, spec, orig, set);
      if (name !== null && local !== name) alias.set(local, name);
    }
  }
  for (const m of src.matchAll(
    /import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = moduleFile(file, m[2]!);
    if (target === null) continue;
    for (const { list, spec } of bindingLists(source(target), "export")) {
      for (const { orig, local } of pairsOf(list)) {
        const name = nameExportedAs(target, spec, orig, set);
        if (name !== null && local !== name) alias.set(`${m[1]!}.${local}`, name);
      }
    }
  }
  return { names, alias };
}

/** The names a function's code lines call: plain names and `ns.name` pairs. */
function calledNames(lines: ReadonlyArray<string>, fn: Fn): { plain: Set<string>; ns: string[] } {
  const plain = new Set<string>();
  const ns: string[] = [];
  // The declaration line too (a one-line function calls there); the name
  // it declares is not a call of itself.
  for (let i = fn.start; i < fn.end; i++) {
    const line = lines[i]!;
    if (isComment(line)) continue;
    const code = codeOf(line);
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\(/g)) {
      if (i === fn.start && m[1] === fn.name) continue;
      plain.add(m[1]!);
    }
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\s*\(/g)) {
      ns.push(`${m[1]!}.${m[2]!}`);
    }
    // A function passed as a value: an edge to it when the name resolves.
    if (i >= fn.bodyEnd) continue;
    for (const m of code.matchAll(VALUE_NAME)) {
      if (m[2] === undefined) plain.add(m[1]!);
      else ns.push(`${m[1]!}.${m[2]}`);
    }
  }
  return { plain, ns };
}

/** A name, or a `ns.name` pair, passed as a value. */
const VALUE_NAME = new RegExp(
  `${VALUE_HEAD}(?<![A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)(?:\\.([A-Za-z_$][A-Za-z0-9_$]*))?${VALUE_TAIL}`,
  "g",
);

/** The names a module binds by its relative imports and the names it re-exports. */
interface ModuleLinks {
  /** Local name to the module and the name it is exported under there. */
  readonly imports: Map<string, { file: string; name: string }>;
  /** Namespace import name to its module. */
  readonly namespaces: Map<string, string>;
  /** Exported name to the module and name it re-exports. */
  readonly reexports: Map<string, { file: string; name: string }>;
  /** Modules re-exported whole (`export * from`). */
  readonly stars: string[];
}

/** Bind the names of one import or re-export list of `target` into `into`. */
const bind = (
  into: Map<string, { file: string; name: string }>,
  list: string,
  target: string,
  reexport: boolean,
): void => {
  for (const raw of list.split(",")) {
    const part = raw.replace(/^\s*type\s+/, "").trim();
    if (part === "") continue;
    const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
    if (orig === undefined || orig === "") continue;
    // An import binds the alias locally; a re-export publishes it.
    into.set(alias ?? orig, { file: target, name: orig });
    if (reexport && alias !== undefined) into.set(alias, { file: target, name: orig });
  }
};

function linksOf(file: string): ModuleLinks {
  const src = source(file);
  const imports = new Map<string, { file: string; name: string }>();
  const namespaces = new Map<string, string>();
  const reexports = new Map<string, { file: string; name: string }>();
  const stars: string[] = [];
  for (const m of src.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = m[1] === undefined ? moduleFile(file, m[3]!) : null;
    if (target !== null) bind(imports, m[2]!, target, false);
  }
  for (const m of src.matchAll(
    /import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = moduleFile(file, m[2]!);
    if (target !== null) namespaces.set(m[1]!, target);
  }
  for (const m of src.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = m[1] === undefined ? moduleFile(file, m[3]!) : null;
    if (target !== null) bind(reexports, m[2]!, target, true);
  }
  for (const m of src.matchAll(/export\s+\*\s+from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = moduleFile(file, m[1]!);
    if (target !== null) stars.push(target);
  }
  return { imports, namespaces, reexports, stars };
}

/** One function of the graph. */
interface Node {
  readonly id: string;
  readonly file: string;
  readonly fn: Fn;
  /** The lane reads it calls by name. */
  readonly direct: string[];
  /** The functions its calls resolve to (ids). */
  callees: Set<string>;
}

/** The call graph of `modules`: nodes by id (`<file>#<name>@<start>`) and by file and name. */
function callGraph(modules: ReadonlyArray<string>): {
  nodes: Map<string, Node>;
  byFile: Map<string, Map<string, Node[]>>;
} {
  const nodes = new Map<string, Node>();
  const byFile = new Map<string, Map<string, Node[]>>();
  const links = new Map<string, ModuleLinks>();
  const linkOf = (file: string): ModuleLinks => {
    let l = links.get(file);
    if (l === undefined) {
      l = linksOf(file);
      links.set(file, l);
    }
    return l;
  };
  const ensureFile = (file: string): Map<string, Node[]> => {
    let named = byFile.get(file);
    if (named !== undefined) return named;
    named = new Map();
    byFile.set(file, named);
    const lines = source(file).split("\n");
    const reads = spellingsIn(file, LANE_READS);
    for (const fn of functionsOf(lines)) {
      const node: Node = {
        id: `${file}#${fn.name}@${fn.start}`,
        file,
        fn,
        // The declaration line too: a one-line function makes its call there.
        direct: callsIn(lines, fn.start, fn.end, reads, fn.bodyEnd).map((c) => c.name),
        callees: new Set(),
      };
      nodes.set(node.id, node);
      const list = named.get(fn.name) ?? [];
      list.push(node);
      named.set(fn.name, list);
    }
    return named;
  };
  // The functions `name` names as exported by `file`, through re-exports.
  const exported = (file: string, name: string, seen: Set<string>): Node[] => {
    const tag = `${file}\u0000${name}`;
    if (seen.has(tag)) return [];
    seen.add(tag);
    const own = ensureFile(file).get(name);
    if (own !== undefined) return own;
    const l = linkOf(file);
    const re = l.reexports.get(name) ?? l.imports.get(name);
    if (re !== undefined) return exported(re.file, re.name, seen);
    return l.stars.flatMap((star) => exported(star, name, seen));
  };
  for (const file of modules) ensureFile(file);
  for (const file of modules) {
    const lines = source(file).split("\n");
    const l = linkOf(file);
    for (const node of ensureFile(file).values()) {
      for (const n of node) {
        const called = calledNames(lines, n.fn);
        for (const name of called.plain) {
          if (LANE_WRITERS.has(name)) continue;
          const local = ensureFile(file).get(name);
          const imp = l.imports.get(name);
          const targets =
            local ?? (imp === undefined ? [] : exported(imp.file, imp.name, new Set()));
          for (const t of targets) if (t.id !== n.id) n.callees.add(t.id);
        }
        for (const pair of called.ns) {
          const [ns, name] = pair.split(".") as [string, string];
          const target = l.namespaces.get(ns);
          if (target === undefined || LANE_WRITERS.has(name)) continue;
          for (const t of exported(target, name, new Set())) n.callees.add(t.id);
        }
      }
    }
  }
  return { nodes, byFile };
}

export interface CensusSite {
  /** `<file>::<function>::<primitive>`, the file relative to the repository. */
  readonly key: string;
  readonly file: string;
  readonly fn: string;
  readonly primitive: string;
  readonly lines: number[];
  /**
   * The narrowed lane reads its decision may depend on: the reads of its
   * function (direct names, `via:<fn>` for a reader it calls, in any
   * file), and `caller:<fn>` for a function above it on a call chain, at
   * any depth, that reads beside the chain.
   */
  readonly laneReads: string[];
  /** Whether the function runs work inside `withPrivateShown`. */
  readonly shown: boolean;
  /** The functions under `src/mcp/` above it on a call chain (empty: no handler reaches it). */
  readonly handlers: string[];
}

/** The census of durable writes in the modules reachable from `src/mcp/`. */
export function scanCensus(roots: CensusRoots = ROOTS): CensusSite[] {
  text.clear();
  const SRC = roots.src;
  const modules = reachableModules(roots).filter(
    (f) => f.startsWith(join(SRC, "core")) || f.startsWith(join(SRC, "mcp")),
  );
  const { nodes, byFile } = callGraph(modules);
  // The readers of the caller's fold, to a fixed point over the graph.
  const readers = new Set<string>();
  for (const node of nodes.values()) {
    if (node.direct.length > 0 && !LANE_WRITERS.has(node.fn.name)) readers.add(node.id);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes.values()) {
      if (readers.has(node.id) || LANE_WRITERS.has(node.fn.name)) continue;
      if ([...node.callees].some((c) => readers.has(c))) {
        readers.add(node.id);
        changed = true;
      }
    }
  }
  // The reverse edges, for the ancestors of a row's function.
  const callersOf = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const c of node.callees) {
      const list = callersOf.get(c) ?? [];
      list.push(node.id);
      callersOf.set(c, list);
    }
  }
  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(callersOf.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next) || next === id) continue;
      seen.add(next);
      queue.push(...(callersOf.get(next) ?? []));
    }
    return seen;
  };
  const sites = new Map<string, CensusSite>();
  for (const file of modules) {
    const lines = source(file).split("\n");
    const rel = relative(roots.repo, file).split("\\").join("/");
    const writeSpellings = spellingsIn(file, WRITE_PRIMITIVES);
    for (const list of byFile.get(file)!.values()) {
      for (const node of list) {
        const fn = node.fn;
        const writes = callsIn(lines, fn.start, fn.end, writeSpellings, fn.bodyEnd);
        if (writes.length === 0) continue;
        const via = [...node.callees]
          .filter((c) => readers.has(c))
          .map((c) => nodes.get(c)!)
          .filter((c) => !(LANE_READS as ReadonlyArray<string>).includes(c.fn.name))
          .map((c) =>
            c.file === file ? `via:${c.fn.name}` : `via:${c.fn.name}@${basename(c.file)}`,
          );
        const above = ancestorsOf(node.id);
        const handlers = [
          ...new Set(
            [...above]
              .map((a) => nodes.get(a)!)
              .filter((a) => a.file.startsWith(join(SRC, "mcp")))
              .map((a) => a.fn.name),
          ),
        ].toSorted();
        let callerReads: string[] = [];
        if (!LANE_WRITERS.has(fn.name)) {
          const chain = new Set([...above, node.id]);
          callerReads = [...above]
            .map((a) => nodes.get(a)!)
            .filter(
              (a) =>
                a.direct.length > 0 || [...a.callees].some((c) => readers.has(c) && !chain.has(c)),
            )
            .map((a) => `caller:${a.fn.name}`);
        }
        const laneReads = [...new Set([...node.direct, ...via, ...callerReads])].toSorted();
        const shown = lines.slice(fn.start, fn.end).some((l) => l.includes("withPrivateShown("));
        for (const w of writes) {
          const key = `${rel}::${fn.name}::${w.name}`;
          const prior = sites.get(key);
          if (prior !== undefined) {
            prior.lines.push(w.line);
            for (const r of laneReads) if (!prior.laneReads.includes(r)) prior.laneReads.push(r);
          } else
            sites.set(key, {
              key,
              file: rel,
              fn: fn.name,
              primitive: w.name,
              lines: [w.line],
              laneReads,
              shown,
              handlers,
            });
        }
      }
    }
  }
  return [...sites.values()].toSorted((a, b) => a.key.localeCompare(b.key));
}
