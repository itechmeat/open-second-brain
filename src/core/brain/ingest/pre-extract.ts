/**
 * Deterministic, no-LLM code-structure pre-extractor (P4, t_ef786747).
 *
 * A pre-ingest pass that turns one CODE source into JSON seeds an agent can
 * treat as pre-extracted facts: classes and functions become entity seeds,
 * imports and inheritance become edge seeds. It runs no model - structural
 * parsing per language family via a line grammar - and is a deliberate FALLBACK
 * pre-pass, not a codegraph substitute.
 *
 * Determinism: the output depends only on (path, content). Seeds are deduped
 * and sorted with a fixed key, so the same input always yields byte-identical
 * JSON. No timestamps, no randomness, no natural-language word lists (only
 * programming-language keywords, which are grammar).
 *
 * Honesty: an unsupported file extension yields an explicit `extracted: false`
 * report with a reason - never a fake empty success that would masquerade an
 * un-parsed source as "no structure found". A supported language that genuinely
 * has no declarations returns an empty-but-`extracted: true` result.
 */

import { resolveUniqueMatch } from "../../graph/unique-match.ts";

/** A class/function declaration surfaced as an entity seed. */
export interface CodeEntitySeed {
  readonly kind: "class" | "function";
  readonly name: string;
}

/**
 * A structural relationship surfaced as an edge seed. `imports` runs from the
 * source path to a module specifier; `inherits` runs from a subclass to a base
 * class (TS `extends`/`implements`, Python base classes); `uses` runs from a
 * `.tsx`/`.jsx` source path to a JSX component it renders.
 *
 * `resolvedTo` is present only when the caller supplied the ingested-file set
 * and a relative import specifier probed to exactly one ingested file; it
 * carries that file's canonical vault-relative path. An ambiguous or unmet
 * probe leaves the seed with its raw specifier and no field.
 */
export interface CodeEdgeSeed {
  readonly kind: "imports" | "inherits" | "uses";
  readonly from: string;
  readonly to: string;
  readonly resolvedTo?: string;
}

/** Options for the pre-extract pass. Absent, every default is byte-identical. */
export interface PreExtractOptions {
  /**
   * Canonical vault-relative paths of the files already ingested - the
   * content manifest's key set. Supplied, a relative import specifier
   * (`./`/`../` for TS/JS, leading-dot for Python) that probes to exactly
   * one member fills the seed's `resolvedTo`.
   */
  readonly ingestedFiles?: ReadonlySet<string>;
}

/** A source whose language family was recognized and parsed. */
export interface PreExtractSuccess {
  readonly extracted: true;
  /** Recognized language family: `typescript`, `javascript`, or `python`. */
  readonly language: string;
  /** Class/function seeds, deduped and sorted by (kind, name). */
  readonly entities: readonly CodeEntitySeed[];
  /** Import/inheritance/uses seeds, deduped and sorted by (kind, from, to). */
  readonly edges: readonly CodeEdgeSeed[];
}

/** A source whose extension is outside the extractor's supported languages. */
export interface PreExtractUnsupported {
  readonly extracted: false;
  readonly reason: string;
}

export type PreExtractResult = PreExtractSuccess | PreExtractUnsupported;

/** Recognized language family for a lowercase, dot-prefixed extension. */
type Language = "typescript" | "javascript" | "python";

/** Extension -> language family. The single home for supported extensions. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, Language> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
]);

/**
 * The TS/JS-family extensions in declaration order: what a `./`/`../`
 * specifier may resolve to. A Python file is never a TS/JS module target.
 */
const JS_FAMILY_EXTENSIONS: ReadonlyArray<string> = [...LANGUAGE_BY_EXTENSION]
  .filter(([, language]) => language !== "python")
  .map(([ext]) => ext);

/** Directory entry file a TS/JS specifier naming a directory resolves to, minus extension. */
const JS_INDEX_BASENAME = "index";
/** Extension a Python relative module specifier resolves to. */
const PY_MODULE_EXTENSION = ".py";
/** File a Python relative specifier naming a package resolves to. */
const PY_PACKAGE_INIT = "__init__.py";
/** A Python specifier of dots only (`.`, `..`): it names a package, never a module file. */
const PY_PACKAGE_ONLY_SPECIFIER = /^\.+$/;

