/**
 * The Terraform family (`hcl`) of the code-structure pre-extractor.
 *
 * A `.tf` source becomes entity seeds in Terraform address syntax, one per
 * top-level block: `resource` (`<type>.<name>`), `data`
 * (`data.<type>.<name>`), `module` (`module.<name>`), `variable`
 * (`var.<name>`), `output` (`output.<name>`), `provider` (`provider.<name>`)
 * and `locals` (`local.<name>`, one per declared local). A module's
 * `source` becomes an `imports` seed from the file path to the source
 * string, passed through the extractor's one specifier step (the userinfo
 * of an http(s) or `git::` source, a userinfo that does not read as a
 * login, and the value of a named credential query parameter such as
 * `sshkey` are redacted; a credential in a path segment, a fragment or an
 * unnamed query parameter is not) and never bound with `resolvedTo`: a
 * module source names a directory or a registry address, not a file. A `.tfvars` source
 * yields one `variable` seed per top-level assignment name.
 *
 * Edges run from a block address (or, inside `locals`, from the local being
 * declared): `depends_on` for each address in a single-line
 * `depends_on = [...]` list, and `references` for each cited `var.`,
 * `local.`, `module.` or `data.` address and each bare `<type>.<name>`
 * declared as a resource in the same file. Self-citations are dropped.
 *
 * Names only, never values: no attribute value leaves this module except a
 * module `source`, which is a specifier.
 *
 * The scanner is a per-line grammar, the first stateful family of the
 * pre-extractor: it tracks block depth outside quoted strings (with `\"`
 * escapes), skips heredoc bodies up to their terminator (`<<EOF`, `<<-EOF`)
 * and drops `#`, `//` and `/* ... *\/` comments, so braces and text inside
 * strings, heredocs and comments never count. Text inside a string is never
 * a citation; the inside of a `${...}` or `%{...}` interpolation is, and
 * the literal escapes `$${` and `%%{` stay string text.
 *
 * Out of scope, by name (a line grammar, not a Terraform parser):
 *
 * - `.hcl` files (Terragrunt, Packer, Nomad, Vault policies and
 *   `.terraform.lock.hcl` use other block vocabularies) and `.tf.json`;
 * - attribute values (only names and a module `source` leave);
 * - nested blocks (`lifecycle`, `dynamic`, `provisioner`, `connection`) as
 *   entities; their citations count for the enclosing top-level block;
 * - multi-line `depends_on` lists (their items are read as ordinary
 *   citations and seeded as `references`) and `depends_on` expressions;
 * - citations inside a heredoc or in template files;
 * - `for_each` and `count` expansion (one seed per block, not per instance);
 * - `moved`, `import`, `check` and `removed` blocks;
 * - `terraform {}` settings and `required_providers`;
 * - resolution of a local module `source` to a directory;
 * - a block header split across lines (the header must open its `{` on the
 *   line that names the block);
 * - quotes inside an interpolation (`"${f("x")}"`) are not tracked, which
 *   can end the interpolation early and drop citations later on that line.
 */

import { type CodeEdgeSeed, type CodeEntitySeed, specifierSeed } from "./pre-extract-seeds.ts";

/** The top-level block kinds this family turns into entity seeds. */
export const HCL_BLOCK_KIND = Object.freeze({
  resource: "resource",
  data: "data",
  module: "module",
  variable: "variable",
  output: "output",
  provider: "provider",
  locals: "locals",
} as const);

export type HclBlockKind = (typeof HCL_BLOCK_KIND)[keyof typeof HCL_BLOCK_KIND];

/** A block kind addressed by its header labels (every kind but `locals`). */
type LabelledBlockKind = Exclude<HclBlockKind, typeof HCL_BLOCK_KIND.locals>;

/**
 * How a labelled block kind is addressed: the number of labels its header
 * carries and the address those labels form. `locals` has no labels; each of
 * its attributes is addressed instead (`LOCAL_PREFIX`).
 */
