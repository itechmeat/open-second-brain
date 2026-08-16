/**
 * Census over the long operations, and what they say while they run.
 *
 * The previous release's whole argument was that a mechanism which must
 * be called by hand is a mechanism that will be missed, and that the
 * answer is declaration plus a census. This is that census for the
 * progress spine, built on the same syntactic technique the write-site
 * and destructive-site censuses use: enumerate the population from the
 * source rather than from a hand-kept list, and fail when a member
 * appears without a declaration.
 *
 * The population is defined by the repository's own statement of what is
 * long: an options type that accepts a `Safeguard` is a type for an
 * operation someone already judged worth guarding with a deadline, and an
 * operation worth a deadline is an operation worth reporting on. So the
 * rule is: **a type that takes a safeguard takes a progress sink, or
 * carries a written reason why it cannot.**
 *
 * Two further rules keep the stream honest rather than merely present:
 *
 *   - every stage handed to the counter is an IDENTIFIER, not prose. The
 *     event shape cannot enforce this in the type system, so it is
 *     enforced here - the same reason the advisory rail refuses
 *     caller-supplied sentences rather than documenting that it would
 *     prefer not to receive them. Every route a stage can travel is read:
 *     an inline literal, a bare `const`, a frozen object, a `stage:`
 *     field on a hand-built event - and an argument that resolves to none
 *     of those is REPORTED, because "I could not tell" is not a pass.
 *   - the sink type is synchronous. Four of the five operations are
 *     synchronous functions and cannot await one; a `Promise`-returning
 *     sink would compile and then silently drop every event's completion.
 *     Read through aliases and through both member forms, and asserted
 *     against `ProgressSink` itself, which is the shortest route to an
 *     awaited event.
 *
 * ## Why this file lexes instead of matching lines
 *
 * The first version of this census was a handful of regexes over raw
 * source, and four independent reviewers walked past it with a positive
 * control each. A required `safeguard` escaped, because the file filter
 * was the literal string `safeguard?:`. A `type X = { … }` alias escaped,
 * because only `interface` was enumerated. A `Promise`-returning sink
 * split over three lines escaped, because the sync rule read one line at
 * a time. Three emitters that hoist their stage into a bare `const`
 * escaped both stage rules, so a stage reading `"Scanning candidate
 * pairs, please wait..."` was reported clean. And a generic constraint
 * containing a brace did not merely hide a violation - it made the block
 * matcher read the wrong body, which is worse than a miss, because a
 * mis-parse reports a fact about a block that was never examined.
 *
 * So the population is now read from a lexed view of each module rather
 * than from its raw text. {@link lexCode}, the shared lexer in
 * `tests/helpers/source-lexer.ts`, blanks comment bodies and string,
 * template and regex CONTENTS while preserving every offset, so brace
 * matching cannot be steered by a `"{"` in a string or by a commented-out
 * member, and a rule that needs the literal value reads it back out of
 * the original text at the same offset. This file used to carry its own
 * character-identical copy of that lexer; the copy is gone, and the
 * helper is tested in its own right rather than only through this
 * census. On top of that view sit three
 * small parsers - one for declarations (`interface`, `class` and `type`
 * alike, with generic constraints skipped rather than walked into), one
 * for object members, and one for the string constants a stage can be
 * named by.
 *
 * This project has one runtime dependency and no TypeScript AST, so a
 * real parser is out. What is in reach is a lexer that is CORRECT about
 * the two things a census gets wrong - what is code and where a block
 * ends - and that is what this is.
 *
 * ## What it still does not see, stated rather than implied
 *
 *   - a heritage clause this tree cannot resolve: `extends` and `&` are
 *     followed into declarations found in this tree (same file first,
 *     then a uniquely-named one anywhere in `src/`), so a shape that
 *     inherits its safeguard is enumerated - but a base imported from a
 *     dependency, or one computed by `Omit<…>`, resolves to the whole
 *     base rather than to the mapped result.
 *   - a sink whose asynchrony is more than one alias deep. The type text
 *     of an `onProgress` member is expanded through named aliases and
 *     indexed accesses to a bounded depth; a chain longer than that is
 *     read as declared.
 *   - a counter it cannot recognise as one. A receiver is a counter when
 *     it was bound from `progressCounter(…)`, was declared a
 *     `ProgressCounter`, or is named for one; a counter arriving as an
 *     un-annotated parameter under a third name is invisible.
 *   - whether a declared `onProgress` is ever READ. This census is about
 *     declaration; the CLI progress tests are what prove a sink attached
 *     to a verb reaches the operation and produces records.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { lexCode } from "../../helpers/source-lexer.ts";

const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** Directories with no operation code in them. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/**
 * Interfaces that take a safeguard and deliberately take no sink.
 *
 * A written reason per entry, on the pattern the write-site census uses:
 * an exemption a reader cannot reconstruct is indistinguishable from an
 * oversight. Keep this list short; an entry here is a claim that the
 * operation genuinely has nothing to report, not that wiring it was
 * inconvenient.
 */
const DECLARED_EXEMPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "DreamApplyInput",
    "The dream pass's MUTATION STAGE, not a run: dream() owns the counter and has an `apply` stage open across this whole call. It takes the safeguard because the one sub-unit it dispatches - the opt-in heal enrichment - walks every user page in the vault and so needs a deadline inside a pass exactly as it does on its own; it takes no sink for the same reason scanBrain takes none from dream(), namely that a second stream would put two terminators on one run.",
  ],
  [
    "EmbeddingPhaseOptions",
    "A PHASE, not a run: called from indexInto and standalone by the vector backfill. Given a sink it would build a second counter, and a stream carrying two terminators cannot say which one ended the run - so it borrows the run owner's ProgressCounter instead, which is strictly more wiring than a sink, not less.",
  ],
]);