/** TS/JS class declaration head, capturing the class name. */
const TS_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
/** TS/JS function declaration head, capturing the function name. */
const TS_FUNCTION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
/** `extends <Base>` clause on a TS/JS class line. */
const TS_EXTENDS = /\bextends\s+([A-Za-z_$][\w$.]*)/;
/** `implements <A>, <B>` clause on a TS/JS class line (comma list). */
const TS_IMPLEMENTS = /\bimplements\s+([A-Za-z_$][\w$.,\s]*?)\s*\{/;
/** `import ... from "mod"` / `export ... from "mod"` module specifier. */
const TS_FROM = /^(?:import|export)\b.*?\bfrom\s*['"]([^'"]+)['"]/;
/** Bare side-effect import `import "mod"`. */
const TS_BARE_IMPORT = /^import\s*['"]([^'"]+)['"]/;
/** CommonJS `require("mod")` anywhere on the line. */
const TS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;

/** Python class head, capturing the name and an optional base-list group. */
const PY_CLASS = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
/** Python function/method head (module-level or indented), capturing the name. */
const PY_FUNCTION = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
/** Python `import a, b.c as d` statement body (after the keyword). */
const PY_IMPORT = /^import\s+(.+?)\s*$/;
/** Python `from <mod> import ...`, capturing the (possibly relative) module. */
const PY_FROM = /^from\s+(\.*[\w.]*)\s+import\b/;
/** A bare Python identifier or dotted name (used to filter base-class args). */
const PY_DOTTED_NAME = /^[A-Za-z_][\w.]*$/;

/**
 * How one language family binds a relative import specifier: which
 * specifiers are relative, how one becomes a `/`-relative path, and the
 * candidate files it may name, in probe tiers. The first tier holding any
 * ingested file decides; a later tier is consulted only when every earlier
 * one is empty.
 */
interface RelativeImportRule {
  readonly relative: RegExp;
  readonly toRelative: (specifier: string) => string;
  readonly probeTiers: (joined: string, specifier: string) => ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * TS/JS: a `./`/`../` specifier. The joined path is probed alone first, as a
 * module resolver does for a specifier that already names its file
 * (`./widget.css`, `./view.js`); then every TS/JS-family extension and the
 * `/index` form of each.
 */
const TS_RELATIVE_IMPORT: RelativeImportRule = {
  relative: /^\.{1,2}\//,
  toRelative: (specifier) => specifier,
  probeTiers: (joined) => [
    [joined],
    [
      ...JS_FAMILY_EXTENSIONS.map((ext) => `${joined}${ext}`),
      ...JS_FAMILY_EXTENSIONS.map((ext) => childPath(joined, `${JS_INDEX_BASENAME}${ext}`)),
    ],
  ],
};

/**
 * Python: a leading-dot `from .x import` specifier names the module file
 * `x.py` or the package `x/__init__.py`. A bare-dot specifier (`from .
 * import y`) names the enclosing package, so only its `__init__.py`.
 */
const PY_RELATIVE_IMPORT: RelativeImportRule = {
  relative: /^\./,
  toRelative: pythonSpecifierToRelative,
  probeTiers: (joined, specifier) => [
    PY_PACKAGE_ONLY_SPECIFIER.test(specifier)
      ? [childPath(joined, PY_PACKAGE_INIT)]
      : [`${joined}${PY_MODULE_EXTENSION}`, childPath(joined, PY_PACKAGE_INIT)],
  ],
};

/**
 * A JSX opening tag whose name is a component, decided by structure alone:
 *
 * - the name sits immediately after `<`, and it starts uppercase (or
 *   `_`/`$`): a lowercase-initial name is a DOM/intrinsic tag;
 * - the character before `<` is not an identifier character, a `.`, or a
 *   `)`: those make the `<` a type-argument list (`Array<Foo>`,
 *   `make()<Foo>`) or a comparison, not an element;
 * - the name is followed by what only an opening tag allows: the end of the
 *   line (attributes continue below), `>`, `/>`, or whitespace and then an
 *   attribute start (a name or a `{...spread}`). That refuses a dotted
 *   member-expression tag (`<Nav.Item>`) and a type-parameter list, whose
 *   name is followed by `,` (`<T,>`) or by `extends` (`<K extends string>`);
 * - a bare `>` is not followed by `(`: that is a generic call signature
 *   (`type Fn = <T>(value: T) => T`, `const id: <U>(x: U) => U`), not an
 *   element.
 *
 * No per-language tag vocabulary that could fall out of date. Known limits of
 * a line grammar, accepted on purpose: a capitalized comparison operand
 * written without a space (`a <Foo b`) can misfire, a generic component
 * (`<Foo<T> />`) is missed, an element whose text child opens with `(`
 * (`<Foo>(note)</Foo>`) is missed, and a closing tag never matches. False edges are
 * bounded by the uppercase-initial rule; missed usages only thin the `uses`
 * tier.
 */
const JSX_COMPONENT_TAG =
  /(^|[^A-Za-z0-9_$.)])<([A-Z_$][A-Za-z0-9_$]*)(?=$|\s*(?:\/>|>(?!\s*\())|\s+(?!extends\b)[A-Za-z_${])/g;

/** Extensions whose line grammar carries JSX (the `uses` tier). */
const JSX_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx"]);

/**
 * Whether `path` carries an extension the pass parses. A caller that must
 * gather inputs before parsing (file bytes, the ingested-file set) asks this
 * first, so an unsupported source costs no read.
 */
export function isCodeStructureSource(path: string): boolean {
  return LANGUAGE_BY_EXTENSION.has(extensionOf(path));
}

/**
 * Extract code structure from `content` addressed by `path`. Returns
 * `extracted: false` with a reason when the extension is unsupported, otherwise
 * the deduped, sorted entity/edge seeds for the recognized language.
 *
 * With `opts.ingestedFiles`, every relative import specifier is probed
 * against that set in its own language's forms - TS/JS: the joined path, then
 * each TS/JS-family extension and `/index` + each; Python: `<name>.py` and
 * `<name>/__init__.py` - and exactly one member fills the seed's `resolvedTo`.
 */
export function preExtractCodeStructure(
  path: string,
  content: string,
  opts: PreExtractOptions = {},
): PreExtractResult {
  const ext = extensionOf(path);
  const language = ext ? LANGUAGE_BY_EXTENSION.get(ext) : undefined;
  if (language === undefined) {
    const shown = ext.length > 0 ? ext : "(none)";
    return {
      extracted: false,
      reason: `unsupported source extension "${shown}" for code-structure pre-extraction`,
    };
  }

  const entities: CodeEntitySeed[] = [];
  const edges: CodeEdgeSeed[] = [];
  if (language === "python") {
    parsePython(path, content, entities, edges, opts.ingestedFiles);
  } else {
    parseTsJs(path, content, entities, edges, opts.ingestedFiles);
  }

  return {
    extracted: true,
    language,
    entities: dedupeSorted(entities, entityKey),
    edges: dedupeSorted(edges, edgeKey),
  };
}

/** Parse the TS/JS line grammar into entity/edge seeds. */
function parseTsJs(
  path: string,
  content: string,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
  ingestedFiles?: ReadonlySet<string>,
): void {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || isTsComment(line)) continue;

    const classMatch = TS_CLASS.exec(line);
    if (classMatch) {
      const name = classMatch[1]!;
      entities.push({ kind: "class", name });
      const ext = TS_EXTENDS.exec(line);
      if (ext) edges.push({ kind: "inherits", from: name, to: ext[1]! });
      const impl = TS_IMPLEMENTS.exec(line);
      if (impl) {
        for (const base of splitNames(impl[1]!)) {
          edges.push({ kind: "inherits", from: name, to: base });
        }
      }
    }

    const fnMatch = TS_FUNCTION.exec(line);
    if (fnMatch) entities.push({ kind: "function", name: fnMatch[1]! });

    const from = TS_FROM.exec(line) ?? TS_BARE_IMPORT.exec(line);
    if (from) edges.push(importSeed(path, from[1]!, ingestedFiles, TS_RELATIVE_IMPORT));
    const req = TS_REQUIRE.exec(line);
    if (req) edges.push(importSeed(path, req[1]!, ingestedFiles, TS_RELATIVE_IMPORT));

    if (JSX_EXTENSIONS.has(extensionOf(path))) {
      for (const match of line.matchAll(JSX_COMPONENT_TAG)) {
        edges.push({ kind: "uses", from: path, to: match[2]! });
      }
    }
  }
}

/** Parse the Python line grammar into entity/edge seeds. */
function parsePython(
  path: string,
  content: string,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
  ingestedFiles?: ReadonlySet<string>,
): void {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const classMatch = PY_CLASS.exec(line);
    if (classMatch) {
      const name = classMatch[1]!;
      entities.push({ kind: "class", name });
      const bases = classMatch[2];
      if (bases !== undefined) {
        for (const base of splitNames(bases)) {
          // Keep only real base classes: drop keyword args (metaclass=..., etc)
          // and anything that is not a bare or dotted identifier.
          if (PY_DOTTED_NAME.test(base)) edges.push({ kind: "inherits", from: name, to: base });
        }
      }
      continue;
    }

    const fnMatch = PY_FUNCTION.exec(line);
    if (fnMatch) {
      entities.push({ kind: "function", name: fnMatch[1]! });
      continue;
    }

    const fromMatch = PY_FROM.exec(line);
    if (fromMatch) {
      const mod = fromMatch[1]!;
      if (mod.length > 0) edges.push(importSeed(path, mod, ingestedFiles, PY_RELATIVE_IMPORT));
      continue;
    }
    const importMatch = PY_IMPORT.exec(line);
    if (importMatch) {
      for (const spec of splitNames(importMatch[1]!)) {
        const mod = spec.split(/\s+as\s+/)[0]!.trim();
        if (mod.length > 0) edges.push({ kind: "imports", from: path, to: mod });
      }
    }
  }
}