interface LabelledBlockGrammar {
  readonly labels: number;
  readonly address: (labels: ReadonlyArray<string>) => string;
}

/** Address prefix of a data source. */
const DATA_PREFIX = "data.";
/** Address prefix of a module call. */
const MODULE_PREFIX = "module.";
/** Address prefix of one input variable (also the `.tfvars` seed form). */
const VARIABLE_PREFIX = "var.";
/** Address prefix of one declared local value. */
const LOCAL_PREFIX = "local.";
/** Address prefix of an output value. */
const OUTPUT_PREFIX = "output.";
/** Address prefix of a provider configuration. */
const PROVIDER_PREFIX = "provider.";

const LABELLED_BLOCKS: Readonly<Record<LabelledBlockKind, LabelledBlockGrammar>> = {
  resource: { labels: 2, address: ([type, name]) => `${type}.${name}` },
  data: { labels: 2, address: ([type, name]) => `${DATA_PREFIX}${type}.${name}` },
  module: { labels: 1, address: ([name]) => `${MODULE_PREFIX}${name}` },
  variable: { labels: 1, address: ([name]) => `${VARIABLE_PREFIX}${name}` },
  output: { labels: 1, address: ([name]) => `${OUTPUT_PREFIX}${name}` },
  provider: { labels: 1, address: ([name]) => `${PROVIDER_PREFIX}${name}` },
};

/** The citation roots that are addresses on their own (`<root>.<name>`). */
const NAMED_CITATION_ROOTS: ReadonlySet<string> = new Set(["var", "local", "module"]);
/** The citation root whose address carries a type and a name (`data.<type>.<name>`). */
const DATA_CITATION_ROOT = "data";

/** A Terraform identifier (letters, digits, `_` and `-`, not starting with a digit). */
const IDENT = "[A-Za-z_][\\w-]*";
/**
 * A block header: keyword, then labels (quoted or bare), then `{`. A label
 * is an identifier either way, as Terraform requires for these block kinds,
 * so any other quoted label opens no block.
 */
const BLOCK_HEADER = new RegExp(`^(${IDENT})((?:\\s+(?:"${IDENT}"|${IDENT}))*)\\s*\\{`);
/** One label inside a header's label run. */
const BLOCK_LABEL = new RegExp(`"(${IDENT})"|(${IDENT})`, "g");
/** An attribute assignment `name = ...` (not the `==` comparison). */
const ATTRIBUTE = new RegExp(`^(${IDENT})\\s*=(?!=)`);
/** The module-block attribute naming where the module's code lives. */
const SOURCE_ATTRIBUTE = /^source\s*=\s*"([^"]*)"/;
/** A single-line `depends_on = [ ... ]` list, capturing its items. */
const DEPENDS_ON = /^depends_on\s*=\s*\[([^\]]*)\]/;
/** One `depends_on` item: a resource, data or module address. */
const DEPENDABLE_ADDRESS = new RegExp(
  `^(?:${DATA_CITATION_ROOT}\\.${IDENT}\\.${IDENT}|${IDENT}\\.${IDENT})$`,
);
/**
 * A dotted citation not itself preceded by a name or a dot (so the
 * attribute tail of `a.b.c` is not cited again), capturing up to three
 * segments.
 */
const CITATION = new RegExp(`(?<![\\w.-])(${IDENT})\\.(${IDENT})(?:\\.(${IDENT}))?`, "g");
/** A heredoc opener `<<EOF` or `<<-EOF`, capturing the terminator. */
const HEREDOC_OPENER = new RegExp(`^<<-?(${IDENT})`);

/**
 * One scanned line: the block depth it starts at, its `text` (comments and
 * heredoc bodies removed, strings kept, trimmed) and its `code` (the text
 * outside string literals plus the inside of interpolations, where a
 * citation can stand).
 */
interface HclLine {
  readonly depth: number;
  readonly text: string;
  readonly code: string;
}