/** A stage name, or a value on a frozen stage object, must look like this. */
const STAGE_IDENTIFIER = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/** Constants whose values are stage names by their own name. */
const STAGE_CONSTANT = /(?:^|_)STAGES?$/;

/**
 * Bracket depth before each character, counting `{}`, `()` and `[]` only.
 *
 * Angle brackets are deliberately absent: `<` is a comparison as often as
 * it is a type argument, and a depth map that counted `i < n` would be
 * wrong for the rest of the file. The two places generics actually matter
 * - an interface header and a type alias's left side - scan them locally,
 * where the text is types and nothing else.
 */
function depths(code: string): ReadonlyArray<number> {
  const out: number[] = Array.from<number>({ length: code.length + 1 });
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    out[i] = d;
    const c = code[i]!;
    if (c === "{" || c === "(" || c === "[") d += 1;
    else if (c === "}" || c === ")" || c === "]") d = Math.max(0, d - 1);
  }
  out[code.length] = d;
  return out;
}

/** Index just past the `}` closing the block opened at `open`. */
function closeBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface Declaration {
  readonly name: string;
  readonly file: string;
  /** `interface X { … }` / `class X { … }`, or `type X = …`. */
  readonly kind: "interface" | "alias";
  /** The block body, or the alias's right-hand side. */
  readonly body: string;
  /** Names in an `extends` clause, or referenced by the alias. */
  readonly references: ReadonlyArray<string>;
}

/**
 * Scans a type-only region forward to `stop`, skipping generic argument
 * lists whole. Returns the index of the first `stop` character seen at
 * generic depth zero, or `-1`.
 *
 * This is the fix for the mis-parse a reviewer reproduced: the old header
 * regex ended at `[^{]*`, so `interface X<T extends { k: string }>` began
 * brace matching inside the CONSTRAINT and read `k: string` as the body
 * of a block whose real members were never examined.
 */
function scanTypeHeader(code: string, from: number, stop: string): number {
  let angle = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if (c === "<") angle += 1;
    else if (c === ">") {
      // `=>` inside a constraint is an arrow, not a closing bracket.
      if (code[i - 1] !== "=" && angle > 0) angle -= 1;
    } else if (angle > 0 && c === "{") i = closeBrace(code, i);
    else if (angle === 0 && stop.includes(c)) return i;
  }
  return -1;
}

/**
 * Index of the first character after a declaration's name and its type
 * parameter list, whitespace skipped.
 *
 * What comes back is how a DECLARATION is told apart from a mention. A
 * type-only import written `import { type ProgressSink }` puts the two
 * keywords side by side exactly as a declaration does, and reading it as
 * one made the census attribute a nearby frozen object to the sink type.
 * A declaration is followed by `=`, by `{`, or by `extends`; a mention is
 * followed by a comma or a brace that closes the import.
 */
function skipTypeParameters(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i] ?? "")) i += 1;
  if (code[i] === "<") {
    let angle = 0;
    for (; i < code.length; i++) {
      const c = code[i]!;
      if (c === "<") angle += 1;
      else if (c === ">" && code[i - 1] !== "=") {
        angle -= 1;
        if (angle === 0) {
          i += 1;
          break;
        }
      } else if (angle > 0 && c === "{") i = closeBrace(code, i);
    }
    while (i < code.length && /\s/.test(code[i] ?? "")) i += 1;
  }
  return i;
}

/** Capitalised names a heritage clause or alias body refers to. */
function referencedNames(text: string): ReadonlyArray<string> {
  return [...text.matchAll(/\b([A-Z][\w$]*)\b/g)].map((m) => m[1] ?? "");
}

/** Every `interface X { … }` and `type X = …` declared in `code`. */
function declarations(
  code: string,
  file: string,
  d: ReadonlyArray<number>,
): ReadonlyArray<Declaration> {
  const out: Declaration[] = [];
  const header =
    /\b(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|class|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of code.matchAll(header)) {
    const kind = match[1];
    const name = match[2] ?? "";
    const after = (match.index ?? 0) + match[0].length;
    const tail = skipTypeParameters(code, after);
    if (kind === "interface" || kind === "class") {
      const heritage =
        code[tail] === "{" || /^(?:extends|implements)\b/.test(code.slice(tail, tail + 10));
      if (!heritage) continue;
      const open = scanTypeHeader(code, tail, "{");
      if (open === -1) continue;
      const close = closeBrace(code, open);
      out.push({
        name,
        file,
        kind: "interface",
        body: code.slice(open + 1, close),
        references: referencedNames(code.slice(tail, open)),
      });
      continue;
    }
    if (code[tail] !== "=") continue;
    const assign = tail;
    let end = assign + 1;
    while (end < code.length && !(d[end] === d[assign + 1] && code[end] === ";")) end += 1;
    const body = code.slice(assign + 1, end);
    out.push({ name, file, kind: "alias", body, references: referencedNames(body) });
  }
  return out;
}

/**
 * The regions of a declaration whose members belong to the declaration
 * itself.
 *
 * An interface body is one region. An alias can have several, because
 * `Readonly<{ … }>` and `{ … } & { … }` are both ways of writing one
 * options object, and a census that only understood a bare `{ … }` would
 * be answered by wrapping it.
 */