/** Build an `imports` seed, binding a relative specifier to its ingested file. */
function importSeed(
  path: string,
  to: string,
  ingestedFiles: ReadonlySet<string> | undefined,
  rule: RelativeImportRule,
): CodeEdgeSeed {
  if (ingestedFiles === undefined || !rule.relative.test(to)) {
    return { kind: "imports", from: path, to };
  }
  const resolvedTo = resolveRelativeImport(path, to, ingestedFiles, rule);
  return resolvedTo === undefined
    ? { kind: "imports", from: path, to }
    : { kind: "imports", from: path, to, resolvedTo };
}

/**
 * Probe one relative specifier against the ingested-file set: the specifier
 * joined to the source's directory (a Python leading-dot specifier first
 * becomes `./`/`../` form, one `..` per extra dot, module dots as slashes),
 * then the language's probe tiers in order. The first tier with any ingested
 * member decides: exactly one names the bound file; several bind nothing.
 */
function resolveRelativeImport(
  path: string,
  to: string,
  ingestedFiles: ReadonlySet<string>,
  rule: RelativeImportRule,
): string | undefined {
  const joined = posixJoin(path, rule.toRelative(to));
  // A specifier climbing above the vault root names nothing the vault holds.
  if (joined === undefined) return undefined;
  for (const tier of rule.probeTiers(joined, to)) {
    const verdict = resolveUniqueMatch(tier.filter((candidate) => ingestedFiles.has(candidate)));
    if (verdict.status === "unique") return verdict.target;
    if (verdict.status === "ambiguous") return undefined;
  }
  return undefined;
}

