/**
 * Note-body templates: a CLOSED two-construct grammar
 * (provenance-at-the-boundary, Unit C).
 *
 * `createNote` can author a body from a caller-supplied template plus a
 * typed variable map instead of a literal string. The grammar has
 * exactly two constructs and is not going to grow a third:
 *
 *   1. Typed variable substitution. `{{name}}` renders the variable's
 *      canonical text: a string as-is, a number through `String`, a
 *      boolean as `true`/`false`, a list joined by {@link LIST_JOIN}.
 *   2. Presence-driven sections and list iteration.
 *      `{{#name}}…{{/name}}` renders its body when `name` is present and
 *      non-empty, and once per entry when `name` is a list, where
 *      `{{.}}` is the current entry. Sections nest.
 *
 * There is no expression language, no comparison, no filter, no
 * partial, no inversion and no dotted path. Anything needing a third
 * construct is out of scope by design: a general template engine is not
 * something this kernel wants to own, and every one of them starts as
 * two constructs.
 *
 * Two failure modes, kept deliberately distinct because collapsing them
 * is exactly the silent-fallback defect this project removes:
 *
 *   - An UNKNOWN name is left byte-intact. `{{ typo }}` renders as
 *     `{{ typo }}`, and an unknown section keeps its whole span, body
 *     included. This is the rule `renderTemplate` in `../templates.ts`
 *     already documents for managed templates - a typo must surface in
 *     the output rather than vanish into an empty string.
 *   - A MALFORMED template - a section opened and never closed - is
 *     refused with a typed {@link NoteTemplateError}, because there is
 *     no rendering of it to return. "Not a construct" and "a construct
 *     that does not parse" are different answers and get different
 *     treatment.
 *
 * Pure and clock-free: the same template and variables always render to
 * the same bytes.
 */

import type { FrontmatterValue } from "../../types.ts";

/**
 * Variables a template may reference. Deliberately the vault's own
 * frontmatter value domain, so the MCP surface coerces template
 * variables through the same parser it already uses for frontmatter
 * instead of growing a second value model.
 */
export type NoteTemplateVariables = Readonly<Record<string, FrontmatterValue>>;

/** Machine-readable reason a template could not be rendered. */
export type NoteTemplateErrorCode = "unbalanced_section" | "section_too_deep" | "invalid_variable";

export class NoteTemplateError extends Error {
  readonly code: NoteTemplateErrorCode;
  constructor(code: NoteTemplateErrorCode, message: string) {
    super(message);
    this.name = "NoteTemplateError";
    this.code = code;
  }
}

/** Construct delimiters. */
const OPEN = "{{";
const CLOSE = "}}";

/** Sigils that turn a delimited name into a section open or close. */
const SECTION_OPEN_SIGIL = "#";
const SECTION_CLOSE_SIGIL = "/";

/** The current entry inside a list iteration. */
const ITEM_NAME = ".";

/**
 * Legal variable and section names. Anything else between the
 * delimiters is not a construct at all and survives as literal text,
 * which is what keeps `{{a.b}}`, `{{a | upper}}` and `{{^a}}` from
 * being a path lookup, a filter and an inverted section.
 */
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Canonical separator when a list renders as one value. */
const LIST_JOIN = ", ";

/**
 * Deepest section nesting accepted. Templates arrive from an MCP
 * caller, and the parser is recursive; a bound keeps a pathological
 * template a typed refusal instead of a stack overflow.
 */
const MAX_SECTION_DEPTH = 16;

type TemplateNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "variable"; readonly name: string; readonly raw: string }
  | {
      readonly kind: "section";
      readonly name: string;
      readonly raw: string;
      readonly body: ReadonlyArray<TemplateNode>;
    };

interface ParsedSpan {
  readonly nodes: ReadonlyArray<TemplateNode>;
  /** Index just past the matching close tag, or the end of the source. */
  readonly next: number;
  /** True when a matching close tag was consumed. */
  readonly closed: boolean;
}

function isName(candidate: string): boolean {
  return NAME_PATTERN.test(candidate);
}

/** A list value, narrowed so the scalar branch narrows too. */
function isList(value: FrontmatterValue): value is ReadonlyArray<string> {
  return Array.isArray(value);
}

/**
 * Own-property read. `variables` may be a prototype-free object built by
 * the MCP argument parser, so `in` and direct indexing are both wrong
 * here for different reasons.
 */
function readVariable(
  variables: NoteTemplateVariables,
  name: string,
): FrontmatterValue | undefined {
  return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
}

/**
 * Canonical text for one variable. Rendering is total for every value
 * in the domain except a non-finite number, which is a caller fault and
 * is named rather than rendered as `NaN`.
 */