/** The top-level block a body line belongs to. */
interface OpenBlock {
  readonly kind: HclBlockKind;
  /** The block's address; `undefined` for `locals`, whose attributes are addressed. */
  readonly address: string | undefined;
  /** Inside `locals`: the local the current body line belongs to. */
  local?: string;
}

/** A bare `<type>.<name>` citation, an edge only if the file declares that resource. */
interface BareCitation {
  readonly from: string;
  readonly to: string;
}

/**
 * Parse one Terraform source into entity and edge seeds. `variablesOnly` is
 * true for a `.tfvars` source: only its top-level assignment names are
 * seeded, as `variable` entities.
 */
export function parseHcl(
  path: string,
  content: string,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
  variablesOnly: boolean,
): void {
  const lines = scanHcl(content);
  if (variablesOnly) {
    for (const line of lines) {
      const assignment = line.depth === 0 ? ATTRIBUTE.exec(line.text) : null;
      if (assignment) {
        entities.push({
          kind: HCL_BLOCK_KIND.variable,
          name: `${VARIABLE_PREFIX}${assignment[1]!}`,
        });
      }
    }
    return;
  }

  const resources = new Set<string>();
  const bare: BareCitation[] = [];
  let block: OpenBlock | undefined;
  for (const line of lines) {
    let body: HclLine = line;
    if (line.depth === 0) {
      block = openBlock(line.text);
      if (block === undefined) continue;
      if (block.address !== undefined) entities.push({ kind: block.kind, name: block.address });
      if (block.kind === HCL_BLOCK_KIND.resource) resources.add(block.address!);
      body = { depth: 1, text: afterBrace(line.text), code: afterBrace(line.code) };
    }
    if (block !== undefined) readBody(path, block, body, entities, edges, bare);
  }
  for (const citation of bare) {
    if (resources.has(citation.to)) edges.push({ kind: "references", ...citation });
  }
}

/** The block a top-level header opens, or `undefined` for any other line or block kind. */
function openBlock(text: string): OpenBlock | undefined {
  const header = BLOCK_HEADER.exec(text);
  if (!header) return undefined;
  const keyword = header[1]!;
  const labels = [...header[2]!.matchAll(BLOCK_LABEL)].map((m) => m[1] ?? m[2]!);
  if (keyword === HCL_BLOCK_KIND.locals) {
    return labels.length === 0 ? { kind: HCL_BLOCK_KIND.locals, address: undefined } : undefined;
  }
  if (!Object.hasOwn(LABELLED_BLOCKS, keyword)) return undefined;
  const kind = keyword as LabelledBlockKind;
  const grammar = LABELLED_BLOCKS[kind];
  if (labels.length !== grammar.labels) return undefined;
  return { kind, address: grammar.address(labels) };
}

/** Read one body line of `block`: locals, a module source, `depends_on`, citations. */
function readBody(
  path: string,
  block: OpenBlock,
  line: HclLine,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
  bare: BareCitation[],
): void {
  if (line.text.length === 0) return;
  if (block.kind === HCL_BLOCK_KIND.locals && line.depth === 1) {
    const local = ATTRIBUTE.exec(line.text);
    if (local) {
      block.local = `${LOCAL_PREFIX}${local[1]!}`;
      entities.push({ kind: HCL_BLOCK_KIND.locals, name: block.local });
    }
  }
  const from = block.address ?? block.local;
  if (from === undefined) return;

  if (line.depth === 1) {
    if (block.kind === HCL_BLOCK_KIND.module) {
      const source = SOURCE_ATTRIBUTE.exec(line.text);
      if (source) edges.push(specifierSeed(path, source[1]!));
    }
    const dependsOn = DEPENDS_ON.exec(line.code);
    if (dependsOn) {
      for (const item of dependsOn[1]!.split(",")) {
        const to = item.trim();
        if (DEPENDABLE_ADDRESS.test(to) && to !== from) {
          edges.push({ kind: "depends_on", from, to });
        }
      }
      return;
    }
  }

  for (const match of line.code.matchAll(CITATION)) {
    const [, root, second, third] = match;
    if (NAMED_CITATION_ROOTS.has(root!)) {
      pushReference(edges, from, `${root!}.${second!}`);
    } else if (root === DATA_CITATION_ROOT) {
      if (third !== undefined) pushReference(edges, from, `${DATA_PREFIX}${second!}.${third}`);
    } else if (`${root!}.${second!}` !== from) {
      bare.push({ from, to: `${root!}.${second!}` });
    }
  }
}