/** `name` inside directory `dir`, where an empty `dir` is the vault root. */
function childPath(dir: string, name: string): string {
  return dir.length === 0 ? name : `${dir}/${name}`;
}

/**
 * `/`-joined normalization of `specifier` relative to the directory of
 * `path`, or `undefined` when a `..` would climb above the vault root.
 */
function posixJoin(path: string, specifier: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return undefined;
  }
  return segments.join("/");
}

/** A Python leading-dot specifier (`..util`) as a `./`-form relative path. */
function pythonSpecifierToRelative(specifier: string): string {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(dots).replace(/\./g, "/");
  return "../".repeat(Math.max(0, dots - 1)) + rest;
}

/** Whether a TS/JS line is a comment (line, block-open, or JSDoc continuation). */
function isTsComment(line: string): boolean {
  return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*");
}

/** Split a comma-separated name clause into trimmed, non-empty tokens. */
function splitNames(clause: string): string[] {
  return clause
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Lowercase, dot-prefixed extension of a path, or "" when it has none. */
function extensionOf(path: string): string {
  const base = path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function entityKey(e: CodeEntitySeed): string {
  return `${e.kind}\0${e.name}`;
}

function edgeKey(e: CodeEdgeSeed): string {
  return `${e.kind}\0${e.from}\0${e.to}`;
}

/** Dedupe by a stable key and sort by that key, so output is deterministic. */
function dedupeSorted<T>(items: readonly T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!byKey.has(k)) byKey.set(k, item);
  }
  return [...byKey.keys()].toSorted().map((k) => byKey.get(k)!);
}
