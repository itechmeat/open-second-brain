/**
 * The Terraform family (`hcl`) of the code-structure pre-extractor.
 *
 * A `.tf` source becomes entity seeds in Terraform address syntax, one per
 * top-level block: `resource` (`<type>.<name>`), `data`
 * (`data.<type>.<name>`), `module` (`module.<name>`), `variable`
 * (`var.<name>`), `output` (`output.<name>`), `provider` (`provider.<name>`)
 * and `locals` (`local.<name>`, one per declared local). A module's
 * `source` becomes an `imports` seed from the file path to the source
 * string, passed through the extractor's one specifier step (URL
 * credentials redacted) and never bound with `resolvedTo`: a module source
 * names a directory or a registry address, not a file. A `.tfvars` source
 * yields one `variable` seed per top-level assignment name.
 *
 * Names only, never values: no attribute value leaves this module except a
 * module `source`, which is a specifier.
 */

import type { CodeEdgeSeed, CodeEntitySeed } from "./pre-extract.ts";
import { specifierSeed } from "./pre-extract.ts";

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

/**
 * How a labelled block kind is addressed: the number of labels its header
 * carries and the address those labels form. `locals` has no labels; each of
 * its attributes is addressed instead (`LOCAL_PREFIX`).
 */
interface LabelledBlockGrammar {
  readonly labels: number;
  readonly address: (labels: ReadonlyArray<string>) => string;
}

const LABELLED_BLOCKS: Readonly<Record<Exclude<HclBlockKind, "locals">, LabelledBlockGrammar>> = {
  resource: { labels: 2, address: ([type, name]) => `${type}.${name}` },
  data: { labels: 2, address: ([type, name]) => `data.${type}.${name}` },
  module: { labels: 1, address: ([name]) => `module.${name}` },
  variable: { labels: 1, address: ([name]) => `var.${name}` },
  output: { labels: 1, address: ([name]) => `output.${name}` },
  provider: { labels: 1, address: ([name]) => `provider.${name}` },
};

/** Address prefix of one declared local value. */
const LOCAL_PREFIX = "local.";
/** Address prefix of one input variable (also the `.tfvars` seed form). */
const VARIABLE_PREFIX = "var.";
/** The module-block attribute naming where the module's code lives. */
const MODULE_SOURCE_ATTRIBUTE = "source";

/** A block header: keyword, then labels (quoted or bare), then `{`. */
const BLOCK_HEADER = /^([A-Za-z_][\w-]*)((?:\s+(?:"[^"]*"|[A-Za-z_][\w-]*))*)\s*\{/;
/** One label inside a header's label run. */
const BLOCK_LABEL = /"([^"]*)"|([A-Za-z_][\w-]*)/g;
/** An attribute assignment `name = ...` (not the `==` comparison). */
const ATTRIBUTE = /^([A-Za-z_][\w-]*)\s*=(?!=)/;
/** A `source = "..."` attribute, capturing the source string. */
const SOURCE_ATTRIBUTE = new RegExp(`^${MODULE_SOURCE_ATTRIBUTE}\\s*=\\s*"([^"]*)"`);

/** One line of the source with the block depth at which it starts. */
interface HclLine {
  readonly depth: number;
  readonly text: string;
}

/** The top-level block a body line belongs to. */
interface OpenBlock {
  readonly kind: HclBlockKind;
  /** The block's address; `undefined` for `locals`, whose attributes are addressed. */
  readonly address: string | undefined;
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
      if (assignment)
        entities.push({ kind: "variable", name: `${VARIABLE_PREFIX}${assignment[1]!}` });
    }
    return;
  }

  let block: OpenBlock | undefined;
  for (const line of lines) {
    if (line.depth === 0) {
      block = openBlock(line.text);
      if (block === undefined) continue;
      if (block.address !== undefined) entities.push({ kind: block.kind, name: block.address });
      readBody(path, block, line.text.slice(line.text.indexOf("{") + 1).trim(), 1, entities, edges);
      continue;
    }
    if (block !== undefined) readBody(path, block, line.text, line.depth, entities, edges);
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
  const kind = keyword as Exclude<HclBlockKind, "locals">;
  const grammar = LABELLED_BLOCKS[kind];
  if (labels.length !== grammar.labels) return undefined;
  return { kind, address: grammar.address(labels) };
}

/** Read one body line of `block` that starts at `depth`. */
function readBody(
  path: string,
  block: OpenBlock,
  text: string,
  depth: number,
  entities: CodeEntitySeed[],
  edges: CodeEdgeSeed[],
): void {
  if (depth !== 1 || text.length === 0) return;
  if (block.kind === HCL_BLOCK_KIND.locals) {
    const local = ATTRIBUTE.exec(text);
    if (local) entities.push({ kind: "locals", name: `${LOCAL_PREFIX}${local[1]!}` });
    return;
  }
  if (block.kind === HCL_BLOCK_KIND.module) {
    const source = SOURCE_ATTRIBUTE.exec(text);
    if (source) edges.push(specifierSeed(path, source[1]!));
  }
}

/** Split `content` into trimmed, non-comment lines with the depth each starts at. */
function scanHcl(content: string): HclLine[] {
  const out: HclLine[] = [];
  let depth = 0;
  for (const raw of content.split("\n")) {
    const text = raw.trim();
    if (text.length === 0 || text.startsWith("#") || text.startsWith("//")) continue;
    out.push({ depth, text });
    for (const ch of text) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return out;
}