/** Push a `references` edge unless it cites its own address. */
function pushReference(edges: CodeEdgeSeed[], from: string, to: string): void {
  if (to !== from) edges.push({ kind: "references", from, to });
}

/** The part of a header line after its opening `{`, trimmed. */
function afterBrace(text: string): string {
  return text.slice(text.indexOf("{") + 1).trim();
}

/** Where the character walk of one line stands. */
const SCAN_STATE = Object.freeze({
  code: "code",
  string: "string",
  interpolation: "interpolation",
  blockComment: "blockComment",
} as const);

type ScanState = (typeof SCAN_STATE)[keyof typeof SCAN_STATE];

/**
 * Split `content` into scanned lines (see `HclLine`), dropping comment-only
 * lines and heredoc bodies. Depth counts braces in code only: never inside a
 * string, an interpolation, a comment or a heredoc.
 */
function scanHcl(content: string): HclLine[] {
  const out: HclLine[] = [];
  let depth = 0;
  let inBlockComment = false;
  let heredoc: string | undefined;
  for (const raw of content.split("\n")) {
    if (heredoc !== undefined) {
      if (raw.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const start = depth;
    let state: ScanState = inBlockComment ? SCAN_STATE.blockComment : SCAN_STATE.code;
    let interpolationDepth = 0;
    let text = "";
    let code = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      const next = raw[i + 1];
      if (state === SCAN_STATE.blockComment) {
        if (ch === "*" && next === "/") {
          state = SCAN_STATE.code;
          i++;
        }
        continue;
      }
      if (state === SCAN_STATE.string) {
        text += ch;
        if (ch === "\\" && next !== undefined) {
          text += next;
          i++;
        } else if (ch === '"') {
          state = SCAN_STATE.code;
          code += ch;
        } else if ((ch === "$" || ch === "%") && next === ch && raw[i + 2] === "{") {
          // `$${` and `%%{` are the literal escapes: string text, not an
          // interpolation.
          text += next + raw[i + 2];
          i += 2;
        } else if ((ch === "$" || ch === "%") && next === "{") {
          text += next;
          i++;
          state = SCAN_STATE.interpolation;
          interpolationDepth = 1;
          code += " ";
        }
        continue;
      }
      if (state === SCAN_STATE.interpolation) {
        text += ch;
        if (ch === "{") interpolationDepth += 1;
        else if (ch === "}") interpolationDepth -= 1;
        if (interpolationDepth === 0) {
          state = SCAN_STATE.string;
          code += " ";
        } else {
          code += ch;
        }
        continue;
      }
      // Code.
      if (ch === "#" || (ch === "/" && next === "/")) break;
      if (ch === "/" && next === "*") {
        state = SCAN_STATE.blockComment;
        i++;
        continue;
      }
      if (ch === "<" && next === "<") {
        const opener = HEREDOC_OPENER.exec(raw.slice(i));
        if (opener) {
          heredoc = opener[1]!;
          text += opener[0];
          code += opener[0];
          i += opener[0].length - 1;
          continue;
        }
      }
      if (ch === '"') state = SCAN_STATE.string;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      text += ch;
      code += ch;
    }
    // A string never spans lines outside a heredoc; only a block comment carries over.
    inBlockComment = state === SCAN_STATE.blockComment;
    const trimmed = text.trim();
    if (trimmed.length > 0) out.push({ depth: start, text: trimmed, code: code.trim() });
  }
  return out;
}