function memberRegions(body: string, kind: Declaration["kind"]): ReadonlyArray<string> {
  if (kind === "interface") return [body];
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === "{") {
      const close = closeBrace(body, i);
      out.push(body.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The type text that follows `at`, to the member's terminator.
 *
 * A member ends at a `;` or `,` at depth zero, or at a newline that is
 * not continuing an expression - the last clause is what makes a sink
 * written across three lines one declaration rather than three.
 */
function typeText(body: string, d: ReadonlyArray<number>, at: number, stopAtBrace = false): string {
  let i = at;
  while (i < body.length) {
    const c = body[i]!;
    if (d[i] === 0 && (c === ";" || c === ",")) break;
    // A method signature in a CLASS is followed by its body; the return
    // type ends where that body opens.
    if (stopAtBrace && d[i] === 0 && c === "{") break;
    if (d[i] === 0 && c === "\n") {
      const soFar = body.slice(at, i).trim();
      if (soFar !== "" && !/[|&,?:]$|=>$/.test(soFar)) break;
    }
    i += 1;
  }
  return body.slice(at, i).trim();
}

/**
 * Member name to declared type text, for members at the top level of a
 * block or an object type. A nested member cannot satisfy the rule for
 * the shape that contains it, so depth zero is the whole filter.
 *
 * Both member forms are read. `onProgress?: (e) => void` is the idiom
 * this tree uses, but `onProgress(e): void` declares the same thing, and
 * a census that knew only the first would report the second as a shape
 * with no sink at all - a false alarm, which is the failure mode a census
 * does not survive twice.
 */
function objectMembers(body: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const d = depths(body);
  const method =
    /(?:(?:public|private|protected|static|abstract|override)\s+)*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of body.matchAll(method)) {
    const start = match.index ?? 0;
    if (d[start] !== 0) continue;
    const before = body.slice(0, start).trimEnd();
    const prev = before.at(-1) ?? "";
    if (prev !== "" && !";,{}".includes(prev)) continue;
    const openParen = start + match[0].length - 1;
    let close = openParen + 1;
    while (close < body.length && !(body[close] === ")" && d[close] === 1)) close += 1;
    let after = close + 1;
    while (after < body.length && /\s/.test(body[after] ?? "")) after += 1;
    if (body[after] !== ":") continue;
    out.set(match[1] ?? "", typeText(body, d, after + 1, true));
  }
  const member =
    /(?:(?:public|private|protected|static|abstract|override)\s+)*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g;
  for (const match of body.matchAll(member)) {
    const start = match.index ?? 0;
    if (d[start] !== 0) continue;
    const before = body.slice(0, start).trimEnd();
    const prev = before.at(-1) ?? "";
    if (prev !== "" && !";,{}&|(".includes(prev)) continue;
    out.set(match[1] ?? "", typeText(body, d, start + match[0].length));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants a stage can be named by
// ---------------------------------------------------------------------------

interface Constants {
  /** `const X = "literal"`. */
  readonly bare: ReadonlyMap<string, string>;
  /** `const X = Object.freeze({ k: "literal" })`, and `{ … } as const`. */
  readonly objects: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * The string constants declared in one module.
 *
 * Both shapes are here because both are in this tree: three emitters
 * hoist a bare `const BRIDGE_STAGE = "candidates"` and three hoist a
 * frozen object. The old census read the second shape and not the first,
 * which is how a stage reading like a sentence passed it.
 */
function constants(text: string, code: string): Constants {
  const bare = new Map<string, string>();
  const objects = new Map<string, ReadonlyMap<string, string>>();
  const decl = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/g;
  for (const match of code.matchAll(decl)) {
    const name = match[1] ?? "";
    const at = (match.index ?? 0) + match[0].length;
    const quote = code[at];
    if (quote === '"' || quote === "'") {
      const end = code.indexOf(quote, at + 1);
      if (end !== -1) bare.set(name, text.slice(at + 1, end));
      continue;
    }
    const frozen = /^Object\.freeze\(\s*\{/.exec(code.slice(at, at + 24));
    const open = frozen !== null ? at + frozen[0].length - 1 : code[at] === "{" ? at : -1;
    if (open === -1) continue;
    const close = closeBrace(code, open);
    const block = code.slice(open + 1, close);
    const values = new Map<string, string>();
    const entry = /([A-Za-z_$][\w$]*)\s*:\s*(["'])/g;
    for (const pair of block.matchAll(entry)) {
      const from = open + 1 + (pair.index ?? 0) + pair[0].length;
      const end = code.indexOf(pair[2] ?? '"', from);
      if (end !== -1) values.set(pair[1] ?? "", text.slice(from, end));
    }
    objects.set(name, values);
  }
  return { bare, objects };
}

/**
 * Names in this module that hold a {@link ProgressCounter}.
 *
 * A counter is usually called `progress`, and reading the receiver by
 * convention would be a census that a rename escapes. So the binding is
 * read instead: whatever `progressCounter(…)` was assigned to, and
 * whatever was declared as a `ProgressCounter`, is a counter here - and
 * the naming convention stays in the set as well, for the receivers a
 * module takes from a caller it does not name.
 */
function counterBindings(code: string): ReadonlySet<string> {
  const out = new Set<string>();
  const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*progressCounter\s*\(/g;
  for (const match of code.matchAll(bound)) out.add(match[1] ?? "");
  const typed = /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:readonly\s+)?ProgressCounter\b/g;
  for (const match of code.matchAll(typed)) out.add(match[1] ?? "");
  return out;
}

// ---------------------------------------------------------------------------
// The tree under census
// ---------------------------------------------------------------------------

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

interface CensusSource extends CensusFile {
  readonly code: string;
  readonly nesting: ReadonlyArray<number>;
  readonly decls: ReadonlyArray<Declaration>;
  readonly consts: Constants;
  readonly counters: ReadonlySet<string>;
}

/** One lex per module, kept, because the fixtures below re-run the tree. */
const ANALYZED = new Map<string, CensusSource>();

function analyze(files: ReadonlyArray<CensusFile>): ReadonlyArray<CensusSource> {
  return files.map((file) => {
    const cached = ANALYZED.get(file.path);
    if (cached !== undefined && cached.text === file.text) return cached;
    const code = lexCode(file.text);
    const nesting = depths(code);
    const source: CensusSource = {
      ...file,
      code,
      nesting,
      decls: declarations(code, file.path, nesting),
      consts: constants(file.text, code),
      counters: counterBindings(code),
    };
    ANALYZED.set(file.path, source);
    return source;
  });
}

/** Every `.ts` file under `src/`, in a stable order. */
function readSourceTree(dir: string = SRC_ROOT): CensusFile[] {
  const out: CensusFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...readSourceTree(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push({
        path: relative(SRC_ROOT, full).split(sep).join("/"),
        text: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 1: a type that takes a safeguard takes a sink
// ---------------------------------------------------------------------------

/** Declarations by name, same file first, then a unique one anywhere. */
function resolver(
  sources: ReadonlyArray<CensusSource>,
): (name: string, file: string) => ReadonlyArray<Declaration> {
  const byName = new Map<string, Declaration[]>();
  for (const source of sources) {
    for (const decl of source.decls) {
      const bucket = byName.get(decl.name) ?? [];
      bucket.push(decl);
      byName.set(decl.name, bucket);
    }
  }
  return (name, file) => {
    const all = byName.get(name) ?? [];
    // Declaration merging: two `interface X` in one module are one type.
    const local = all.filter((d) => d.file === file);
    if (local.length > 0) return local;
    // Cross-module, only when the name is unambiguous in the tree.
    const files = new Set(all.map((d) => d.file));
    return files.size === 1 ? all : [];
  };
}

type Resolve = ReturnType<typeof resolver>;

/**
 * Members of `decl`, plus the members of everything it extends or
 * intersects that this tree can resolve. Bounded, so a cyclic heritage
 * clause cannot hang the census.
 */
function effectiveMembers(
  decl: Declaration,
  resolve: Resolve,
  seen: Set<string> = new Set(),
): ReadonlyMap<string, string> {
  const key = `${decl.file}#${decl.name}#${decl.kind}`;
  const out = new Map<string, string>();
  if (seen.has(key) || seen.size > 16) return out;
  seen.add(key);
  for (const region of memberRegions(decl.body, decl.kind)) {
    for (const [name, type] of objectMembers(region)) out.set(name, type);
  }
  for (const reference of decl.references) {
    for (const parent of resolve(reference, decl.file)) {
      for (const [name, type] of effectiveMembers(parent, resolve, seen)) {
        if (!out.has(name)) out.set(name, type);
      }
    }
  }
  return out;
}

interface SafeguardRow {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly hasSink: boolean;
}

/**
 * Every declared shape that carries a `safeguard` member, optional or
 * required, declared or inherited.
 *
 * The member NAME is the whole test. Requiring the type to spell
 * `Safeguard` would drop `DreamStageOptions`, which types its field as
 * `DreamOptions["safeguard"]`, and a census that reads a type expression
 * is a census that can be evaded by writing a different one.
 */
function safeguardedShapes(sources: ReadonlyArray<CensusSource>): ReadonlyArray<SafeguardRow> {
  const resolve = resolver(sources);
  const out: SafeguardRow[] = [];
  for (const source of sources) {
    // Two `interface X` in one module are ONE type - the language merges
    // them - so the census reads them merged. A rule that read them apart
    // would report a violation against a type that does not exist.
    const merged = new Map<string, Declaration[]>();
    for (const decl of source.decls) {
      merged.set(decl.name, [...(merged.get(decl.name) ?? []), decl]);
    }
    for (const [name, group] of merged) {
      const members = new Map<string, string>();
      for (const decl of group) {
        for (const [member, type] of effectiveMembers(decl, resolve)) {
          if (!members.has(member)) members.set(member, type);
        }
      }
      if (!members.has("safeguard")) continue;
      out.push({
        id: `${source.path}: ${name}`,
        name,
        file: source.path,
        hasSink: members.has("onProgress"),
      });
    }
  }
  return out;
}

/**
 * Files that declare a `readonly safeguard` member, found without the
 * parser.
 *
 * This is the parser's own alarm. `readonly` appears in a type
 * declaration and nowhere else - not in an object literal, not in a
 * parameter list - so every file it matches must contribute at least one
 * row to the population above. A parser that stops finding blocks, or
 * reads the wrong one, goes quiet rather than red; this is what makes it
 * red.
 */
function filesDeclaringSafeguard(sources: ReadonlyArray<CensusSource>): ReadonlyArray<string> {
  return sources
    .filter((source) => /\breadonly\s+safeguard\s*\??\s*:/.test(source.code))
    .map((source) => source.path);
}

// ---------------------------------------------------------------------------
// Rule 2: no stage is prose
// ---------------------------------------------------------------------------

/** Offsets of the first argument of the call whose `(` is at `open`. */
function firstArgument(
  code: string,
  d: ReadonlyArray<number>,
  open: number,
): readonly [number, number] {
  const base = d[open + 1] ?? 0;
  let i = open + 1;
  while (i < code.length) {
    const c = code[i]!;
    if ((d[i] ?? 0) < base) break;
    if ((d[i] ?? 0) === base && (c === "," || c === ")")) break;
    i += 1;
  }
  let from = open + 1;
  while (from < i && /\s/.test(code[from] ?? "")) from += 1;
  let to = i;
  while (to > from && /\s/.test(code[to - 1] ?? "")) to -= 1;
  return [from, to];
}

/**
 * Every stage a counter is handed, resolved to its literal value.
 *
 * An argument this cannot resolve is reported rather than skipped. That
 * is the difference between a census and a sample: a stage computed at
 * run time is exactly the shape that would carry a caller's sentence onto
 * the stream, and "I could not tell" is not a pass.
 */
function proseStages(sources: ReadonlyArray<CensusSource>): ReadonlyArray<string> {
  const offenders: string[] = [];
  const globalBare = new Map<string, string>();
  const globalObjects = new Map<string, ReadonlyMap<string, string>>();
  for (const source of sources) {
    for (const [name, value] of source.consts.bare) globalBare.set(name, value);
    for (const [name, values] of source.consts.objects) globalObjects.set(name, values);
  }

  for (const source of sources) {
    // A constant named for stages must hold stage names, whether or not
    // any call site was found to hand one over.
    for (const [name, value] of source.consts.bare) {
      if (!STAGE_CONSTANT.test(name)) continue;
      if (!STAGE_IDENTIFIER.test(value)) {
        offenders.push(`${source.path}: ${name} = ${JSON.stringify(value)}`);
      }
    }
    for (const [name, values] of source.consts.objects) {
      if (!STAGE_CONSTANT.test(name)) continue;
      for (const [key, value] of values) {
        if (!STAGE_IDENTIFIER.test(value)) {
          offenders.push(`${source.path}: ${name}.${key} = ${JSON.stringify(value)}`);
        }
      }
    }

    // A hand-built event carries a stage too. Only in the modules that
    // know the progress schema, so an unrelated module's `stage:` field
    // is not conscripted into this vocabulary.
    if (source.code.includes("PROGRESS_SCHEMA")) {
      for (const match of source.code.matchAll(/\bstage\s*:\s*"/g)) {
        const from = (match.index ?? 0) + match[0].length;
        const end = source.code.indexOf('"', from);
        const value = source.text.slice(from, end === -1 ? from : end);
        if (!STAGE_IDENTIFIER.test(value)) {
          offenders.push(`${source.path}: stage: ${JSON.stringify(value)}`);
        }
      }
    }

    const call = /\b([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(start|advance)\s*\(/g;
    for (const match of source.code.matchAll(call)) {
      const receiver = match[1] ?? "";
      if (!/progress|counter/i.test(receiver) && !source.counters.has(receiver)) continue;
      const open = (match.index ?? 0) + match[0].length - 1;
      const [from, to] = firstArgument(source.code, source.nesting, open);
      const argument = source.code.slice(from, to);
      // The lexer blanked the contents of a literal, so the site is
      // named from the original text and only READ from the lexed view.
      const site = `${source.path}: ${receiver}.${match[2]}(${source.text.slice(from, to)})`;

      let value: string | undefined;
      if (/^["']/.test(argument) && argument.length >= 2) {
        value = source.text.slice(from + 1, to - 1);
      } else if (/^[A-Za-z_$][\w$]*$/.test(argument)) {
        // A constant imported from elsewhere resolves across the tree; a
        // lower-case name is a local binding, and a local binding that
        // does not resolve HERE is a stage this census cannot read.
        value =
          source.consts.bare.get(argument) ??
          (/^[A-Z][A-Z0-9_]*$/.test(argument) ? globalBare.get(argument) : undefined);
      } else {
        const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(argument);
        if (member !== null) {
          const holder =
            source.consts.objects.get(member[1] ?? "") ?? globalObjects.get(member[1] ?? "");
          value = holder?.get(member[2] ?? "");
        }
      }
      if (value === undefined) {
        offenders.push(`${site}: stage does not resolve to a literal`);
        continue;
      }
      if (!STAGE_IDENTIFIER.test(value)) offenders.push(`${site} = ${JSON.stringify(value)}`);
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Rule 3: the sink is synchronous
// ---------------------------------------------------------------------------

/** Expands a type expression through named aliases, to a bounded depth. */
function expandType(type: string, file: string, resolve: Resolve, depth = 0): string {
  if (depth > 3) return type;
  // `import("./progress.ts").ProgressSink` lexes to `import("").Name`.
  const direct = /^(?:import\(\s*["'][^"']*["']\s*\)\.)?([A-Za-z_$][\w$]*)$/.exec(type);
  if (direct !== null) {
    const parts = resolve(direct[1] ?? "", file).map((d) =>
      expandType(d.body.trim(), d.file, resolve, depth + 1),
    );
    return parts.length === 0 ? type : `${type} ${parts.join(" ")}`;
  }
  const indexed = /^([A-Za-z_$][\w$]*)\[\s*["']([^"']*)["']\s*\]$/.exec(type);
  if (indexed !== null) {
    const parts: string[] = [];
    for (const decl of resolve(indexed[1] ?? "", file)) {
      const member = effectiveMembers(decl, resolve).get(indexed[2] ?? "");
      if (member !== undefined) parts.push(expandType(member, decl.file, resolve, depth + 1));
    }
    return parts.length === 0 ? type : `${type} ${parts.join(" ")}`;
  }
  return type;
}

/**
 * Every `onProgress` declaration whose type can carry a promise.
 *
 * Whole declarations, not lines: the reviewer's control split a
 * `Promise`-returning sink over three lines and the line-based rule it
 * replaced never saw the return type. Aliases are expanded too, so
 * `onProgress?: AsyncSink` is read as what `AsyncSink` says it is.
 */
function asyncSinks(sources: ReadonlyArray<CensusSource>): ReadonlyArray<string> {
  const resolve = resolver(sources);
  const offenders: string[] = [];
  for (const source of sources) {
    const d = source.nesting;
    // Both forms: `onProgress?: (e) => T` and `onProgress(e): T`. The
    // second declares the same sink and would otherwise be read as the
    // parameter list it opens with.
    const sites = /\bonProgress\s*(?:\??\s*:|\()/g;
    for (const match of source.code.matchAll(sites)) {
      let from = (match.index ?? 0) + match[0].length;
      const methodForm = match[0].endsWith("(");
      if (methodForm) {
        const openParen = from - 1;
        const inner = (d[openParen] ?? 0) + 1;
        let close = from;
        while (close < source.code.length && !(source.code[close] === ")" && d[close] === inner)) {
          close += 1;
        }
        let after = close + 1;
        while (after < source.code.length && /\s/.test(source.code[after] ?? "")) after += 1;
        if (source.code[after] !== ":") continue;
        from = after + 1;
      }
      const base = d[from] ?? 0;
      let i = from;
      while (i < source.code.length) {
        const c = source.code[i]!;
        if ((d[i] ?? 0) < base) break;
        if ((d[i] ?? 0) === base && (c === ";" || c === ",")) break;
        if (methodForm && (d[i] ?? 0) === base && c === "{") break;
        if ((d[i] ?? 0) === base && c === "\n") {
          const soFar = source.code.slice(from, i).trim();
          if (soFar !== "" && !/[|&,?:]$|=>$/.test(soFar)) break;
        }
        i += 1;
      }
      const declared = source.code.slice(from, i).trim();
      if (/\bPromise\s*</.test(expandType(declared, source.path, resolve))) {
        offenders.push(`${source.path}: onProgress?: ${declared.replace(/\s+/g, " ")}`);
      }
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

const TREE = readSourceTree();
const SOURCES = analyze(TREE);

describe("progress census", () => {
  test("every options type that takes a safeguard takes a progress sink", () => {
    const population = safeguardedShapes(SOURCES);
    const missing = population
      .filter((row) => !row.hasSink && !DECLARED_EXEMPTIONS.has(row.name))
      .map((row) => row.id);

    // A census that found nothing passes for the wrong reason.
    expect(population.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("the parser sees every module that declares a safeguard", () => {
    // The alarm on the parser itself: a block matcher that goes wrong
    // reports a clean tree, so the population is cross-checked against a
    // naive search that cannot mis-parse because it does not parse.
    const enumerated = new Set(safeguardedShapes(SOURCES).map((row) => row.file));
    const unseen = filesDeclaringSafeguard(SOURCES).filter((path) => !enumerated.has(path));
    expect(unseen).toEqual([]);
  });

  test("every declared exemption names a type that still exists", () => {
    const declared = new Set(safeguardedShapes(SOURCES).map((row) => row.name));
    const stale = [...DECLARED_EXEMPTIONS.keys()].filter((name) => !declared.has(name));
    expect(stale).toEqual([]);
  });

  test("every exemption carries a reason a reader can act on", () => {
    for (const [name, reason] of DECLARED_EXEMPTIONS) {
      // Long enough to be an argument rather than a label. The
      // destructive-site census uses the same floor for the same reason.
      expect(reason.length).toBeGreaterThanOrEqual(80);
      expect(reason).not.toMatch(/\bTODO\b|\bfor now\b|\blater\b/i);
      expect(name).not.toBe("");
    }
  });

  test("no stage is prose, wherever the emitter keeps it", () => {
    // Identifiers and integers only: the human sentence is rendered at
    // the edge from the identifier. A stage with a space in it would mean
    // a caller had started writing sentences onto a structured stream.
    expect(proseStages(SOURCES)).toEqual([]);
  });

  test("the sink is synchronous everywhere it is declared", () => {
    // Four of the five long operations are synchronous functions. An
    // async sink would typecheck and then drop every event's completion
    // on the floor, which is a silent failure of exactly the kind this
    // spine exists to remove.
    expect(asyncSinks(SOURCES)).toEqual([]);
  });

  test("the sink type itself promises nothing", () => {
    // The rule above reads call sites and members. This reads the one
    // declaration they all point at, so making the SINK async - the
    // shortest route to an awaited event - is not a way through.
    const sink = SOURCES.flatMap((source) => source.decls).filter(
      (decl) => decl.name === "ProgressSink",
    );
    expect(sink.length).toBeGreaterThan(0);
    for (const decl of sink) {
      expect(decl.body).not.toMatch(/\bPromise\s*</);
      expect(decl.body).toMatch(/=>\s*void/);
    }
  });
});

// ---------------------------------------------------------------------------
// The census can fail
// ---------------------------------------------------------------------------

/**
 * Each fixture below is one of the ways a reviewer walked past the
 * previous census, kept as a test so the hole cannot reopen quietly. The
 * shape a fixture is written in is the shape that was reproduced, not a
 * strawman: every one of them was confirmed to PASS the old rules before
 * the new ones were written.
 */
/** Only the intruder's own rows, so an unrelated module cannot answer for it. */
function onlyFrom(path: string, lines: ReadonlyArray<string>): ReadonlyArray<string> {
  return lines.filter((line) => line.startsWith(`${path}:`));
}

describe("the census can fail", () => {
  // The intruder joins the real tree rather than standing alone, so a
  // fixture proves the rule under the conditions the rule runs in - the
  // name resolution, the constant table, the lot. What each assertion
  // reads back is only the intruder's own rows, so a fixture cannot go
  // green or red because of an unrelated module.
  const intruder = (path: string, text: string): ReadonlyArray<CensusSource> =>
    analyze([...TREE, { path, text }]);

  const sinkless = (path: string, text: string): ReadonlyArray<string> =>
    safeguardedShapes(intruder(path, text))
      .filter((row) => row.file === path && !row.hasSink && !DECLARED_EXEMPTIONS.has(row.name))
      .map((row) => row.id);

  test("a REQUIRED safeguard is in the population too", () => {
    const path = "core/brain/synthetic-required.ts";
    expect(
      sinkless(path, "export interface EvadeRequired {\n  readonly safeguard: Safeguard;\n}\n"),
    ).toEqual([`${path}: EvadeRequired`]);
  });

  test("a type alias is in the population too", () => {
    const path = "core/brain/synthetic-alias.ts";
    expect(
      sinkless(path, "export type EvadeAlias = {\n  readonly safeguard?: Safeguard;\n};\n"),
    ).toEqual([`${path}: EvadeAlias`]);
  });

  test("a brace in a generic constraint does not move the block", () => {
    const path = "core/brain/synthetic-generic.ts";
    expect(
      sinkless(
        path,
        "export interface EvadeGeneric<T extends { k: string }> {\n  readonly seed: T;\n  readonly safeguard?: Safeguard;\n}\n",
      ),
    ).toEqual([`${path}: EvadeGeneric`]);
  });

  test("a brace inside a string literal does not move the block", () => {
    const path = "core/brain/synthetic-string-brace.ts";
    expect(
      sinkless(
        path,
        'export interface EvadeStringBrace {\n  readonly opener?: "{";\n  readonly safeguard?: Safeguard;\n}\n\nexport interface Unrelated {\n  readonly onProgress?: ProgressSink;\n}\n',
      ),
    ).toEqual([`${path}: EvadeStringBrace`]);
  });

  test("a commented-out sink is not a sink", () => {
    const path = "core/brain/synthetic-comment.ts";
    expect(
      sinkless(
        path,
        "export interface EvadeComment {\n  readonly safeguard?: Safeguard;\n  // readonly onProgress?: ProgressSink;\n}\n",
      ),
    ).toEqual([`${path}: EvadeComment`]);
  });

  test("an inherited safeguard puts the heir in the population", () => {
    const path = "core/brain/synthetic-extends.ts";
    expect(
      sinkless(
        path,
        "interface SyntheticGuarded {\n  readonly safeguard?: Safeguard;\n}\n\nexport interface EvadeExtends extends SyntheticGuarded {\n  readonly limit?: number;\n}\n",
      ),
    ).toEqual([`${path}: SyntheticGuarded`, `${path}: EvadeExtends`]);
  });

  test("an inherited sink satisfies the rule, so the census does not cry wolf", () => {
    const path = "core/brain/synthetic-inherited-sink.ts";
    expect(
      sinkless(
        path,
        "interface SyntheticWatched {\n  readonly safeguard?: Safeguard;\n  readonly onProgress?: ProgressSink;\n}\n\nexport interface HeirOptions extends SyntheticWatched {\n  readonly limit?: number;\n}\n",
      ),
    ).toEqual([]);
  });

  test("a class that holds a safeguard is in the population too", () => {
    // An operation implemented as an object rather than a function is
    // still an operation, and `readonly safeguard` reads the same in a
    // class body as in an interface - so the naive cross-check would see
    // it whether or not the parser did.
    const path = "core/brain/synthetic-runner.ts";
    const text =
      "export class SyntheticRunner {\n" +
      "  private readonly safeguard?: Safeguard;\n" +
      "  run(): void {\n    this.safeguard?.checkpoint();\n  }\n}\n";
    expect(sinkless(path, text)).toEqual([`${path}: SyntheticRunner`]);
  });

  test("declaration merging is one type, not a violation", () => {
    const path = "core/brain/synthetic-merged.ts";
    expect(
      sinkless(
        path,
        "export interface MergedOptions {\n  readonly safeguard?: Safeguard;\n}\n\nexport interface MergedOptions {\n  readonly onProgress?: ProgressSink;\n}\n",
      ),
    ).toEqual([]);
  });

  test("a wrapper and an intersection are read through", () => {
    const path = "core/brain/synthetic-wrapped.ts";
    expect(
      sinkless(
        path,
        "export type EvadeWrapped = Readonly<{\n  safeguard?: Safeguard;\n}>;\n\nexport type EvadeIntersected = { readonly limit?: number } & {\n  readonly safeguard?: Safeguard;\n};\n",
      ),
    ).toEqual([`${path}: EvadeWrapped`, `${path}: EvadeIntersected`]);
  });

  test("a module the parser cannot read is reported, not skipped", () => {
    // The population and the naive search must agree. A block matcher
    // that walks off the end of a file goes quiet; this is the alarm.
    const path = "core/brain/synthetic-unparsed.ts";
    const sources = intruder(
      path,
      "export interface Broken {\n  readonly safeguard?: Safeguard;\n",
    );
    const enumerated = new Set(safeguardedShapes(sources).map((row) => row.file));
    expect(filesDeclaringSafeguard(sources).filter((p) => !enumerated.has(p))).toEqual([]);
    // …and the unterminated block is still in the population, because
    // the matcher runs to the end of the file rather than giving up.
    expect(enumerated.has(path)).toBe(true);
  });

  test("a bare stage constant carrying prose is caught", () => {
    const path = "core/brain/synthetic-bare-stage.ts";
    const text =
      'const SYNTHETIC_STAGE = "Scanning candidate pairs, please wait...";\n' +
      "export function run(): void {\n  progress.start(SYNTHETIC_STAGE);\n}\n";
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: SYNTHETIC_STAGE = "Scanning candidate pairs, please wait..."`,
      `${path}: progress.start(SYNTHETIC_STAGE) = "Scanning candidate pairs, please wait..."`,
    ]);
  });

  test("a frozen stage object carrying prose is caught", () => {
    const path = "core/brain/synthetic-frozen-stage.ts";
    const text =
      'const SYNTHETIC_STAGE = Object.freeze({ sweep: "Propagating labels ACROSS the graph" } as const);\n' +
      "export function run(): void {\n  progress.advance(SYNTHETIC_STAGE.sweep);\n}\n";
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: SYNTHETIC_STAGE.sweep = "Propagating labels ACROSS the graph"`,
      `${path}: progress.advance(SYNTHETIC_STAGE.sweep) = "Propagating labels ACROSS the graph"`,
    ]);
  });

  test("an inline stage literal carrying prose is caught", () => {
    const path = "core/brain/synthetic-inline-stage.ts";
    const text = 'export function run(): void {\n  progress.start("Working, please wait");\n}\n';
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: progress.start("Working, please wait") = "Working, please wait"`,
    ]);
  });

  test("a stage computed at run time is reported rather than skipped", () => {
    const path = "core/brain/synthetic-dynamic-stage.ts";
    const text = "export function run(label: string): void {\n  progress.start(label);\n}\n";
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: progress.start(label): stage does not resolve to a literal`,
    ]);
  });

  test("a counter under any other name is still a counter", () => {
    const path = "core/brain/synthetic-renamed-counter.ts";
    const text =
      "export function run(): void {\n" +
      "  const ticker = progressCounter(OPERATION.dream, undefined);\n" +
      '  ticker.start("Working away on it");\n' +
      "}\n";
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: ticker.start("Working away on it") = "Working away on it"`,
    ]);
  });

  test("a hand-built event carrying prose is caught", () => {
    const path = "core/brain/synthetic-hand-built.ts";
    const text =
      'export function emit(): void {\n  sink({ schema: PROGRESS_SCHEMA, stage: "still working" });\n}\n';
    expect(onlyFrom(path, proseStages(intruder(path, text)))).toEqual([
      `${path}: stage: "still working"`,
    ]);
  });

  test("a multi-line Promise-returning sink is caught", () => {
    const path = "core/brain/synthetic-async-sink.ts";
    const text =
      "export interface EvadeAsync {\n  readonly safeguard?: Safeguard;\n  readonly onProgress?: (\n    event: ProgressEvent,\n  ) => Promise<void>;\n}\n";
    expect(onlyFrom(path, asyncSinks(intruder(path, text)))).toEqual([
      `${path}: onProgress?: ( event: ProgressEvent, ) => Promise<void>`,
    ]);
  });

  test("a Promise-returning sink hidden behind an alias is caught", () => {
    const path = "core/brain/synthetic-alias-sink.ts";
    const text =
      "type SyntheticAsyncSink = (event: ProgressEvent) => Promise<void>;\n\nexport interface EvadeAliasSink {\n  readonly safeguard?: Safeguard;\n  readonly onProgress?: SyntheticAsyncSink;\n}\n";
    expect(onlyFrom(path, asyncSinks(intruder(path, text)))).toEqual([
      `${path}: onProgress?: SyntheticAsyncSink`,
    ]);
  });

  test("a method-form sink is a sink, promise and all", () => {
    const path = "core/brain/synthetic-method-sink.ts";
    const text =
      "export interface EvadeMethodSink {\n  readonly safeguard?: Safeguard;\n  onProgress(event: ProgressEvent): Promise<void>;\n}\n";
    // Declared, so the shape is not reported as sinkless…
    expect(sinkless(path, text)).toEqual([]);
    // …and the sink it declared is still held to being synchronous.
    expect(onlyFrom(path, asyncSinks(intruder(path, text)))).toEqual([
      `${path}: onProgress?: Promise<void>`,
    ]);
  });

  test("the real sink is not reported, so the rule discriminates", () => {
    const path = "core/brain/synthetic-sync-sink.ts";
    const text =
      'export interface FineOptions {\n  readonly safeguard?: Safeguard;\n  readonly onProgress?: import("./progress.ts").ProgressSink;\n}\n';
    expect(onlyFrom(path, asyncSinks(intruder(path, text)))).toEqual([]);
  });
});