function canonical(value: FrontmatterValue, name: string): string {
  if (isList(value)) return value.join(LIST_JOIN);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) {
    throw new NoteTemplateError(
      "invalid_variable",
      `template variable '${name}' is not a finite number`,
    );
  }
  return String(value);
}

/**
 * Presence, NOT JavaScript truthiness. A string is present when it is
 * non-empty and a boolean when it is `true`; a number is ALWAYS present,
 * because `0` is a value the caller supplied and reading it as absence
 * is the classic falsy-zero defect. Lists are handled by the iteration
 * branch before this is reached.
 */
function isPresent(value: string | number | boolean): boolean {
  if (typeof value === "string") return value !== "";
  if (typeof value === "boolean") return value;
  return true;
}

/**
 * Parse `source` from `start` until either the close tag for
 * `sectionName` or the end of input. `sectionName` is null at the top
 * level, where a close tag has nothing to match and is therefore not a
 * construct.
 */
function parseSpan(
  source: string,
  start: number,
  sectionName: string | null,
  depth: number,
): ParsedSpan {
  const nodes: TemplateNode[] = [];
  let cursor = start;
  let literalStart = start;
  const pushText = (end: number): void => {
    if (end > literalStart) nodes.push({ kind: "text", text: source.slice(literalStart, end) });
  };

  while (cursor < source.length) {
    const open = source.indexOf(OPEN, cursor);
    if (open < 0) break;
    const close = source.indexOf(CLOSE, open + OPEN.length);
    // An unterminated `{{` is not a construct; the remainder is text.
    if (close < 0) break;
    const after = close + CLOSE.length;
    const inner = source.slice(open + OPEN.length, close).trim();

    if (inner.startsWith(SECTION_CLOSE_SIGIL)) {
      const name = inner.slice(SECTION_CLOSE_SIGIL.length).trim();
      if (isName(name) && name === sectionName) {
        pushText(open);
        return { nodes, next: after, closed: true };
      }
      // A close tag that matches no open section is an unknown token,
      // not a broken construct: leave it intact so it surfaces.
      cursor = after;
      continue;
    }

    if (inner.startsWith(SECTION_OPEN_SIGIL)) {
      const name = inner.slice(SECTION_OPEN_SIGIL.length).trim();
      if (!isName(name)) {
        cursor = after;
        continue;
      }
      if (depth >= MAX_SECTION_DEPTH) {
        throw new NoteTemplateError(
          "section_too_deep",
          `template nests sections deeper than ${MAX_SECTION_DEPTH}`,
        );
      }
      const body = parseSpan(source, after, name, depth + 1);
      if (!body.closed) {
        throw new NoteTemplateError(
          "unbalanced_section",
          `template opens section '${name}' and never closes it`,
        );
      }
      pushText(open);
      nodes.push({
        kind: "section",
        name,
        raw: source.slice(open, body.next),
        body: body.nodes,
      });
      cursor = body.next;
      literalStart = cursor;
      continue;
    }

    if (inner === ITEM_NAME || isName(inner)) {
      pushText(open);
      nodes.push({ kind: "variable", name: inner, raw: source.slice(open, after) });
      cursor = after;
      literalStart = cursor;
      continue;
    }

    // Not one of the two constructs: the delimiters stay literal text.
    cursor = after;
  }

  pushText(source.length);
  return { nodes, next: source.length, closed: false };
}

/**
 * Render a parsed span. `item` is the current list entry inside an
 * iteration and `undefined` everywhere else, which is what makes
 * `{{.}}` outside an iteration an unknown placeholder rather than an
 * empty one.
 */
function renderNodes(
  nodes: ReadonlyArray<TemplateNode>,
  variables: NoteTemplateVariables,
  item: FrontmatterValue | undefined,
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.text;
      continue;
    }
    if (node.kind === "variable") {
      const value = node.name === ITEM_NAME ? item : readVariable(variables, node.name);
      out += value === undefined ? node.raw : canonical(value, node.name);
      continue;
    }
    const value = readVariable(variables, node.name);
    if (value === undefined) {
      // An undeclared section name is an unknown placeholder, not an
      // empty one: the whole construct survives so the typo surfaces.
      out += node.raw;
      continue;
    }
    if (isList(value)) {
      for (const entry of value) out += renderNodes(node.body, variables, entry);
      continue;
    }
    if (isPresent(value)) out += renderNodes(node.body, variables, item);
  }
  return out;
}

/**
 * Render `template` against `variables`. Throws
 * {@link NoteTemplateError} only for a template that cannot be parsed
 * or a variable outside the value domain; an unknown name is never an
 * error, it is preserved.
 */
export function renderNoteTemplate(
  template: string,
  variables: NoteTemplateVariables = {},
): string {
  const parsed = parseSpan(template, 0, null, 0);
  return renderNodes(parsed.nodes, variables, undefined);
}
