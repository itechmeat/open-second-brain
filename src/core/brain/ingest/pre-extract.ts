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

/** A class/function declaration surfaced as an entity seed. */
export interface CodeEntitySeed {
  readonly kind: "class" | "function";
  readonly name: string;
}

/**
 * A structural relationship surfaced as an edge seed. `imports` runs from the
 * source path to a module specifier; `inherits` runs from a subclass to a base
 * class (TS `extends`/`implements`, Python base classes).
 */
export interface CodeEdgeSeed {
  readonly kind: "imports" | "inherits";
  readonly from: string;
  readonly to: string;
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
 * Extract code structure from `content` addressed by `path`. Returns
 * `extracted: false` with a reason when the extension is unsupported, otherwise
 * the deduped, sorted entity/edge seeds for the recognized language.
 */
export function preExtractCodeStructure(path: string, content: string): PreExtractResult {
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
    parsePython(path, content, entities, edges);
  } else {
    parseTsJs(path, content, entities, edges);
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
    if (from) edges.push({ kind: "imports", from: path, to: from[1]! });
    const req = TS_REQUIRE.exec(line);
    if (req) edges.push({ kind: "imports", from: path, to: req[1]! });
  }
}

/** Parse the Python line grammar into entity/edge seeds. */
function parsePython(
  path: string,
  content: string,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
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
      if (mod.length > 0) edges.push({ kind: "imports", from: path, to: mod });
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
  return `${e.kind} ${e.name}`;
}

function edgeKey(e: CodeEdgeSeed): string {
  return `${e.kind} ${e.from} ${e.to}`;
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
