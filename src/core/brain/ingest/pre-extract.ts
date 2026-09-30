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
 * class (TS `extends`/`implements`, Python base classes).
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
  /** Import/inheritance seeds, deduped and sorted by (kind, from, to). */
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

/** The supported extensions in declaration order: the relative-specifier probe set. */
const SUPPORTED_EXTENSIONS: ReadonlyArray<string> = [...LANGUAGE_BY_EXTENSION.keys()];

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

/** A TS/JS specifier relative to the importing file (`./x`, `../x`). */
const TS_RELATIVE_SPECIFIER = /^\.{1,2}\//;
/** A Python specifier at least one dot above or below the importing module. */
const PY_RELATIVE_SPECIFIER = /^\./;

/**
 * A JSX opening tag whose name is a component: the name sits immediately
 * after `<`, the character before `<` is not an identifier character or a
 * dot, and the name starts uppercase (or `_`/`$`).
 *
 * The two structural skips are the point: a lowercase-initial name is a
 * DOM/intrinsic tag, and a dotted name is a member expression - both without
 * any per-language tag vocabulary that could fall out of date. Known limits
 * of a line grammar, accepted on purpose: a capitalized comparison operand
 * (`x < Foo`) and a JSX open spanning lines can misfire or be missed, and a
 * closing tag never matches. False edges are bounded by requiring an
 * uppercase-initial name; missed usages only thin the `uses` tier.
 */
const JSX_COMPONENT_TAG = /(^|[^A-Za-z0-9_$.])<([A-Z_$][A-Za-z0-9_$]*)(?![\w$.])/g;

/** Extensions whose line grammar carries JSX (the `uses` tier). */
const JSX_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx"]);

/**
 * Extract code structure from `content` addressed by `path`. Returns
 * `extracted: false` with a reason when the extension is unsupported, otherwise
 * the deduped, sorted entity/edge seeds for the recognized language.
 *
 * With `opts.ingestedFiles`, every relative import specifier is probed
 * against that set (joined path, each supported extension, `/index` + each
 * supported extension); exactly one member fills the seed's `resolvedTo`.
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
    if (from) edges.push(importSeed(path, from[1]!, ingestedFiles, TS_RELATIVE_SPECIFIER));
    const req = TS_REQUIRE.exec(line);
    if (req) edges.push(importSeed(path, req[1]!, ingestedFiles, TS_RELATIVE_SPECIFIER));

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
      if (mod.length > 0)
        edges.push(
          importSeed(path, mod, ingestedFiles, PY_RELATIVE_SPECIFIER, pythonSpecifierToRelative),
        );
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
  relative: RegExp,
  toRelative: (specifier: string) => string = (specifier) => specifier,
): CodeEdgeSeed {
  if (ingestedFiles === undefined || !relative.test(to)) {
    return { kind: "imports", from: path, to };
  }
  const resolvedTo = resolveRelativeImport(path, toRelative(to), ingestedFiles);
  return resolvedTo === undefined
    ? { kind: "imports", from: path, to }
    : { kind: "imports", from: path, to, resolvedTo };
}

/**
 * Probe one relative specifier against the ingested-file set: the specifier
 * joined to the source's directory (a Python leading-dot specifier first
 * becomes `./`/`../` form, one `..` per extra dot, module dots as slashes),
 * then each supported extension and each `/index` + extension form. Exactly
 * one member of the set names the bound file; zero or several bind nothing.
 */
function resolveRelativeImport(
  path: string,
  to: string,
  ingestedFiles: ReadonlySet<string>,
): string | undefined {
  const joined = posixJoin(path, to);
  const candidates =
    extensionOf(joined) !== "" && LANGUAGE_BY_EXTENSION.has(extensionOf(joined))
      ? [joined]
      : [...SUPPORTED_EXTENSIONS].flatMap((ext) => [`${joined}${ext}`, `${joined}/index${ext}`]);
  const verdict = resolveUniqueMatch(
    candidates.filter((candidate) => ingestedFiles.has(candidate)),
  );
  return verdict.status === "unique" ? verdict.target : undefined;
}

/** `/`-joined normalization of `specifier` relative to the directory of `path`. */
function posixJoin(path: string, specifier: string): string {
  const segments = path.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
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
